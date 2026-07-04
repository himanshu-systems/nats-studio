# Subsystem Design — Monitoring (`[monitoring]`)

**Owning team:** Monitoring Team
**Primary crate:** `ns-monitor` (`crates/ns-monitor`, L2 feature service)
**Subsystem prefix:** `monitor_*` (IPC), `ns://monitor/*` (events)
**Status:** Design v1 (implementable)

> This document conforms to THE ARCHITECTURAL SPINE. It does not introduce new deps outside the pins, does not import `async-nats` (that stays in `ns-nats`), and uses `ns-types` as the single DTO source of truth. Where this subsystem needs NATS request/reply (for `$SYS` account queries) it goes through the `NatsClient` port, never `async-nats` directly.

---

## a) Responsibilities & Boundaries

### In scope (this subsystem owns)
1. **HTTP monitoring endpoint polling** against a NATS server's monitoring port (`reqwest`, ADR-0015):
   `/varz`, `/connz`, `/routez`, `/subsz`, `/gatewayz`, `/leafz`, `/accountz`, `/accstatz`, `/healthz`, `/jsz`.
2. **`$SYS` system-account equivalents** over NATS (request/reply) where a monitoring port is not exposed but a system-account user is available:
   `$SYS.REQ.SERVER.PING.VARZ|CONNZ|ROUTEZ|SUBSZ|GATEWAYZ|LEAFZ|JSZ|ACCOUNTZ|HEALTHZ`, `$SYS.REQ.SERVER.<id>.<KIND>`, and `$SYS.REQ.ACCOUNT.<acct>.CONNZ|SUBSZ|JSZ|INFO`. Multi-server fan-in (PING replies aggregated per server id).
3. **Polling scheduler**: per-connection, per-endpoint configurable intervals, jitter, adaptive backoff on failure, pause/resume, on-demand refresh.
4. **Response caching + diffing**: keep the latest snapshot per (connection, endpoint, serverId, scope) and compute a structural diff vs. previous snapshot to drive incremental UI updates and reduce IPC payloads.
5. **Bounded metric time-series ring buffers**: derive rate/gauge series (msgs/s, bytes/s, connections, slow consumers, mem, cpu, JS bytes, consumer lag) from successive `varz`/`jsz`/`connz` snapshots; fixed capacity, flat memory (ADR-0015).
6. **Pagination** for large `connz` (offset/limit, up to tens of thousands of connections) and `subsz` (subject-map slices), surfaced as cursor-based IPC.
7. **Typed, visualization-ready DTOs** per endpoint (in `ns-types`), plus chart-shaped series DTOs.

### Explicitly out of scope (owned elsewhere)
- **Raw NATS connection lifecycle / reconnection** → `ns-connection` (`ConnectionService`). We consume a `NatsClient` handle + resolved monitoring URL from it.
- **The `async-nats` adapter** → `ns-nats`. We only touch the `NatsClient` trait for `$SYS` requests.
- **JetStream stream/consumer CRUD & message ops** → `ns-jetstream`. We only *read* `jsz` for account/stream aggregate health metrics; we do not manage streams.
- **Home/overview aggregation across subsystems** → `ns-dashboard` (L3) composes our snapshots with connection + jetstream. We expose read models; the dashboard composes them.
- **Subject tree / wildcard analysis** → `ns-subject`. `subsz` here is server-side subscription accounting, not the live subject explorer.
- **Tauri wiring / event bridging** → `ns-ipc` (`EventBridge`) + the bin. We emit domain events via the `EventPublisher` port only.
- **Persistence engine** → `ns-storage`. We define repo *ports* consumed for monitor settings; SQL lives in `ns-storage`.

### Boundary contract
`ns-monitor` is a headless, `tauri`-free, `async-nats`-free library. Its only inbound edges are: the bin injects a `NatsClientProvider` port + `EventPublisher` port + `MonitorSettingsRepo` port + an `HttpClient` port; the bin registers our commands. Everything visualization-facing crosses IPC as `ns-types` DTOs.

---

## b) Rust Public Interface (`ns-monitor`)

### Crate layout
```
crates/ns-monitor/
├─ src/
│  ├─ lib.rs                # re-exports, MonitorService trait, MonitorError
│  ├─ service.rs            # MonitorServiceImpl (composition of the pieces below)
│  ├─ scheduler.rs          # PollScheduler, PollJob, interval/backoff/jitter
│  ├─ http/
│  │  ├─ client.rs          # HttpMonitorClient (reqwest) behind HttpFetcher port
│  │  └─ endpoints.rs       # endpoint URL builders + query params
│  ├─ sys/
│  │  └─ requestor.rs       # SysRequestor: $SYS.REQ.* over NatsClient, fan-in
│  ├─ parse/               # serde_json -> ns-types DTOs, one module per endpoint
│  │  ├─ varz.rs connz.rs routez.rs subsz.rs gatewayz.rs
│  │  ├─ leafz.rs accountz.rs accstatz.rs healthz.rs jsz.rs
│  ├─ cache.rs              # SnapshotCache (latest per key) + Diff engine
│  ├─ series.rs             # RingBuffer<T>, MetricSeriesStore, rate derivation
│  ├─ source.rs             # MonitorSource enum (Http | Sys) selection/fallback
│  └─ ports.rs              # ports THIS crate depends on (re-declared from ns-core)
├─ Cargo.toml
└─ tests/                   # integration tests w/ ns-testkit + mock HTTP + embedded server
```

### Error type (thiserror, one public enum — ADR-0008)
```rust
// ns-monitor/src/lib.rs
#[derive(Debug, thiserror::Error)]
pub enum MonitorError {
    #[error("monitoring endpoint unreachable: {url}")]
    Unreachable { url: String, #[source] source: HttpError },

    #[error("monitoring endpoint returned status {status} for {endpoint:?}")]
    BadStatus { endpoint: Endpoint, status: u16 },

    #[error("failed to parse {endpoint:?} response")]
    Parse { endpoint: Endpoint, #[source] source: serde_json::Error },

    #[error("$SYS request failed for {subject}")]
    SysRequest { subject: String, #[source] source: NatsPortError },

    #[error("no monitoring source available (no HTTP URL and no $SYS user)")]
    NoSource,

    #[error("monitoring not enabled on server (endpoint {endpoint:?} 404)")]
    NotEnabled { endpoint: Endpoint },

    #[error("connection {0} not found in registry")]
    UnknownConnection(ConnectionId),

    #[error("operation cancelled")]
    Cancelled,

    #[error(transparent)]
    Settings(#[from] SettingsRepoError),
}

// DomainError mapping (ns-core trait) -> ErrorCode
impl DomainError for MonitorError {
    fn code(&self) -> ErrorCode {
        match self {
            MonitorError::Unreachable { .. } | MonitorError::BadStatus { .. }
            | MonitorError::NotEnabled { .. }                 => ErrorCode::MonitorUnreachable,
            MonitorError::Parse { .. }                        => ErrorCode::MonitorParseError,
            MonitorError::SysRequest { .. }                   => ErrorCode::MonitorUnreachable,
            MonitorError::NoSource                            => ErrorCode::MonitorUnreachable,
            MonitorError::UnknownConnection(_)               => ErrorCode::NotFound,
            MonitorError::Cancelled                          => ErrorCode::Cancelled,
            MonitorError::Settings(_)                        => ErrorCode::Storage,
        }
    }
    fn retriable(&self) -> bool {
        matches!(self,
            MonitorError::Unreachable{..} | MonitorError::BadStatus{..}
          | MonitorError::SysRequest{..}  | MonitorError::Cancelled)
    }
    fn user_message(&self) -> String { /* secret-safe copy per variant */ }
}
```
> New `ErrorCode` values used: `MONITOR_UNREACHABLE`, `MONITOR_PARSE_ERROR` (already in the spine's ErrorCode enum). No new codes required.

### The public service trait (port lives in `ns-core`, impl here)
```rust
/// Object-safe service port; AppState holds Arc<dyn MonitorService>.
#[async_trait::async_trait]
pub trait MonitorService: Send + Sync {
    /// One-shot fetch of a single endpoint (cache-bypass optional).
    async fn fetch(
        &self,
        conn: ConnectionId,
        req: FetchEndpointRequest,
    ) -> Result<EndpointSnapshot, MonitorError>;

    /// Latest cached snapshot without hitting the wire (None if never polled).
    async fn cached(
        &self,
        conn: ConnectionId,
        endpoint: Endpoint,
        scope: SnapshotScope,
    ) -> Option<EndpointSnapshot>;

    /// Paginated connz (offset/limit + filters), always cache-diffable.
    async fn connz(
        &self,
        conn: ConnectionId,
        req: ConnzQuery,
    ) -> Result<ConnzResponse, MonitorError>;

    /// Paginated subsz.
    async fn subsz(
        &self,
        conn: ConnectionId,
        req: SubszQuery,
    ) -> Result<SubszResponse, MonitorError>;

    /// Fan-in $SYS server discovery + per-server varz summary.
    async fn topology(
        &self,
        conn: ConnectionId,
    ) -> Result<ClusterTopology, MonitorError>;

    /// Read a derived metric time-series from the ring buffers.
    async fn series(
        &self,
        conn: ConnectionId,
        req: SeriesQuery,
    ) -> Result<MetricSeries, MonitorError>;

    /// Start/replace the polling plan for a connection (per-endpoint intervals).
    async fn start_polling(
        &self,
        conn: ConnectionId,
        plan: PollPlan,
    ) -> Result<(), MonitorError>;

    async fn update_plan(&self, conn: ConnectionId, plan: PollPlan) -> Result<(), MonitorError>;
    async fn pause_polling(&self, conn: ConnectionId) -> Result<(), MonitorError>;
    async fn resume_polling(&self, conn: ConnectionId) -> Result<(), MonitorError>;
    async fn stop_polling(&self, conn: ConnectionId) -> Result<(), MonitorError>;

    /// Health rollup (healthz + derived thresholds) for a connection.
    async fn health(&self, conn: ConnectionId) -> Result<HealthReport, MonitorError>;
}
```

### Ports this crate depends on (declared in `ns-core`, injected by bin)
```rust
/// Abstracts reqwest so tests can mock HTTP. Impl (reqwest) lives in ns-monitor::http.
#[async_trait::async_trait]
pub trait HttpFetcher: Send + Sync {
    async fn get_json(&self, url: &Url, timeout: Duration) -> Result<Bytes, HttpError>;
}

/// Supplies a live NatsClient + resolved monitoring base URL for a connection.
/// Implemented by ns-connection; injected as Arc<dyn NatsClientProvider>.
#[async_trait::async_trait]
pub trait NatsClientProvider: Send + Sync {
    async fn client(&self, conn: ConnectionId) -> Option<Arc<dyn NatsClient>>;
    async fn monitor_url(&self, conn: ConnectionId) -> Option<Url>;      // http(s)://host:8222
    async fn sys_account_available(&self, conn: ConnectionId) -> bool;    // has $SYS user
}

/// EventPublisher (ns-core) — already defined; we publish EventPayload::MetricsTick etc.
/// MonitorSettingsRepo (ns-core port; impl in ns-storage).
#[async_trait::async_trait]
pub trait MonitorSettingsRepo: Send + Sync {
    async fn load(&self, conn: ConnectionId) -> Result<Option<MonitorSettings>, SettingsRepoError>;
    async fn save(&self, conn: ConnectionId, s: &MonitorSettings) -> Result<(), SettingsRepoError>;
}
```

### Key internal structs
```rust
pub struct MonitorServiceImpl {
    http: Arc<dyn HttpFetcher>,
    nats: Arc<dyn NatsClientProvider>,
    events: Arc<dyn EventPublisher>,
    settings: Arc<dyn MonitorSettingsRepo>,
    scheduler: PollScheduler,             // owns per-conn JoinHandles + tokens
    cache: SnapshotCache,                 // DashMap<CacheKey, CachedSnapshot>
    series: MetricSeriesStore,            // DashMap<SeriesKey, RingBuffer<Point>>
    clock: Arc<dyn Clock>,                // ns-core port (testable time)
    cancels: CancellationRegistry,        // shared with bin for *_cancel commands
}

struct CacheKey { conn: ConnectionId, endpoint: Endpoint, server_id: Option<String>, scope_hash: u64 }

struct CachedSnapshot {
    fetched_at: OffsetDateTime,
    etag: u64,                 // xxhash of canonical JSON for cheap change detection
    value: EndpointPayload,    // typed enum, ns-types
    source: MonitorSource,     // Http | Sys
}

pub struct RingBuffer<T> { buf: Box<[Option<T>]>, head: usize, len: usize, cap: usize }
impl<T: Copy> RingBuffer<T> {
    pub fn push(&mut self, v: T);            // O(1), overwrites oldest
    pub fn iter_chrono(&self) -> impl Iterator<Item=&T>;
    pub fn last(&self) -> Option<&T>;
}
```

### Endpoint & scope enums (in `ns-types`, typeshared)
```rust
#[typeshare] #[derive(Serialize,Deserialize,Clone,Copy,PartialEq,Eq,Hash)]
#[serde(rename_all="camelCase")]
pub enum Endpoint {
    Varz, Connz, Routez, Subsz, Gatewayz, Leafz,
    Accountz, Accstatz, Healthz, Jsz,
}

#[typeshare] #[derive(Serialize,Deserialize,Clone)]
#[serde(rename_all="camelCase", tag="kind", content="data")]
pub enum EndpointPayload {         // adjacently tagged -> TS discriminated union
    Varz(ServerVarz),
    Connz(ConnzPage),
    Routez(Routez),
    Subsz(SubszPage),
    Gatewayz(Gatewayz),
    Leafz(Leafz),
    Accountz(Accountz),
    Accstatz(Accstatz),
    Healthz(Healthz),
    Jsz(Jsz),
}
```

---

## c) Tauri IPC Commands (registered by the bin, defined in `ns-ipc` command module for monitoring)

All commands are `snake_case`, take one `req` arg, return `Result<_, IpcError>`. Streams use `tauri::ipc::Channel<T>` (ADR-0009). `connectionId: ConnectionId` is explicit on every command (no hidden current connection).

| Command | Kind | Request (`ns-types`) | Returns / Stream item | Errors (`ErrorCode`) |
|---|---|---|---|---|
| `monitor_get_varz` | request | `{ connectionId, serverId?, refresh? }` | `ServerVarz` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR, NOT_FOUND |
| `monitor_get_connz` | request | `ConnzQuery { connectionId, serverId?, offset?, limit?, sort?, state?, subs?, auth?, filterSubject? }` | `ConnzResponse { items, total, offset, limit, nextCursor? }` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR |
| `monitor_get_routez` | request | `{ connectionId, serverId?, subs? }` | `Routez` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR |
| `monitor_get_subsz` | request | `SubszQuery { connectionId, serverId?, offset?, limit?, subs?, test? }` | `SubszResponse { items, total, offset, limit, nextCursor? }` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR |
| `monitor_get_gatewayz` | request | `{ connectionId, serverId?, accs? }` | `Gatewayz` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR |
| `monitor_get_leafz` | request | `{ connectionId, serverId?, subs? }` | `Leafz` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR |
| `monitor_get_accountz` | request | `{ connectionId, serverId?, acc? }` | `Accountz` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR |
| `monitor_get_accstatz` | request | `{ connectionId, serverId?, unused? }` | `Accstatz` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR |
| `monitor_get_healthz` | request | `{ connectionId, serverId?, jsEnabledOnly?, jsServerOnly? }` | `Healthz` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR |
| `monitor_get_jsz` | request | `JszQuery { connectionId, serverId?, acc?, streams?, consumers?, config?, offset?, limit? }` | `Jsz` | MONITOR_UNREACHABLE, MONITOR_PARSE_ERROR, JETSTREAM_NOT_ENABLED |
| `monitor_get_topology` | request | `{ connectionId }` | `ClusterTopology` | MONITOR_UNREACHABLE |
| `monitor_get_series` | request | `SeriesQuery { connectionId, metric, serverId?, sinceMs?, maxPoints? }` | `MetricSeries` | NOT_FOUND, INVALID_ARGUMENT |
| `monitor_get_health` | request | `{ connectionId }` | `HealthReport` | MONITOR_UNREACHABLE |
| `monitor_start_polling` | command | `{ connectionId, plan: PollPlan }` | `()` | NOT_FOUND, INVALID_ARGUMENT |
| `monitor_update_plan` | command | `{ connectionId, plan: PollPlan }` | `()` | NOT_FOUND, INVALID_ARGUMENT |
| `monitor_pause_polling` | command | `{ connectionId }` | `()` | NOT_FOUND |
| `monitor_resume_polling` | command | `{ connectionId }` | `()` | NOT_FOUND |
| `monitor_stop_polling` | command | `{ connectionId }` | `()` | NOT_FOUND |
| `monitor_get_settings` | request | `{ connectionId }` | `MonitorSettings` | STORAGE |
| `monitor_update_settings` | command | `{ connectionId, settings: MonitorSettings }` | `MonitorSettings` | STORAGE, INVALID_ARGUMENT |
| `monitor_subscribe_metrics` | **stream** | `{ connectionId, metrics: MetricKind[], channel }` | Channel item `MonitorStreamEvent` (see below) | MONITOR_UNREACHABLE |
| `monitor_unsubscribe_metrics` | command | `{ subscriptionId }` | `()` | NOT_FOUND |

> Ambient metric ticks are normally delivered via **bridged events** (below) so many panels can observe them cheaply. `monitor_subscribe_metrics` exists for the case where a single high-resolution panel wants a request-scoped Channel with a tighter interval + per-call cancellation. Its Channel item enum:
```rust
#[typeshare] #[serde(tag="kind", content="data", rename_all="camelCase")]
pub enum MonitorStreamEvent {
    Tick(MetricsFrame),          // coalesced frame of the subscribed metrics
    SnapshotDiff(EndpointDiff),  // structural diff since last emit
    Lagged { droppedSinceLast: u64 },
    Error(IpcError),             // terminal in-band error (stream ends)
}
```

### Diffing on the wire
`ConnzResponse`/`SubszResponse` and `EndpointSnapshot` include an optional `diff?: EndpointDiff` when the caller passes `ifNoneMatchEtag`. If server-side etag matches, we return `{ unchanged: true, etag }` with no body, saving IPC bandwidth on unchanged polls.

---

## d) Events Emitted (via `EventPublisher` port → bus → `ns-ipc::EventBridge` → Tauri)

Domain events published on the internal bus (`ns-event`). The **bridge is the only translator** to Tauri events; we never call `app.emit`. Envelope carries `connection_id`, monotonic `seq`, `ts`.

| Bus `EventPayload` variant | Tauri event name | Trigger / cadence | Backpressure policy |
|---|---|---|---|
| `MetricsTick(MetricsFrame)` | `ns://monitor/metrics` | every poll cycle produces derived points | keep-latest per `(connectionId, metric)` in 250 ms tick, coalesced frame |
| `ServerInfoUpdated(ServerVarzSummary)` | `ns://server/info` | on `varz` change (etag delta) | dedupe identical |
| `HealthChanged(HealthReport)` | `ns://monitor/health` | on `healthz` status transition | always deliver transitions, dedupe identical |
| `TopologyChanged(ClusterTopology)` | `ns://monitor/topology` | server add/remove/route/gateway/leaf delta | dedupe identical |
| `MonitorAlert(MonitorAlert)` | `ns://notification` | threshold breach (slow consumers, mem, JS bytes %, consumer lag) | never drop (Notification) |
| `TaskProgress(...)` | `ns://task/progress` | long `connz` full-scan progress | keep-latest per task id |

```rust
#[typeshare] #[serde(rename_all="camelCase")]
pub struct MetricsFrame {
    pub connection_id: ConnectionId,
    pub server_id: Option<String>,
    pub ts: String,               // RFC-3339
    pub points: Vec<MetricPoint>, // one per metric changed this tick
}
#[typeshare] #[serde(rename_all="camelCase")]
pub struct MetricPoint { pub metric: MetricKind, pub value: f64, pub ts: String }

#[typeshare] #[serde(rename_all="camelCase")]
pub enum MetricKind {
    InMsgsRate, OutMsgsRate, InBytesRate, OutBytesRate,
    Connections, TotalConnections, Subscriptions, SlowConsumers,
    MemBytes, CpuPercent, Routes, Gateways, Leafs,
    JsMemoryBytes, JsStorageBytes, JsStreams, JsConsumers, JsApiErrors,
    ConsumerLagMax, Uptime,
}
```

---

## e) Frontend Surface

### Routes (React Router, under the connection workspace)
- `/c/:connectionId/monitor` → Monitoring overview (server vitals).
- `/c/:connectionId/monitor/connections` → connz explorer (virtualized table + filters).
- `/c/:connectionId/monitor/subscriptions` → subsz explorer.
- `/c/:connectionId/monitor/topology` → cluster/gateway/leaf topology (routez/gatewayz/leafz).
- `/c/:connectionId/monitor/accounts` → accountz/accstatz.
- `/c/:connectionId/monitor/jetstream-health` → jsz aggregate health (links out to `[jetstream]`).
- `/c/:connectionId/monitor/health` → healthz + alerts.

### Panels / components (dockview-compatible, ADR-0012)
- `ServerVitalsPanel` — ECharts sparklines (msgs/s, bytes/s, conns, mem, cpu, slow consumers) fed from the metrics cache.
- `MetricChart` — reusable ECharts line/area bound to a `['monitor','series',...]` key.
- `ConnzTable` — TanStack Virtual + column sort/filter, offset pagination, "kick"/detail drill-in (detail via `connz` with `cid` filter + subs).
- `SubszTable`, `RoutezList`, `GatewayzView`, `LeafzView`, `AccountzView`, `AccstatzTable`.
- `TopologyGraph` — ECharts graph layout of servers/routes/gateways/leafs.
- `HealthBadge` + `AlertsFeed` — driven by `ns://monitor/health` / `ns://notification`.
- `PollControls` — interval config per endpoint, pause/resume, manual refresh (writes `MonitorSettings`).

### Zustand stores (UI/session only — never mirror server-state)
- `useMonitorUiStore`: selected serverId (multi-server), active endpoint tab, connz filter/sort form state, chart time-window selection (1m/5m/15m/1h), paused flag (optimistic), pinned metrics for the vitals panel, column visibility.

### TanStack Query keys (all server-state)
```
['monitor','varz', connectionId, serverId]
['monitor','connz', connectionId, serverId, {offset,limit,sort,filter}]
['monitor','subsz', connectionId, serverId, {offset,limit}]
['monitor','routez', connectionId, serverId]
['monitor','gatewayz', connectionId, serverId]
['monitor','leafz', connectionId, serverId]
['monitor','accountz', connectionId, serverId, acc]
['monitor','accstatz', connectionId, serverId]
['monitor','healthz', connectionId, serverId]
['monitor','jsz', connectionId, serverId, {acc,streams}]
['monitor','topology', connectionId]
['monitor','series', connectionId, metric, serverId]
['monitor','health', connectionId]
['monitor','settings', connectionId]
```
- Metric ticks (`ns://monitor/metrics`) are folded into `['monitor','series',...]` via `queryClient.setQueryData` from the `useAppEvents()` hook — **no polling from the frontend**; the Rust scheduler owns cadence.
- `ns://monitor/health` / `topology` invalidate or setQueryData their keys.
- Mutations (`monitor_update_settings`, poll controls) invalidate `['monitor','settings',connectionId]`.

### IPC client calls (generated wrappers in `packages/ns-bindings`, from `commands.manifest.ts`)
`ipc.monitor.getVarz(req)`, `getConnz`, `getSubsz`, `getRoutez`, `getGatewayz`, `getLeafz`, `getAccountz`, `getAccstatz`, `getHealthz`, `getJsz`, `getTopology`, `getSeries`, `getHealth`, `startPolling`, `updatePlan`, `pause/resume/stopPolling`, `getSettings`, `updateSettings`, `subscribeMetrics(req, channel)`, `unsubscribeMetrics`.

---

## f) Data Model

### DTOs owned (in `ns-types`, typeshared, camelCase; timestamps RFC-3339 strings; durations `*Ms: u64`)
Typed models mirror the NATS server monitoring JSON, normalized to our conventions. Highlights (fields abbreviated):

```rust
#[typeshare] #[serde(rename_all="camelCase")]
pub struct ServerVarz {
    pub server_id: String, pub server_name: String, pub version: String,
    pub proto: i32, pub go: String, pub host: String, pub port: u16,
    pub max_connections: u64, pub connections: u64, pub total_connections: u64,
    pub routes: u32, pub remotes: u32, pub in_msgs: u64, pub out_msgs: u64,
    pub in_bytes: u64, pub out_bytes: u64, pub slow_consumers: u64,
    pub subscriptions: u64, pub mem_bytes: u64, pub cpu_percent: f64,
    pub uptime: String, pub now: String, pub start: String,
    pub jetstream: Option<VarzJetStream>, pub cluster: Option<VarzCluster>,
    pub gateway: Option<VarzGateway>, pub leaf: Option<VarzLeaf>,
    pub http_req_stats: Option<HashMap<String,u64>>,
}

#[typeshare] pub struct ConnzPage { pub server_id: String, pub now: String,
    pub num_connections: u64, pub total: u64, pub offset: u64, pub limit: u64,
    pub connections: Vec<ConnInfo> }
#[typeshare] pub struct ConnInfo { pub cid: u64, pub kind: String, pub ip: String,
    pub port: u16, pub start: String, pub last_activity: String,
    pub rtt: Option<String>, pub uptime: String, pub pending_bytes: u64,
    pub in_msgs: u64, pub out_msgs: u64, pub in_bytes: u64, pub out_bytes: u64,
    pub subscriptions: u32, pub name: Option<String>, pub lang: Option<String>,
    pub version: Option<String>, pub subscriptions_list: Option<Vec<String>>,
    pub account: Option<String>, pub tls_version: Option<String> }

#[typeshare] pub struct Routez { /* now, num_routes, routes: Vec<RouteInfo> */ }
#[typeshare] pub struct SubszPage { /* num_subscriptions, num_cache, offset, limit,
    total, subscriptions_list: Vec<SubDetail> */ }
#[typeshare] pub struct Gatewayz { /* name, outbound_gateways, inbound_gateways */ }
#[typeshare] pub struct Leafz { /* leafnodes: Vec<LeafInfo> */ }
#[typeshare] pub struct Accountz { /* accounts: Vec<String>, account_detail? */ }
#[typeshare] pub struct Accstatz { /* acc_stats: Vec<AccStat> (conns, sent, recv, slow) */ }
#[typeshare] pub struct Healthz { pub status: String, pub error: Option<String>,
    pub status_code: Option<u16> }
#[typeshare] pub struct Jsz { /* memory, storage, reserved_*, accounts, ha_assets,
    api: {total, errors}, account_details? : Vec<JszAccount> */ }

#[typeshare] pub struct ClusterTopology { pub servers: Vec<ServerNode>,
    pub routes: Vec<TopoEdge>, pub gateways: Vec<TopoEdge>, pub leafs: Vec<TopoEdge>,
    pub generated_at: String }

#[typeshare] pub struct MetricSeries { pub metric: MetricKind, pub server_id: Option<String>,
    pub points: Vec<MetricPoint>, pub interval_ms: u64, pub capacity: u64 }

#[typeshare] pub struct HealthReport { pub overall: HealthLevel, // Ok|Degraded|Critical|Unknown
    pub servers: Vec<ServerHealth>, pub alerts: Vec<MonitorAlert>, pub generated_at: String }

#[typeshare] pub struct MonitorSettings {
    pub intervals_ms: HashMap<Endpoint, u64>,   // per-endpoint poll interval
    pub enabled_endpoints: Vec<Endpoint>,
    pub source_preference: SourcePreference,     // HttpFirst | SysFirst | HttpOnly | SysOnly
    pub series_capacity: u32,                    // ring buffer points (default 900 = 15m@1s)
    pub connz_page_size: u32,
    pub alert_thresholds: AlertThresholds,       // slowConsumers, memPct, jsBytesPct, lag
    pub paused: bool,
}
#[typeshare] pub struct PollPlan { pub jobs: Vec<PollJobSpec> }
#[typeshare] pub struct PollJobSpec { pub endpoint: Endpoint, pub interval_ms: u64,
    pub server_id: Option<String>, pub enabled: bool }
```

### SQLite tables (schema owned here; **SQL lives in `ns-storage`** via `MonitorSettingsRepo` + migration `NNNN_monitor.sql`)
```sql
-- forward-only migration in crates/ns-storage/migrations/
CREATE TABLE monitor_settings (
  connection_id   TEXT PRIMARY KEY,          -- FK-ish to connection_profiles.id
  settings_json   TEXT NOT NULL,             -- serialized MonitorSettings (versioned)
  schema_version  INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL
);
```
> **No time-series in SQLite.** Metric history is intentionally in-memory ring buffers only (flat memory, ADR-0015). If long-term retention is later desired that is a separate ADR (candidate: a bounded `monitor_metric_rollup` table written by the storage worker). Snapshots are cached in RAM, not persisted.

---

## g) Dependencies

### Crate deps (must match the spine's declared `ns-monitor.depends_on = [ns-types, ns-core, ns-event]`)
- `ns-types` — all DTOs + `ErrorCode`/`IpcError`.
- `ns-core` — `DomainError`, `EventPublisher`, `Clock`, `CancellationToken`, port traits, `Settings`, newtype IDs, `Redacted<T>`.
- `ns-event` — the bus is consumed indirectly via the `EventPublisher` port; direct dep only for `Topic`/envelope types if needed.
- **`reqwest`** (workspace-pinned, rustls) — HTTP polling. Confined here (this is a monitoring-only HTTP consumer; per ADR-0015 reqwest lives with the monitor). 
- `serde` / `serde_json` — parse endpoint JSON.
- `async-trait`, `tokio`, `dashmap`, `xxhash-rust` (etag), `time`, `url`, `thiserror`.

> **NatsClient access note:** `ns-monitor.depends_on` in the spine does NOT list `ns-nats`. To keep the spine's dependency list authoritative while still supporting `$SYS` requests, the `NatsClient` trait we call is re-exported through `ns-core` as a port (the trait definition is shared; `ns-nats` provides the impl). We depend on the **trait in `ns-core`**, and the bin injects the `ns-nats` implementation via `NatsClientProvider`. This preserves one-way layering (L2 → L0) with no `ns-monitor → ns-nats` edge. **Open question O1** flags reconciling where the `NatsClient` trait canonically lives.

### Subsystem deps (runtime, via ports — no compile edges beyond the above)
- `[connection-manager]` (`ns-connection`) — supplies `NatsClientProvider` (client + monitor URL + `$SYS` availability). We react to `ConnectionStatusChanged` bus events to start/stop polling.
- `[storage]` (`ns-storage`) — impl of `MonitorSettingsRepo`.
- `[logging-observability]` (`ns-telemetry`) — tracing targets `ns_monitor`.
- `[tauri-shell]` (`ns-ipc` + bin) — command registration + `EventBridge`.

### Consumers of us
- `[dashboard]` (`ns-dashboard`, L3) — composes our `ServerVarz`/`Jsz`/`HealthReport` snapshots. We never depend back.
- `[jetstream]` links from `jsz` health into stream detail (frontend nav only).

---

## h) Concurrency / Async & Backpressure

1. **Scheduler model.** `PollScheduler` owns, per connection, a set of `PollJob` tokio tasks (one per enabled endpoint), each a `tokio::time::interval` loop with:
   - configurable base interval + **±10% jitter** (avoid thundering-herd across many endpoints/servers),
   - **adaptive backoff** on failure: interval × 2 up to a cap (e.g. 60 s), reset on success,
   - a `CancellationToken` from the shared `CancellationRegistry`; stop/pause trips it.
   Tasks are tracked in the bin's `TaskRegistry` (ADR-0018). Nothing runs on the UI thread.

2. **Fan-in for `$SYS` PING.** `SysRequestor` publishes to `$SYS.REQ.SERVER.PING.<KIND>` with a reply inbox and collects replies for a bounded window (e.g. 1.5 s or until `expected_servers` reached), producing one snapshot per server id. Bounded collection prevents unbounded wait on large clusters. Uses `NatsClient::request_many`-style subscription with a deadline.

3. **HTTP timeouts + cancellation.** Every `HttpFetcher::get_json` has a per-call timeout (default 5 s). A poll cycle that overruns its interval is **skipped, not queued** (no pile-up) — `tokio::time::MissedTickBehavior::Skip`.

4. **Caching + diff pipeline.** Each successful fetch → parse → canonicalize → xxhash etag. If etag unchanged, we emit nothing (dedupe). If changed, compute a lightweight structural diff (added/removed/changed for list endpoints keyed by cid/subject/serverId) and derive metric points. Cache writes use `DashMap` (sharded, no global lock).

5. **Ring buffers.** Fixed-capacity `RingBuffer<MetricPoint>` per `(conn, metric, serverId)`; O(1) push, no realloc → flat memory. Rate metrics derived as `(cur - prev) / Δt` from monotonic counters with wrap/reset guards (counter reset on server restart → emit gap, not negative).

6. **Backpressure to UI.** Producers never block on a slow WebView. Bus → `EventBridge` applies the per-topic policy (MetricsTick keep-latest per metric within 250 ms; Notification never drop; a `broadcast` `Lagged(n)` yields a synthetic gap marker → UI shows a discontinuity). The optional `monitor_subscribe_metrics` Channel uses a **bounded mpsc**; on overflow it emits `Lagged { droppedSinceLast }` and drops intermediate frames (sample+count), preserving the newest.

7. **Pagination memory.** `connz`/`subsz` full scans iterate server pages (`offset`/`limit`) server-side; we never materialize an entire 50k-connection list unless explicitly requested. Full-scan (for topology/aggregate counts) runs as a `TaskProgress`-reporting background job with cancellation.

8. **Lazy init & startup.** No polling until a connection is established AND monitoring is enabled for it. Subsystem allocates nothing per-connection until first use (fast startup / low memory).

9. **Source selection & fallback.** `MonitorSource` chosen by `SourcePreference`: try HTTP monitor URL; on `NoSource`/unreachable and `$SYS` available, fall back to `$SYS` request; surface which source produced each snapshot (`source` field) so the UI can badge "via system account".

---

## i) Test Plan

### Unit tests (in-crate, no network)
- **Parsers** (`parse/*`): golden-file tests per endpoint using captured real `nats-server` JSON (varz/connz/routez/subsz/gatewayz/leafz/accountz/accstatz/healthz/jsz) across server versions (2.9, 2.10, 2.11) → assert DTO mapping, `Option` handling for absent JetStream/gateway/leaf, and forward-compat (unknown fields ignored). Golden helpers from `ns-testkit`.
- **RingBuffer**: capacity/wraparound, `iter_chrono` ordering, rate derivation incl. counter reset (no negatives, gap emitted).
- **Diff engine**: added/removed/changed detection for connz (keyed by cid) & subsz (keyed by subject); etag stability under key reordering (canonicalization).
- **Scheduler**: with a mock `Clock` + paused/virtual time — interval firing, jitter bounds, backoff escalation/reset, `MissedTickBehavior::Skip`, cancellation stops the loop, pause/resume.
- **Source selection**: HttpFirst/SysFirst/HttpOnly/SysOnly matrix incl. fallback and `NoSource`.
- **Error mapping**: each `MonitorError` → correct `ErrorCode`/`retriable`/secret-safe `user_message`.

### Integration tests (`ns-testkit` embedded `nats-server`, ADR-0016)
- Boot an embedded `nats-server` with `-m 8222` (monitoring) + JetStream + a `$SYS` account user; run `MonitorServiceImpl` against it via a real `reqwest` `HttpFetcher` and a real `NatsClient` (mocked provider wiring):
  - `fetch`/`connz`/`subsz` return well-typed data; pagination offsets behave; `jsz` reflects created streams.
  - `$SYS` PING fan-in returns one snapshot for a single-server, and N for a 3-node cluster fixture (routez/gatewayz populated).
  - `healthz` transitions (start JS-disabled vs enabled) → `HealthChanged` event emitted.
  - polling loop emits `MetricsTick` at configured cadence; publish traffic on the server → in/out msg rate series increases.
  - HTTP monitor port down but `$SYS` available → fallback path produces snapshots with `source = Sys`.
- **Event/bridge contract**: use a mock `EventPublisher` capturing payloads; assert coalescing (many quick ticks → keep-latest) and dedupe (unchanged varz → no ServerInfoUpdated).

### E2E (app-level, testing-strategy owns harness)
- Launch the desktop app against a real `nats-server` cluster fixture; open `/monitor`, assert vitals sparklines populate, connz table paginates and filters, topology graph renders cluster edges, health badge flips when a node is killed, alert appears on slow-consumer threshold. Cancellation: navigate away → `monitor_unsubscribe_metrics`/Channel drop cancels the task (assert via log/telemetry no leaked tasks).

### Type-contract tests
- CI `pnpm gen:types` + `git diff --exit-code` guarantees `ns-types` monitoring DTOs and the committed `types.ts` agree. `commands.manifest.ts` pairs every `monitor_*` command with its Request/Response so a rename breaks the TS build.

### Performance/soak
- 10k-connection connz fixture → paginated fetch memory stays bounded; ring buffers over a 1 h soak → flat RSS. Poll 5 endpoints × 5 servers @ 1 s → CPU budget check.

---

## j) Risks & Open Questions

**Risks**
- **R1 — Server-version JSON drift.** NATS monitoring JSON evolves across versions (fields added/removed). Mitigation: tolerant serde (`#[serde(default)]`, ignore unknown), golden tests per version, `Option` everywhere non-guaranteed. A missing field must degrade a metric, never crash a poll.
- **R2 — `$SYS` request semantics differ from HTTP.** `$SYS` PING responses are per-server and require correct expected-count/deadline handling; a large cluster can flood the inbox. Mitigation: bounded collection window + expected-server hint from prior topology; cap reply buffer.
- **R3 — Large connz/subsz cost.** Full scans are expensive on busy servers. Mitigation: default to paginated on-demand; background full-scan is cancellable + progress-reported; never auto-poll full subscription lists.
- **R4 — reqwest placement vs. layering purity.** Adding `reqwest` to an L2 crate widens its dep surface; acceptable per ADR-0015 which explicitly assigns HTTP polling to `ns-monitor`, but must stay confined (no other crate imports reqwest).
- **R5 — Counter resets / clock skew** producing bogus rates. Mitigation: monotonic-counter guard, use server-reported `now`/`uptime` for Δt, emit gap markers on reset.
- **R6 — TLS to monitoring port.** `https` monitoring endpoints with self-signed/enterprise CAs. Mitigation: reuse the connection profile's rustls trust config (ADR-0004) when building the `reqwest` client per connection; native-tls fallback behind the feature flag.
- **R7 — Metric memory unbounded if series_capacity × metrics × servers explodes** on huge clusters. Mitigation: cap total series count per connection, evict least-recently-viewed server series.

**Open questions**
- **O1 — Canonical home of the `NatsClient` trait.** The spine lists `ns-monitor.depends_on` without `ns-nats`, yet `$SYS` requests need `NatsClient`. Proposal: the `NatsClient` *trait* lives in `ns-core` (port), `ns-nats` provides the impl; confirm with `[core-runtime]`/`[connection-manager]` and record an ADR if we move the trait. (Blocks the `NatsClientProvider` port location.)
- **O2 — Persist metric history?** Currently RAM-only. Do we want optional bounded on-disk rollups for "what happened overnight"? Needs an ADR + `ns-storage` table if yes.
- **O3 — Multi-server metric identity.** For `$SYS` clusters, do we key series per server id, or also offer a cluster-aggregate synthetic series? Affects `SeriesKey` and UI. Proposal: store per-server, aggregate in `ns-dashboard`.
- **O4 — Alert engine ownership.** Threshold alerts here vs. a future generic alerting subsystem. Proposal: keep simple thresholds local now; expose `MonitorAlert` DTO stable so a future engine can subsume it.
- **O5 — `accountz`/`accstatz` scope.** How much account-level detail belongs in `[monitoring]` vs `[account-security]`? Proposal: raw server-account stats here; identity/permission modeling in `[account-security]`.
- **O6 — Default poll intervals.** Need product decision on defaults (varz 2 s, healthz 5 s, connz on-demand, jsz 5 s, routez/gatewayz/leafz 10 s) balancing freshness vs server load.
