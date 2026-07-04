# Subsystem Design — [core-runtime] Rust Core Team

**Owner:** Rust Core Team
**Crates owned:** `ns-types` (L0), `ns-core` (L0), `ns-event` (L1)
**Framework contributions (co-owned with [tauri-shell]):** the composition-root pattern, `AppState` service registry shape, the background-worker/cancellation framework, and the shared tokio runtime + graceful-shutdown protocol that live physically in `apps/desktop/src-tauri` but whose contracts are defined here.

> This subsystem is the **kernel**. It sits at the bottom of the dependency graph: every other crate depends on `ns-types` + `ns-core`, and every service depends on `ns-event`. We own no `async-nats`, no `tauri`, no `rusqlite`, no `reqwest`. We define the *ports* (traits) and the *shared vocabulary* (DTOs, errors, events, IDs) that the whole workspace inverts its dependencies onto. Because we are frozen public interface, changes here ripple everywhere — we move slowly and deliberately (ADR + `appSchemaVersion` bump for breaking DTO changes).

---

## (a) Responsibilities & Boundaries

### In scope (we own)
1. **`ns-types` — the DTO source of truth.** Every value crossing the IPC boundary: command `Request`/`Response` DTOs *shared* value objects, `ErrorCode`, `IpcError`, `EventPayload`, `Topic`. Pure `serde` + `typeshare`, no logic. Frozen public interface.
2. **`ns-core` — the kernel.** All **port traits** (repository ports, `EventPublisher`, `SecretStore`, `Clock`, service-registry marker traits), the `DomainError` trait + `ErrorCode` helpers, newtype IDs, `Redacted<T>`, the `Settings` model + defaults, and the **cancellation/task primitives** (`CancellationToken`, `CancellationRegistry`, `TaskHandle`, `TaskRegistry`, `TaskSpec`, supervision policy).
3. **`ns-event` — the internal async event bus.** `EventBus` over `tokio::sync::broadcast` (fan-out topics) + `mpsc` (work queues), the `Event` envelope with monotonic per-topic `seq`, `Topic` routing, and the `EventPublisher` port implementation with per-topic coalescing/backpressure policy.
4. **The composition-root contract.** The shape of `AppState` (a registry of `Arc<dyn Service>` ports), the wiring order (ports → adapters → services → bridge → commands → run), and the **graceful-shutdown protocol** (`Shutdown` token fan-out, drain order, task-join deadline).
5. **The background-worker framework.** Spawn/track/cancel/supervise long-running tokio tasks with structured `TaskProgress` reporting and restart-with-backoff supervision.
6. **A handful of app-level IPC commands** (`app_*`, `settings_*`, `task_*`) that are genuinely cross-cutting and belong to no feature team.

### Out of scope (explicit boundaries — do NOT implement here)
- **Connection lifecycle itself** lives in `ns-connection` ([connection-manager]). We provide the *task/cancellation framework* and the `EventBus` it emits status on; we do **not** define `ConnectionService` or touch `async-nats`. "Connection lifecycle orchestration" in our charter means *the runtime scaffolding* (shared runtime, task supervision, shutdown drain of connection tasks), not the NATS protocol logic.
- **Tauri glue** (`AppError→IpcError` mapping, `EventBridge`, command envelopes) lives in `ns-ipc` ([tauri-shell]). We define `IpcError`/`ErrorCode`/`EventPayload`; ns-ipc does the *translation*. We never import `tauri`.
- **SQL / persistence** lives in `ns-storage`. We define the repository **ports** and the `Settings` DTO; storage implements them.
- **Secrets** live in `ns-security`. We define the `SecretStore` port + `Redacted<T>`; security implements it.
- **Logging subscriber setup** lives in `ns-telemetry`. We define the `Clock` port and `correlation_id` span convention; telemetry wires the subscriber.

### The one hard rule we enforce
`ns-types` and `ns-core` have **zero** dependency on any adapter crate, any I/O crate, or `tauri`. They compile on a headless server with no NATS, no WebView. This is what makes the entire domain testable and a future CLI/server reusable. CI enforces via `cargo xtask check-layers` + `cargo-deny`.

---

## (b) Rust Public Interface

### `ns-types` — shared DTOs (typeshare-annotated, all `#[serde(rename_all = "camelCase")]`)

```rust
// ---- IDs (newtypes over Uuid, serialized as strings) ----
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectionId(pub Uuid);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SubscriptionId(pub Uuid);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub Uuid);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskId(pub Uuid);
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CorrelationId(pub String);

// ---- Stable wire error (frozen) ----
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ConnectionTimeout, ConnectionClosed, AuthFailed, TlsError, PermissionDenied,
    JetstreamNotEnabled, StreamNotFound, ConsumerNotFound, KvKeyNotFound, ObjectNotFound,
    SubjectInvalid, PayloadDecodeFailed, RequestTimeout, NoResponders,
    MonitorUnreachable, MonitorParseError, Storage, MigrationFailed, SecretStoreUnavailable,
    TerminalSpawnFailed, PluginError, PluginIncompatible,
    Cancelled, Timeout, Serialization, Io, NotFound, InvalidArgument, Internal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,                 // user_message(), secret-safe
    pub retriable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<CorrelationId>,
    pub causes: Vec<String>,             // redacted source chain
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>, // the ONE sanctioned Json escape
}

// ---- Pagination (monomorphize where typeshare generics are weak) ----
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

// ---- Event envelope payload (adjacently tagged -> TS discriminated union) ----
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum EventPayload {
    ConnectionStatusChanged(ConnectionStatusChanged),
    ServerInfoUpdated(ServerInfoUpdated),
    MetricsTick(MetricsTick),
    StreamUpdated(StreamUpdated),
    ConsumerLag(ConsumerLag),
    SubjectActivity(SubjectActivity),
    LogEmitted(LogEmitted),
    TaskProgress(TaskProgress),
    Notification(Notification),
    PluginEvent(PluginEvent),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    ConnectionStatus, ServerInfo, Metrics, JetstreamStream, JetstreamConsumerLag,
    SubjectActivity, Log, TaskProgress, Notification, Plugin,
}

// ---- App-level DTOs we own ----
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,          // SemVer, from Cargo workspace version
    pub app_schema_version: u32,  // IPC/DTO contract version
    pub plugin_api_version: String,
    pub storage_schema_version: u32,
    pub commit: String,
    pub build_profile: String,    // "release" | "debug"
    pub os: String,
    pub arch: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub task_id: TaskId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<ConnectionId>,
    pub kind: String,             // e.g. "jetstream.replay", "monitor.poll"
    pub label: String,
    pub state: TaskState,         // Running | Completed | Failed | Cancelled
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f32>,    // 0.0..=1.0 when determinate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub ts: String,               // RFC-3339
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState { Running, Completed, Failed, Cancelled }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub level: NotificationLevel, // Info | Success | Warn | Error
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub ts: String,
}

// ---- Settings DTO (defaults live in ns-core; persisted by ns-storage) ----
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub theme: Theme,                 // System | Light | Dark
    pub log_level: String,            // maps to EnvFilter default
    pub telemetry_enabled: bool,      // opt-in, default false
    pub history_max_rows: u64,
    pub history_ttl_days: u32,
    pub reconnect_max_backoff_ms: u64,
    pub metrics_poll_interval_ms: u64,
    pub task_shutdown_grace_ms: u64,
    pub terminal_shell_mode_enabled: bool,
    pub confirm_destructive_ops: bool,
}
```

**Command Request/Response DTOs we own** (in `ns-types`, `<Verb><Noun>Request/Response`):

```rust
pub struct AppInfoRequest {}                         // -> AppInfo
pub struct AppHealthRequest {}                        // -> AppHealth { ok, subsystems: Vec<SubsystemHealth> }
pub struct SettingsGetRequest {}                      // -> Settings
pub struct SettingsUpdateRequest { pub patch: SettingsPatch }  // -> Settings (full, post-merge)
pub struct TaskListRequest { pub connection_id: Option<ConnectionId> } // -> Page<TaskSnapshot>
pub struct TaskCancelRequest { pub task_id: TaskId } // -> TaskCancelResponse { accepted: bool }
pub struct LogReportRequest { pub level: String, pub message: String, pub context: Option<serde_json::Value> } // -> ()
```

`SettingsPatch` is an all-`Option<T>` mirror of `Settings` (partial update). `TaskSnapshot` mirrors the runtime `TaskHandle` metadata (id, kind, label, state, started_at, connection_id, cancellable).

### `ns-core` — ports, kernel primitives

```rust
// ---- DomainError: the uniform mapping every crate error implements ----
pub trait DomainError: std::error::Error + Send + Sync + 'static {
    fn code(&self) -> ErrorCode;
    fn retriable(&self) -> bool;
    /// Secret-safe, user-facing. MUST NOT leak creds/seeds/tokens.
    fn user_message(&self) -> String;
}

// ---- Redaction ----
/// Wraps a secret. Debug/Display print `***`. Deref-none; explicit `.expose()` only.
pub struct Redacted<T>(T);
impl<T> Redacted<T> {
    pub fn new(v: T) -> Self { Self(v) }
    pub fn expose(&self) -> &T { &self.0 }
    pub fn into_inner(self) -> T { self.0 }
}
impl<T> fmt::Debug for Redacted<T> { /* writes "***" */ }
impl<T> fmt::Display for Redacted<T> { /* writes "***" */ }

// ---- Clock port (deterministic tests) ----
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> OffsetDateTime;
    fn monotonic(&self) -> Instant;
}
pub struct SystemClock;   // real impl
pub struct MockClock { /* advanceable */ }  // in ns-testkit re-export

// ---- EventPublisher port (implemented in ns-event) ----
pub trait EventPublisher: Send + Sync + 'static {
    fn publish(&self, event: Event);
    /// Non-blocking; NEVER awaits a slow consumer (producers are never blocked).
    fn try_publish(&self, topic: Topic, connection_id: Option<ConnectionId>, payload: EventPayload);
}

// ---- Repository ports (implemented by ns-storage) ----
#[async_trait::async_trait]
pub trait SettingsRepo: Send + Sync + 'static {
    async fn load(&self) -> Result<Option<Settings>, RepoError>;
    async fn save(&self, settings: &Settings) -> Result<(), RepoError>;
}
// (ConnectionProfileRepo, MessageHistoryRepo, SavedQueryRepo, PublishTemplateRepo,
//  LayoutRepo, PluginStateRepo declared here as ports; other teams consume them.)

// ---- Cancellation primitives ----
#[derive(Clone)]
pub struct CancellationToken(tokio_util::sync::CancellationToken);
impl CancellationToken {
    pub fn new() -> Self;
    pub fn child(&self) -> Self;
    pub fn cancel(&self);
    pub fn is_cancelled(&self) -> bool;
    pub async fn cancelled(&self);   // await for cancellation
}

/// Maps UI-visible ids (subscriptionId/sessionId/taskId) -> token.
pub struct CancellationRegistry { /* DashMap<Uuid, CancellationToken> */ }
impl CancellationRegistry {
    pub fn new() -> Self;
    pub fn register(&self, id: Uuid) -> CancellationToken;
    pub fn cancel(&self, id: Uuid) -> bool;         // returns whether found
    pub fn remove(&self, id: Uuid);
    pub fn cancel_all(&self);                        // used on shutdown
}

// ---- Background-worker framework ----
pub struct TaskSpec {
    pub kind: String,
    pub label: String,
    pub connection_id: Option<ConnectionId>,
    pub cancellable: bool,
    pub supervision: Supervision,   // Never | Restart { max, backoff }
}
pub enum Supervision {
    None,
    Restart { max_restarts: u32, backoff: Backoff },
}

pub struct TaskHandle {
    pub id: TaskId,
    pub token: CancellationToken,
    // join handle held internally by the registry
}

/// The supervised task runner. Emits TaskProgress on start/finish/restart.
pub struct TaskRegistry {
    // events: Arc<dyn EventPublisher>, clock: Arc<dyn Clock>, DashMap<TaskId, TaskEntry>
}
impl TaskRegistry {
    pub fn new(events: Arc<dyn EventPublisher>, clock: Arc<dyn Clock>) -> Self;

    /// Spawn a supervised background task. `f` receives its own CancellationToken.
    pub fn spawn<F, Fut>(&self, spec: TaskSpec, f: F) -> TaskHandle
    where
        F: Fn(CancellationToken, ProgressReporter) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), TaskError>> + Send + 'static;

    pub fn cancel(&self, id: TaskId) -> bool;
    pub fn snapshot(&self, connection_id: Option<ConnectionId>) -> Vec<TaskSnapshot>;
    pub async fn shutdown(&self, grace: Duration);  // cancel all, join within grace
}

/// Passed into a task body; coalesced TaskProgress emission.
pub struct ProgressReporter { /* task_id, events, clock, min-interval throttle */ }
impl ProgressReporter {
    pub fn set_fraction(&self, f: f32);
    pub fn message(&self, msg: impl Into<String>);
    pub fn tick(&self);  // keep-latest per task id, throttled
}

// ---- Service-registry marker + AppState contract (assembled in the bin) ----
/// Every feature service is exposed as Arc<dyn XxxService>. This module declares
/// the *shape*; concrete traits live in each feature crate; the bin composes them.
pub trait ServiceRegistry: Send + Sync + 'static {
    fn events(&self) -> &EventBusHandle;
    fn cancels(&self) -> &CancellationRegistry;
    fn tasks(&self) -> &TaskRegistry;
    fn clock(&self) -> &Arc<dyn Clock>;
}
```

### `ns-event` — the internal bus

```rust
pub struct Event {
    pub topic: Topic,
    pub connection_id: Option<ConnectionId>,
    pub seq: u64,            // monotonic PER topic -> UI gap detection
    pub ts: OffsetDateTime,
    pub payload: EventPayload,
}

/// Clone-cheap handle stored in AppState and injected everywhere.
#[derive(Clone)]
pub struct EventBusHandle { /* Arc<Inner> with per-topic broadcast senders + seq counters */ }

impl EventBusHandle {
    pub fn new(capacity: BusCapacity) -> Self;
    /// Subscribe to a topic's broadcast stream (used by the EventBridge in ns-ipc).
    pub fn subscribe(&self, topic: Topic) -> broadcast::Receiver<Event>;
    /// Point-to-point work queue (mpsc) for internal producers/consumers.
    pub fn work_queue<T: Send + 'static>(&self, name: &'static str, cap: usize) -> (mpsc::Sender<T>, mpsc::Receiver<T>);
}

/// EventPublisher impl over EventBusHandle, applying per-topic policy.
pub struct BusPublisher { inner: EventBusHandle, policy: PolicyTable }
impl EventPublisher for BusPublisher { /* stamps seq+ts, applies coalescing, try_send */ }

// Per-topic backpressure/coalescing policy table (see section h).
pub struct PolicyTable { /* Topic -> Policy { Coalesce{window}, DedupeTransitions, RateLimit{n_per_s}, RingDropOldest{cap}, KeepLatestPerKey, NeverDrop } */ }
```

**Graceful shutdown contract** (implemented in the bin, defined here):

```rust
pub struct ShutdownController { token: CancellationToken /* root */ }
impl ShutdownController {
    pub fn token(&self) -> CancellationToken;       // child tokens handed to every long task
    /// Drain order: (1) trip root token, (2) TaskRegistry.shutdown(grace),
    /// (3) CancellationRegistry.cancel_all(), (4) flush EventBridge, (5) close connections,
    /// (6) flush storage worker, (7) flush tracing appender.
    pub async fn run(self, app: Arc<AppStateInner>, grace: Duration);
}
```

---

## (c) Tauri IPC Commands We Expose

All are `#[tauri::command] async fn`, take one `req` arg, return `Result<Resp, IpcError>`. They physically live in `apps/desktop/src-tauri/src/commands/app.rs` but call **only** into core-runtime primitives (Tauri-agnostic core logic).

| Command | Kind | Params (`req`) | Returns | Errors (`ErrorCode`) |
|---|---|---|---|---|
| `app_info` | request | `AppInfoRequest{}` | `AppInfo` | `INTERNAL` |
| `app_health` | request | `AppHealthRequest{}` | `AppHealth` | `INTERNAL` |
| `settings_get` | request | `SettingsGetRequest{}` | `Settings` | `STORAGE`, `INTERNAL` |
| `settings_update` | command | `SettingsUpdateRequest{patch}` | `Settings` | `INVALID_ARGUMENT`, `STORAGE`, `INTERNAL` |
| `task_list` | request | `TaskListRequest{connectionId?}` | `Page<TaskSnapshot>` | `INTERNAL` |
| `task_cancel` | command | `TaskCancelRequest{taskId}` | `TaskCancelResponse{accepted}` | `NOT_FOUND`, `INTERNAL` |
| `log_report` | command | `LogReportRequest{level,message,context?}` | `()` | `INVALID_ARGUMENT` |
| `app_shutdown` | command | `AppShutdownRequest{}` | `()` | `INTERNAL` |

Notes:
- `settings_update` merges the patch, persists via `SettingsRepo`, and emits a bridged `Notification` + a settings-changed signal so hot-reload subscribers re-read (`log_level` re-applies `EnvFilter`; `metrics_poll_interval_ms` re-arms monitor scheduler).
- `task_cancel` is the **generic** background-task canceller (TaskRegistry). It is distinct from the per-stream `*_unsubscribe`/`*_cancel` commands each feature team owns (CancellationRegistry) — those cancel *request-scoped* Channel streams; `task_cancel` cancels *supervised background jobs*.
- `log_report` forwards significant UI errors into the same tracing pipeline (feeds `ns-telemetry`).

---

## (d) Events We Emit

We **define** all `EventPayload` variants and `Topic`s (they are `ns-types`), and we **originate** these two as framework signals; the rest are originated by feature crates but flow through *our* bus and policy engine:

| Bridged Tauri event | Topic | Payload | Policy |
|---|---|---|---|
| `ns://task/progress` | `TaskProgress` | `TaskProgress` | keep-latest per `taskId`, throttled |
| `ns://notification` | `Notification` | `Notification` | never drop |

We also own the **envelope + seq machinery** for *every* topic (`ns://connection/status`, `ns://server/info`, `ns://monitor/metrics`, `ns://jetstream/*`, `ns://subject/activity`, `ns://log`, `ns://plugin`). Feature crates publish `EventPayload` via the injected `EventPublisher` port; `ns-ipc::EventBridge` is the sole translator to Tauri. Lagged broadcast receivers (`RecvError::Lagged(n)`) are surfaced by the bridge as a synthetic gap indicator — the `seq` field we stamp is what lets the UI detect the gap.

---

## (e) Frontend Surface

Core-runtime is mostly headless, but owns the app-shell glue that every feature builds on.

**Routes:** none of its own (feature teams own routes). Owns the app boot sequence in `app/AppProviders.tsx`.

**Components / panels:**
- `AppBootGate` — blocks render until `app_info` + `settings_get` resolve; shows fatal-error screen on `INTERNAL`.
- `GlobalTaskTray` — a status-bar popover listing active background tasks (from `task_list` + `ns://task/progress`), each with a cancel button → `task_cancel`.
- `NotificationToaster` — subscribes to `ns://notification`.
- `useAppEvents()` — the single hook that subscribes to all bridged Tauri events and routes each into the TanStack Query cache (`setQueryData`) or the relevant Zustand slice. **We own this hook.**

**Zustand stores (UI/session only):**
- `useAppStore` — `appInfo`, boot phase, `activeConnectionId` (UI selection), theme (mirrors `Settings.theme`), command-palette open state, feature flags.
- `useTaskStore` — live in-flight task map keyed by `taskId`, folded from `ns://task/progress`.
- `useNotificationStore` — transient toast queue.

**TanStack Query keys (server-state):**
- `['app','info']` → `ipc.app.info()`
- `['app','health']` → `ipc.app.health()`
- `['settings']` → `ipc.settings.get()` (mutation `ipc.settings.update` invalidates it)
- `['tasks', connectionId ?? 'all']` → `ipc.tasks.list({connectionId})` (folded from `ns://task/progress`, not polled)

**IPC client calls (generated wrappers in `packages/ns-bindings`):** `ipc.app.info()`, `ipc.app.health()`, `ipc.settings.get()`, `ipc.settings.update(patch)`, `ipc.tasks.list(req)`, `ipc.tasks.cancel(taskId)`, `ipc.app.logReport(req)`, `ipc.app.shutdown()`. All derive from `commands.manifest.ts` pairing each name with its `ns-types` Request/Response so a renamed DTO breaks the TS build.

---

## (f) Data Model

Core-runtime owns **no SQLite tables directly** (`ns-core` has zero SQL — that is `ns-storage`'s monopoly). We own:

- **The `Settings` DTO shape + defaults** (`ns-core::default_settings()`), persisted by `ns-storage`'s `SettingsRepo` into a single-row `settings` table (`user_version`-tracked). We define the *contract*; storage owns the *table DDL* and migrations. `Settings.schema_version` is versioned independently of the SQLite `PRAGMA user_version`; a mismatch triggers a settings-migration pass in storage.
- **In-memory runtime state** (not persisted): `CancellationRegistry` (`DashMap<Uuid, CancellationToken>`), `TaskRegistry` (`DashMap<TaskId, TaskEntry>`), `EventBusHandle` (per-topic `broadcast::Sender` + `AtomicU64` seq counters). All guarded by `DashMap`/`RwLock` — **no global mutable statics**.

DTOs owned (in `ns-types`, frozen): `IpcError`, `ErrorCode`, `EventPayload`, `Topic`, `Event`(internal), `AppInfo`, `AppHealth`, `Settings`, `SettingsPatch`, `TaskProgress`, `TaskSnapshot`, `TaskState`, `Notification`, `NotificationLevel`, `Page<T>`, all newtype IDs.

---

## (g) Dependencies

**We depend on (Cargo):**
- `ns-types`: nothing (leaf).
- `ns-core`: `ns-types` + `tokio-util` (CancellationToken), `dashmap`, `async-trait`, `time`, `uuid`, `thiserror`, `serde`.
- `ns-event`: `ns-types`, `ns-core` + `tokio` (broadcast/mpsc).

**Depends on us (everyone):** every L1/L2/L3 crate and the bin depend on `ns-types` + `ns-core`; every service depends on `ns-event`. We are the base of the layer graph.

**Subsystem collaboration points:**
- [connection-manager] `ns-connection` uses our `TaskRegistry` for reconnection loops and our `EventPublisher` for status events.
- [tauri-shell] `ns-ipc` translates our `IpcError`/`EventPayload`; the bin uses our `ShutdownController`, `AppState` shape, and `TaskRegistry`.
- [storage] implements our `SettingsRepo` + other repo ports.
- [account-security] implements our `SecretStore` port + consumes `Redacted<T>`.
- [logging-observability] `ns-telemetry` consumes our `Clock`, `correlation_id` convention, and receives `log_report`.

---

## (h) Concurrency / Async & Backpressure

- **Single shared tokio multi-thread runtime**, created by Tauri in the bin. Core-runtime never spawns its own runtime; it spawns *tasks* onto the ambient runtime via `tokio::spawn` inside `TaskRegistry`.
- **Never block the UI thread.** Every command is `async`; CPU-heavy work (codec/serde on large payloads) is offloaded with `spawn_blocking` by the owning feature crate — core provides the pattern, not the offload.
- **Cancellation is structural.** Root `ShutdownController` token → child tokens per task. `CancellationRegistry` maps UI ids to tokens for request-scoped streams; `TaskRegistry` holds tokens for background jobs. Channel-drop watchdogs (in ns-ipc) also trip tokens — no leaked tasks.
- **Bus backpressure (producers never blocked):** `EventPublisher::try_publish` uses non-blocking `try_send`/`broadcast::send`; a full/lagging channel drops per the topic policy rather than awaiting. Per-topic policy table:
  - `MetricsTick` → keep-latest per `(connectionId, metric)` within a 250ms coalesce window.
  - `ConnectionStatus` → dedupe consecutive identical states; always deliver transitions.
  - `SubjectActivity` → rate-limit N/s per connection; aggregate + surface `dropped`.
  - `Log` → bounded ring, drop-oldest, surface `truncated`.
  - `TaskProgress` → keep-latest per `taskId`.
  - `Notification` → never drop (unbounded-ish, bounded by a high cap with backpressure-to-caller as last resort).
- **Monotonic `seq` per topic** via `AtomicU64` so a lagging `broadcast::Receiver` (`Lagged(n)`) yields a detectable gap; the bridge emits a synthetic "n dropped" and the UI shows a gap indicator.
- **Task supervision:** `Supervision::Restart { max_restarts, backoff }` restarts a failed task body with exponential backoff + jitter, emitting `TaskProgress{state: Failed}` then a fresh `Running`; exceeding `max_restarts` emits a terminal `Failed` + a `Notification{level: Error}`.
- **Graceful shutdown deadline:** `TaskRegistry::shutdown(grace)` cancels all tokens then `join` with a timeout; tasks exceeding the grace are detached and logged at `warn`. Default grace from `Settings.task_shutdown_grace_ms` (e.g. 3000ms).
- **`DashMap` over global `RwLock`** for the registries to avoid a single contended lock across all task/cancel operations.

---

## (i) Test Plan

**Unit (headless, no NATS, no Tauri — the payoff of the kernel being pure):**
- `ns-types`: serde round-trip golden tests for every DTO (camelCase, adjacently-tagged enum shape); `IpcError`/`EventPayload` snapshot tests; `typeshare` output committed + CI `gen:types && git diff --exit-code`.
- `ns-core`:
  - `Redacted<T>` never prints the secret via `Debug`/`Display`/`format!` (property test over arbitrary strings including seed-like values).
  - `DomainError` contract: a test harness enum implementing it; assert `code/retriable/user_message` mapping and that `user_message` is secret-free.
  - `CancellationToken` child propagation; `CancellationRegistry` register/cancel/remove/cancel_all.
  - `TaskRegistry`: spawn → cancel mid-run (task observes `cancelled()`); progress throttling; `snapshot` filtering by connection; `shutdown(grace)` joins within deadline and detaches stragglers (use `MockClock` + `tokio::time::pause`).
  - `Supervision::Restart`: inject a body that fails N times, assert restart count, backoff timing (paused clock), terminal `Failed` after `max_restarts`.
- `ns-event`:
  - seq monotonicity per topic under concurrent publish (loom or high-concurrency stress).
  - policy: coalescing keeps-latest within window; dedupe transitions; ring drop-oldest surfaces `truncated`; `never drop` for notifications.
  - producer-never-blocked: fill a slow receiver, assert `try_publish` returns immediately and increments a drop counter.
  - `Lagged(n)` surfaced correctly to a subscriber.

**Integration (crate boundaries, using `ns-testkit` mocks):**
- `settings_update` end-to-end against a mock `SettingsRepo`: patch merge, persistence, change-signal emission, `EnvFilter` re-apply hook fires.
- `TaskRegistry` + `BusPublisher`: spawn a task that reports progress → assert `TaskProgress` events land on the bus with correct topic/coalescing.
- `ShutdownController.run`: assemble a fake `AppStateInner` with tasks + registries, trip shutdown, assert drain order and that all tokens are cancelled and joins complete.

**E2E (through Tauri, requires `nats-server` for downstream but core commands don't):**
- Boot the app in a headless Tauri test harness; call `app_info`/`app_health`/`settings_get`; assert DTO shapes match the generated TS types.
- Drive `GlobalTaskTray`: start a long background job (mock), observe `ns://task/progress` in the WebView, click cancel → `task_cancel` → task ends with `Cancelled`.
- Kill-switch: trigger `app_shutdown`, assert clean process exit within grace and tracing appender flushed (no lost final log line).

**CI gates:** `cargo xtask check-layers` (no upward deps, ns-core/ns-types import no adapters), `cargo-deny` (bans `tauri`/`async-nats`/`rusqlite` from ns-core/ns-types), `gen:types` drift check, clippy `-D warnings`, `cargo test --workspace` on the pinned stable toolchain.

---

## (j) Risks & Open Questions

**Risks**
1. **Frozen-interface churn.** `ns-types` breaking changes ripple to every crate + the TS bindings. Mitigation: additive-only by default, ADR + `appSchemaVersion` bump for breaks, CI drift check. *Highest-leverage risk in the whole product.*
2. **`Page<T>` generics under typeshare.** typeshare's weak generics may emit awkward TS. Mitigation: monomorphize (`StreamPage`, `MessagePage`) where it emits poorly; keep `Page<T>` only where clean (per ADR-0005).
3. **Bus lag / silent drops.** Aggressive coalescing could hide meaningful transitions. Mitigation: `ConnectionStatus`/`Notification` are never-coalesced/never-dropped; `seq` gap indicators make drops visible rather than silent.
4. **Task supervision restart storms.** A permanently-failing body could thrash. Mitigation: `max_restarts` cap + backoff + terminal `Failed` notification; consider a circuit-breaker window.
5. **Shutdown stragglers.** A task ignoring its token blocks clean exit. Mitigation: hard grace deadline + detach + `warn`; audit each feature task for `select!` on `token.cancelled()`.
6. **`Redacted<T>` leakage via `serde`.** A secret accidentally placed in a serializable DTO. Mitigation: `Redacted<T>` is *not* `Serialize`; scrubber on the log path as defense-in-depth; secrets live only in `ns-security`/keychain, never in `ns-types`.

**Open questions**
1. Should `AppHealth` aggregate *live* subsystem probes (each service exposes a `health()`), or a cheap cached status? Leaning: cheap cached + on-demand deep probe param.
2. Do we need a **priority** dimension on `TaskRegistry` (interactive replay vs background poll) for fair scheduling, or is tokio's scheduler enough? Defer until we see contention.
3. Where does the **command dispatch metrics** (per-command latency/error-rate) live — a thin middleware in `ns-ipc` or a `TaskRegistry`-style instrument here? Proposal: `#[instrument]` + a tracing metrics layer in `ns-telemetry`, core defines the span-field convention only.
4. Multi-window: `TaskRegistry` snapshots are global; should `task_list`/tray be scoped per window's active connection only? Current design filters by `connectionId`; confirm with [frontend-shell].
5. Settings hot-reload fan-out — is a dedicated `Topic::SettingsChanged` event warranted, or reuse `Notification` + query invalidation? Proposal: add a `SettingsChanged` payload variant (small ADR) for precise subscriber re-read.
6. `plugin_api_version` surfacing in `AppInfo` — owned value comes from [plugin-architecture]; confirm the constant source (compile-time from `ns-plugin`).
