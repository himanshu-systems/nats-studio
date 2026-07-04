# Subsystem Design — Logging & Observability (`[logging-observability]`)

**Owning team:** Logging Team
**Primary crate:** `ns-telemetry` (`crates/ns-telemetry`, L1 lib)
**Subsystem prefix:** `log_*` (IPC), `ns://log`, `ns://task/progress` (events)
**Status:** Design v1 (implementable)

> Conforms to THE ARCHITECTURAL SPINE. No new deps outside the pins (`tracing`, `tracing-subscriber`, `tracing-appender`, `serde`, `time`, `tokio`, `flate2`/`zip` are the only additions and all are standard for this role — see §g for the exact list and justification). `ns-telemetry` is `tauri`-free and `async-nats`-free; all DTOs live in `ns-types`; all events go through the `EventPublisher` port to the bus, and only `ns-ipc::EventBridge` translates them to Tauri events (ADR-0010). SQL lives in `ns-storage` behind a `LogViewRepo` port (ADR-0003/0007).

---

## a) Responsibilities & Boundaries

### In scope (this subsystem owns)
1. **Subscriber assembly (`init_telemetry`)** — build the layered `tracing-subscriber` stack at the very start of `main`, *before* `AppState` (per the spine's logging conventions):
   1. `fmt` layer → rolling file via `tracing-appender` (non-blocking, daily rotation), JSON **and** pretty variants selectable, in `{appDataDir}/logs/`.
   2. **In-app ring-buffer layer** (`RingBufferLayer`) → bounded ring + `tokio::broadcast` fan-out that feeds the live Logs view and the `ns://log` ambient event.
   3. **`EnvFilter` behind a `reload::Handle`** for **runtime log-level control** (default `info`, per-target overrides via `NS_LOG` / persisted settings).
   4. **Opt-in OTLP/telemetry layer** (feature `otlp`, off by default — ADR-0019).
2. **In-app application-log store & query** — bounded ring buffer of structured `LogRecord`s with monotonic `seq`; filtering by level / target / span field / connection / source / time window; full-text substring **and** regex search; cursor pagination (newest-first scrollback).
3. **Live streaming to the UI with backpressure** — a request-scoped Tauri `Channel<LogStreamEvent>` (`log_subscribe`) that server-side-filters, coalesces into batches, and surfaces drop/lag counters; producers (any code that logs) are **never blocked**.
4. **Runtime level control** — parse/validate `EnvFilter` directive strings, hot-apply via the reload handle, persist to `Settings`, echo effective per-target levels back to the UI.
5. **Server log ingestion / tailing where reachable** — a `LogSource` abstraction that ingests NATS **server** logs from a local file (poll-based tail) or from the stdout of a server process the app spawned (e.g. `ns-testkit` / bundled `nats-server`), parses NATS log formats (text + JSON) into the same `LogRecord` shape, and unifies them with app logs in the ring under `source = Server`.
6. **Export** — write a filtered slice to disk as JSONL / plain text / CSV, optional gzip, with the same redaction the live path applies.
7. **Diagnostics bundle** — background task that zips (scrubbed) rotated log files + system info + redacted settings + a ring dump, with progress + cancellation.
8. **Frontend-diagnostics ingress (`log_report`)** — a command that funnels significant UI errors into the same pipeline so backend and frontend diagnostics share one stream and one correlation id.
9. **Redaction / secret scrubbing** as defense-in-depth on every emitted, streamed, exported, and bundled record.

### Explicitly out of scope (owned elsewhere)
- **Metrics time-series / NATS HTTP monitoring** (`varz/connz/jsz`…) → `ns-monitor`. We log; we do not poll monitoring endpoints. `MetricsTick` is theirs; `LogEmitted` is ours.
- **Tauri wiring / event bridging / window scoping** → `ns-ipc::EventBridge` + the bin. We publish domain events via the `EventPublisher` port only.
- **Persistence engine / SQL** → `ns-storage`. We declare the `LogViewRepo` port; migrations + SQL live there.
- **Secret storage / `Redacted<T>` definition** → `ns-security` / `ns-core`. We *consume* `Redacted<T>` semantics and re-apply a scrubber; we never own keychain access.
- **Notifications UI / toast center** → `[frontend-shell]`. We emit `LogEmitted`; the shell decides what to surface.
- **Connection lifecycle** → `ns-connection`. We tag records with `connectionId` from span context; we never open NATS connections.

### Boundary contract
`ns-telemetry` is a headless library. Inbound edges: the bin calls `init_telemetry(TelemetryConfig)` at startup (returning a `TelemetryController`, an `Arc<dyn LogService>`, and the `tracing-appender` `WorkerGuard`s the bin must hold for the process lifetime), then injects `EventPublisher`, `Clock`, `LogPaths`, `SettingsPort`, and `LogViewRepo` ports. All UI-facing values cross IPC as `ns-types` DTOs.

---

## b) Rust Public Interface (`ns-telemetry`)

### Crate layout
```
crates/ns-telemetry/
├─ src/
│  ├─ lib.rs               # re-exports, LogError, init_telemetry entrypoint
│  ├─ init.rs              # TelemetryConfig, init_telemetry(), layer assembly, WorkerGuards
│  ├─ controller.rs        # TelemetryController: reload::Handle, ring handle, otlp control
│  ├─ ring/
│  │  ├─ mod.rs            # LogRing (bounded VecDeque + broadcast + seq + dropped counter)
│  │  ├─ layer.rs          # RingBufferLayer (tracing Layer) + FieldVisitor
│  │  └─ aggregator.rs     # off-hot-path task: raw record -> Arc<LogRecord> -> push+fanout
│  ├─ filter.rs            # LogFilter matching engine (level/target/regex/source/time)
│  ├─ query.rs             # ring query + cursor pagination
│  ├─ stream.rs            # per-subscription tail task: filter + coalesce + drop accounting
│  ├─ level.rs             # directive parse/validate/apply/persist
│  ├─ source/
│  │  ├─ mod.rs            # LogSource, LogSourceRegistry
│  │  ├─ file_tail.rs      # poll-based file tailer (offset tracking, rotation-aware)
│  │  ├─ stdout.rs         # spawned-process stdout ingestor
│  │  └─ parse.rs          # NATS server log parsers (text + JSON) -> LogRecord
│  ├─ export.rs            # JSONL/Text/CSV writer (+ gzip)
│  ├─ diagnostics.rs       # bundle builder (zip) + progress
│  ├─ scrub.rs             # secret scrubber (defense-in-depth)
│  ├─ service.rs           # LogServiceImpl composing the above
│  └─ ports.rs             # ports THIS crate depends on (re-declared from ns-core)
├─ Cargo.toml
└─ tests/                  # integration tests w/ ns-testkit
```

### Error type (thiserror, one public enum — ADR-0008)
```rust
// ns-telemetry/src/lib.rs
#[derive(Debug, thiserror::Error)]
pub enum LogError {
    #[error("invalid log filter directives: {directives}")]
    InvalidDirectives { directives: String, #[source] source: tracing_subscriber::filter::ParseError },

    #[error("invalid search regex")]
    InvalidRegex(#[source] regex::Error),

    #[error("log source {0} not found")]
    UnknownSource(LogSourceId),

    #[error("cannot open server log source at {path}")]
    SourceOpen { path: String, #[source] source: std::io::Error },

    #[error("failed to parse server log line")]
    SourceParse { source_id: LogSourceId, #[source] source: ServerLogParseError },

    #[error("export failed writing {path}")]
    Export { path: String, #[source] source: std::io::Error },

    #[error("diagnostics bundle build failed")]
    Bundle(#[source] std::io::Error),

    #[error("operation cancelled")]
    Cancelled,

    #[error(transparent)]
    Repo(#[from] LogViewRepoError),

    #[error(transparent)]
    Settings(#[from] SettingsPortError),
}

// DomainError mapping (ns-core trait) -> ErrorCode. No NEW ErrorCode values required.
impl DomainError for LogError {
    fn code(&self) -> ErrorCode {
        match self {
            LogError::InvalidDirectives { .. } | LogError::InvalidRegex(_) => ErrorCode::InvalidArgument,
            LogError::UnknownSource(_)                                      => ErrorCode::NotFound,
            LogError::SourceOpen { .. } | LogError::SourceParse { .. }      => ErrorCode::Io,
            LogError::Export { .. } | LogError::Bundle(_)                   => ErrorCode::Io,
            LogError::Cancelled                                            => ErrorCode::Cancelled,
            LogError::Repo(_)                                              => ErrorCode::Storage,
            LogError::Settings(_)                                          => ErrorCode::Storage,
        }
    }
    fn retriable(&self) -> bool { matches!(self, LogError::SourceOpen { .. } | LogError::Cancelled) }
    fn user_message(&self) -> String { /* secret-safe copy per variant */ }
}
```

### Startup entrypoint (bin-facing, before `AppState`)
```rust
// ns-telemetry/src/init.rs
pub struct TelemetryConfig {
    pub logs_dir: std::path::PathBuf,       // {appDataDir}/logs, resolved by the bin (directories/Tauri path)
    pub file_format: FileFormat,            // Json | Pretty (both can be enabled)
    pub also_json_file: bool,               // write a parallel .jsonl for machine parsing
    pub ring_capacity: usize,               // default 50_000 records
    pub initial_directives: String,         // from NS_LOG env or persisted Settings, else "info"
    pub rotation: Rotation,                 // Daily (default) | Hourly | Never
    pub max_retained_files: usize,          // pruned on startup by the file layer
    pub emit_ambient_min_level: LogLevel,   // threshold for ns://log ambient events, default Warn
    pub otlp: Option<OtlpConfig>,           // None unless telemetry opted in
    pub app_meta: AppMeta,                  // version, schemaVersion, target triple (for bundle/header)
}

/// Called ONCE at the top of main(), before anything else logs.
/// Returns handles the bin must keep alive; installs the global default subscriber.
pub fn init_telemetry(cfg: TelemetryConfig) -> Result<TelemetryInit, TelemetryInitError>;

pub struct TelemetryInit {
    pub controller: TelemetryController,     // runtime control (reload, ring handle)
    pub service_builder: LogServiceBuilder,  // finish with injected ports -> Arc<dyn LogService>
    pub _guards: Vec<tracing_appender::non_blocking::WorkerGuard>, // hold for process lifetime
}
```

> **Bootstrapping order note.** `init_telemetry` runs before the bus exists. The ring layer buffers immediately; the `EventPublisher` is attached later (`controller.attach_publisher(pub)`) once `ns-event` is constructed. Ambient `ns://log` emission is a no-op until attached, so no early-boot log is lost from the *ring* (it is only excluded from ambient toasts). This keeps tracing available for the earliest boot code.

### Runtime controller
```rust
// ns-telemetry/src/controller.rs
#[derive(Clone)]
pub struct TelemetryController {
    reload: tracing_subscriber::reload::Handle<EnvFilter, Registry>,
    ring: Arc<LogRing>,
    ambient_min: Arc<AtomicU8>,       // LogLevel threshold, hot-swappable
    publisher: Arc<ArcSwapOption<dyn EventPublisher>>,
    otlp: Option<OtlpControl>,
}
impl TelemetryController {
    pub fn set_directives(&self, directives: &str) -> Result<EffectiveFilter, LogError>; // validates then reload()
    pub fn current_directives(&self) -> String;
    pub fn ring(&self) -> Arc<LogRing>;
    pub fn attach_publisher(&self, publisher: Arc<dyn EventPublisher>);
    pub fn set_ambient_min_level(&self, level: LogLevel);
}
```

### The in-app ring + tracing layer
```rust
// ns-telemetry/src/ring/mod.rs
pub struct LogRing {
    inner: parking_lot::RwLock<VecDeque<Arc<LogRecord>>>, // capacity-bounded, drop-oldest
    capacity: usize,
    seq: AtomicU64,                    // monotonic, never reused (gap detection in UI)
    dropped: AtomicU64,                // records evicted before any consumer read them
    tx: tokio::sync::broadcast::Sender<Arc<LogRecord>>, // live fan-out to tail tasks + ambient
}
impl LogRing {
    pub fn push(&self, rec: Arc<LogRecord>);                 // called by aggregator only
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<LogRecord>>;
    pub fn snapshot(&self, f: &LogFilter, page: PageSpec) -> LogPage; // cursor pagination over ring
    pub fn stats(&self) -> LogBufferStats;
}

// ns-telemetry/src/ring/layer.rs
pub struct RingBufferLayer { tx: mpsc::Sender<RawRecord> } // bounded mpsc to aggregator
impl<S> tracing_subscriber::Layer<S> for RingBufferLayer
where S: Subscriber + for<'a> LookupSpan<'a> {
    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        // 1. Visit fields into an owned RawRecord (message, kv pairs).
        // 2. Walk ctx.event_scope() to capture span stack + span fields
        //    (connection_id, subscription_id, correlation_id lifted to typed columns).
        // 3. try_send(RawRecord). If the aggregator queue is FULL -> increment a dropped
        //    counter and return. NEVER blocks the emitting thread (backpressure rule).
    }
}
```
> **Self-log guard.** All internal telemetry code paths (aggregator, tailer, export) log under target `ns_telemetry::internal`, which the `RingBufferLayer` hard-excludes, preventing a log→ring→log feedback loop. The aggregator itself never emits `tracing` events on its hot path.

### The public service trait (port in `ns-core`, impl here)
```rust
// port declared in ns-core::ports::log; impl = ns_telemetry::LogServiceImpl
#[async_trait::async_trait]
pub trait LogService: Send + Sync + 'static {
    /// Historical scrollback over the ring (newest-first by default), filtered + paginated.
    async fn query(&self, req: LogQueryRequest) -> Result<LogPage, LogError>;

    /// Live tail. Returns a handle; the CALLER (ns-ipc command) owns the Channel and pumps
    /// `stream` into it under a CancellationToken. Backpressure + coalescing live in `stream`.
    fn subscribe(&self, req: LogSubscribeRequest) -> Result<LogStream, LogError>;

    async fn get_level(&self) -> Result<LogFilterConfig, LogError>;
    async fn set_level(&self, req: SetLogLevelRequest) -> Result<LogFilterConfig, LogError>;

    async fn export(&self, req: LogExportRequest, cancel: CancellationToken)
        -> Result<LogExportResult, LogError>;

    async fn list_sources(&self) -> Result<Vec<LogSourceInfo>, LogError>;
    async fn open_source(&self, req: OpenLogSourceRequest) -> Result<LogSourceInfo, LogError>;
    async fn close_source(&self, id: LogSourceId) -> Result<(), LogError>;

    /// Frontend diagnostics ingress -> emitted as a tracing event on target `ns_frontend`.
    async fn report(&self, req: LogReportRequest) -> Result<(), LogError>;

    async fn build_diagnostics_bundle(&self, req: DiagnosticsBundleRequest, cancel: CancellationToken)
        -> Result<DiagnosticsBundleResult, LogError>;

    async fn stats(&self) -> Result<LogBufferStats, LogError>;

    // Saved log views (persisted named filters)
    async fn save_view(&self, req: SaveLogViewRequest) -> Result<LogSavedView, LogError>;
    async fn list_views(&self) -> Result<Vec<LogSavedView>, LogError>;
    async fn delete_view(&self, id: LogViewId) -> Result<(), LogError>;
}

/// Returned by subscribe(); the ns-ipc command drives it into a Tauri Channel.
pub struct LogStream {
    pub subscription_id: SubscriptionId,
    rx: broadcast::Receiver<Arc<LogRecord>>,
    filter: LogFilter,
    coalesce: CoalescePolicy, // batch window + max batch size
}
impl LogStream {
    /// Yields the next coalesced batch or a Lagged marker; None on close.
    pub async fn next(&mut self) -> Option<LogStreamEvent>;
}
```

### Ports this crate depends on (declared in `ns-core`, injected by bin)
```rust
// ns-core::ports::log
#[async_trait::async_trait]
pub trait LogViewRepo: Send + Sync {                 // impl in ns-storage
    async fn upsert_view(&self, v: LogSavedViewRow) -> Result<(), LogViewRepoError>;
    async fn list_views(&self) -> Result<Vec<LogSavedViewRow>, LogViewRepoError>;
    async fn delete_view(&self, id: LogViewId) -> Result<(), LogViewRepoError>;
}
// SettingsPort (ns-core) — read/write the LogSettings slice (directives, retention, capacity).
// EventPublisher (ns-core) — publish LogEmitted / TaskProgress to the bus.
// Clock (ns-core) — timestamps.
pub struct LogPaths { pub logs_dir: PathBuf, pub export_dir: PathBuf, pub bundle_dir: PathBuf }
```

### Server log source model
```rust
// ns-telemetry/src/source/mod.rs
pub struct LogSourceRegistry { /* id -> running tail task + handle */ }
pub enum LogSourceBackend {
    File { path: PathBuf, follow: bool },   // poll-based tail, rotation-aware (inode/len reset detect)
    Stdout { child: Arc<ChildStdoutHandle> }, // stdout of a process the app spawned
}
// parse.rs: detect JSON lines vs classic text NATS format:
//   [12345] 2024/06/01 10:00:00.000000 [INF] server message ...
// -> LogRecord { level, ts, target="nats-server", message, source=Server{id} }
```

---

## c) Tauri IPC Commands (registered by the bin, defined in the `ns-ipc` log command module)

All `snake_case`, one `req` arg, return `Result<_, IpcError>`. Streams use `tauri::ipc::Channel<T>` (ADR-0009). Log commands are **app-scoped** (not connection-scoped) since the ring unifies all connections; `connectionId` appears only as an optional *filter*.

| Command | Kind | Request (`ns-types`) | Returns / Stream item | Errors (`ErrorCode`) |
|---|---|---|---|---|
| `log_query` | request | `LogQueryRequest { filter, cursor?, limit, direction }` | `LogPage { items, nextCursor?, total?, droppedSinceLast }` | INVALID_ARGUMENT |
| `log_subscribe` | **stream** | `LogSubscribeRequest { filter, batchIntervalMs?, maxBatch?, channel }` | Channel item `LogStreamEvent` | INVALID_ARGUMENT |
| `log_unsubscribe` | command | `{ subscriptionId }` | `()` | NOT_FOUND |
| `log_get_level` | request | `{}` | `LogFilterConfig` | INTERNAL |
| `log_set_level` | command | `SetLogLevelRequest { directives }` | `LogFilterConfig` | INVALID_ARGUMENT, STORAGE |
| `log_export` | request | `LogExportRequest { filter, format, destPath?, gzip }` | `LogExportResult { path, bytes, recordCount }` | IO, INVALID_ARGUMENT, CANCELLED |
| `log_list_sources` | request | `{}` | `LogSourceInfo[]` | INTERNAL |
| `log_open_source` | request | `OpenLogSourceRequest { kind, connectionId?, filePath?, follow }` | `LogSourceInfo` | IO, INVALID_ARGUMENT |
| `log_close_source` | command | `{ sourceId }` | `()` | NOT_FOUND |
| `log_report` | command | `LogReportRequest { level, message, fields?, correlationId?, stack? }` | `()` | INVALID_ARGUMENT |
| `log_build_diagnostics_bundle` | request | `DiagnosticsBundleRequest { includeRing, includeSettings, sinceTs? }` | `DiagnosticsBundleResult { path, bytes }` | IO, CANCELLED |
| `log_stats` | request | `{}` | `LogBufferStats { count, capacity, dropped, oldestSeq, newestSeq, bytesApprox }` | INTERNAL |
| `log_save_view` | command | `SaveLogViewRequest { id?, name, filter }` | `LogSavedView` | STORAGE, INVALID_ARGUMENT |
| `log_list_views` | request | `{}` | `LogSavedView[]` | STORAGE |
| `log_delete_view` | command | `{ id }` | `()` | STORAGE, NOT_FOUND |

Streaming Channel item enum (adjacently tagged; terminal `error` per spine):
```rust
#[typeshare] #[serde(tag="kind", content="data", rename_all="camelCase")]
pub enum LogStreamEvent {
    Batch { records: Vec<LogRecord>, droppedSinceLast: u64 }, // coalesced window
    Lagged { dropped: u64 },       // broadcast RecvError::Lagged -> UI gap indicator
    Truncated { dropped: u64 },    // ring drop-oldest overflow marker
    Error(IpcError),               // terminal, stream ends
}
```

> **Cancellation & drop-detection (ADR-0018).** `log_subscribe` registers the `subscriptionId` in the `CancellationRegistry`, spawns the pump task, and returns immediately. `log_unsubscribe` trips the token; Channel drop (view unmount) is caught by the bridge watchdog and also cancels — no leaked tail tasks.

---

## d) Events Emitted (via `EventPublisher` port → bus → `ns-ipc::EventBridge` → Tauri)

| Bus `EventPayload` variant | Tauri event name | Trigger / cadence | Backpressure policy |
|---|---|---|---|
| `LogEmitted(LogEmitted)` | `ns://log` | every ring push whose level ≥ `ambient_min` (default Warn) | bounded ring, **drop-oldest**, surface `truncated` count (spine policy) |
| `TaskProgress(TaskProgress)` | `ns://task/progress` | diagnostics-bundle build + large export | keep-latest per task id |

```rust
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogEmitted {
    pub record: LogRecord,   // compact: message truncated to N chars, fields capped
    pub ringSeq: u64,        // lets UI de-dupe against the Channel tail
}
```
> The **full** Logs view is fed by the `log_subscribe` Channel (request-scoped, high-volume). `ns://log` carries only ≥Warn records so ambient UI (status-bar error badge, notification center) reacts without opening the view and without flooding the bus with trace/debug. Threshold is the runtime `ambient_min` (settable via `log_set_level` side-config).

---

## e) Frontend Surface

### Routes (React Router)
- `/logs` → global Logs view (all connections + server sources unified).
- `/logs/settings` → level control + retention/rotation config.
- Embedded per-connection tab `/c/:connectionId/logs` → same viewer pre-filtered by `connectionId` (Zustand seeds the filter; still one backend ring).

### Panels / components (dockview-compatible, ADR-0012)
- `LogViewerPanel` — TanStack-Virtual table (columns: ts, level chip, target, message, connection); auto-scroll/follow-tail toggle; row → `LogDetailDrawer`.
- `LogDetailDrawer` — full record: pretty fields, span stack, `correlationId` copy-to-clipboard (deep-links to the originating `IpcError`), raw JSON toggle.
- `LogFilterBar` — min-level select, target multiselect (typeahead over seen targets), search box with **regex** toggle, source multiselect, connection filter, time-range, live/pause. Filter (de)serializes to a `LogSavedView`.
- `LogLevelControl` — directive editor (`info,ns_connection=debug,ns_jetstream=trace`) with validation + effective-levels table; writes `log_set_level`.
- `ServerLogSourcePanel` — list/open/close file & stdout sources (`log_open_source`).
- `LogExportDialog` — format + gzip + destination (native save dialog) → `log_export`.
- `DiagnosticsBundleButton` — builds + reveals the zip; progress from `ns://task/progress`.
- `LogGapIndicator` — renders `Lagged`/`Truncated` markers inline so users see dropped-line counts.

### Zustand store (`logsUiStore` — UI/session only, never mirrors server-state)
- `filter`, `regexEnabled`, `live` (bool), `followTail`, `selectedSeq`, `columnVisibility`, `activeSourceIds`, `pinnedCorrelationIds`.
- `liveBuffer`: a **client-side bounded ring** (capacity ~20k) of streamed `LogRecord`s appended from the Channel handler — ephemeral session data, correctly Zustand not TanStack (streaming, not server-state-of-record).

### TanStack Query keys (server-state)
- `['logs','query', filterHash, cursor]` — infinite query for historical scrollback (`log_query`).
- `['logs','level']` — `log_get_level`; invalidated by the `log_set_level` mutation.
- `['logs','sources']`, `['logs','stats']`, `['logs','savedViews']`.

### IPC client calls (generated wrappers in `packages/ns-bindings`, from `commands.manifest.ts`)
`ipc.log.query`, `ipc.log.subscribe` / `ipc.log.unsubscribe`, `ipc.log.getLevel` / `ipc.log.setLevel`, `ipc.log.export`, `ipc.log.listSources` / `openSource` / `closeSource`, `ipc.log.report`, `ipc.log.buildDiagnosticsBundle`, `ipc.log.stats`, `ipc.log.saveView` / `listViews` / `deleteView`.

A single `useLogTail(filter)` hook owns the `log_subscribe` Channel: appends `Batch` records into `logsUiStore.liveBuffer`, renders `Lagged`/`Truncated` markers, and cancels (`log_unsubscribe`) on unmount. `useAppEvents()` routes `ns://log` into a lightweight error-badge slice.

---

## f) Data Model

### `ns-types` DTOs (typeshared; camelCase; tagged enums; RFC-3339 `ts`; `*Ms` durations)
```rust
#[typeshare] #[serde(rename_all="camelCase")]
pub enum LogLevel { Trace, Debug, Info, Warn, Error }

#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogRecord {
    pub seq: u64,
    pub ts: String,                       // RFC-3339
    pub level: LogLevel,
    pub target: String,                   // crate module path or "nats-server"/"ns_frontend"
    pub message: String,
    pub fields: Vec<LogField>,            // ordered kv, values already scrubbed
    pub spans: Vec<LogSpan>,              // outermost..innermost span stack
    pub source: LogSourceRef,
    pub connectionId: Option<ConnectionId>,
    pub correlationId: Option<String>,
    pub threadName: Option<String>,
    pub fileLine: Option<String>,         // "ns_jetstream/src/streams.rs:120"
}
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogField { pub key: String, pub value: String }
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogSpan { pub name: String, pub fields: Vec<LogField> }

#[typeshare] #[serde(tag="kind", content="data", rename_all="camelCase")]
pub enum LogSourceRef { App, Server { sourceId: LogSourceId } }

#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogFilter {
    pub minLevel: Option<LogLevel>,
    pub targets: Vec<String>,             // include: prefix match (any-of)
    pub excludeTargets: Vec<String>,
    pub search: Option<String>,
    pub regex: bool,
    pub connectionId: Option<ConnectionId>,
    pub sources: Vec<LogSourceRef>,
    pub correlationId: Option<String>,
    pub sinceTs: Option<String>,
    pub untilTs: Option<String>,
}
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogQueryRequest { pub filter: LogFilter, pub cursor: Option<String>, pub limit: u32, pub direction: PageDirection }
#[typeshare] #[serde(rename_all="camelCase")]
pub enum PageDirection { Backward, Forward } // Backward = newest-first (default)
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogPage { pub items: Vec<LogRecord>, pub nextCursor: Option<String>, pub total: Option<u64>, pub droppedSinceLast: u64 }

#[typeshare] #[serde(rename_all="camelCase")]
pub struct SetLogLevelRequest { pub directives: String }         // EnvFilter syntax
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogFilterConfig { pub directives: String, pub defaultLevel: LogLevel, pub effective: Vec<TargetLevel>, pub ambientMinLevel: LogLevel }
#[typeshare] #[serde(rename_all="camelCase")]
pub struct TargetLevel { pub target: String, pub level: LogLevel }

#[typeshare] #[serde(rename_all="camelCase")]
pub enum LogExportFormat { Jsonl, Text, Csv }
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogExportRequest { pub filter: LogFilter, pub format: LogExportFormat, pub destPath: Option<String>, pub gzip: bool }
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogExportResult { pub path: String, pub bytes: u64, pub recordCount: u64 }

#[typeshare] #[serde(rename_all="camelCase")]
pub enum LogSourceKind { ServerFile, ServerStdout }
#[typeshare] #[serde(rename_all="camelCase")]
pub struct OpenLogSourceRequest { pub kind: LogSourceKind, pub connectionId: Option<ConnectionId>, pub filePath: Option<String>, pub follow: bool }
#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogSourceInfo { pub id: LogSourceId, pub kind: LogSourceKind, pub label: String, pub path: Option<String>, pub active: bool, pub format: ServerLogFormat, pub connectionId: Option<ConnectionId> }
#[typeshare] #[serde(rename_all="camelCase")]
pub enum ServerLogFormat { Text, Json, Unknown }

#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogReportRequest { pub level: LogLevel, pub message: String, pub fields: Vec<LogField>, pub correlationId: Option<String>, pub stack: Option<String> }

#[typeshare] #[serde(rename_all="camelCase")]
pub struct DiagnosticsBundleRequest { pub includeRing: bool, pub includeSettings: bool, pub sinceTs: Option<String> }
#[typeshare] #[serde(rename_all="camelCase")]
pub struct DiagnosticsBundleResult { pub path: String, pub bytes: u64 }

#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogBufferStats { pub count: u64, pub capacity: u64, pub dropped: u64, pub oldestSeq: Option<u64>, pub newestSeq: Option<u64>, pub bytesApprox: u64 }

#[typeshare] #[serde(rename_all="camelCase")]
pub struct LogSavedView { pub id: LogViewId, pub name: String, pub filter: LogFilter, pub createdAt: String, pub updatedAt: String }
#[typeshare] #[serde(rename_all="camelCase")]
pub struct SaveLogViewRequest { pub id: Option<LogViewId>, pub name: String, pub filter: LogFilter }

// newtype IDs (serialize as strings): LogSourceId(Uuid), LogViewId(Uuid), SubscriptionId(Uuid)
```
> **Cursor encoding.** `nextCursor` is an opaque base64 of `{ seq, direction }`. Pagination is purely `seq`-based over the ring; because `seq` is monotonic and never reused, a cursor whose `seq` has already been evicted returns the oldest still-present slice plus `droppedSinceLast > 0` so the UI can show a truncation banner rather than silently skipping.

### SQLite tables (schema owned here; **SQL lives in `ns-storage`** via `LogViewRepo` + `SettingsRepo`)
```sql
-- migrations/NNNN_logging.sql (authored by Logging team, applied by ns-storage)
CREATE TABLE log_saved_view (
  id          TEXT PRIMARY KEY,       -- LogViewId (uuid)
  name        TEXT NOT NULL UNIQUE,
  filter_json TEXT NOT NULL,          -- serialized LogFilter
  created_at  TEXT NOT NULL,          -- RFC-3339
  updated_at  TEXT NOT NULL
);
```
**Deliberately NOT persisted to SQLite:** raw log records. Durable logs live as **rotated files** in `{appDataDir}/logs/` (privacy + volume + the ring is the hot store). `LogSettings` (directives, ring capacity, retention days, rotation, `ambientMinLevel`, redaction toggles) lives under the **`settings` aggregate** (`SettingsRepo`, `SettingsPort`), versioned with the rest of app settings — this subsystem owns the `LogSettings` shape, not a table.

---

## g) Dependencies

### Crate deps (must match the spine's `ns-telemetry.depends_on = [ns-types, ns-core, ns-event]`)
- `ns-types` — all DTOs above.
- `ns-core` — `DomainError`, `ErrorCode`, `Redacted<T>`, `CancellationToken`, ports (`LogViewRepo`, `SettingsPort`, `EventPublisher`, `Clock`), `LogPaths`.
- `ns-event` — `EventPublisher` impl / `EventPayload::{LogEmitted, TaskProgress}` construction.
- **External (within pins + role-standard):** `tracing`, `tracing-subscriber` (`env-filter`, `json`, `registry`, `reload`), `tracing-appender`, `serde`/`serde_json`, `time`, `tokio` (broadcast/mpsc/fs/process), `regex` (search + scrub), `parking_lot` (ring RwLock), `arc-swap` (publisher hot-swap), `zip`+`flate2` (bundle/export gzip). All single-pinned in `[workspace.dependencies]`. `otlp` feature adds `opentelemetry`/`tracing-opentelemetry` only when enabled.

### Subsystem deps (runtime, via ports — no compile edges beyond the above)
- `ns-storage` (impl `LogViewRepo`, `SettingsRepo`), `ns-security` (`Redacted<T>` producers — we consume the marker), `ns-ipc` (owns the log command module + `EventBridge`), bin (composition root: `init_telemetry`, port injection, command registration).

### Consumers of us
- **Every crate** is a producer (they call `tracing` macros; no compile dep on `ns-telemetry`).
- `ns-ipc` maps `LogError → AppError → IpcError`; attaches `correlationId` from the current span (the same field we record) so a UI error links to a log line.
- `[frontend-shell]` consumes `ns://log`; `[dashboard]`/support flows consume the diagnostics bundle.

---

## h) Concurrency / Async & Backpressure

1. **Hot path never blocks producers (the cardinal rule).** `on_event` runs on whatever thread logged. It does minimal owned-field materialization then `try_send` to a bounded mpsc; a full queue increments a dropped counter and returns. No lock is held across `.await`; no blocking send. This guarantees a slow UI can never stall business logic. The reload `EnvFilter` gates events *before* the layer, so below-threshold events cost ~nothing.
2. **Single aggregator task** owns the `LogRing` + broadcast + ambient publisher. It assigns `seq`, wraps in `Arc`, pushes (drop-oldest under a short write lock), `broadcast::send` (non-blocking), and conditionally builds a compact `LogEmitted` for `ns://log` (≥ `ambient_min`). One writer ⇒ no ring contention; readers (`query`) take a short read lock and clone `Arc`s.
3. **Per-subscription tail tasks** each hold a `broadcast::Receiver`. They filter server-side, coalesce into `Batch` windows (`batchIntervalMs`, default 100 ms, or `maxBatch` records, whichever first). `RecvError::Lagged(n)` → emit `Lagged { dropped: n }` (UI gap indicator); the writer is never blocked by a slow receiver (broadcast semantics). The Channel→WebView leg is bounded; overflow is coalesced, never buffered unboundedly.
4. **File tailing** = a `tokio::time::interval` (200 ms) poll loop tracking byte offset; detects rotation via length-reset / inode change and re-opens from 0; parses complete lines only (partial-line carry-over buffer). Poll-based avoids adding `notify` to the dep set (noted as a future optimization behind a feature). Each parsed record enters the same aggregator mpsc, so app + server logs unify with identical backpressure.
5. **Runtime reload** uses `reload::Handle` (internal `RwLock`); `set_directives` validates via `EnvFilter::try_new` *before* swapping, so a bad directive returns `INVALID_ARGUMENT` and leaves the live filter untouched. Reload adds a per-event `RwLock` read on the filter — benchmarked (§i) to confirm negligible overhead.
6. **Export / bundle** run on `spawn_blocking` (file IO + zip) under a `CancellationToken`, streaming the ring/filter through the writer so peak memory is bounded regardless of match count; progress via `TaskProgress`.
7. **Redaction placement** — the scrubber runs on the aggregator task (off the emitting thread), applied once to `message` + field values before the record is shared; the file-fmt layer uses `Redacted<T>`'s `Display` (already `***`) plus a formatting scrubber as belt-and-suspenders.

---

## i) Test Plan

### Unit (`ns-telemetry`)
- `LogRing`: push/evict/`seq` monotonicity; `dropped` accounting; `snapshot` cursor pagination correctness incl. evicted-cursor → oldest-slice + `droppedSinceLast`.
- `RingBufferLayer`/`FieldVisitor`: message + kv extraction; span-stack capture; lifting `connection_id`/`correlation_id` to typed columns; full-mpsc → dropped counter, no block.
- `filter.rs`: level threshold, target prefix include/exclude, substring vs regex, source/connection/time-window, `correlationId` exact match; invalid regex → `INVALID_ARGUMENT`.
- `level.rs`: valid/invalid directive parse; effective-levels computation; reload leaves filter intact on parse error.
- `source/parse.rs`: NATS **text** and **JSON** log formats → `LogRecord` via golden files; unknown format fallback; partial-line carry-over.
- `scrub.rs`: seeds (`SU…`), JWTs (`eyJ…`), `.creds` bodies, `password`/`token`/`authorization` kv → `***`; verify no false-negative on known patterns; perf bound.
- `export.rs`: JSONL/Text/CSV byte-exact golden; gzip round-trip; scrubbing applied.

### Integration (`ns-testkit`, real subscriber + tokio)
- Install full stack; emit `tracing` events across multiple targets/levels; assert `log_query` returns the right filtered slice + ordering.
- `log_subscribe`: drive a live tail through an in-proc channel; assert coalescing window, `maxBatch`, `droppedSinceLast`, and `Lagged` under forced broadcast lag; assert `log_unsubscribe` + Channel-drop both stop the task (no leak).
- `log_set_level`: flip `ns_x=debug` at runtime and assert debug records begin/stop reaching the ring; persisted to `SettingsPort` and re-read on restart.
- File tailer: append to a temp file over time (incl. a rotation event) and assert records + rotation re-open; stdout ingestor against a spawned **embedded `nats-server`** (ns-testkit) → `source=Server` records parsed.
- Diagnostics bundle: build zip; assert entries (scrubbed logs, sysinfo, redacted settings, ring dump) + `TaskProgress` emitted + cancellation aborts cleanly.
- `LogEmitted` ambient path: only ≥Warn records reach `ns://log`; `ringSeq` de-dupes against the Channel tail.

### E2E (Tauri + WebView driver)
- Open `/logs`, generate load, assert virtualized render + follow-tail + pause/resume.
- Change level at runtime in `LogLevelControl`; observe new debug lines appear live.
- Full-text + regex search; save/apply a `LogSavedView`; export → file exists with expected count.
- **Backpressure e2e:** flood logs at high rate; assert UI stays responsive, `Lagged`/`Truncated` counters surface, and — via a bench probe — `on_event` latency stays flat (producers unblocked).
- Diagnostics bundle download reveals a valid zip.

### Bench / stress
- `criterion` on `on_event` (filtered-out, matched, full-queue) — target sub-microsecond for filtered-out, low-single-digit µs for matched.
- Reload-handle overhead A/B (static filter vs reload) to justify runtime control.
- Sustained 100k events/s soak: flat memory (ring cap held), bounded dropped growth, no unbounded task/File-handle growth.

---

## j) Risks & Open Questions

- **Self-log feedback loop** — mitigated by the `ns_telemetry::internal` target exclusion + no tracing on the aggregator hot path; must be enforced by a lint/test so a future contributor doesn't reintroduce a log call inside the ring path.
- **On-event cost & reload overhead** — every log pays the visitor + `try_send`; benchmark-gated in CI. If reload overhead proves material, fall back to a coarse per-target atomic level switch for the common case and keep reload for full re-directive changes.
- **"Server logs where reachable" is genuinely limited** — NATS has **no remote log endpoint**; only a local file path or a process we spawned is tailable. Remote-server logs are out of reach in v1. **Open question:** add SSH/agent-based remote tail, or a sidecar that republishes server logs onto a NATS subject we subscribe to? Deferred.
- **Poll-based tailing latency** (200 ms) vs adding `notify` — acceptable for v1; revisit behind a feature flag if users want sub-100 ms server-log latency.
- **Ring capacity vs memory** — 50k × ~1 KB ≈ 50 MB worst case; make capacity a setting and account `bytesApprox` in `log_stats`. **Open question:** should very high-volume trace sessions spill to a temp file-backed ring, or is "raise the file log + query files" the answer? Leaning file-log.
- **Secret scrubbing is best-effort** — regex can't catch every secret; the real guarantee is `Redacted<T>` at the source (ns-security). Scrubber is defense-in-depth only; document that plugin/third-party log lines are the highest risk.
- **Correlation-id propagation across async** — depends on `#[instrument]` discipline in every crate; provide a `#[instrument]` field convention doc + a test that asserts an `IpcError.correlationId` matches a ring record.
- **Multi-window** — `ns://log` is global (bridge emits to all windows); the Channel tail is per-view. Confirm with `[tauri-shell]` that per-window log filtering isn't required (currently assumed not).
- **Startup ordering** — `init_telemetry` before the bus means the earliest boot logs have no ambient event; acceptable (they are in the ring + file). Confirm the bin resolves `logs_dir` via `directories` at init and that it matches the Tauri path API value later (asserted in an integration test).
- **OTLP opt-in scope** — endpoint/auth config surface and PII policy for exported spans is owned jointly with `[deployment-strategy]`; not designed here beyond the feature gate.
