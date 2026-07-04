# Subsystem Design — `[tauri-shell]`

> Owner: Tauri Team (lead). Crates owned: **`ns-ipc`** (L3) and **`nats-studio`** (L4 bin, `apps/desktop/src-tauri`). Also owns the Tauri **capabilities/permissions** files, `tauri.conf.json`, native shell integration (menu/tray/dialogs/notifications/deep-link/single-instance), and the **auto-updater** wiring.
>
> This document is the implementation contract for the shell. It is subordinate to `docs/architecture/00-conventions-and-workspace.md` (the spine) and must never contradict it. Where the spine defines a name (`AppState`, `EventBridge`, `IpcError`, `ns://…` event names, per-topic backpressure), this doc reuses it verbatim.

---

## 1. Responsibilities & Boundaries

### 1.1 What the shell IS
The tauri-shell is the **only** place in the system that knows it is running inside Tauri. It is the *composition root* and the *IPC/OS boundary*. Concretely it owns:

1. **The typed IPC boundary.** Every `#[tauri::command]` is registered here (bin), and the glue that makes commands uniform — argument extraction, a per-call `Ctx`, `AppError → IpcError` mapping, panic catching, correlation-id propagation — lives in `ns-ipc`.
2. **Streaming Rust → UI.** Both mechanisms: request-scoped `tauri::ipc::Channel<T>` helpers (with cancellation + drop-detection watchdog + bounded backpressure), and the ambient `EventBridge` that is the *sole* translator from the internal `ns-event` bus to Tauri `emit`/`emit_to`.
3. **Composition / DI.** `main.rs` constructs adapters, injects ports into services, assembles `AppState`, starts the runtime, registers commands, starts the bridge.
4. **Native OS surface.** Native application menu, system tray/menubar, OS notifications, file open/save dialogs, multi-window lifecycle, deep-link (`nats-studio://`) handling, single-instance enforcement.
5. **Lifecycle & update.** Tauri v2 updater (check/download/install, signed manifests, stable/beta channels), single-instance plugin, startup/shutdown orchestration, graceful cancellation of all tasks on exit.
6. **The capability/permission manifest.** Per-window capability files that gate which commands & core plugins each window may call (least privilege), plus the strict CSP.

### 1.2 What the shell is NOT (hard boundaries)
- **No business logic.** The shell never talks to NATS, SQL, keychain, PTY, or HTTP monitoring directly. It calls into `Arc<dyn XxxService>` ports only. Any temptation to "just call async-nats here" is a layering violation (CI-enforced by `xtask check-layers`).
- **No domain events invented here.** Feature crates emit domain events onto the bus via the `EventPublisher` port; the shell only *bridges* them. The shell may originate a small set of *shell-native* events (window/update/deep-link/tray) — see §5.3 — but those still flow through the same bus so the bridge remains the single emit surface.
- **No DTO definitions.** All request/response/event DTOs live in `ns-types`. `ns-ipc` defines exactly one wire type of its own concern — nothing; even `IpcError` lives in `ns-types`. `ns-ipc` owns the *mapping* (`to_ipc_error`) and the *aggregate* `AppError`, which is internal and never serialized.
- **`tauri` import is confined** to `ns-ipc` and the bin (spine rule §7, ADR-0007). No feature crate imports `tauri`.

### 1.3 Boundary diagram
```
        React (WebView)  ── invoke() / Channel / listen('ns://…')
                │  (the ONLY trust boundary)
   ┌────────────┴─────────────────────────────────────────┐
   │  nats-studio (bin, L4)                                │
   │   • command registry  • Tauri plugins  • windows/menu │
   │   • updater  • deep-link  • single-instance           │
   │            uses ↓                                     │
   │  ns-ipc (L3): Ctx, AppError→IpcError, Channel helpers, │
   │              CancellationRegistry, TaskRegistry,       │
   │              EventBridge (bus→Tauri)                    │
   └────────────┬─────────────────────────────────────────┘
                │ Arc<dyn Service> ports  +  EventBus handle
   ┌────────────┴─────────────────────────────────────────┐
   │  L2 feature services (connection/pubsub/jetstream/…)   │
   │  L1 adapters (ns-nats, ns-storage, ns-security …)      │
   └───────────────────────────────────────────────────────┘
```

---

## 2. Crate `ns-ipc` — Public Rust Interface

`ns-ipc` depends only on `ns-types`, `ns-core`, `ns-event`, `tauri`. It exposes the reusable machinery that the bin's command modules consume.

### 2.1 Error mapping

```rust
// ns-ipc/src/error.rs
use ns_core::DomainError;
use ns_types::{ErrorCode, IpcError};

/// Aggregate internal error at the command boundary. Wraps every subsystem
/// error via #[from]. NEVER serialized directly — always via `to_ipc_error`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)] Connection(#[from] ns_connection::ConnectionError),
    #[error(transparent)] PubSub(#[from] ns_pubsub::PubSubError),
    #[error(transparent)] JetStream(#[from] ns_jetstream::JetStreamError),
    #[error(transparent)] Monitor(#[from] ns_monitor::MonitorError),
    #[error(transparent)] Subject(#[from] ns_subject::SubjectError),
    #[error(transparent)] Inspector(#[from] ns_inspector::InspectorError),
    #[error(transparent)] Terminal(#[from] ns_terminal::TerminalError),
    #[error(transparent)] Security(#[from] ns_security::SecurityError),
    #[error(transparent)] Storage(#[from] ns_storage::StorageError),
    #[error(transparent)] Plugin(#[from] ns_plugin::PluginError),
    /// Shell-native failures: window/dialog/update/deep-link/menu.
    #[error(transparent)] Shell(#[from] ShellError),
    /// A cancelled operation (token tripped).
    #[error("operation cancelled")] Cancelled,
}

impl DomainError for AppError {
    fn code(&self) -> ErrorCode { /* delegate to wrapped error's .code() */ }
    fn retriable(&self) -> bool { /* delegate */ }
    fn user_message(&self) -> String { /* delegate, secret-safe */ }
}

/// The SINGLE serialization surface (spine §7). Walks the std::error::Error
/// source() chain, applies redaction, attaches the current tracing span's
/// correlation_id, and produces the stable wire DTO.
pub fn to_ipc_error(err: &AppError) -> IpcError;
```

```rust
// ns-ipc/src/shell_error.rs
#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("window not found: {0}")] WindowNotFound(String),
    #[error("dialog cancelled by user")] DialogCancelled,
    #[error("update check failed: {0}")] UpdateCheck(String),
    #[error("update install failed: {0}")] UpdateInstall(String),
    #[error("deep link rejected: {0}")] DeepLinkRejected(String),
    #[error("capability denied for command {0}")] CapabilityDenied(String),
    #[error("shell io: {0}")] Io(#[from] std::io::Error),
}
// Maps to ErrorCode::INTERNAL / INVALID_ARGUMENT / CANCELLED as appropriate.
```

### 2.2 Command context & the `command!` uniformity helper

Every command needs: the `AppState`, the current `AppHandle`/`Window`, a correlation id, and a tracing span. `Ctx` bundles this so command bodies stay thin.

```rust
// ns-ipc/src/ctx.rs
pub struct Ctx<'a> {
    pub state: &'a AppStateRef,      // opaque handle to the service registry
    pub app: tauri::AppHandle,
    pub window: tauri::Window,
    pub correlation_id: CorrelationId, // uuid v7, also set as a span field
}

impl<'a> Ctx<'a> {
    pub fn span(&self) -> tracing::Span;                 // #[instrument]-ready
    pub fn cancels(&self) -> &CancellationRegistry;
    pub fn tasks(&self) -> &TaskRegistry;
    pub fn events(&self) -> &ns_event::EventBus;
}

/// Wrap a command body: opens a correlated span, catches panics
/// (AssertUnwindSafe + catch_unwind) → ErrorCode::INTERNAL, maps AppError.
pub async fn run_command<T, F, Fut>(ctx: Ctx<'_>, f: F) -> Result<T, IpcError>
where F: FnOnce(Ctx<'_>) -> Fut, Fut: Future<Output = Result<T, AppError>>;
```

> The bin's `AppState` (defined in the bin per spine §10.1) is exposed to `ns-ipc` behind a small `AppStateRef` trait object so `ns-ipc` does not need to depend on every service crate at the *type* level for `Ctx` — but note `AppError` does need the concrete error enums, so `ns-ipc` gains dev-cheap `#[from]` deps on the L2 crates' *error* types only (their errors are in-crate, no async-nats leakage). This is the one place `ns-ipc`'s dependency set is broader than `{ns-types,ns-core,ns-event}` and it is intentional and documented in ADR reference below.

### 2.3 Streaming helpers (Channels)

```rust
// ns-ipc/src/stream.rs
use tauri::ipc::Channel;

/// A stream event envelope: every request-scoped Channel<T> carries one of
/// these variants so partial streams can report why they ended (spine §8.4).
#[typeshare] #[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum StreamEvent<T> {
    Ready { subscription_id: String },   // first frame: id handshake
    Item(T),                             // a data frame
    Dropped { dropped_since_last: u64 }, // backpressure marker
    Error(IpcError),                     // terminal: stream ended with error
    Done,                                // terminal: stream ended normally
}

pub struct StreamOpts {
    pub buffer: usize,                   // bounded mpsc capacity
    pub policy: BackpressurePolicy,      // SampleAndCount | PreserveOrderOverflow
}

/// Spawn a cancellable pump: registers a CancellationToken under `id`,
/// installs a Channel drop-watchdog, pumps a bounded mpsc → Channel applying
/// `policy`, and guarantees the token is tripped + task deregistered on exit.
pub fn spawn_stream<T, S>(
    ctx: &Ctx<'_>,
    id: SubscriptionId,
    channel: Channel<StreamEvent<T>>,
    source: S,                           // impl Stream<Item = Result<T, AppError>>
    opts: StreamOpts,
) -> Result<(), AppError>
where T: Serialize + Send + 'static, S: Stream + Send + 'static;

pub enum BackpressurePolicy {
    /// High-rate: keep newest, count skipped, emit Dropped periodically.
    SampleAndCount { max_in_flight: usize },
    /// Terminal/log: bounded FIFO, preserve order, single overflow marker.
    PreserveOrderOverflow,
}
```

The **drop-watchdog**: `Channel` exposes no direct "closed" signal, so `spawn_stream` races the pump against a periodic liveness probe — every emit result is checked; a failed emit (WebView dropped the channel / view unmounted) trips the token and stops the task. Additionally the companion `*_unsubscribe`/`*_cancel` command trips the same token synchronously. Both paths converge on one cleanup closure (deregister from `CancellationRegistry` + `TaskRegistry`).

### 2.4 Cancellation & task registries

```rust
// ns-ipc/src/cancel.rs
#[derive(Clone, Default)]
pub struct CancellationRegistry { /* DashMap<StreamId, CancellationToken> */ }
impl CancellationRegistry {
    pub fn register(&self, id: StreamId) -> CancellationToken;
    pub fn cancel(&self, id: &StreamId) -> bool;   // true if existed
    pub fn cancel_all_for_connection(&self, c: &ConnectionId) -> usize;
    pub fn remove(&self, id: &StreamId);
}

// ns-ipc/src/tasks.rs
#[derive(Clone, Default)]
pub struct TaskRegistry { /* DashMap<TaskId, JoinHandle<()> + meta> */ }
impl TaskRegistry {
    pub fn spawn(&self, meta: TaskMeta, fut: impl Future<Output=()> + Send + 'static) -> TaskId;
    pub fn abort(&self, id: &TaskId) -> bool;
    pub async fn shutdown(&self, grace: Duration);  // cooperative cancel then abort
    pub fn snapshot(&self) -> Vec<TaskMeta>;        // for diagnostics / app_list_tasks
}
```
`StreamId` is the newtype over `SubscriptionId`/`SessionId` (from `ns-types`). On connection close, `cancel_all_for_connection` guarantees no orphaned subscriptions/replays/samplers survive (ADR-0018).

### 2.5 The EventBridge

```rust
// ns-ipc/src/bridge.rs
pub struct EventBridge {
    app: tauri::AppHandle,
    bus: ns_event::EventBus,
    windows: WindowConnectionIndex,      // window <-> open connectionIds
    policies: BackpressureTable,         // per-topic (spine §9.4)
}

impl EventBridge {
    pub fn new(app: tauri::AppHandle, bus: EventBus) -> Self;

    /// Subscribe to the bus and run the forward loop on a dedicated task.
    /// The ONLY component allowed to call AppHandle::emit/emit_to.
    pub fn start(self, tasks: &TaskRegistry) -> BridgeHandle;

    /// Register/unregister which connectionIds a window observes, so
    /// connection-scoped events are emitted only to interested windows.
    pub fn bind_window(&self, window: &str, conn: ConnectionId);
    pub fn unbind_window(&self, window: &str, conn: ConnectionId);
}
```

Forward loop responsibilities (spine §9.3–9.4):
- **Coalescing**: `MetricsTick` keep-latest per `(connectionId, metric)` on a 250 ms flush timer; `TaskProgress` keep-latest per task id; `ConnectionStatusChanged` dedupe consecutive identical states.
- **Rate-limit / ring**: `SubjectActivity` token-bucket per connection with a `dropped` count; `LogEmitted` bounded ring drop-oldest with `truncated`.
- **Lag handling**: on `broadcast::error::RecvError::Lagged(n)` emit a synthetic `ns://notification` "n events dropped" gap indicator; never block producers.
- **Window scoping**: connection-scoped payloads → `emit_to` each window in `WindowConnectionIndex`; global payloads (`Notification`, app updates) → `emit` to all.
- **Tauri event name mapping**: `EventPayload` variant → `ns://…` name via a single exhaustive `match` (compile-time total, so a new variant forces a decision).

### 2.6 Native shell services (traits, implemented in bin)
`ns-ipc` declares thin **ports** for the OS surface so command modules stay testable and the bin provides the real Tauri-backed impls.

```rust
// ns-ipc/src/shell_ports.rs
#[async_trait]
pub trait DialogPort: Send + Sync {
    async fn open_file(&self, req: OpenFileRequest) -> Result<Option<Vec<PathBuf>>, ShellError>;
    async fn save_file(&self, req: SaveFileRequest) -> Result<Option<PathBuf>, ShellError>;
    async fn message(&self, req: MessageDialogRequest) -> Result<bool, ShellError>;
}
#[async_trait]
pub trait NotificationPort: Send + Sync {
    async fn notify(&self, req: NotifyRequest) -> Result<(), ShellError>;
}
#[async_trait]
pub trait WindowPort: Send + Sync {
    async fn open(&self, req: OpenWindowRequest) -> Result<WindowId, ShellError>;
    async fn close(&self, id: &WindowId) -> Result<(), ShellError>;
    async fn list(&self) -> Result<Vec<WindowInfoDto>, ShellError>;
    async fn set_title(&self, id: &WindowId, title: String) -> Result<(), ShellError>;
}
#[async_trait]
pub trait UpdatePort: Send + Sync {
    async fn check(&self, channel: ReleaseChannel) -> Result<UpdateStatusDto, ShellError>;
    async fn download_and_install(&self, ch: Channel<StreamEvent<UpdateProgressDto>>)
        -> Result<(), ShellError>;
}
```

---

## 3. Bin `nats-studio` — Composition Root

### 3.1 `main.rs` sequence
```rust
fn main() {
    // 1. tracing-subscriber layers FIRST (ns-telemetry), before AppState (spine §12).
    let _guard = ns_telemetry::init(TelemetryConfig::from_env_and_settings());

    // 2. Build the Tauri app.
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(on_second_instance))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            // 3. Async setup on the tokio runtime.
            let state = build_app_state(app)?;   // adapters → services → registry
            let bus   = state.events.clone();
            app.manage(state);
            // 4. Start the EventBridge (only emit surface).
            EventBridge::new(app.handle().clone(), bus).start(&tasks);
            // 5. Native surface: menu, tray, deep-link handler.
            install_menu(app)?; install_tray(app)?; register_deep_link(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ /* every command, §4 */ ])
        .on_window_event(handle_window_event) // drop-detection, close → cancel
        .build(tauri::generate_context!())
        .expect("error building app")
        .run(handle_run_event);               // ExitRequested → graceful shutdown
}
```

`build_app_state` (composition, spine §10.1): construct `SqliteStorage` (ns-storage), `AsyncNatsFactory` (ns-nats), `KeychainSecretStore` (ns-security), the `EventBus` (ns-event) → inject as ports into each L2 service → build `AppState`. Services are wrapped so **lazy init** holds (terminal/plugins spin up on first command).

### 3.2 Command module layout
```
apps/desktop/src-tauri/src/
  main.rs            // sequence above
  state.rs           // AppState (spine §10.1)
  bridge.rs          // EventBridge wiring + WindowConnectionIndex maintenance
  menu.rs            // native app menu + accelerators
  tray.rs            // system tray / menubar
  deeplink.rs        // nats-studio:// parsing + routing
  update.rs          // UpdatePort impl over tauri-plugin-updater
  windows.rs         // WindowPort impl, multi-window mgmt
  shell_impls.rs     // Dialog/Notification port impls (tauri plugins)
  commands/
    app.rs           // app_info, app_list_tasks, app_check_update, window_* …
    connection.rs    // connection_* (thin: delegate to ConnectionService)
    pubsub.rs        // pubsub_* (incl. Channel subscribe)
    jetstream.rs     // jetstream_*, kv_*, objectstore_*
    monitor.rs       // monitor_*
    subject.rs       // subject_*
    inspector.rs     // inspector_*
    terminal.rs      // terminal_* (Channel)
    security.rs      // security_*
    storage.rs       // storage_*, settings_*, layout_*
    plugin.rs        // plugin_*
    dashboard.rs     // dashboard_*
```
> Each feature team authors the *body* of its own subsystem's commands, but the shell owns the **registration list**, the `Ctx`/`run_command` wrapper convention, and the capability manifest that gates them. This doc specifies the *shell-owned* commands (`app_*`, `window_*`, `update_*`, `deeplink_*`, `menu_*`) in full and the *cross-cutting streaming/error contract* every other command must follow.

---

## 4. IPC Command Surface

Every command: `async fn name(req: XxxRequest, /* maybe on_event: Channel<…> */, state, window, app) -> Result<XxxResponse, IpcError>`, wrapped by `run_command`. Below, the **shell-owned** commands are specified fully; cross-subsystem commands are listed as the contract the shell enforces (their DTOs are owned by the respective team but registered here).

### 4.1 Shell-owned commands (`app_*`, `window_*`, `update_*`, `deeplink_*`, `menu_*`)

| Command | Kind | Request | Returns | Errors (ErrorCode) |
|---|---|---|---|---|
| `app_info` | request | `()` | `AppInfoDto { version, appSchemaVersion, pluginApiRange, os, arch, buildChannel }` | — |
| `app_list_tasks` | request | `()` | `Vec<TaskMetaDto>` | — |
| `app_cancel` | command | `CancelRequest { id }` | `CancelResponse { cancelled: bool }` | `INVALID_ARGUMENT` |
| `app_log_report` | command | `LogReportRequest { level, message, context }` | `()` | — (forwards FE errors into tracing) |
| `app_export_diagnostics` | request | `DiagnosticsRequest { includeSettings }` | `DiagnosticsBundleDto { path }` | `IO`, `INTERNAL` |
| `window_open` | command | `OpenWindowRequest { kind, connectionId?, route? }` | `WindowInfoDto` | `INTERNAL` |
| `window_close` | command | `CloseWindowRequest { windowId }` | `()` | `NOT_FOUND` |
| `window_list` | request | `()` | `Vec<WindowInfoDto>` | — |
| `window_set_title` | command | `SetTitleRequest { windowId, title }` | `()` | `NOT_FOUND` |
| `window_bind_connection` | command | `BindConnectionRequest { windowId, connectionId }` | `()` | `NOT_FOUND` |
| `window_unbind_connection` | command | `BindConnectionRequest` | `()` | `NOT_FOUND` |
| `dialog_open_file` | request | `OpenFileRequest { title?, filters, multiple, directory }` | `OpenFileResponse { paths: string[] }` (empty = cancelled) | `INTERNAL` |
| `dialog_save_file` | request | `SaveFileRequest { title?, defaultPath?, filters }` | `SaveFileResponse { path? }` | `INTERNAL` |
| `dialog_message` | request | `MessageDialogRequest { title, message, kind, buttons }` | `MessageDialogResponse { confirmed }` | — |
| `notify` | command | `NotifyRequest { title, body, urgency? }` | `()` | `INTERNAL` |
| `update_check` | request | `UpdateCheckRequest { channel }` | `UpdateStatusDto { available, version?, notes?, date? }` | `INTERNAL` |
| `update_install` | **stream** | `UpdateInstallRequest {}` + `Channel<StreamEvent<UpdateProgressDto>>` | `()` (progress on channel; app relaunches on success) | `INTERNAL` |
| `deeplink_current` | request | `()` | `Option<DeepLinkDto>` | — (last unhandled deep link, for cold-start) |

**Deep-link routing** is push, not pull, in the steady state: an incoming `nats-studio://…` URL is parsed in `deeplink.rs`, validated against an allowlist of intents (`connect?profile=…`, `open?stream=…`, `import?…`), published on the bus as a `Notification`/custom shell event, and bridged to `ns://deeplink`. `deeplink_current` exists only to drain a URL that arrived before the WebView was listening (cold start / second instance).

### 4.2 Cross-subsystem commands (registered by shell, bodies owned by teams)
The shell registers and capability-gates these; it does not define their DTOs. Full list mirrors spine §8.1. Representative subset with the streaming/cancel contract the shell enforces:

| Command | Kind | Cancel companion | Channel event type |
|---|---|---|---|
| `connection_connect` / `_disconnect` / `_list` / `_status` | request/command | — | — |
| `pubsub_publish` | command | — | — |
| `pubsub_subscribe` | **stream** | `pubsub_unsubscribe { subscriptionId }` | `StreamEvent<SubMessageDto>` |
| `pubsub_request` | request | — | — |
| `jetstream_list_streams` / `_get_stream` / `_create_stream` … | request/command | — | — |
| `jetstream_replay` | **stream** | `jetstream_replay_cancel { subscriptionId }` | `StreamEvent<ReplayMessageDto>` |
| `kv_*` / `objectstore_*` | request/command | — | — |
| `monitor_get_varz` / `_connz` / `_jsz` … | request | — | — |
| `monitor_watch` | **stream** | `monitor_unwatch { subscriptionId }` | (usually via bridged `ns://monitor/metrics` instead) |
| `subject_sample_start` | **stream** | `subject_sample_stop { subscriptionId }` | `StreamEvent<SubjectSampleDto>` |
| `terminal_open` | **stream** | `terminal_close { sessionId }` | `StreamEvent<TerminalChunkDto>` |
| `terminal_write` | command | — | — |
| `security_*`, `storage_*`, `settings_*`, `layout_*`, `plugin_*`, `dashboard_*` | request/command | — | — |

**Enforced contract for every `stream` command:**
1. Returns immediately with a `Ready { subscriptionId }` first frame on the channel and the id in the command result DTO.
2. Registers its token in `CancellationRegistry` keyed by that id.
3. Uses `spawn_stream` (bounded buffer, declared `BackpressurePolicy`).
4. Has a companion `*_unsubscribe`/`*_cancel`/`*_stop`/`*_close`/`*_unwatch` command.
5. Terminal frames are `Error(IpcError)` or `Done` — never a silent hang.

---

## 5. Events Emitted

### 5.1 Bridged domain events (from bus, spine §9.2)
The shell (via `EventBridge`) is the sole emitter of:
`ns://connection/status`, `ns://server/info`, `ns://monitor/metrics`, `ns://jetstream/stream`, `ns://jetstream/consumer-lag`, `ns://subject/activity`, `ns://log`, `ns://task/progress`, `ns://notification`, `ns://plugin`. Payloads are the typeshared `EventPayload` variant `data`.

### 5.2 Shell-native events (also routed through the bus → bridge)
| Tauri event | Payload | Trigger |
|---|---|---|
| `ns://update/status` | `UpdateStatusDto` | updater check result / channel change |
| `ns://update/progress` | `UpdateProgressDto` | (also on the install Channel; event mirrors for other windows) |
| `ns://deeplink` | `DeepLinkDto { intent, params }` | incoming `nats-studio://` URL |
| `ns://window/lifecycle` | `WindowLifecycleDto { windowId, event }` | open/close/focus/blur |
| `ns://menu/action` | `MenuActionDto { id }` | native menu item / accelerator invoked |
| `ns://tray/action` | `TrayActionDto { id }` | tray menu item / click |
| `ns://app/quit-requested` | `QuitRequestedDto { reason }` | user/OS requested quit → FE can veto with unsaved buffers |

These originate in the shell but are published onto the `ns-event` bus as `Notification`/a dedicated `ShellEvent` payload so the bridge stays the single emit path (no ad-hoc `emit` scattered in `menu.rs`/`tray.rs`). A thin `ShellEventPublisher` (holds the `EventBus`) is what `menu.rs`/`tray.rs`/`deeplink.rs`/`update.rs` call.

### 5.3 Window scoping rule
Connection-scoped events (`connection/status`, `monitor/metrics`, `jetstream/*`, `subject/activity`) are emitted only to windows bound to that `connectionId` (via `window_bind_connection`). Global events (`notification`, `update/*`, `log`) go to all windows.

---

## 6. Frontend Surface (shell slice)

The shell team owns the **app shell** (`src/app/*`) and the IPC/event plumbing (`src/ipc/*`), not the feature panels.

### 6.1 Routes (React Router)
Top-level shell routes; feature teams mount subtrees:
```
/                         → Dashboard (dashboard team)
/connections              → Connection Manager
/connection/:id/pubsub    → Pub/Sub
/connection/:id/jetstream → JetStream
/connection/:id/monitor   → Monitoring
/connection/:id/subjects  → Subject Explorer
/connection/:id/terminal  → Terminal
/settings                 → Settings (shell-adjacent)
/logs                     → Logs view
```
Workspace composition inside a route is **dockview** panels (ADR-0012), driven by Zustand + persisted layout — not the router.

### 6.2 Shell-owned components
- `AppShell` — dockview host, native-feel title bar region, global command palette mount.
- `useAppEvents()` — the single hook that `listen()`s to all `ns://…` events and routes each to `queryClient.setQueryData`/`invalidateQueries` or the right Zustand slice (spine §10.2). One subscription per event name, set up once at shell mount, torn down on unmount.
- `useStreamChannel<T>(open, opts)` — generic hook wrapping a `Channel<StreamEvent<T>>`: owns the channel, folds `Item` frames, surfaces `Dropped`/`Error`/`Done`, and **cancels on unmount** by calling the companion `*_cancel` command. Used by subscribe/replay/terminal/sample views.
- `UpdateBanner` — listens `ns://update/status`, drives `update_install` stream, shows progress + relaunch prompt.
- `Notifications` — toast host fed by `ns://notification`.
- `WindowMenuBar` (Windows/Linux) / native menu (macOS) glue; `useMenuActions()` maps `ns://menu/action` ids to route/command dispatch.
- `DeepLinkHandler` — on mount reads `deeplink_current`, then listens `ns://deeplink`; routes intents.
- `ConnectionGapIndicator` — reads the synthetic "n dropped" notifications + per-topic `seq` gaps to show staleness.

### 6.3 Zustand stores (UI/session only — never server-state)
| Store | Slice |
|---|---|
| `useLayoutStore` | dockview layout JSON per window, panel sizes, active tab; **mirror** of SQLite `layout_*` |
| `useSessionStore` | active connection selection, open tabs, focused window id |
| `useUiPrefsStore` | theme, density, telemetry opt-in mirror; **mirror** of `settings_*` |
| `useCommandPaletteStore` | palette open state, recent actions |
| `useUpdateStore` | update availability + install progress (ephemeral UI) |
| `useNotificationStore` | in-app toast queue |
| `useStreamRegistryStore` | active subscription/session ids owned by this window (for cleanup/debug) |

Persisted slices are debounced-synced to SQLite via `layout_*`/`settings_*` mutations; SQLite is the source of truth (spine §10.2).

### 6.4 TanStack Query keys (shell-adjacent)
| Key | Source command |
|---|---|
| `['app','info']` | `app_info` |
| `['app','tasks']` | `app_list_tasks` |
| `['update','status', channel]` | `update_check` |
| `['windows','list']` | `window_list` |
| `['settings', section]` | `settings_get` |
| `['layout', windowId]` | `layout_get` |

### 6.5 Generated IPC client (`packages/ns-bindings`)
Frontend calls only `ipc.app.info()`, `ipc.window.open(req)`, `ipc.update.check(req)`, `ipc.pubsub.subscribe(req, onEvent)`, etc. — generated from `commands.manifest.ts` pairing each command name to its `Request`/`Response` types (spine §8.5). The manifest is co-owned; the shell owns the `app_*`/`window_*`/`update_*`/`dialog_*`/`deeplink_*` entries and the `Channel` wrapper conventions.

---

## 7. Data Model (owned by shell)

The shell owns **no SQLite tables** — persistence is `ns-storage`'s job (only crate with SQL). The shell *defines the DTOs* it needs (in `ns-types`) and *calls* `settings_*`/`layout_*` commands whose repos (`SettingsRepo`, `LayoutRepo`) live in `ns-storage`. The relevant persisted shapes it drives:

- `LayoutRepo` → `layouts(window_kind TEXT, connection_id TEXT?, layout_json TEXT, updated_at)` — dockview layout the shell serializes.
- `SettingsRepo` → `settings(key TEXT PK, value_json TEXT, updated_at)` — includes shell settings: `updater.channel` (`stable|beta`), `updater.autoCheck`, `window.restoreOnStart`, `tray.minimizeToTray`, `deeplink.enabled`, `telemetry.optIn`.

Shell-owned DTOs (in `ns-types`, typeshared, camelCase): `AppInfoDto`, `WindowInfoDto`, `OpenWindowRequest`, `UpdateStatusDto`, `UpdateProgressDto`, `DeepLinkDto`, `MenuActionDto`, `TrayActionDto`, `WindowLifecycleDto`, `TaskMetaDto`, `DiagnosticsBundleDto`, plus the `StreamEvent<T>` envelope and dialog/notify request DTOs. All follow spine serde conventions (adjacently-tagged enums, `fooMs: u64`, base64+encoding for bytes, newtype ids as strings).

---

## 8. Dependencies

**`ns-ipc` depends on:** `ns-types`, `ns-core`, `ns-event`, `tauri`, and (for `AppError` aggregation) the *error enums* of the L2 service crates. It depends on the **port traits** (in `ns-core`) not on service implementations.

**`nats-studio` (bin) depends on:** every crate (composition root) — `ns-ipc` + all L0–L3 crates + Tauri plugins (`tauri-plugin-updater`, `-single-instance`, `-deep-link`, `-dialog`, `-notification`, `-os`).

**Depended on by:** nothing (bin is the top; `ns-ipc` is used only by the bin). Feature teams depend on `ns-ipc` only for the `StreamEvent<T>` envelope type and the streaming/cancel conventions — they do **not** import `tauri`.

**Cross-subsystem runtime dependencies:** the shell wires (does not own) `ConnectionService`, `PubSubService`, `JetStreamService`, `MonitorService`, `SubjectService`, `InspectorService`, `TerminalService`, `SecurityService`, `SettingsService`, `DashboardService`, `PluginHost`, `EventBus`.

---

## 9. Concurrency, Async & Backpressure

1. **Never block the WebView thread.** Every command is `async` and runs on the tokio runtime; the invoke handler returns a future. Any accidentally-blocking service call is the service's bug, but the shell adds a defensive `tokio::time::timeout` wrapper on request-scoped commands (configurable, default from settings) mapping to `ErrorCode::TIMEOUT`.
2. **Bounded everything.** Every Channel pump uses a bounded `mpsc`; every bridged topic has an explicit policy (spine §9.4). No unbounded queue exists between a producer and the WebView. Producers publish to `broadcast`; a slow UI causes `Lagged(n)`, surfaced as a gap indicator, never backpressuring the producer.
3. **Cancellation is total.** Three cancel triggers converge on one token: explicit `*_cancel` command, Channel drop-watchdog (failed emit), and connection close (`cancel_all_for_connection`). Window close (`on_window_event`) cancels all streams owned by that window. App exit (`ExitRequested`) runs `TaskRegistry::shutdown(grace)` — cooperative cancel, then abort after grace.
4. **Panic isolation.** `run_command` catches panics (`catch_unwind`) → `ErrorCode::INTERNAL` + correlation id; the WebView never crashes. Bridge/pump tasks are `catch_unwind`-wrapped and restart-logged.
5. **Coalescing is time-bounded.** `MetricsTick` flush timer (250 ms) ensures at most one frame per `(connectionId, metric)` per tick — CPU flat under metric storms. `TaskProgress` keep-latest per id.
6. **Multi-window fan-out** is O(windows-for-connection), computed from `WindowConnectionIndex` (a `DashMap<ConnectionId, HashSet<WindowLabel>>`), not a global broadcast to all windows.
7. **Startup latency.** Lazy service init keeps cold start fast; the tracing subscriber and single-instance check are the only synchronous pre-window work.

---

## 10. Test Plan

### 10.1 Unit (crate `ns-ipc`, no Tauri runtime)
- **`to_ipc_error`**: table-driven over each `AppError` variant → asserts `code`, `retriable`, redaction (seeds/JWTs/passwords never in `message`/`causes`), and correlation-id attachment. Golden fixtures.
- **`CancellationRegistry` / `TaskRegistry`**: register/cancel/remove idempotency; `cancel_all_for_connection` count; `shutdown` grace→abort semantics (tokio `time` paused).
- **`spawn_stream` policies**: feed a synthetic high-rate `Stream`; assert `SampleAndCount` emits `Dropped { droppedSinceLast }` and preserves newest; assert `PreserveOrderOverflow` preserves order + single overflow marker; assert terminal `Error`/`Done` always emitted.
- **`EventBridge` forward logic** (with a fake `AppHandle` emit sink): MetricsTick coalescing within 250 ms; ConnectionStatus dedupe; SubjectActivity rate-limit + `dropped`; LogEmitted ring drop-oldest; `Lagged(n)` → synthetic gap notification; window-scoping via a stub `WindowConnectionIndex`.
- **`run_command`**: panic → `INTERNAL`; `AppError::Cancelled` → `CANCELLED`; span/correlation propagation.

### 10.2 Integration (bin, `ns-testkit` + mock ports)
- Boot `AppState` with **mock services** (from `ns-testkit`) and a `tauri::test::mock_builder`. Assert every registered command name resolves and returns the declared DTO shape (schema check against generated `types.ts`).
- **Streaming round-trip**: invoke `pubsub_subscribe` with a mock stream source → assert `Ready` first frame, N `Item`s, then `pubsub_unsubscribe` trips the token and yields `Done`; assert `TaskRegistry` empty afterward (no leak).
- **Drop-detection**: drop the Channel receiver → watchdog cancels within one probe interval; assert deregistration.
- **Capability gating**: attempt a command from a window whose capability file excludes it → rejected before body runs (`CapabilityDenied` / Tauri denial).
- **Event bridge e2e (in-proc)**: publish bus events → assert correct `ns://…` emit and payloads via a captured emit sink; verify window scoping with two mock windows bound to different connections.

### 10.3 E2E (real app, WebDriver + real `nats-server`)
Requires the missing prerequisites (`nats-server`, `nats`, `cargo-tauri`) pinned in `tools/versions.toml`.
- **tauri-driver + WebdriverIO**: launch the bundled app against an embedded `nats-server` (ns-testkit fixture). Flows: connect → subscribe (assert live messages render, backpressure `dropped` badge under a publish storm) → unsubscribe (assert no orphan task via `app_list_tasks`).
- **Multi-window**: open a second window (`window_open`), bind a different connection, assert connection-scoped events do not cross windows.
- **Deep link**: invoke `nats-studio://connect?profile=…` via OS handler and via second-instance path; assert routing.
- **Single-instance**: launch twice; assert the second instance focuses the first and forwards its deep link.
- **Auto-update**: point updater at a **local signed test manifest** (fake release server); assert `update_check` availability, `update_install` progress frames, signature verification failure path (tampered manifest → `INTERNAL`, no install).
- **Native menu/tray/dialogs**: driver-triggered menu actions emit `ns://menu/action`; save/open dialogs mocked via Tauri test dialog responder; notification permission path.
- **Crash safety**: force a panic in a mock command → assert WebView stays alive and shows the error toast with a correlation id that matches a log line.

### 10.4 CI gates
- `xtask check-layers` (no `tauri` outside `ns-ipc`+bin; no cycles).
- `pnpm gen:types && git diff --exit-code` (DTO drift).
- `cargo-deny` (licenses/advisories/bans) + `pnpm audit`.
- Capability-manifest lint: every registered command appears in exactly the capability files intended (a custom `xtask verify-capabilities`).

---

## 11. Security (shell-specific)
- **Strict CSP** in `tauri.conf.json`: no remote origins, no `eval`, `connect-src` limited to `ipc:`/`tauri:`; images/styles self-only. WebView loads only bundled assets.
- **Capabilities = least privilege** per window: the main window gets the full command set; a future plugin/preview window gets a reduced capability file. Core-plugin permissions (dialog/notification/updater/deep-link) are explicitly enumerated, not wildcarded.
- **Deep-link allowlist**: only known intents are accepted; unknown schemes/params → `DeepLinkRejected`, logged, never executed. No intent may carry secrets.
- **Updater**: only signed manifests (Tauri v2 updater public key pinned in config); signature failure aborts install. Channels (`stable`/`beta`) select distinct signed manifest URLs. `NS_DISABLE_UPDATER` for dev.
- **Redaction** is enforced at the single `to_ipc_error` surface and defended again by the tracing scrubber; the shell never logs raw request payloads that may contain creds (it logs command name + correlation id + connection id only).
- **No secrets in config** (`tauri.conf.json`, env). Secrets flow through `ns-security` → keychain only.

---

## 12. Risks & Open Questions

**Risks**
1. **Channel drop-detection reliability.** Tauri `Channel` gives no explicit closed signal; we rely on failed-emit + watchdog. If a WebView holds a channel without reading (backpressured JS), we could keep a task alive. Mitigation: bounded buffer + idle-timeout on streams with no downstream ack; needs validation across platforms (WebView2/WKWebView/WebKitGTK).
2. **Multi-window event scoping correctness.** `WindowConnectionIndex` must stay consistent with actual open connections per window; a stale binding leaks events cross-window. Mitigation: bind/unbind tied to window lifecycle + connection close; integration test coverage.
3. **Updater signing key custody / channel config** is owned by deployment-strategy; a misconfig bricks auto-update. Mitigation: e2e test against a local signed manifest; staged rollout on `beta`.
4. **`ns-ipc` depending on L2 error enums** slightly widens the L3 crate's dependency graph. Acceptable (errors are pure, no async-nats/tauri leakage) but must be layer-lint-whitelisted so `check-layers` doesn't flag it.
5. **Panic-catching across async** (`catch_unwind` + `AssertUnwindSafe`) can mask poisoned state. Mitigation: only command bodies (stateless-per-call) are unwound; shared state is behind `Arc`/`DashMap`, not `Mutex` held across `.await` in the caught scope.
6. **Backpressure tuning**: default buffer sizes / rate limits are guesses until profiled under real message storms; expose them as settings and load-test.

**Open questions**
1. **Menu on macOS vs Windows/Linux**: native `NSMenu` vs an in-WebView menubar for a consistent look — do we ship native everywhere (OS-consistent) or a custom title bar with a JS menu (brand-consistent)? Leaning native menu + custom in-window command palette; needs design sign-off.
2. **Tray behavior**: minimize-to-tray default on/off per platform; background connection keep-alive when all windows closed — does the runtime stay alive with an active subscription and only the tray present? Impacts task lifecycle.
3. **Deep-link intents schema** — final allowlist (`connect`, `open`, `import`, `run`?) and whether `import` may reference a filesystem path (security review needed).
4. **Per-window vs per-connection capability scoping** for the future plugin sandbox (ADR-0014 Phase 2 WASM) — how do plugin windows get a reduced command set at runtime, not just build time?
5. **Update UX**: silent background download + prompt-to-relaunch vs explicit user-initiated — coordinate with deployment-strategy and product.
6. **`app_export_diagnostics`** bundle contents & redaction depth — coordinate with logging-observability on what "redacted settings" includes.
