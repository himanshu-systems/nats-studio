# Subsystem Design: Connection Manager

Owner: Connection Manager Team
Crates owned: `ns-nats` (L1 adapter), `ns-connection` (L2 service)
Subsystem key: `[connection-manager]`
Status: Draft v1 — implementable
Related SoT: `docs/architecture/00-conventions-and-workspace.md`

---

## 1. Responsibilities & Boundaries

The Connection Manager is the single authority for **establishing, supervising, multiplexing, and tearing down NATS connections**, and for **owning connection profiles** (the persisted recipe for how to connect). Everything else in NATS Studio (pubsub, jetstream, monitor, subject, dashboard) obtains a live `NatsClient` handle *by connection id* from this subsystem — no other crate constructs an async-nats client.

### In scope (this team owns)
- **Profiles**: CRUD, clone, import/export (JSON bundle, `nats context` import), validation, secret references.
- **Auth resolution**: username/password, token, TLS + mTLS, JWT+NKey seed, `.creds` files, NKey-only. (Cryptographic material handling is delegated to `ns-security`; we own the *wiring* of resolved credentials into the async-nats connect options.)
- **TLS setup wiring**: CA bundles, client cert/key, verification modes (full / insecure-skip-verify with explicit opt-in), SNI override. (rustls `ClientConfig` is *built* by `ns-security`; we consume it.)
- **Connection lifecycle & state machine**: `Disconnected → Connecting → Connected → Degraded → Reconnecting → Closed/Failed`.
- **Reconnection**: backoff + jitter policy, max attempts, manual reconnect, server list / discovered-server handling.
- **Health**: ping RTT probes, last-error, server info (`ServerInfo`) negotiation snapshot, lameduck detection.
- **Transport reachability**: SSH tunnel and SOCKS5/HTTP proxy to reach private servers (local listener → forwards to NATS).
- **Multiplexed registry**: N simultaneous connections keyed by `ConnectionId`, each an isolated `ConnectionHandle`.
- **Live status + per-connection metrics** (client-side: bytes/msgs in/out, RTT, reconnect count, current server) emitted as events.

### Explicitly out of scope (consumed from / delegated to others)
- **Crypto & secret storage** → `ns-security` (`SecretStore`, nkeys/jwt/.creds parsing, rustls config builder). We hold only `Redacted<T>` references and keychain keys.
- **Server-side monitoring** (`/varz`, `/connz`, `$SRV`) → `ns-monitor`. We provide client-side metrics only.
- **Actual pub/sub/JS traffic** → `ns-pubsub`, `ns-jetstream` (they borrow our handle).
- **Persistence engine (SQL)** → `ns-storage`. We define the repo *port* usage; `ns-storage` implements `ConnectionProfileRepo`.
- **Tauri glue / event bridging** → `ns-ipc`. We emit domain events via the `EventPublisher` port only.

### Boundary rule (critical)
`ns-nats` is the **only** crate in the workspace permitted to `use async_nats`. `ns-connection` depends on the `NatsClient` / `NatsClientFactory` **traits** from `ns-nats`, never on async-nats types directly. This keeps the domain headless and mockable.

---

## 2. Crate: `ns-nats` (L1 adapter over async-nats)

### 2.1 Purpose
Thin, testable adapter that turns our typed connect spec into a live async-nats client and exposes it behind traits. It hides every async-nats type (`async_nats::Client`, `ConnectOptions`, `ServerAddr`, `Event`) behind our own surface.

### 2.2 Public traits & types

```rust
// crates/ns-nats/src/lib.rs

use std::sync::Arc;
use async_trait::async_trait;
use ns_core::cancel::CancellationToken;

/// Fully-resolved, ready-to-dial spec. Secrets are already materialized
/// (by ns-security) into in-memory redacted forms; this struct never touches
/// the keychain and is dropped/zeroized ASAP after connect.
pub struct NatsConnectSpec {
    pub servers: Vec<String>,              // nats:// / tls:// URLs (post tunnel/proxy rewrite)
    pub name: String,                      // client connection name shown in connz
    pub auth: ResolvedAuth,
    pub tls: Option<Arc<rustls::ClientConfig>>, // built by ns-security
    pub tls_required: bool,
    pub ping_interval: std::time::Duration,
    pub connect_timeout: std::time::Duration,
    pub max_reconnects: Option<usize>,     // None = handled by our supervisor, we disable inner
    pub no_echo: bool,
    pub inbox_prefix: Option<String>,
    pub sni_override: Option<String>,
}

pub enum ResolvedAuth {
    Anonymous,
    UserPass { user: String, pass: Redacted<String> },
    Token(Redacted<String>),
    Creds(Redacted<String>),               // full .creds file contents
    JwtNkey { jwt: String, seed: Redacted<String> },
    NkeyOnly { seed: Redacted<String> },
}

/// Lifecycle events surfaced by the underlying client (mapped from async_nats::Event).
#[derive(Clone, Debug)]
pub enum ClientEvent {
    Connected,
    Disconnected,
    Reconnected,
    LameDuckMode,
    SlowConsumer { subject: Option<String> },
    ServerError(String),
    ClientError(String),
}

/// The adapter port every feature crate depends on. Object-safe.
#[async_trait]
pub trait NatsClient: Send + Sync {
    fn server_info(&self) -> Option<ServerInfoDto>;    // from async_nats::ServerInfo
    fn connection_state(&self) -> ClientState;         // Pending/Connected/Disconnected
    async fn rtt(&self) -> Result<std::time::Duration, NatsError>;
    async fn flush(&self) -> Result<(), NatsError>;
    fn stats(&self) -> ClientStats;                    // in/out bytes+msgs, reconnects
    async fn drain(&self) -> Result<(), NatsError>;    // graceful
    /// Raw handle escape hatch for feature crates that need async-nats primitives.
    /// Returns a trait object; concrete downcast lives inside ns-nats-owned wrappers
    /// used by ns-pubsub/ns-jetstream (they receive `Arc<dyn NatsClient>` and call
    /// typed methods on a re-exported facade, never async_nats directly).
    fn as_any(&self) -> &dyn std::any::Any;
}

/// Factory port — the seam mocked in tests. The bin injects the real impl.
#[async_trait]
pub trait NatsClientFactory: Send + Sync {
    async fn connect(
        &self,
        spec: NatsConnectSpec,
        events: tokio::sync::mpsc::Sender<ClientEvent>,
        cancel: CancellationToken,
    ) -> Result<Arc<dyn NatsClient>, NatsError>;
}

#[derive(Clone, Debug)]
pub enum ClientState { Pending, Connected, Disconnected }

#[derive(Clone, Debug, Default)]
pub struct ClientStats {
    pub in_msgs: u64,
    pub out_msgs: u64,
    pub in_bytes: u64,
    pub out_bytes: u64,
    pub reconnects: u64,
}
```

Real impl `AsyncNatsFactory` builds `async_nats::ConnectOptions` from `NatsConnectSpec`:
- disables async-nats' own infinite retry when our supervisor owns reconnection (`.retry_on_initial_connect()` off, `.max_reconnects(0)`), OR delegates to inner retry when configured (policy flag). Default: **our supervisor owns reconnect** so we can emit typed state + backoff telemetry; inner retry is used only as a fast-path fallback.
- installs an event callback that forwards `async_nats::Event` → `ClientEvent` into the `events` mpsc.
- applies `tls_required`, custom `rustls::ClientConfig`, name, inbox prefix, ping interval, auth.

### 2.3 `ns-nats` error enum

```rust
#[derive(thiserror::Error, Debug)]
pub enum NatsError {
    #[error("connection timed out")] Timeout,
    #[error("connection closed")] Closed,
    #[error("authentication failed: {0}")] Auth(String),
    #[error("tls error: {0}")] Tls(String),
    #[error("no servers reachable")] NoServers,
    #[error(transparent)] Connect(#[from] async_nats::ConnectError),
    #[error(transparent)] Request(#[from] async_nats::RequestError),
    #[error("{0}")] Other(String),
}
```
Implements `ns_core::DomainError` → maps to `CONNECTION_TIMEOUT`, `CONNECTION_CLOSED`, `AUTH_FAILED`, `TLS_ERROR`, etc.

---

## 3. Crate: `ns-connection` (L2 service)

### 3.1 Module layout
```
crates/ns-connection/src/
├─ lib.rs              # ConnectionService trait + re-exports
├─ service.rs         # DefaultConnectionService (impl)
├─ registry.rs        # ConnectionHandle registry (DashMap)
├─ handle.rs          # ConnectionHandle, per-connection state + tasks
├─ state_machine.rs   # ConnState transitions, guards
├─ reconnect.rs       # BackoffPolicy (exp + jitter), supervisor loop
├─ health.rs          # RTT prober, degraded detection
├─ profile.rs         # ProfileService: CRUD/clone/import/export/validate
├─ resolve.rs         # profile + secrets -> NatsConnectSpec (via ns-security)
├─ transport/
│  ├─ mod.rs          # Transport trait, LocalForwarder
│  ├─ direct.rs       # no-op passthrough
│  ├─ ssh.rs          # SSH tunnel (russh) local listener -> remote NATS
│  └─ proxy.rs        # SOCKS5 / HTTP CONNECT forwarder
├─ metrics.rs         # per-connection metric sampler -> events
└─ error.rs           # ConnectionError
```

### 3.2 The core service trait

```rust
// crates/ns-connection/src/lib.rs
use async_trait::async_trait;
use ns_types::{ConnectionId, ProfileId};
use ns_types::connection::*;   // DTOs (see §6)

#[async_trait]
pub trait ConnectionService: Send + Sync {
    // ---- Profiles ----
    async fn list_profiles(&self) -> Result<Vec<ConnectionProfileDto>, ConnectionError>;
    async fn get_profile(&self, id: ProfileId) -> Result<ConnectionProfileDto, ConnectionError>;
    async fn create_profile(&self, req: CreateProfileRequest) -> Result<ConnectionProfileDto, ConnectionError>;
    async fn update_profile(&self, req: UpdateProfileRequest) -> Result<ConnectionProfileDto, ConnectionError>;
    async fn delete_profile(&self, id: ProfileId) -> Result<(), ConnectionError>;
    async fn clone_profile(&self, req: CloneProfileRequest) -> Result<ConnectionProfileDto, ConnectionError>;
    async fn import_profiles(&self, req: ImportProfilesRequest) -> Result<ImportProfilesResponse, ConnectionError>;
    async fn export_profiles(&self, req: ExportProfilesRequest) -> Result<ExportBundleDto, ConnectionError>;
    /// Dial with a throwaway spec WITHOUT persisting a profile (the "Test connection" button).
    async fn test_profile(&self, req: TestConnectionRequest) -> Result<TestConnectionReport, ConnectionError>;

    // ---- Lifecycle ----
    /// Open a live connection from a stored profile (or an ephemeral inline spec).
    async fn connect(&self, req: ConnectRequest) -> Result<ConnectionStatusDto, ConnectionError>;
    async fn disconnect(&self, id: ConnectionId) -> Result<(), ConnectionError>;
    async fn reconnect_now(&self, id: ConnectionId) -> Result<ConnectionStatusDto, ConnectionError>;

    // ---- Introspection ----
    async fn list_connections(&self) -> Result<Vec<ConnectionStatusDto>, ConnectionError>;
    async fn get_status(&self, id: ConnectionId) -> Result<ConnectionStatusDto, ConnectionError>;
    async fn get_server_info(&self, id: ConnectionId) -> Result<ServerInfoDto, ConnectionError>;
    async fn ping(&self, id: ConnectionId) -> Result<RttSampleDto, ConnectionError>;
    async fn get_metrics(&self, id: ConnectionId) -> Result<ConnMetricsDto, ConnectionError>;

    // ---- Internal port used by other L2 crates (NOT an IPC command) ----
    /// Feature crates (pubsub/jetstream/monitor/subject) obtain the live client here.
    async fn client(&self, id: ConnectionId) -> Result<Arc<dyn NatsClient>, ConnectionError>;
}
```

`client()` is the linchpin: it is how the whole rest of the app gets a connection. It returns an `Err(CONNECTION_CLOSED)` if the connection is not currently `Connected`, so callers get a typed, retriable error rather than a panic.

### 3.3 `ConnectionHandle` + registry

```rust
// handle.rs
pub struct ConnectionHandle {
    pub id: ConnectionId,
    pub profile_id: Option<ProfileId>,     // None for ephemeral
    pub state: watch::Sender<ConnState>,   // observable state machine
    pub client: ArcSwapOption<dyn NatsClient>, // hot-swapped on reconnect
    pub stats: Arc<Mutex<ConnMetrics>>,
    pub transport: Option<Box<dyn Transport>>, // SSH/proxy forwarder kept alive
    pub cancel: CancellationToken,         // trips supervisor + probes + transport
    pub tasks: TaskSet,                    // supervisor, prober, metric sampler
    pub last_error: Arc<Mutex<Option<IpcError>>>,
}

// registry.rs
pub struct ConnectionRegistry {
    handles: DashMap<ConnectionId, Arc<ConnectionHandle>>,
}
```
`ArcSwapOption` lets a reconnect replace the underlying `NatsClient` atomically without a global lock, so in-flight readers keep working and the new client is picked up on the next `client()` call.

### 3.4 State machine

```rust
// state_machine.rs
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]  // -> ns-types mirror
pub enum ConnState {
    Idle,          // handle created, not yet dialing
    Connecting,    // first dial in progress
    Connected,     // healthy
    Degraded,      // connected but RTT high / slow consumer / lameduck advisory
    Reconnecting,  // lost, supervisor backing off
    Draining,      // graceful shutdown in progress
    Closed,        // user-initiated stop, terminal
    Failed,        // gave up (max attempts) / fatal auth-tls error, terminal
}
```
Transitions are centralized (`fn transition(cur, ev) -> ConnState`) and are the sole writer to the `watch` channel; each transition emits `ConnectionStatusChanged`. Fatal errors (`AUTH_FAILED`, `TLS_ERROR`, `PERMISSION_DENIED`) go straight to `Failed` (not retried) unless the user hits reconnect.

### 3.5 Reconnection policy

```rust
// reconnect.rs
pub struct BackoffPolicy {
    pub initial: Duration,   // default 250ms
    pub max: Duration,       // default 30s
    pub factor: f64,         // default 2.0
    pub jitter: f64,         // default 0.3 (full-ish jitter fraction)
    pub max_attempts: Option<u32>, // None = infinite until user stops
    pub reset_after: Duration,     // stable-connected time that resets attempt count
}
impl BackoffPolicy { fn next_delay(&self, attempt: u32) -> Duration; }
```
The supervisor task owns the loop: on `Disconnected` client event → `Reconnecting`, compute `next_delay(attempt)`, sleep (cancellable), rebuild spec (re-resolving secrets in case of rotation), redial via factory, on success hot-swap client + `Connected` + emit `Reconnected`. `reset_after` of stable uptime resets `attempt` to 0.

### 3.6 Health / RTT prober
A per-connection task pings every `ping_interval` (default 10s), records RTT into a bounded ring (last 60 samples). If RTT exceeds `degraded_rtt_threshold` (default 750ms) for K consecutive samples, or a `SlowConsumer`/`LameDuckMode` client event fires → `Degraded`; recovery restores `Connected`.

### 3.7 Transport (SSH / proxy) to private servers

```rust
// transport/mod.rs
#[async_trait]
pub trait Transport: Send + Sync {
    /// Start local forwarder(s); returns rewritten server URLs pointing at
    /// 127.0.0.1:<ephemeral> that tunnel to the real NATS endpoints.
    async fn establish(&self, targets: &[ServerEndpoint], cancel: CancellationToken)
        -> Result<Vec<String>, ConnectionError>;
    async fn shutdown(&self);
    fn kind(&self) -> TransportKind; // Direct | Ssh | Socks5 | HttpConnect
}
```
- **Direct**: returns targets unchanged.
- **SSH** (`russh` client): auth via password / private key (key material via `ns-security`), opens `direct-tcpip` channels; a local `TcpListener` proxies each accepted socket to a forwarded channel. Host-key verification with a known-hosts store (TOFU prompt surfaced as a typed error → UI confirm → stored fingerprint).
- **SOCKS5 / HTTP CONNECT** (`tokio-socks` / manual CONNECT): dial the NATS host through the proxy; local listener bridges. Optional proxy auth.

The transport is created during `connect()` *before* the factory dials, and its lifetime is tied to the `ConnectionHandle` (dropped on disconnect → listeners closed). If TLS is enabled, `sni_override` ensures the cert is validated against the real hostname, not `127.0.0.1`.

### 3.8 Resolution pipeline (`resolve.rs`)
`ConnectionProfileDto` + secret refs → `NatsConnectSpec`:
1. Load non-secret profile from `ConnectionProfileRepo`.
2. Ask `ns-security::SecretStore` to fetch secrets by keychain ref (password/token/seed/creds/ssh key/cert key), returning `Redacted<T>`.
3. Ask `ns-security` to build `rustls::ClientConfig` from CA bundle + client cert/key + verification mode + SNI.
4. Establish transport → rewrite server URLs.
5. Assemble `NatsConnectSpec`. Spec is consumed by the factory then dropped (secrets zeroized).

### 3.9 `ConnectionError`

```rust
#[derive(thiserror::Error, Debug)]
pub enum ConnectionError {
    #[error("connection not found: {0}")] NotFound(ConnectionId),
    #[error("profile not found: {0}")] ProfileNotFound(ProfileId),
    #[error("connection not open")] NotConnected,
    #[error("invalid profile: {0}")] InvalidProfile(String),
    #[error(transparent)] Nats(#[from] ns_nats::NatsError),
    #[error(transparent)] Security(#[from] ns_security::SecurityError),
    #[error(transparent)] Storage(#[from] ns_storage::StorageError),
    #[error("ssh tunnel failed: {0}")] SshTunnel(String),
    #[error("proxy failed: {0}")] Proxy(String),
    #[error("host key not trusted: {fingerprint}")] HostKeyUntrusted { fingerprint: String },
    #[error("operation cancelled")] Cancelled,
}
```
`DomainError` mapping: `NotFound`→`NOT_FOUND`, `NotConnected`→`CONNECTION_CLOSED` (retriable), `InvalidProfile`→`INVALID_ARGUMENT`, `Nats`/`Security`/`Storage` delegate to inner, `SshTunnel`/`Proxy`→`CONNECTION_TIMEOUT` (retriable), `HostKeyUntrusted`→`TLS_ERROR` (not retriable, actionable), `Cancelled`→`CANCELLED`.

---

## 4. Tauri IPC Commands

All live in `ns-ipc` command module `commands/connection.rs`, delegating to `AppState.connections`. Every command is `async fn(...) -> Result<T, IpcError>`, one `req` arg. Kinds: **request** (unary), **command** (side-effect unary), **stream** (Channel). Streaming here is minimal — status flows via ambient events (see §5); a single opt-in metrics stream uses a Channel.

| Command | Kind | Request | Returns | Primary error codes |
|---|---|---|---|---|
| `connection_list_profiles` | request | `()` | `Vec<ConnectionProfileDto>` | `STORAGE` |
| `connection_get_profile` | request | `GetProfileRequest{ profileId }` | `ConnectionProfileDto` | `NOT_FOUND` |
| `connection_create_profile` | command | `CreateProfileRequest` | `ConnectionProfileDto` | `INVALID_ARGUMENT`, `SECRET_STORE_UNAVAILABLE`, `STORAGE` |
| `connection_update_profile` | command | `UpdateProfileRequest` | `ConnectionProfileDto` | `NOT_FOUND`, `INVALID_ARGUMENT`, `STORAGE` |
| `connection_delete_profile` | command | `DeleteProfileRequest{ profileId }` | `()` | `NOT_FOUND`, `STORAGE` |
| `connection_clone_profile` | command | `CloneProfileRequest{ profileId, newName }` | `ConnectionProfileDto` | `NOT_FOUND`, `STORAGE` |
| `connection_import_profiles` | command | `ImportProfilesRequest{ bundle, format, secretsPolicy }` | `ImportProfilesResponse` | `INVALID_ARGUMENT`, `STORAGE` |
| `connection_export_profiles` | request | `ExportProfilesRequest{ profileIds, includeSecrets }` | `ExportBundleDto` | `NOT_FOUND`, `SECRET_STORE_UNAVAILABLE` |
| `connection_test` | command | `TestConnectionRequest{ spec }` | `TestConnectionReport` | `CONNECTION_TIMEOUT`, `AUTH_FAILED`, `TLS_ERROR`, `NO_RESPONDERS` |
| `connection_connect` | command | `ConnectRequest{ profileId? , inlineSpec? }` | `ConnectionStatusDto` | `NOT_FOUND`, `AUTH_FAILED`, `TLS_ERROR`, `CONNECTION_TIMEOUT` |
| `connection_disconnect` | command | `DisconnectRequest{ connectionId }` | `()` | `NOT_FOUND` |
| `connection_reconnect` | command | `ReconnectRequest{ connectionId }` | `ConnectionStatusDto` | `NOT_FOUND`, `CONNECTION_TIMEOUT` |
| `connection_list` | request | `()` | `Vec<ConnectionStatusDto>` | — |
| `connection_get_status` | request | `GetStatusRequest{ connectionId }` | `ConnectionStatusDto` | `NOT_FOUND` |
| `connection_get_server_info` | request | `GetServerInfoRequest{ connectionId }` | `ServerInfoDto` | `NOT_FOUND`, `CONNECTION_CLOSED` |
| `connection_ping` | command | `PingRequest{ connectionId }` | `RttSampleDto` | `CONNECTION_CLOSED`, `REQUEST_TIMEOUT` |
| `connection_get_metrics` | request | `GetMetricsRequest{ connectionId }` | `ConnMetricsDto` | `NOT_FOUND` |
| `connection_stream_metrics` | **stream** | `StreamMetricsRequest{ connectionId, intervalMs }` → `Channel<ConnMetricsFrame>` returns `SubscriptionId` | `SubscriptionId` | `NOT_FOUND` |
| `connection_stream_metrics_cancel` | command | `CancelRequest{ subscriptionId }` | `()` | — |
| `connection_trust_host_key` | command | `TrustHostKeyRequest{ profileId, fingerprint }` | `()` | `NOT_FOUND` |

Notes:
- `inlineSpec` on `connect` allows connecting without saving (still requires transient secrets which are not persisted).
- `connection_test` never mutates the registry or storage; it dials, negotiates, pings, and drains.
- `secretsPolicy` on import: `Skip | PromptLater | InlineEncrypted` — imported bundles with inline secrets are decrypted and re-stored in the keychain.

---

## 5. Events emitted

All emitted via the `EventPublisher` port into `ns-event`; `ns-ipc::EventBridge` forwards to Tauri. Payload variants live in `ns-types` `EventPayload`.

| Domain event (bus) | Tauri event name | Payload | Coalescing policy |
|---|---|---|---|
| `ConnectionStatusChanged` | `ns://connection/status` | `ConnStatusChangedPayload{ connectionId, state, prevState, serverUrl?, lastError?, ts }` | dedupe identical states; always deliver transitions |
| `ServerInfoUpdated` | `ns://server/info` | `ServerInfoDto` (+ connectionId) | keep-latest per connection |
| `MetricsTick` (client-side) | `ns://monitor/metrics` | `ConnMetricsFrame{ connectionId, rttMs, inMsgs, outMsgs, inBytes, outBytes, reconnects, ts }` | keep-latest per (connectionId) within 250ms tick |
| `Notification` | `ns://notification` | reconnect exhausted / host-key TOFU prompt / lameduck advisory | never drop |

The `connection_stream_metrics` Channel is an alternative pull-scoped path for a focused connection detail view that wants a tighter, per-connection cadence than the coalesced global `MetricsTick`. Ambient status changes always go over `ns://connection/status`, so the connection list stays live without any open Channel.

---

## 6. Data model — DTOs & SQLite tables

### 6.1 DTOs (in `ns-types`, `connection` module, typeshared, camelCase)

```rust
pub struct ConnectionId(pub Uuid);   // newtype, serialized as string
pub struct ProfileId(pub Uuid);

pub struct ConnectionProfileDto {
    pub id: ProfileId,
    pub name: String,
    pub color: Option<String>,            // UI tag color
    pub folder: Option<String>,           // grouping
    pub servers: Vec<String>,             // nats:// urls
    pub auth: AuthConfigDto,              // discriminated union (tag=kind,content=data)
    pub tls: Option<TlsConfigDto>,
    pub transport: TransportConfigDto,    // Direct | Ssh | Socks5 | HttpConnect
    pub options: ConnectionOptionsDto,    // name, noEcho, inboxPrefix, pingIntervalMs, connectTimeoutMs
    pub reconnect: ReconnectPolicyDto,
    pub createdAt: String,                // RFC-3339
    pub updatedAt: String,
}

// tag="kind", content="data"
pub enum AuthConfigDto {
    Anonymous,
    UserPassword { user: String, passwordRef: SecretRef },
    Token { tokenRef: SecretRef },
    Creds { credsRef: SecretRef },
    JwtNkey { jwt: String, seedRef: SecretRef },
    NkeyOnly { seedRef: SecretRef },
}

pub struct TlsConfigDto {
    pub mode: TlsVerifyMode,              // Full | InsecureSkipVerify | PinnedCert
    pub caBundleRef: Option<SecretRef>,   // or file path
    pub clientCert: Option<ClientCertDto>,// cert (public) + keyRef (secret)
    pub sni: Option<String>,
    pub pinnedSha256: Option<String>,
}

pub enum TransportConfigDto {
    Direct,
    Ssh { host: String, port: u16, user: String, authRef: SecretRef, knownHostFingerprint: Option<String> },
    Socks5 { host: String, port: u16, authRef: Option<SecretRef> },
    HttpConnect { host: String, port: u16, authRef: Option<SecretRef> },
}

pub struct ReconnectPolicyDto {
    pub enabled: bool, pub initialMs: u64, pub maxMs: u64,
    pub factor: f64, pub jitter: f64, pub maxAttempts: Option<u32>,
}

pub struct ConnectionStatusDto {
    pub connectionId: ConnectionId,
    pub profileId: Option<ProfileId>,
    pub name: String,
    pub state: ConnStateDto,              // mirrors ConnState
    pub currentServer: Option<String>,
    pub connectedSince: Option<String>,
    pub reconnectAttempts: u32,
    pub lastError: Option<IpcError>,
    pub rttMs: Option<u64>,
}

pub struct ServerInfoDto { /* server_id, server_name, version, proto, host, port,
    maxPayload, jetstream, tls_required, auth_required, cluster?, connect_urls[], lameDuckMode */ }

pub struct ConnMetricsDto { pub inMsgs:u64, pub outMsgs:u64, pub inBytes:u64,
    pub outBytes:u64, pub reconnects:u64, pub rttSamplesMs: Vec<u64> }

pub struct SecretRef(pub String); // opaque keychain key; NEVER contains the secret
```

`SecretRef` is the only thing persisted for secrets — the actual value lives in the OS keychain (or encrypted fallback) via `ns-security`. The DTO layer, IPC wire, and SQLite never carry raw secrets.

### 6.2 SQLite tables (owned; migrations in `ns-storage/migrations`)

```sql
-- 0002_connection_profiles.sql
CREATE TABLE connection_profile (
  id            TEXT PRIMARY KEY,          -- ProfileId (uuid)
  name          TEXT NOT NULL,
  color         TEXT,
  folder        TEXT,
  servers       TEXT NOT NULL,             -- JSON array
  auth_json     TEXT NOT NULL,             -- AuthConfigDto (secret REFS only)
  tls_json      TEXT,                      -- TlsConfigDto
  transport_json TEXT NOT NULL,            -- TransportConfigDto
  options_json  TEXT NOT NULL,
  reconnect_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_profile_folder ON connection_profile(folder);

-- 0003_known_hosts.sql  (SSH TOFU store)
CREATE TABLE ssh_known_host (
  host TEXT NOT NULL, port INTEGER NOT NULL,
  fingerprint TEXT NOT NULL, added_at TEXT NOT NULL,
  PRIMARY KEY (host, port)
);

-- 0004_connection_session_history.sql  (bounded, non-secret audit)
CREATE TABLE connection_session (
  id TEXT PRIMARY KEY, profile_id TEXT,
  opened_at TEXT NOT NULL, closed_at TEXT,
  outcome TEXT NOT NULL,       -- connected | failed | cancelled
  last_error_code TEXT, server_url TEXT
);
```
Repos implementing `ns-core` ports: `ConnectionProfileRepo`, `KnownHostRepo`, `ConnectionSessionRepo`. Retention on `connection_session` enforced by the storage worker (size + TTL).

---

## 7. Dependencies

**`ns-nats` depends on:** `ns-types`, `ns-core`, `async-nats`, `rustls`, `async-trait`, `tokio`.

**`ns-connection` depends on:** `ns-types`, `ns-core`, `ns-event`, `ns-nats`, `ns-security`, `ns-storage` (repo ports via ns-core — concrete impls injected by bin), `russh`, `tokio-socks`, `arc-swap`, `dashmap`, `tokio`, `async-trait`, `thiserror`.

**Consumed ports (from `ns-core`, injected by bin):** `EventPublisher`, `SecretStore`, `Clock`, `ConnectionProfileRepo`, `KnownHostRepo`, `ConnectionSessionRepo`, `TlsConfigBuilder` (ns-security).

**Depended on by:** `ns-pubsub`, `ns-jetstream`, `ns-subject` (all call `ConnectionService::client(id)`), `ns-dashboard` (composes `ConnectionService` snapshots), `ns-ipc`/bin (commands + bridge). `ns-monitor` depends on us only for the resolved monitoring URL/host of a connection, not the client.

**Composition root (bin):** constructs `AsyncNatsFactory`, `DefaultConnectionService::new(factory, secret_store, repos, event_publisher, clock)`, inserts `Arc<dyn ConnectionService>` into `AppState`.

---

## 8. Concurrency, async & backpressure

- **Per-connection isolation**: each `ConnectionHandle` owns its own tasks (supervisor, RTT prober, metric sampler) and a single `CancellationToken`; disconnect trips the token → all tasks + transport listeners stop; no shared lock across connections (`DashMap` + `ArcSwap`).
- **Never block the UI**: all IPC commands are async; dialing, tunnels, and drains run on tokio tasks. `connect()` returns as soon as the initial dial resolves (or the first backoff kicks in if `waitForReady=false`).
- **Event backpressure**: the client `ClientEvent` mpsc is bounded (cap 64); on lag we keep the latest state-relevant events (Disconnected/Reconnected/LameDuck are coalesced by the state machine anyway). Metrics use keep-latest coalescing at the bridge (250ms). The Channel-based `connection_stream_metrics` uses a bounded buffer with keep-latest overflow (`droppedSinceLast`).
- **Reconnect storms**: backoff+jitter prevents thundering herd across N connections; `reset_after` avoids attempt-count inflation on flappy links. `max_attempts` bounds infinite loops → `Failed` + non-drop `Notification`.
- **Hot-swap safety**: `ArcSwapOption<dyn NatsClient>` — readers `load()` a snapshot `Arc`; a reconnect stores a new client; in-flight ops on the old client either complete or error (retriable) and the caller re-fetches via `client()`.
- **Secret lifetime**: `NatsConnectSpec` holds `Redacted<T>` secrets only for the duration of a dial; dropped/zeroized after. Re-resolved on each reconnect to pick up rotated creds.
- **Cancellation correctness**: `test_profile`/`connect` honor a `CancellationToken` so a user cancelling a slow dial (e.g. dead SSH host) tears down the half-open tunnel immediately.

---

## 9. Test plan

### Unit (no network; `ns-testkit` mocks)
- **State machine**: exhaustive transition table tests (every `(state, event)` pair), terminal-state guards, fatal-vs-retriable classification.
- **BackoffPolicy**: delay growth, cap, jitter bounds (statistical), `reset_after`, `max_attempts` exhaustion.
- **Resolution**: profile+secret-refs → `NatsConnectSpec` for each `AuthConfigDto` variant using a `MockSecretStore`; assert secrets are `Redacted` and never logged (capture `tracing` output, assert no seed/pass substring).
- **Profile service**: CRUD/clone/import/export round-trips against an in-memory `ConnectionProfileRepo`; import format parsing incl. `nats context` JSON; export redaction (`includeSecrets=false` strips refs).
- **Registry**: concurrent connect/disconnect of many ids (loom-style / `tokio::test` with many tasks), no leaks, `client()` returns `NotConnected` when appropriate.
- **Error mapping**: each `ConnectionError` → expected `ErrorCode` + `retriable`.

### Integration (real `nats-server` via `ns-testkit` fixture)
- **Auth matrix**: spin up `nats-server` configured for each mode (user/pass, token, TLS, mTLS, JWT+NKey via a test operator/account, `.creds`, NKey-only); assert `connect` succeeds and `AUTH_FAILED`/`TLS_ERROR` on bad creds.
- **TLS**: full verify (good CA), pinned cert, insecure-skip (explicit), SNI override, mTLS client-cert required; wrong CA → `TLS_ERROR`.
- **Reconnection**: kill/restart the server mid-connection; assert `Connected→Reconnecting→Connected`, `Reconnected` event, attempt counter reset after stable uptime, client hot-swap works (a subsequent `ping` succeeds).
- **Multiplex**: open 10 connections to 2 servers; assert isolation (kill one server, others stay `Connected`).
- **Health**: inject latency (toxiproxy-style or a slow proxy) → `Degraded`; recover → `Connected`.
- **Metrics**: publish/consume via a helper, assert `ConnMetricsDto` counters advance and RTT samples populate.
- **Transport**: SSH tunnel to a `nats-server` bound to loopback behind a test sshd container; SOCKS5 via a local socks server; assert connect through tunnel + `sni_override` validates the real host cert.

### E2E (Tauri harness + WebView)
- Create profile → Test connection (green) → Connect → status pill goes live via `ns://connection/status` → open metrics stream → disconnect. Assert no leaked tasks (registry empty) and Channel cancelled on view unmount.
- Import a `nats` CLI context bundle → profile appears; export without secrets → re-import prompts for secrets.
- Kill server from a script → UI shows `Reconnecting` then `Connected`; exhaust attempts → `Failed` + notification toast.

### Property / fuzz
- Fuzz `.creds`/JWT/profile-JSON parsers (delegated types from `ns-security`) at our boundary for graceful `INVALID_ARGUMENT`, never panic (bridge catches panics anyway, but assert none).

---

## 10. Frontend surface

### Routes (React Router)
- `/connections` — Connection Manager home (list + folders).
- `/connections/:profileId/edit` — profile editor (modal or route).
- `/connections/new` — create wizard.
- Global **Connection Switcher** in the app top bar (always mounted).

### Panels / components (`src/features/connections/`)
- `ConnectionListPanel` — grouped by folder, status pill (green/yellow/red/grey per `ConnState`), RTT badge, quick connect/disconnect.
- `ConnectionEditor` — tabbed: General, Auth (variant-driven form), TLS, Transport (SSH/Proxy), Advanced (reconnect/ping/options). Uses Monaco for pasting `.creds`/CA PEM (never echoed back; stored as secret ref).
- `ConnectionSwitcher` — top-bar dropdown, active-connection selection (Zustand), multi-select for split views.
- `ConnectionStatusPill` + `ConnectionDetailDrawer` — live status, server info, RTT sparkline (ECharts) fed by metrics stream.
- `TestConnectionButton` — calls `connection_test`, renders `TestConnectionReport`.
- `HostKeyTrustDialog` — TOFU prompt on `HostKeyUntrusted`.
- `ImportExportDialog`.

### Zustand store (`stores/connectionUi.ts`) — UI/session only
- `activeConnectionId`, `openConnectionIds[]` (for split views), `switcherOpen`, `editorDraft` (unsaved form buffer), `detailDrawerOpen`, per-list `filter/sort`, `selectedFolder`. **No server-state mirrored here.**

### TanStack Query keys (server-state)
- `['connection','profiles']` → `connection_list_profiles`
- `['connection','profile', profileId]` → `connection_get_profile`
- `['connection','list']` → `connection_list`
- `['connection','status', connectionId]` → `connection_get_status`
- `['connection','serverInfo', connectionId]` → `connection_get_server_info`
- `['connection','metrics', connectionId]` → `connection_get_metrics`

Mutations (`connect/disconnect/reconnect/create/update/delete/clone/import`) invalidate `['connection','list']` and the relevant profile/status keys. `IpcError.retriable` drives retry.

### Event integration
`useAppEvents()` routes `ns://connection/status` and `ns://server/info` into the query cache via `queryClient.setQueryData(['connection','list'], …)` and per-connection status keys — the list stays live with **zero polling**. `useConnectionMetricsStream(connectionId)` owns a `connection_stream_metrics` Channel, folds frames into `['connection','metrics', id]`, and calls `connection_stream_metrics_cancel` on unmount.

### IPC client calls (`packages/ns-bindings`)
`ipc.connection.listProfiles()`, `.createProfile(req)`, `.connect(req)`, `.disconnect(req)`, `.reconnect(req)`, `.test(req)`, `.getServerInfo(req)`, `.streamMetrics(req, channel)`, `.trustHostKey(req)`, etc. — generated from `commands.manifest.ts`, typed against `ns-types`.

---

## 11. Risks & open questions

**Risks**
- **async-nats reconnect ownership overlap**: async-nats has its own reconnection. Running our supervisor *and* its retry can double-reconnect. Decision: disable inner reconnect (`max_reconnects(0)`) by default so our state machine is authoritative; document the fallback flag. Needs careful validation that async-nats surfaces a clean `Disconnected` event on drop.
- **Raw handle escape hatch**: `NatsClient::as_any()` downcasting for pubsub/jetstream leaks the concrete type across the trait boundary. Mitigation: provide a typed facade in `ns-nats` (re-exported) so feature crates never touch `async_nats` directly; revisit if it proves leaky.
- **SSH/proxy surface area**: `russh` host-key verification, key formats, and keepalive are fiddly and a security-sensitive path. Bound scope to password + private-key auth v1; agent-forwarding later.
- **Secret zeroization guarantees**: `Redacted<T>` must actually zeroize (use `zeroize` crate). Coordinate with `ns-security` to guarantee no `Clone` leaks into logs/spec copies.
- **Metrics fidelity**: async-nats exposes limited client stats; some counters (per-subject) are unavailable client-side. Set expectations that rich metrics come from `ns-monitor` (server-side `/connz`).
- **TLS through tunnel**: SNI/hostname mismatch when dialing `127.0.0.1` local forwarder. Mitigated via `sni_override` + `ServerName` override in rustls config — must be verified per platform.

**Open questions**
1. Should ephemeral (unsaved) connections be allowed to persist secrets transiently across app restart, or die with the session? (Proposed: session-only.)
2. Import format canonicalization — do we support `nats context` directory import and `.creds` bundles in v1, or JSON-only? (Proposed: JSON bundle + single `.creds` in v1.)
3. Multi-window: when the same connection is open in two windows, is the registry shared (single client) or per-window? SoT implies shared backend registry with window-scoped event emission — confirm the switcher UX for "who owns disconnect".
4. Do we expose `waitForReady` (block until first successful connect) vs. fire-and-forget connect as a per-call flag or a profile setting? (Proposed: per-call flag, default true for the "Connect" button, false for auto-connect-on-startup.)
5. Health thresholds (degraded RTT, K consecutive samples) — global setting vs per-profile? (Proposed: global default overridable per profile in Advanced.)
```
