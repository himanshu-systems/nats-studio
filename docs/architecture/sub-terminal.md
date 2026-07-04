# Subsystem Design — Embedded Terminal `[terminal]`

> Crate: `ns-terminal` (L2 feature service) · Owning team: Terminal Team
> Status: Design v1 · Subordinate to `docs/architecture/00-conventions-and-workspace.md` (the spine). Where this doc and the spine disagree, the spine wins. Reuses spine names verbatim (`AppState`, `EventBridge`, `IpcError`, `StreamEvent<T>`, `ns://…`, `CancellationRegistry`, `TaskRegistry`, ADR-0017, ADR-0018).

---

## 1. Responsibilities & Boundaries

### 1.1 In scope (what `ns-terminal` owns)

`TerminalService` is the single L2 service for the **embedded terminal and the "everything-as-nats-CLI" surface**:

1. **PTY sessions** — spawn a pseudo-terminal via `portable-pty` (the ONLY crate allowed to import `portable-pty`, per ADR-0017) running the `nats` CLI environment, stream merged stdout/stderr bytes to a Tauri `Channel<StreamEvent<TerminalChunk>>` for xterm.js, accept stdin, handle resize and interrupt/EOF/kill. Session registry with per-session cancellation.
2. **Two run modes (ADR-0017)** — `NatsCli` (default): a shell pre-configured for NATS (bundled `nats` binary on `PATH`, a synthesized ephemeral `nats context` bound to the current connection, branded prompt, optional soft command guard restricting input to `nats …`). `RawShell` (gated behind a setting + capability): unrestricted platform shell.
3. **"Generate CLI" / "Copy as nats CLI"** — a pure, synchronous translator turning a structured `CliAction` (a GUI action DTO) into a `GeneratedCommand` (program + args + redacted display string + runnable string + notes). Every feature team drops a `<CopyAsCliButton action={…}/>` into its panels; the translation table lives here. A `CliGeneratorExt` port lets plugins add generators.
4. **Command history** — record commands the app *originated* (generated-CLI runs, runbook steps, command-bar submissions) with exit code + duration + redacted text; paged history + replay-into-terminal. (Raw interactive keystrokes are NOT parsed/persisted — see §10.)
5. **Saved scripts & runbooks** — CRUD over reusable single/multi-line scripts and structured multi-step runbooks (ordered steps, stop-on-error, per-step confirm), executed sequentially inside a session with per-step progress.
6. **Secret-safe execution glue** — materialize a short-lived `.creds` file (0600, temp, deleted on close) from the connection's secret handle so the `nats` CLI can authenticate, without ever inlining seeds/tokens into a command line, env dump, history row, or log.

### 1.2 Out of scope (delegated)

| Concern | Owner |
|---|---|
| Opening/closing NATS connections, connection handles, server URLs/creds refs | `ns-connection` (we get an env descriptor via a `ns-core` port) |
| Any `async-nats` call site | `ns-nats` |
| Keychain access, `.creds` parsing, secret decryption | `ns-security` (we call a `CredsMaterializer` port) |
| SQL execution / migration mechanics | `ns-storage` (we define repo ports + own our tables) |
| Tauri command registration, `AppError→IpcError`, `Channel` helpers, `EventBridge` | `ns-ipc` + the bin |
| Payload codec/hex/format detection | `ns-inspector` (terminal deals in raw bytes only) |
| Domain semantics of the CLI actions (what a stream config *means*) | the originating feature team (they hand us a `CliAction` variant) |

**Boundary rule:** `ns-terminal` imports **only** `portable-pty` (its confined dep) plus ports/traits (`ns-core`, `ns-event`) and DTOs (`ns-types`). It never imports `async-nats`, `tauri`, `rusqlite`, `reqwest`, or `keyring`. This keeps it headless-testable with mock ports and a mock PTY.

### 1.3 Where we sit

```
ns-types  ns-core  ns-event        (portable-pty confined inside)
   \        |        |
    \-------+--------+
              ns-terminal  (L2)
                  |
        ns-ipc (L3) → nats-studio bin (L4)
```

We do **not** depend on `ns-connection` or `ns-security` at the type level. The bin injects a `NatsContextProvider` port (resolve `ConnectionId` → server URLs + a secret handle, impl in `ns-connection`) and a `CredsMaterializer` port (write/erase a temp creds file, impl in `ns-security`). No crate cycle; both remain L2/L1 peers.

---

## 2. Rust Public Interface (`ns-terminal`)

### 2.1 Module layout

```
crates/ns-terminal/
├─ src/
│  ├─ lib.rs           # re-exports: TerminalService, DefaultTerminalService, TerminalError
│  ├─ service.rs       # TerminalService trait + DefaultTerminalService impl
│  ├─ pty/
│  │  ├─ mod.rs        # PtyBackend trait (abstracts portable-pty; mockable)
│  │  ├─ portable.rs   # PortablePtyBackend (ONLY file importing portable-pty)
│  │  └─ reader.rs     # blocking read loop → bounded mpsc → sink; overflow policy
│  ├─ session.rs       # Session, SessionRegistry (DashMap<SessionId, Session>)
│  ├─ mode.rs          # NatsCli vs RawShell: shell selection, env/prompt/context build
│  ├─ context.rs       # ephemeral nats-context synth + temp creds lifecycle (via ports)
│  ├─ command.rs       # run_command guard + one-shot execution over a session
│  ├─ cli/
│  │  ├─ mod.rs        # CliBuilder, GeneratedCommand assembly, redaction
│  │  ├─ core.rs       # built-in generators: pub/sub/req, stream, consumer, kv, object…
│  │  └─ ext.rs        # CliGeneratorExt registry (plugin extension point)
│  ├─ history.rs       # history recording + paging + replay
│  ├─ scripts.rs       # script & runbook CRUD over repo ports
│  ├─ runbook.rs       # sequential runbook executor (progress, stop-on-error)
│  ├─ ports.rs         # NatsContextProvider, CredsMaterializer, repo ports (re-export from ns-core)
│  └─ error.rs         # TerminalError (thiserror) + DomainError impl
└─ Cargo.toml
```

### 2.2 The service trait (port consumed by `ns-ipc`)

```rust
use std::sync::Arc;
use async_trait::async_trait;
use ns_core::CancellationToken;
use ns_types::terminal::*;                 // all DTOs live in ns-types
use ns_types::ids::{ConnectionId, SessionId, RunId, ScriptId, RunbookId, HistoryId};

/// The single L2 entry point for the embedded terminal + CLI generation.
/// All methods are async; nothing blocks the caller. Streaming methods take a
/// `sink` (ns-ipc bridges it to a Tauri Channel) plus a cancellation token.
#[async_trait]
pub trait TerminalService: Send + Sync + 'static {
    // ---- PTY sessions --------------------------------------------------
    async fn open_session(
        &self,
        req: OpenSessionRequest,
        sink: Arc<dyn TerminalSink>,
        token: CancellationToken,
    ) -> Result<OpenSessionResponse, TerminalError>;

    async fn write_stdin(&self, req: WriteStdinRequest) -> Result<(), TerminalError>;
    async fn resize(&self, req: ResizeRequest)         -> Result<(), TerminalError>;
    async fn signal(&self, req: SignalRequest)         -> Result<(), TerminalError>;
    async fn close_session(&self, id: SessionId)       -> Result<(), TerminalError>;
    async fn list_sessions(&self) -> Result<Vec<SessionInfo>, TerminalError>;

    // ---- One-shot guarded command (generated-CLI run / command bar) -----
    async fn run_command(
        &self,
        req: RunCommandRequest,
        sink: Arc<dyn TerminalSink>,
        token: CancellationToken,
    ) -> Result<RunCommandResponse, TerminalError>;
    async fn cancel_run(&self, id: RunId) -> Result<(), TerminalError>;

    // ---- Generate CLI ("Copy as nats CLI") -----------------------------
    /// Pure, synchronous translation. `connection_id` lets it emit the right
    /// `--context`/server flags; never inlines secrets (see §4.3).
    fn generate_cli(&self, req: GenerateCliRequest) -> Result<GeneratedCommand, TerminalError>;

    // ---- History -------------------------------------------------------
    async fn list_history(&self, req: ListHistoryRequest) -> Result<HistoryPage, TerminalError>;
    async fn clear_history(&self, req: ClearHistoryRequest) -> Result<u64, TerminalError>;

    // ---- Scripts -------------------------------------------------------
    async fn save_script(&self, req: SaveScriptRequest) -> Result<TerminalScript, TerminalError>;
    async fn get_script(&self, id: ScriptId)            -> Result<TerminalScript, TerminalError>;
    async fn list_scripts(&self, req: ListScriptsRequest) -> Result<Vec<TerminalScript>, TerminalError>;
    async fn delete_script(&self, id: ScriptId)         -> Result<(), TerminalError>;

    // ---- Runbooks ------------------------------------------------------
    async fn save_runbook(&self, req: SaveRunbookRequest) -> Result<Runbook, TerminalError>;
    async fn list_runbooks(&self, req: ListRunbooksRequest) -> Result<Vec<Runbook>, TerminalError>;
    async fn delete_runbook(&self, id: RunbookId)        -> Result<(), TerminalError>;
    async fn run_runbook(
        &self,
        req: RunRunbookRequest,
        sink: Arc<dyn RunbookSink>,
        token: CancellationToken,
    ) -> Result<RunbookHandle, TerminalError>;
    async fn cancel_runbook(&self, id: RunId) -> Result<(), TerminalError>;

    /// Register a plugin-contributed CLI generator (called at plugin load).
    fn register_cli_ext(&self, ext: Arc<dyn CliGeneratorExt>);
}
```

### 2.3 Streaming sink abstractions (keep `tauri` out of `ns-terminal`)

```rust
/// Implemented in ns-ipc over tauri::ipc::Channel<StreamEvent<TerminalChunk>>; mocked in tests.
/// `try_send` is non-blocking. Terminal policy = PreserveOrderOverflow: a bounded
/// FIFO applies natural TTY backpressure to the reader; a hard-cap breach emits one
/// Overflow marker rather than silently corrupting the byte stream (spine §9.4).
pub trait TerminalSink: Send + Sync + 'static {
    fn try_send(&self, event: TerminalEvent) -> SinkOutcome;
    fn close(&self);
}

pub trait RunbookSink: Send + Sync + 'static {
    fn try_send(&self, event: RunbookEvent) -> SinkOutcome;
    fn close(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkOutcome { Delivered, Full, Closed }
```

### 2.4 Key structs / internal handles

```rust
pub struct DefaultTerminalService {
    backend:   Arc<dyn PtyBackend>,          // PortablePtyBackend in prod, MockPty in tests
    ctx:       Arc<dyn NatsContextProvider>, // ns-core port, impl ns-connection
    creds:     Arc<dyn CredsMaterializer>,   // ns-core port, impl ns-security
    events:    ns_event::EventPublisher,     // domain events → bus (Notification/TaskProgress)
    history:   Arc<dyn TerminalHistoryRepo>, // ns-core port, impl ns-storage
    scripts:   Arc<dyn TerminalScriptRepo>,
    runbooks:  Arc<dyn RunbookRepo>,
    settings:  Arc<dyn SettingsReader>,      // shell-mode enable, default shell, retention
    cli:       CliBuilder,                    // built-ins + registered CliGeneratorExt
    sessions:  SessionRegistry,               // DashMap<SessionId, Session>
    clock:     Arc<dyn ns_core::Clock>,
    tasks:     ns_core::TaskRegistry,
}

struct Session {
    id: SessionId,
    connection_id: Option<ConnectionId>,
    mode: RunMode,
    pid: Option<u32>,
    master: Arc<dyn MasterHandle>,       // resize + writer, behind the backend abstraction
    writer: tokio::sync::Mutex<Box<dyn std::io::Write + Send>>,
    reader_task: TaskHandle,             // blocking read loop
    waiter_task: TaskHandle,             // awaits child exit → emits Exit frame
    creds_guard: Option<CredsTempGuard>, // Drop erases the temp creds file
    guard: CommandGuard,                 // NatsCli soft-allowlist policy
    cancel: CancellationToken,
    started_ts: OffsetDateTime,
}

/// RAII: on Drop, zeroizes + unlinks the temp creds file. Also swept at startup.
pub struct CredsTempGuard { path: PathBuf }
```

### 2.5 PTY backend abstraction (isolates `portable-pty`)

```rust
/// Everything portable-pty-shaped hides behind this trait so the service is
/// unit-testable with a MockPty (scripted output, exit codes) and the concurrency
/// logic is exercised without a real OS PTY.
pub trait PtyBackend: Send + Sync {
    fn spawn(&self, spec: PtySpawnSpec) -> Result<PtyProcess, TerminalError>;
}

pub struct PtySpawnSpec {
    pub program: String,           // shell path, or the bundled `nats` shim
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>, // NATS_CONTEXT/NATS_URL/NATS_CREDS preset here (no secrets literal)
    pub size: PtySize,             // { cols, rows }
}

pub struct PtyProcess {
    pub pid: Option<u32>,
    pub master: Box<dyn MasterHandle>,          // resize(); take_writer(); try_clone_reader()
    pub reader: Box<dyn std::io::Read + Send>,  // merged stdout+stderr
    pub child:  Box<dyn ChildHandle>,           // wait(), kill()
}
```

### 2.6 Ports we *define* (implemented elsewhere; declared in `ns-core`)

```rust
/// Impl in ns-connection: resolve a connection to a runnable nats-CLI environment.
#[async_trait]
pub trait NatsContextProvider: Send + Sync {
    async fn describe(&self, id: ConnectionId) -> Result<NatsCliContext, ContextError>;
}
pub struct NatsCliContext {
    pub servers: Vec<String>,          // nats:// URLs
    pub auth: AuthDescriptor,          // Creds(handle) | Token(secretRef) | NkeyFile(handle) | None
    pub tls: TlsDescriptor,            // ca/cert refs; nats CLI flags derived
    pub context_name: String,          // synthesized ephemeral context id
}

/// Impl in ns-security: write a locked-down temp creds/nkey file; erase on Drop.
#[async_trait]
pub trait CredsMaterializer: Send + Sync {
    async fn materialize(&self, auth: &AuthDescriptor)
        -> Result<Option<CredsTempGuard>, SecretError>;   // None when auth = None/Token env
}

// Repo ports (ns-core), impl by ns-storage — standard CRUD/paging shapes:
#[async_trait] pub trait TerminalHistoryRepo: Send + Sync { /* insert, page, delete, enforce_retention */ }
#[async_trait] pub trait TerminalScriptRepo:  Send + Sync { /* upsert, get, list, delete */ }
#[async_trait] pub trait RunbookRepo:         Send + Sync { /* upsert, get, list, delete */ }
```

### 2.7 CLI generation

```rust
/// Extensible translator. Built-in generators cover the core+JetStream+KV+Object surface;
/// plugins register more. Pure & synchronous — no IO, no secrets.
pub struct CliBuilder { exts: Vec<Arc<dyn CliGeneratorExt>> }

pub trait CliGeneratorExt: Send + Sync {
    /// Return Some(cmd) if this ext handles the action; None to pass through.
    fn generate(&self, action: &CliAction, ctx: &CliContext) -> Option<GeneratedCommand>;
}

impl CliBuilder {
    pub fn generate(&self, action: &CliAction, ctx: &CliContext)
        -> Result<GeneratedCommand, TerminalError>;   // built-ins first, then exts, else Unsupported
}
```

`CliAction` (in `ns-types`, adjacently tagged `{kind,data}`) is the frozen contract every panel emits. Representative variants (teams extend via ns-types PR + `gen:types`, per ADR-0006):

```rust
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum CliAction {
    Publish { subject: String, payloadPreview: EncodedPayload, headers: Vec<Header>, replyTo: Option<String> },
    Subscribe { subject: String, queueGroup: Option<String> },
    Request { subject: String, payloadPreview: EncodedPayload, timeoutMs: u64 },
    StreamAdd(StreamConfig),          // → `nats stream add --config <tmp.json>`
    StreamInfo { stream: String },
    ConsumerAdd { stream: String, config: ConsumerConfig },
    KvPut { bucket: String, key: String, valuePreview: EncodedPayload },
    KvGet { bucket: String, key: String },
    ObjectGet { bucket: String, name: String },
    ServerCheck,                      // → `nats server check …`
    Bench(BenchSpec),
    // …extended per team
}
```

```rust
#[serde(rename_all = "camelCase")]
pub struct GeneratedCommand {
    pub program: String,                 // "nats"
    pub args: Vec<CliArg>,               // structured, each flagged secret/inline-file
    pub display: String,                 // redacted, human copy (secrets → ***)
    pub runnable: String,                // safe-to-run: uses --context/creds file refs, no inline secrets
    pub context_name: Option<String>,    // ephemeral nats context this run binds to
    pub temp_files: Vec<TempFileSpec>,   // payload/config bodies written to temp before run
    pub notes: Vec<String>,              // e.g. "payload written to a temp file", "requires nats ≥ 0.1.x"
    pub copyable: bool,                  // false when a secret cannot be safely externalized
}
pub struct CliArg { pub value: String, pub secret: bool, pub file_body: Option<String> }
```

### 2.8 Streaming event enums (in-band, on the Channel)

```rust
// ns-types, adjacently tagged. Wrapped by ns-ipc's StreamEvent<TerminalChunk> envelope,
// but the domain-level frames the service produces are:
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum TerminalEvent {
    Started { pid: Option<u32>, cols: u16, rows: u16 },
    Chunk   { data: String /* base64 of raw PTY bytes */, seq: u64 },
    Overflow { droppedBytes: u64 },     // hard-cap breach marker (rare)
    Exit    { code: Option<i32>, signal: Option<String> },  // TERMINAL
    Error   (IpcError),                  // TERMINAL: session ended due to error
}

#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum RunbookEvent {
    StepStarted  { index: u32, command: String /* redacted */ },
    StepOutput   { index: u32, data: String /* base64 */ },
    StepFinished { index: u32, exitCode: Option<i32>, durationMs: u64 },
    AwaitConfirm { index: u32, command: String },   // when confirmEachStep
    Finished     { ran: u32, failed: u32 },          // TERMINAL
    Error        (IpcError),                          // TERMINAL
}
```

### 2.9 Error type

```rust
#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("failed to spawn pty: {0}")]           SpawnFailed(String),
    #[error("`nats` CLI not found on PATH")]        NatsCliNotFound,
    #[error("session {0} not found")]               SessionNotFound(SessionId),
    #[error("run {0} not found")]                   RunNotFound(RunId),
    #[error("write to session {0} failed: {1}")]    WriteFailed(SessionId, String),
    #[error("resize failed: {0}")]                  ResizeFailed(String),
    #[error("command not permitted in NatsCli mode: {0}")] CommandDisallowed(String),
    #[error("raw shell mode is disabled by settings")] ShellModeDisabled,
    #[error("no generator for action kind {0}")]    UnsupportedAction(String),
    #[error("script {0} not found")]                ScriptNotFound(ScriptId),
    #[error("runbook {0} not found")]               RunbookNotFound(RunbookId),
    #[error("connection {0} unavailable")]          ConnectionUnavailable(ConnectionId),
    #[error(transparent)] Secret(#[from] ns_core::SecretError),
    #[error(transparent)] Context(#[from] ns_core::ContextError),
    #[error(transparent)] Storage(#[from] ns_storage::StorageError),
    #[error("io: {0}")] Io(#[from] std::io::Error),
    #[error("operation cancelled")] Cancelled,
}

impl ns_core::DomainError for TerminalError {
    fn code(&self) -> ns_types::ErrorCode { /* mapping below */ }
    fn retriable(&self) -> bool { matches!(self, Self::SpawnFailed(_) | Self::ConnectionUnavailable(_)) }
    fn user_message(&self) -> String { /* secret-safe copy */ }
}
```

ErrorCode mapping: `SpawnFailed | NatsCliNotFound → TERMINAL_SPAWN_FAILED`; `SessionNotFound | RunNotFound | ScriptNotFound | RunbookNotFound → NOT_FOUND`; `CommandDisallowed | ShellModeDisabled → PERMISSION_DENIED`; `UnsupportedAction → INVALID_ARGUMENT`; `ConnectionUnavailable → CONNECTION_CLOSED`; `Secret → SECRET_STORE_UNAVAILABLE`; `Storage → STORAGE`; `Io → IO`; `Cancelled → CANCELLED`; else `INTERNAL`.

---

## 3. Tauri IPC Commands (namespace `terminal_*`)

Every command takes one arg `req: XxxRequest`, returns `Result<XxxResponse, IpcError>`, lives as a thin `ns-ipc` wrapper delegating to `TerminalService`. Streaming commands additionally take a `tauri::ipc::Channel<StreamEvent<…>>` and follow the shell's enforced streaming contract (Ready first frame, token in `CancellationRegistry`, `spawn_stream` with `PreserveOrderOverflow`, terminal `Error`/`Done`, companion cancel).

| Command | Kind | Params (`req`) | Returns | Notable errors |
|---|---|---|---|---|
| `terminal_open` | **stream** (Channel) | `OpenSessionRequest { connectionId?, mode: NatsCli\|RawShell, shell?, cwd?, env[], cols, rows, initialCommand? }` + `Channel<StreamEvent<TerminalChunk>>` | `OpenSessionResponse { sessionId, pid? }` | `TERMINAL_SPAWN_FAILED`, `PERMISSION_DENIED` (shell mode off), `SECRET_STORE_UNAVAILABLE` |
| `terminal_write` | command | `WriteStdinRequest { sessionId, data: { encoding: text\|base64, data } }` | `()` | `NOT_FOUND`, `PERMISSION_DENIED` (guard) |
| `terminal_resize` | command | `ResizeRequest { sessionId, cols, rows }` | `()` | `NOT_FOUND` |
| `terminal_signal` | command | `SignalRequest { sessionId, signal: Interrupt\|Eof\|Kill }` | `()` | `NOT_FOUND` |
| `terminal_close` | command | `{ sessionId }` | `()` | `NOT_FOUND` |
| `terminal_list_sessions` | request | `()` | `SessionInfo[]` | — |
| `terminal_run_command` | **stream** (Channel) | `RunCommandRequest { command, connectionId?, sessionId?, source: Generated\|CommandBar\|Script, record }` + `Channel<StreamEvent<TerminalChunk>>` | `RunCommandResponse { sessionId, runId }` | `TERMINAL_SPAWN_FAILED`, `PERMISSION_DENIED` |
| `terminal_run_command_cancel` | command | `{ runId }` | `()` | `NOT_FOUND` |
| `terminal_generate_cli` | request | `GenerateCliRequest { action: CliAction, connectionId?, redact: bool }` | `GeneratedCommand` | `INVALID_ARGUMENT` (unsupported action) |
| `terminal_list_history` | request | `ListHistoryRequest { connectionId?, source?, cursor?, limit }` | `HistoryPage { items[], nextCursor?, total? }` | `STORAGE` |
| `terminal_clear_history` | command | `ClearHistoryRequest { connectionId?, olderThanTs? }` | `{ deleted: u64 }` | `STORAGE` |
| `terminal_save_script` | request | `SaveScriptRequest { id?, name, body, mode, tags[] }` | `TerminalScript` | `STORAGE` |
| `terminal_get_script` | request | `{ scriptId }` | `TerminalScript` | `NOT_FOUND` |
| `terminal_list_scripts` | request | `ListScriptsRequest { tagFilter? }` | `TerminalScript[]` | `STORAGE` |
| `terminal_delete_script` | command | `{ scriptId }` | `()` | `NOT_FOUND` |
| `terminal_save_runbook` | request | `SaveRunbookRequest { id?, name, description?, steps[], tags[] }` | `Runbook` | `STORAGE` |
| `terminal_list_runbooks` | request | `ListRunbooksRequest { tagFilter? }` | `Runbook[]` | `STORAGE` |
| `terminal_delete_runbook` | command | `{ runbookId }` | `()` | `NOT_FOUND` |
| `terminal_run_runbook` | **stream** (Channel) | `RunRunbookRequest { runbookId, connectionId?, sessionId?, stopOnError, confirmEachStep }` + `Channel<StreamEvent<RunbookProgress>>` | `RunbookHandle { runId, sessionId }` | `NOT_FOUND`, `TERMINAL_SPAWN_FAILED` |
| `terminal_run_runbook_cancel` | command | `{ runId }` | `()` | `NOT_FOUND` |
| `terminal_runbook_confirm` | command | `{ runId, index, proceed }` | `()` | `NOT_FOUND` |

Notes:
- `terminal_generate_cli` is a plain request (pure translation) — cheap enough to run synchronously in the command body; no PTY involved. It never touches secrets, so a "Copy as nats CLI" preview needs no elevated capability.
- `terminal_write` accepts base64 so xterm.js raw keystroke bytes (including control chars, paste, unicode) round-trip losslessly.
- `terminal_signal { Interrupt }` writes `0x03` (Ctrl-C) into the PTY on ALL platforms rather than an OS signal (Windows ConPTY has no SIGINT); `Eof` writes `0x04`; `Kill` calls `child.kill()`.

---

## 4. Events Emitted (bus → bridge → Tauri)

`ns-terminal` emits **domain events** through the injected `EventPublisher` only; it never touches Tauri. Because the spine's `EventPayload` enum has no terminal-specific variant, per-session output and exit live on the **request-scoped Channel** (spine "belongs to one screen → Channel"); only genuinely ambient signals go on the bus using the existing variants:

| Domain `EventPayload` variant | Tauri event | When | Coalescing (bridge) |
|---|---|---|---|
| `TaskProgress { taskId, done, total }` | `ns://task/progress` | runbook step progress; long generated-CLI run | keep-latest per taskId |
| `Notification { level, code, text }` | `ns://notification` | session exited (non-zero), runbook finished/failed, `nats` CLI missing, history pruned | never drop |

Adding a first-class `TerminalSessionChanged` payload would require an `ns-types` PR + ADR (ADR-0006); we deliberately avoid it and keep session lifecycle on the Channel + `Notification`. Live byte output is **never** an ambient event (it would flood the bus and lose ordering) — it is Channel-only with per-chunk monotonic `seq` for gap detection.

---

## 5. Frontend Surface

### 5.1 Routes (React Router, under the workspace shell)

- `/connection/:id/terminal` — Terminal workspace (the xterm host + side rails).
- Scripts/runbooks/history appear as dockview panels or side rails within the terminal route, not separate top-level routes.
- **"Copy as nats CLI"** is not a route — it is a global affordance (`<CopyAsCliButton>`) mounted inside every feature panel across the app.

Panels are dockview (ADR-0012) so a user can tile Terminal beside Publisher/JetStream and run generated commands next to the GUI action.

### 5.2 Components / panels (`apps/desktop/src/features/terminal/`)

- `TerminalPanel` — xterm.js host (addons: `fit`, `webgl` w/ canvas fallback, `search`, `web-links`, `unicode11`). Owns one `Channel<StreamEvent<TerminalChunk>>`; decodes base64 `Chunk.data` → `term.write(Uint8Array)`; sends keystrokes via `terminal_write`; wires `onResize → terminal_resize` (debounced) and a `FitAddon` on container resize; Ctrl-C button → `terminal_signal`.
- `SessionTabs` — multiple sessions per connection; new/close; mode badge (NatsCli / RawShell); "raw shell" toggle disabled unless the setting is on.
- `CommandBar` — an above-the-terminal input for guarded single commands (`terminal_run_command`, `source: CommandBar`) with history autocomplete (↑/↓) fed by `['terminal','history',…]`.
- `CommandHistoryPanel` — virtualized table (ts, command redacted, exit code, duration, source, connection); row actions: copy, re-run (`run_command`), save-as-script.
- `ScriptLibrary` — list + Monaco editor for script bodies; run (streams into the active session); save/delete; tags filter.
- `RunbookRunner` — step list editor + run controls (stopOnError, confirmEachStep); live step status from `RunbookEvent`; per-step output pane; `terminal_runbook_confirm` on gated steps.
- `CopyAsCliButton` / `useCopyAsCli(action)` — **shared, exported to all feature teams.** Calls `ipc.terminal.generateCli({ action, connectionId })`, renders `CommandPreview` popover with `display` string, Copy-to-clipboard, "Run in terminal" (opens/uses a session then `run_command` with `runnable`), and `notes` (e.g. "payload written to temp file").
- `GenerateCliDialog` — expanded preview with the structured `args`, temp-file bodies, and the ephemeral context explanation.

### 5.3 Zustand stores (UI/session only — never mirror server-state)

- `useTerminalStore` — open sessions per connection `{ sessionId, mode, cols, rows, title, alive }`, active session id, xterm instance refs (non-serializable, kept out of persistence), font size/theme, scrollback cap, input-guard toggle.
- `useCommandBarStore` — current input, local recent-command ring (client convenience; source of truth is history query).
- `useScriptEditorStore` — Monaco draft body, unsaved flag, selected script id.
- `useRunbookRunnerStore` — active runId, per-step status map, pending-confirm index.
- `useCliPreviewStore` — open action, last `GeneratedCommand`, popover anchor.

Live terminal bytes are held in the xterm buffer itself (transient UI stream owned by the initiating view), **not** TanStack Query and not Zustand. Query cache holds only *retrievable* server-state (history, scripts, runbooks).

### 5.4 TanStack Query keys

```
['terminal','history', connectionId, filters]     // infinite query (cursor)
['terminal','scripts', tagFilter]
['terminal','runbooks', tagFilter]
['terminal','sessions']                            // snapshot; live lifecycle via Channel/Notification
```

Mutations (`saveScript`, `deleteScript`, `saveRunbook`, `clearHistory`, and history-recording side effects of runs) invalidate the relevant keys. `IpcError.retriable` drives retry (spawn failures are retriable; `NOT_FOUND`/`PERMISSION_DENIED` are not).

### 5.5 IPC client calls (generated wrappers, `packages/ns-bindings`)

`ipc.terminal.open(req, channel)`, `.write(req)`, `.resize(req)`, `.signal(req)`, `.close(req)`, `.listSessions()`, `.runCommand(req, channel)`, `.runCommandCancel(req)`, `.generateCli(req)`, `.listHistory(req)`, `.clearHistory(req)`, `.saveScript(req)`, `.getScript(req)`, `.listScripts(req)`, `.deleteScript(req)`, `.saveRunbook(req)`, `.listRunbooks(req)`, `.deleteRunbook(req)`, `.runRunbook(req, channel)`, `.runRunbookCancel(req)`, `.runbookConfirm(req)`.

A `useTerminalSession()` hook owns the Channel lifecycle: creates it on mount, folds `Started`/`Chunk`/`Overflow`/`Exit`/`Error` frames into the xterm instance + `useTerminalStore`, and on unmount calls `terminal_close` and drops the Channel (the backend drop-watchdog also cancels — ADR-0018).

---

## 6. Data Model (SQLite tables owned by `[terminal]`)

Migrations live in `crates/ns-storage/migrations/` but are authored by this team. Sessions, runs, and PTYs are **runtime-only** (in-memory registry) — never persisted.

```sql
-- 00xx_terminal.sql
CREATE TABLE terminal_history (
  id            TEXT PRIMARY KEY,      -- HistoryId (uuid v7)
  connection_id TEXT,                  -- profile at run time (nullable)
  session_id    TEXT,                  -- runtime session id (not an FK; sessions are ephemeral)
  command       TEXT NOT NULL,         -- REDACTED command string (never inline secrets)
  source        TEXT NOT NULL,         -- 'generated' | 'commandBar' | 'script' | 'runbook'
  exit_code     INTEGER,               -- NULL if still running / killed
  signal        TEXT,                  -- e.g. 'SIGINT' when killed
  duration_ms   INTEGER,
  started_ts    TEXT NOT NULL          -- RFC-3339
);
CREATE INDEX ix_term_hist_conn_ts ON terminal_history(connection_id, started_ts DESC);

CREATE TABLE terminal_script (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,           -- one or more lines; may reference $NATS_CONTEXT etc.
  mode        TEXT NOT NULL,           -- 'natsCli' | 'rawShell'
  tags_json   TEXT NOT NULL DEFAULT '[]',
  created_ts  TEXT NOT NULL,
  updated_ts  TEXT NOT NULL
);

CREATE TABLE terminal_runbook (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  steps_json  TEXT NOT NULL,           -- JSON [{ title, command, confirm?:bool, continueOnError?:bool }]
  tags_json   TEXT NOT NULL DEFAULT '[]',
  created_ts  TEXT NOT NULL,
  updated_ts  TEXT NOT NULL
);
```

**Redaction rule (hard):** only `command` strings that are *already redacted* are persisted (secrets rendered `***`; creds referenced as a context/file, never inline). Runbook/script bodies are user-authored text — we run the tracing scrubber before *logging* them, but we store them verbatim as user content, with a UI warning against pasting raw secrets and a lint that flags obvious `--token`/`--password` inline literals on save.

**Retention:** `terminal_history` bounded by user-configurable size + TTL (Settings), enforced by the storage worker via `TerminalHistoryRepo::enforce_retention`.

DTOs owned in `ns-types::terminal`: `OpenSessionRequest/Response`, `WriteStdinRequest`, `ResizeRequest`, `SignalRequest`, `SessionInfo`, `RunCommandRequest/Response`, `RunbookHandle`, `TerminalEvent`, `TerminalChunk`, `RunbookEvent`, `RunbookProgress`, `GenerateCliRequest`, `GeneratedCommand`, `CliArg`, `CliAction`, `TempFileSpec`, `RunMode`, `TerminalSignal`, `TerminalScript`, `Runbook`, `RunbookStep`, `HistoryRecord/Page/Query`, and all list/CRUD envelopes.

---

## 7. Dependencies

**Crate deps (Cargo):** `ns-types`, `ns-core`, `ns-event`, `portable-pty` (confined here). Dev: `ns-testkit`. No `async-nats`/`tauri`/`rusqlite`/`reqwest`/`keyring`.

**Runtime port injections (from the bin composition root):**
- `NatsContextProvider` (port in `ns-core`, impl **ns-connection**) — resolve `ConnectionId` → server URLs + auth/tls descriptors + ephemeral context name.
- `CredsMaterializer` (port in `ns-core`, impl **ns-security**) — write/erase temp `.creds`/nkey file for the `nats` CLI; returns a `CredsTempGuard`.
- `TerminalHistoryRepo` / `TerminalScriptRepo` / `RunbookRepo` (ports in `ns-core`, impl **ns-storage**).
- `SettingsReader` (**ns-storage/ns-core**) — raw-shell-mode enable, default shell per platform, history retention, scrollback cap.
- `EventPublisher` (**ns-event**), `Clock`, `TaskRegistry`, `CancellationRegistry` (**ns-core**).
- `PtyBackend` → `PortablePtyBackend` (in-crate) in prod; `MockPty` (ns-testkit) in tests.

**Consumed by:** `ns-ipc` (wraps our trait in `terminal_*` commands + bridges our events). Every feature team consumes the `CliAction` DTO and the `<CopyAsCliButton>` component but calls us only through generated IPC wrappers.

---

## 8. Concurrency / Async & Backpressure

- **Every service method is async & non-blocking.** Each session owns two tokio tasks in the `TaskRegistry`, keyed by `SessionId`: a **reader** task and a **waiter** task, both cancellable by the session's `CancellationToken`.
- **Reader task (the blocking-IO boundary):** `portable-pty`'s reader is a synchronous `Read`. We run the read loop on `tokio::task::spawn_blocking`, reading into a reusable buffer and forwarding chunks to the `TerminalSink` via a **bounded** mpsc→Channel. Policy = `PreserveOrderOverflow`: on a full buffer we briefly apply natural TTY backpressure (don't read → the child's tty write blocks, exactly like a real terminal); only if a hard cap (e.g. buffered bytes over a window) is exceeded do we coalesce and emit a single `Overflow { droppedBytes }` marker rather than corrupt the stream. **We never drop bytes silently mid-line.**
- **Writer:** the PTY master writer is guarded by a `tokio::sync::Mutex`; `write_stdin` and `signal` (control-byte injection) serialize through it. `resize` calls `master.resize()` (its own lock inside portable-pty) — independent of the writer.
- **Waiter task:** blocks on `child.wait()` (spawn_blocking); on exit emits a terminal `Exit { code, signal }` frame, closes the sink, deregisters tasks, drops the `CredsTempGuard` (erasing the temp creds file), and emits a `Notification` if exit code ≠ 0.
- **Cancellation is total (ADR-0018):** three triggers converge on one token — explicit `terminal_close`/`*_cancel`, Channel drop-watchdog (view unmount → failed emit), and connection close (`cancel_all_for_connection`). Cancel kills the child, closes the master (unblocking the reader), joins both tasks, and erases creds.
- **Session cap & resource bounds:** a max concurrent-session limit (setting, default ~20) prevents spawn-storms exhausting the blocking pool; each session's scrollback is bounded client-side (xterm) and the server keeps no scrollback (byte pass-through).
- **Runbook executor:** a single task drives steps sequentially against one session, writing each command, reading until a completion sentinel/exit, emitting `RunbookEvent` + `TaskProgress`. `stopOnError` halts on non-zero exit; `confirmEachStep` parks on `AwaitConfirm` until `terminal_runbook_confirm`. Cancellable mid-run; partial results reported (`Finished { ran, failed }`).
- **History writes:** fire-and-forget onto the storage worker's single-writer queue at command *start* (id pre-generated) and *finish* (exit code/duration update) — a run never awaits the DB on its latency path. Retention enforced off the hot path.
- **CLI generation** is pure/sync, no locks, no IO — cheap enough to run inline in the command body.
- **Cross-platform:** `PtyBackend` hides ConPTY (Windows) vs unix PTY; interrupt is a `0x03` byte write everywhere (no reliance on OS signals); default shell chosen per platform (`pwsh`/`cmd` on Windows, `$SHELL`/`bash`/`zsh` on unix) but overridable by setting.

---

## 9. Test Plan

### 9.1 Unit (headless, `MockPty` + mock ports from `ns-testkit`)
- **CLI generation** table-driven per `CliAction` variant → assert exact `program`/`args`/`display`/`runnable`; assert **no secret ever appears inline** (creds → `--context`/file ref, `--token`/`--password` → `***` in `display`, externalized in `runnable`); `temp_files` populated for payload/config bodies; unsupported action → `INVALID_ARGUMENT`.
- **Redaction fuzz:** feed actions carrying token/seed/password fields → property-assert redacted output contains none of the secret substrings.
- **Reader overflow policy:** drive `MockPty` emitting a byte flood into a small bounded sink → assert order preserved, one `Overflow` marker, byte accounting correct, no silent drops under the cap.
- **Session lifecycle:** open → write → resize → close idempotency; double-close → `NOT_FOUND`; cancel token trips reader+waiter; `CredsTempGuard` Drop unlinks the temp path (assert file gone).
- **Command guard:** NatsCli mode rejects `rm -rf`/non-`nats` command via `terminal_run_command` → `PERMISSION_DENIED`; RawShell-disabled `terminal_open{RawShell}` → `PERMISSION_DENIED`.
- **Signal mapping:** `Interrupt/Eof` write `0x03`/`0x04` to the mock writer; `Kill` calls mock `child.kill()`.
- **Runbook executor:** stopOnError halts after a failing step; continueOnError proceeds; confirmEachStep parks and resumes on confirm; cancel mid-run reports partial `Finished`.
- **Error mapping:** every `TerminalError` → correct `ErrorCode`, `retriable`, secret-safe `user_message`.

### 9.2 Integration (real `portable-pty` + real `nats` CLI + embedded `nats-server` via `ns-testkit`)
- Open a NatsCli session against the embedded server → `echo`/`nats server info` produces expected bytes on the Channel; exit code captured.
- Ephemeral context + temp creds: open against an auth-required server → assert `nats stream ls` succeeds (creds materialized) and the temp creds file is 0600 and is unlinked after `terminal_close`.
- `terminal_run_command` runs a generated `nats pub`/`nats sub` and its output streams back; history row written with redacted command + exit code + duration.
- Resize: shrink cols → `stty size`/wrapped output reflects new size.
- Interrupt: start a long `nats sub` → `terminal_signal{Interrupt}` → process stops; session stays alive for the next command.
- Backpressure: a command emitting a large fast output (e.g. `yes`/big `nats stream get`) → session survives, order preserved, at most an `Overflow` marker, reader thread not wedged.
- Runbook of 3 `nats` steps against the server → all `StepFinished`, `Finished{ran:3,failed:0}`, `TaskProgress` observed.
- Missing binary: PATH without `nats` → `TERMINAL_SPAWN_FAILED` (`NatsCliNotFound`) with actionable message.
- Retention: seed history over cap → prune leaves the newest N.

### 9.3 E2E (Tauri harness + WebView + xterm.js + real nats-server)
- Terminal panel → type `nats pub demo hi` → output renders; open a Subscriber panel → message observed (cross-subsystem).
- "Copy as nats CLI" on the Publisher panel → preview shows redacted `display`; Copy works; "Run in terminal" opens a session and runs `runnable`, output rendered.
- Unmount the terminal panel → backend session cancelled (assert via `terminal_list_sessions`/`app_list_tasks`: no leak, and no orphan `connz` connection from the CLI).
- Save a script → reload app → script persists → run → output streams.
- Runbook with `confirmEachStep` → UI parks at step, user confirms → proceeds; a failing step with stopOnError halts and surfaces a `Notification`.
- Raw-shell toggle: off by default (spawn refused); enable in Settings → RawShell session spawns.
- Multi-window: two terminal sessions on different connections do not cross byte streams.

### 9.4 Property / fuzz
- Round-trip: arbitrary bytes (incl. control chars, UTF-8 multibyte split across reads) → base64 chunk → decode → equals original; multibyte sequences never split a code point incorrectly at chunk boundaries (reader emits raw bytes; xterm reassembles).
- `CliAction` → `GeneratedCommand` never emits a shell-injection vector: args are structured, values shell-escaped in `runnable`; proptest random subjects/payloads.

---

## 10. Risks & Open Questions

**Risks**
1. **`nats` binary availability.** ADR-0016 lists `nats` as a prerequisite. If unbundled/missing, terminal is dead. Mitigation: bundle a pinned `nats` per platform (tools/versions.toml), detect on first open, `TERMINAL_SPAWN_FAILED` with an install/repair action; keep RawShell usable without it.
2. **Secret leakage via temp creds files.** Materialized `.creds` on disk is a window. Mitigation: 0600 perms, per-session temp dir under appData, `CredsTempGuard` erase-on-Drop, startup sweep of stale files, and prefer env/context references over inline auth. Consider `nats` context stored encrypted vs plaintext temp — needs security review with `[account-security]`.
3. **Arbitrary shell execution.** RawShell mode is a real RCE-adjacent surface (by design, user-initiated). Mitigation: off by default, gated by setting + capability, audit-logged; NatsCli soft-guard is *best-effort* (a determined user can still run arbitrary things via a `nats exec`-style path) — documented, not a security boundary.
4. **History secret capture.** We persist only app-originated, pre-redacted commands; raw interactive keystrokes are never parsed into history (avoids capturing typed passwords). Risk: users lose "real shell history" — acceptable; the shell's own history file is out of scope.
5. **Byte-stream corruption under flood.** Dropping bytes corrupts terminal rendering. Mitigation: prefer TTY backpressure over dropping; `Overflow` marker only on hard cap; load-tested in 9.2.
6. **Blocking-thread exhaustion.** Each session pins a blocking read thread (+ waiter). Mitigation: session cap, cancel joins threads promptly, watchdog reclaims leaked sessions.
7. **Cross-platform PTY quirks** (ConPTY resize timing, WebKitGTK paste, signal semantics). Mitigation: control-byte interrupt everywhere; matrix E2E on Win/mac/Linux.

**Open questions**
1. **NatsCli mode shape:** interactive shell with preset env + soft guard, vs a bespoke `nats`-only REPL wrapper? Leaning shell-with-guard; needs UX + security sign-off (affects §1.2 guard strength).
2. **Context strategy:** synthesize a real named `nats context` (persisted by the CLI) vs pure env vars (`NATS_URL`/`NATS_CREDS`)? Env vars leave no on-disk context artifact — leaning env vars; confirm with `[connection-manager]` how it exposes auth/tls descriptors.
3. **`CliAction` ownership/extension cadence:** every team adds variants to `ns-types` (SoT) vs each team ships a `CliGeneratorExt`. Proposal: core surface in ns-types + built-in generators here; niche/plugin actions via `CliGeneratorExt`. Needs agreement so the enum doesn't sprawl.
4. **Runbook step completion detection:** how to know a step finished in an interactive shell (sentinel echo / exit-code capture wrapper) vs one-shot child per step? Leaning one-shot child per step for reliable exit codes, with an option to run inside the live session. Confirm.
5. **Does history need output capture** (not just command + exit)? Storing output risks secret/size bloat; default = no output persisted, optional per-run. Coordinate with `[storage]` retention.
6. **Windows default shell** (`pwsh` vs `cmd`) and quoting rules for `runnable` — finalize per-platform escaping so "Run in terminal" is byte-identical to "Copy".
7. **Capability scoping** for RawShell and `terminal_run_command` under the future plugin sandbox (ADR-0014 Phase 2) — how do plugin windows get a reduced terminal capability at runtime?
