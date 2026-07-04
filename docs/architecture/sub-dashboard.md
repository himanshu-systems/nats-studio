# Subsystem Design — Dashboard (`[dashboard]`)

**Owner:** Dashboard Team
**Crate(s):** `ns-dashboard` (L3, `crates/ns-dashboard`)
**Frontend slice:** `apps/desktop/src/features/dashboard/*`
**Status:** Design v1 (implementable). Conforms to `docs/architecture/00-conventions-and-workspace.md` (the Spine). Where this doc needs a change to a shared crate (`ns-types`, `ns-core`, `ns-storage`), it is flagged as a **cross-team dependency** and requires the noted ADR/PR.

---

## 1. Responsibilities & boundaries

### 1.1 In scope (this subsystem owns)
The dashboard is the **composition/aggregation layer** for the "home / overview" experience of a connection:

1. **Cluster overview** — fuse per-server `varz`/`jsz`/`healthz`/`routez`/`gatewayz`/`leafz` snapshots (produced by `ns-monitor`) into a single cluster-level DTO: server count, healthy/degraded/down counts, total connections, total subscriptions, cluster msg/byte rates, JetStream aggregate (streams, consumers, bytes, memory/file storage).
2. **Per-server health indicators** — a `ServerHealth` row per server: up/down, slow-consumer count, CPU/mem, connection count, pending bytes, route/gateway/leaf link health, uptime, version drift across cluster.
3. **Traffic time-series** — msgs/s and bytes/s (in/out) derived by **differentiating** monotonic counters (`in_msgs`, `out_msgs`, `in_bytes`, `out_bytes`) from successive monitor polls into rate series; connection-count and subscription-count series; per-server and cluster-aggregate.
4. **KPI tiles** — computed scalar tiles (current rate, peak, deltas vs previous window) with an embedded sparkline series.
5. **Aggregation engine** — a per-subscription task that consumes `MetricsTick` bus events, maintains a bounded in-memory rollup (ring buffers of derived rates + last raw snapshot per server), and emits coalesced `OverviewFrame`s at a fixed cadence.
6. **Alerts & thresholds** — user-defined `AlertRule`s (metric + comparator + threshold + duration/hysteresis), evaluated on every aggregation tick; alert state machine (`Ok → Pending → Firing → Ok`), persistence of rules and fired events, ack.
7. **Event timeline** — a merged, time-ordered feed of dashboard-relevant events (connection status transitions, server up/down, alert fire/clear, JetStream stream created/deleted as observed) for the overview screen.
8. **Frontend** — the `/dashboard/:connectionId` route, ECharts charts/sparklines/KPI tiles, alert management UI, timeline UI, with smooth jank-free live updates.

### 1.2 Explicitly OUT of scope (belongs to peers — do not duplicate)
- **HTTP polling / parsing of monitoring endpoints** → `ns-monitor` ([monitoring]). Dashboard never calls `reqwest` and never imports `async-nats`. It reads monitor snapshots and subscribes to `MetricsTick`.
- **Raw metric ring buffers of parsed endpoint values** → `ns-monitor` owns per-endpoint history. Dashboard keeps only *derived* rollups for the overview screen and backfills history by asking `ns-monitor`.
- **Connection lifecycle / status source of truth** → `ns-connection` ([connection-manager]). Dashboard consumes `ConnectionStatusChanged`.
- **Stream/consumer CRUD & detail** → `ns-jetstream`. Dashboard only reads aggregate JS snapshots for the overview KPI/health, then deep-links into the JetStream feature for detail.
- **Generic notification center / toasts** → emitted via the standard `Notification` payload on the bus; the frontend-shell renders them. Dashboard only *produces* alert notifications.
- **SQL execution** → `ns-storage` ([storage]) is the only crate with SQL. Dashboard defines repository **ports** (traits) and DTOs; `ns-storage` implements them.
- **Panel docking/layout engine** → dockview + `LayoutRepo` (frontend-shell/storage). Dashboard supplies panel components; it does not own the docking framework.

### 1.3 Boundary invariant
`ns-dashboard` is L3 and composes L2 peers **downward only** (`ns-connection`, `ns-monitor`, `ns-jetstream`). Those peers never depend back on it. It imports **no** `tauri`, `async-nats`, `reqwest`, `rusqlite`, or `keyring`. It talks to the outside only through ports (traits) injected by the bin, and to the UI only through `ns-ipc`.

---

## 2. Rust public interface (`ns-dashboard`)

### 2.1 Crate error (thiserror, one public enum — Spine §7)
```rust
// crates/ns-dashboard/src/error.rs
use ns_core::{DomainError, ErrorCode};

#[derive(Debug, thiserror::Error)]
pub enum DashboardError {
    #[error("monitor data unavailable for connection {0}")]
    MonitorUnavailable(ConnectionId),

    #[error("connection {0} is not active")]
    ConnectionInactive(ConnectionId),

    #[error("alert rule {0} not found")]
    AlertRuleNotFound(AlertRuleId),

    #[error("invalid alert rule: {0}")]
    InvalidAlertRule(String),

    #[error("no data yet for metric {metric:?} on connection {conn}")]
    NoSeriesData { conn: ConnectionId, metric: MetricKind },

    #[error("overview subscription {0} not found")]
    SubscriptionNotFound(SubscriptionId),

    #[error(transparent)]
    Storage(#[from] ns_storage::StorageError),   // wrapped; source chain preserved

    #[error("operation cancelled")]
    Cancelled,

    #[error(transparent)]
    Internal(#[from] anyhow::Error), // internal only; NOT anyhow in public fn signatures
}

impl DomainError for DashboardError {
    fn code(&self) -> ErrorCode {
        match self {
            DashboardError::MonitorUnavailable(_)        => ErrorCode::MonitorUnreachable,
            DashboardError::ConnectionInactive(_)        => ErrorCode::ConnectionClosed,
            DashboardError::AlertRuleNotFound(_)         => ErrorCode::NotFound,
            DashboardError::InvalidAlertRule(_)          => ErrorCode::InvalidArgument,
            DashboardError::NoSeriesData { .. }          => ErrorCode::NotFound,
            DashboardError::SubscriptionNotFound(_)      => ErrorCode::NotFound,
            DashboardError::Storage(e)                   => e.code(),
            DashboardError::Cancelled                    => ErrorCode::Cancelled,
            DashboardError::Internal(_)                  => ErrorCode::Internal,
        }
    }
    fn retriable(&self) -> bool {
        matches!(self,
            DashboardError::MonitorUnavailable(_) | DashboardError::ConnectionInactive(_))
    }
    fn user_message(&self) -> String { /* localized, secret-safe */ }
}

pub type DashResult<T> = Result<T, DashboardError>;
```

### 2.2 The service trait (the public port — implemented here, injected by the bin)
```rust
// crates/ns-dashboard/src/service.rs
use async_trait::async_trait;
use ns_core::CancellationToken;
use ns_types::dashboard::*;   // DTOs live in ns-types (SoT)

#[async_trait]
pub trait DashboardService: Send + Sync + 'static {
    /// One-shot snapshot: pulls latest monitor snapshot(s) + connection status + JS aggregate
    /// and composes a full overview. Backfills sparkline series from monitor history.
    async fn get_overview(&self, req: GetOverviewRequest) -> DashResult<DashboardOverview>;

    /// Historical (backfilled) rate series for a metric over a time range, resampled to `points`.
    async fn get_traffic_series(&self, req: GetTrafficSeriesRequest) -> DashResult<TrafficSeries>;

    /// Start a live overview stream. Returns a subscription id; frames are pumped into the
    /// caller-supplied sink (Channel adapter is created in ns-ipc). Cancelled via `stop_overview`.
    async fn start_overview_stream(
        &self,
        req: StartOverviewRequest,
        sink: Box<dyn OverviewSink>,      // ns-ipc adapts tauri::ipc::Channel<OverviewFrame> to this
        cancel: CancellationToken,
    ) -> DashResult<SubscriptionId>;

    async fn stop_overview_stream(&self, id: SubscriptionId) -> DashResult<()>;

    // ---- Alerts ----
    async fn list_alert_rules(&self, req: ListAlertRulesRequest) -> DashResult<Vec<AlertRule>>;
    async fn create_alert_rule(&self, req: CreateAlertRuleRequest) -> DashResult<AlertRule>;
    async fn update_alert_rule(&self, req: UpdateAlertRuleRequest) -> DashResult<AlertRule>;
    async fn delete_alert_rule(&self, req: DeleteAlertRuleRequest) -> DashResult<()>;
    async fn set_alert_rule_enabled(&self, req: SetAlertRuleEnabledRequest) -> DashResult<AlertRule>;
    /// Evaluate a (possibly unsaved) rule against the current rollup — for the editor "test" button.
    async fn test_alert_rule(&self, req: TestAlertRuleRequest) -> DashResult<AlertEvaluation>;

    async fn list_alert_events(&self, req: ListAlertEventsRequest) -> DashResult<AlertEventPage>;
    async fn acknowledge_alert(&self, req: AcknowledgeAlertRequest) -> DashResult<()>;

    // ---- Timeline ----
    async fn get_timeline(&self, req: GetTimelineRequest) -> DashResult<TimelinePage>;
}

/// Object-safe sink so the service is decoupled from tauri::ipc::Channel.
pub trait OverviewSink: Send + Sync {
    fn send(&self, frame: OverviewFrame) -> Result<(), SinkClosed>;
    fn is_closed(&self) -> bool;   // watchdog uses this to detect view unmount (Spine §ADR-0018)
}
pub struct SinkClosed;
```

### 2.3 Concrete implementation & injected ports
```rust
// crates/ns-dashboard/src/lib.rs
pub struct DashboardServiceImpl {
    connections: Arc<dyn ConnectionQuery>,   // narrow read-only port over ns-connection
    monitor:     Arc<dyn MonitorQuery>,      // narrow read-only port over ns-monitor
    jetstream:   Arc<dyn JetStreamQuery>,    // narrow read-only port over ns-jetstream
    events:      EventBus,                    // ns-event handle (subscribe MetricsTick / status)
    publisher:   Arc<dyn EventPublisher>,     // ns-core port (emit AlertStateChanged / Notification)
    alerts_repo: Arc<dyn AlertRuleRepo>,      // ns-core port, impl in ns-storage
    alert_events_repo: Arc<dyn AlertEventRepo>,
    clock:       Arc<dyn Clock>,              // ns-core port (testable time)
    subs:        DashMap<SubscriptionId, AggregationHandle>, // live streams
    settings:    Arc<dyn SettingsQuery>,      // retention/cadence knobs
}
```

**Narrow inbound ports** (defined in `ns-core`, implemented by the L2 peers so dashboard depends on abstractions, not the whole peer surface — DIP, Spine §ADR-0007):
```rust
// ns-core::ports::dashboard
#[async_trait] pub trait MonitorQuery: Send + Sync {
    async fn latest_snapshot(&self, c: ConnectionId) -> Option<ClusterMonitorSnapshot>;
    async fn history(&self, c: ConnectionId, metric: MetricKind, range: TimeRange)
        -> Option<RawCounterSeries>;   // monotonic counters, for rate derivation/backfill
}
#[async_trait] pub trait ConnectionQuery: Send + Sync {
    async fn status(&self, c: ConnectionId) -> Option<ConnectionStatus>;
    async fn list_active(&self) -> Vec<ConnectionId>;
}
#[async_trait] pub trait JetStreamQuery: Send + Sync {
    async fn aggregate(&self, c: ConnectionId) -> Option<JsAggregateSnapshot>;
}
```
> These three ports are **cross-team contributions** to `ns-core` (small PR + review). `ns-monitor`, `ns-connection`, `ns-jetstream` each `impl` them over their existing internal state. This keeps `ns-dashboard`'s Cargo deps to `ns-core`/`ns-types`/`ns-event` for behaviour and the three peers only for concrete wiring in the bin. (Per Spine the crate-level `depends_on` already lists the three peers; the port split is an internal refinement, not a layering change.)

### 2.4 Internal building blocks (private)
```rust
// Aggregation engine — one per live overview subscription.
struct AggregationEngine {
    conn: ConnectionId,
    cadence: Duration,               // default 1s (settings-driven, floor 250ms)
    window: Duration,                // sparkline lookback, default 5m
    rollup: RwLock<Rollup>,          // bounded ring buffers of derived rates + last raw snapshot
    rate_calc: RateCalculator,       // counter-diff with wrap/reset detection
    evaluator: AlertEvaluator,
}
struct Rollup { series: HashMap<(ServerId, MetricKind), RingBuffer<RatePoint>>, /* ... */ }

struct RateCalculator; // dv/dt with reset detection: if curr < prev -> treat as counter reset, emit gap
struct AlertEvaluator { rules: Vec<CompiledRule>, states: HashMap<AlertRuleId, RuleState> }
struct RuleState { phase: AlertPhase, since: OffsetDateTime, last_value: f64 } // hysteresis machine
```

---

## 3. Shared DTOs (added to `ns-types::dashboard` — typeshared, camelCase, tagged enums)

> **Cross-team dependency:** these types are added to `ns-types` (SoT) under a new `dashboard` module; adding types is non-breaking but still goes through `pnpm gen:types` + CI drift check (Spine §6). No `appSchemaVersion` bump needed for additive DTOs.

```rust
#[typeshare] #[serde(rename_all="camelCase")]
pub struct DashboardOverview {
    pub connection_id: ConnectionId,
    pub generated_at: String,               // RFC-3339
    pub connection_status: ConnectionStatus,
    pub cluster: ClusterOverview,
    pub servers: Vec<ServerHealth>,
    pub kpis: Vec<KpiTile>,
    pub jetstream: Option<JsAggregateSnapshot>,
    pub active_alerts: Vec<AlertState>,     // currently Pending/Firing
    pub stale: bool,                        // monitor data older than 2×poll interval
}

#[typeshare] #[serde(rename_all="camelCase")]
pub struct ClusterOverview {
    pub name: Option<String>,
    pub server_count: u32,
    pub healthy: u32, pub degraded: u32, pub down: u32,
    pub total_connections: u64,
    pub total_subscriptions: u64,
    pub total_routes: u32, pub total_gateways: u32, pub total_leafs: u32,
    pub in_msgs_rate: f64, pub out_msgs_rate: f64,   // msgs/s cluster aggregate
    pub in_bytes_rate: f64, pub out_bytes_rate: f64, // bytes/s
    pub slow_consumers: u64,
    pub version_skew: Vec<String>,          // distinct server versions if >1
}

#[typeshare] #[serde(rename_all="camelCase")]
pub struct ServerHealth {
    pub server_id: String,                  // varz.server_id
    pub name: String, pub host: String, pub version: String,
    pub status: ServerStatus,               // enum Up/Degraded/Down/Unknown
    pub uptime_ms: u64,
    pub connections: u64, pub subscriptions: u64,
    pub cpu: f64, pub mem_bytes: u64,
    pub in_msgs_rate: f64, pub out_msgs_rate: f64,
    pub in_bytes_rate: f64, pub out_bytes_rate: f64,
    pub slow_consumers: u64, pub pending_bytes: u64,
    pub route_health: LinkHealth, pub gateway_health: LinkHealth, pub leaf_health: LinkHealth,
    pub health_reason: Option<String>,      // why degraded/down (secret-safe)
}

#[typeshare] #[serde(tag="kind", content="data", rename_all="camelCase")]
pub enum MetricKind {
    InMsgsRate, OutMsgsRate, InBytesRate, OutBytesRate,
    Connections, Subscriptions, SlowConsumers, PendingBytes,
    CpuPct, MemBytes, JsBytes, JsConsumers, RouteCount, GatewayCount, LeafCount,
}

#[typeshare] #[serde(rename_all="camelCase")]
pub struct KpiTile {
    pub metric: MetricKind, pub label: String, pub unit: String,
    pub current: f64, pub peak: f64, pub avg: f64,
    pub delta_pct: Option<f64>,             // vs previous window
    pub spark: Vec<f64>,                    // downsampled sparkline values
    pub trend: Trend,                       // Up/Down/Flat
}

#[typeshare] #[serde(rename_all="camelCase")]
pub struct TrafficSeries {
    pub metric: MetricKind, pub scope: SeriesScope, // Cluster | Server(id)
    pub points: Vec<TimePoint>,             // {ts: string, value: f64}
    pub interval_ms: u64, pub gaps: Vec<TimeGap>,   // reset/missing-poll markers
}

#[typeshare] #[serde(rename_all="camelCase")]
pub struct OverviewFrame {                  // pushed on the live Channel
    pub connection_id: ConnectionId,
    pub seq: u64,                           // monotonic; UI gap detection
    pub ts: String,
    pub cluster: ClusterOverview,
    pub servers: Vec<ServerHealthDelta>,    // only-changed servers to keep frames small
    pub kpis: Vec<KpiTile>,
    pub appended: Vec<SeriesAppend>,        // {metric, scope, point} live tail for charts
    pub alerts: Vec<AlertState>,            // changed alert states this frame
    pub dropped_ticks: u32,                 // from broadcast Lagged(n) -> gap indicator
}

// ---- Alerts ----
#[typeshare] #[serde(rename_all="camelCase")]
pub struct AlertRule {
    pub id: AlertRuleId, pub connection_id: Option<ConnectionId>, // None => applies to all
    pub name: String, pub metric: MetricKind, pub scope: SeriesScope,
    pub comparator: Comparator,             // Gt|Gte|Lt|Lte
    pub threshold: f64,
    pub for_ms: u64,                        // must breach continuously this long -> Firing
    pub clear_ms: u64,                      // hysteresis: below threshold this long -> Ok
    pub severity: Severity,                 // Info|Warning|Critical
    pub enabled: bool,
    pub created_at: String, pub updated_at: String,
}
#[typeshare] #[serde(rename_all="camelCase")]
pub struct AlertState {
    pub rule_id: AlertRuleId, pub name: String, pub severity: Severity,
    pub phase: AlertPhase,                  // Ok|Pending|Firing
    pub value: f64, pub threshold: f64,
    pub since: String, pub acknowledged: bool,
}
#[typeshare] #[serde(rename_all="camelCase")]
pub struct AlertEvent {                     // persisted history row
    pub id: AlertEventId, pub rule_id: AlertRuleId, pub connection_id: ConnectionId,
    pub transition: AlertTransition,        // Fired|Cleared|Acknowledged
    pub value: f64, pub threshold: f64, pub severity: Severity,
    pub at: String, pub message: String,
}
#[typeshare] #[serde(rename_all="camelCase")]
pub struct AlertEvaluation { pub would_fire: bool, pub value: f64, pub sample_count: u32 }

// ---- Timeline ----
#[typeshare] #[serde(tag="kind", content="data", rename_all="camelCase")]
pub enum TimelineEvent {
    ConnectionStatus { status: ConnectionStatus },
    ServerUp { server_id: String }, ServerDown { server_id: String, reason: Option<String> },
    AlertFired { rule_id: AlertRuleId, name: String, severity: Severity, value: f64 },
    AlertCleared { rule_id: AlertRuleId, name: String },
    JetStreamChange { detail: String },
}
#[typeshare] #[serde(rename_all="camelCase")]
pub struct TimelineEntry { pub at: String, pub connection_id: ConnectionId, pub event: TimelineEvent }

// Pages (monomorphized per Spine generics policy)
#[typeshare] pub struct AlertEventPage { pub items: Vec<AlertEvent>, pub next_cursor: Option<String>, pub total: Option<u64> }
#[typeshare] pub struct TimelinePage { pub items: Vec<TimelineEntry>, pub next_cursor: Option<String> }
```

New ID newtypes in `ns-types`: `AlertRuleId(Uuid)`, `AlertEventId(Uuid)` (string-serialized, Spine §6.2).

---

## 4. Tauri IPC commands (exposed via `ns-ipc`; registered in the bin)

All commands: `#[tauri::command] async fn`, single `req` arg, return `Result<T, IpcError>`; the command body calls `AppState.dashboard`. Naming prefix `dashboard_*` (Spine §ipc_conventions).

| Command | Kind | Request | Returns | Primary error codes |
|---|---|---|---|---|
| `dashboard_get_overview` | request | `GetOverviewRequest { connectionId }` | `DashboardOverview` | `CONNECTION_CLOSED`, `MONITOR_UNREACHABLE` |
| `dashboard_get_traffic_series` | request | `GetTrafficSeriesRequest { connectionId, metric, scope, range: {fromTs,toTs}, points }` | `TrafficSeries` | `NOT_FOUND`, `MONITOR_UNREACHABLE`, `INVALID_ARGUMENT` |
| `dashboard_subscribe_overview` | **stream** (Channel) | `StartOverviewRequest { connectionId, cadenceMs?, windowMs? }` + `Channel<OverviewFrame>` | `SubscriptionId` (setup result) | `CONNECTION_CLOSED`, `MONITOR_UNREACHABLE` |
| `dashboard_unsubscribe_overview` | command | `UnsubscribeRequest { subscriptionId }` | `()` | `NOT_FOUND` |
| `dashboard_list_alert_rules` | request | `ListAlertRulesRequest { connectionId? }` | `Vec<AlertRule>` | `STORAGE` |
| `dashboard_create_alert_rule` | command | `CreateAlertRuleRequest { rule: AlertRuleDraft }` | `AlertRule` | `INVALID_ARGUMENT`, `STORAGE` |
| `dashboard_update_alert_rule` | command | `UpdateAlertRuleRequest { rule: AlertRule }` | `AlertRule` | `NOT_FOUND`, `INVALID_ARGUMENT`, `STORAGE` |
| `dashboard_delete_alert_rule` | command | `DeleteAlertRuleRequest { ruleId }` | `()` | `NOT_FOUND`, `STORAGE` |
| `dashboard_set_alert_rule_enabled` | command | `SetAlertRuleEnabledRequest { ruleId, enabled }` | `AlertRule` | `NOT_FOUND`, `STORAGE` |
| `dashboard_test_alert_rule` | command | `TestAlertRuleRequest { connectionId, rule: AlertRuleDraft }` | `AlertEvaluation` | `INVALID_ARGUMENT`, `MONITOR_UNREACHABLE` |
| `dashboard_list_alert_events` | request | `ListAlertEventsRequest { connectionId?, ruleId?, cursor?, limit }` | `AlertEventPage` | `STORAGE` |
| `dashboard_acknowledge_alert` | command | `AcknowledgeAlertRequest { ruleId }` | `()` | `NOT_FOUND`, `STORAGE` |
| `dashboard_get_timeline` | request | `GetTimelineRequest { connectionId, cursor?, limit }` | `TimelinePage` | `STORAGE` |

**Streaming contract (`dashboard_subscribe_overview`)** — Spine §ADR-0009/0018:
- Command spawns the `AggregationEngine` task, wires the `tauri::ipc::Channel<OverviewFrame>` through an `OverviewSink` adapter, registers the `CancellationToken` in the `CancellationRegistry` keyed by the returned `SubscriptionId`, and returns immediately.
- Backpressure: **keep-latest frame** at cadence (coalesce). If the internal bounded mpsc (cap 8) is full, drop older frames and set `dropped_ticks`.
- Cancellation: `dashboard_unsubscribe_overview` trips the token; a watchdog polling `sink.is_closed()` (view unmount / window close) also cancels — no leaked tasks.
- Mid-stream failure (e.g. monitor becomes unreachable) is delivered **in-band** as a terminal `error` variant on the Channel envelope (`ns-ipc` stream envelope), never as a thrown promise after setup succeeded.

---

## 5. Events emitted

Dashboard produces **domain events** on the internal bus (`EventPublisher` port); the single `ns-ipc::EventBridge` forwards UI-relevant ones (Spine §event_architecture). Dashboard never calls `AppHandle::emit` directly.

| Bus payload (`ns-types::EventPayload`) | Tauri event name | When | Coalescing policy |
|---|---|---|---|
| `AlertStateChanged` **(new variant — cross-team addition to the payload enum)** | `ns://dashboard/alert` | Rule transitions Ok↔Pending↔Firing or acked | dedupe identical states; always deliver transitions |
| `Notification` (existing) | `ns://notification` | Alert enters `Firing` / clears (Critical/Warning) | never drop |
| `TimelineAppended` **(new variant)** | `ns://dashboard/timeline` | New timeline entry created | rate-limit 10/s per connection, aggregate overflow |

> **Cross-team dependency:** adding `AlertStateChanged` and `TimelineAppended` to the `EventPayload` enum in `ns-types` + registering their topics + backpressure policy in the `EventBridge` is a PR to [core-runtime]/[tauri-shell]. Live overview frames do **not** go through the bus/bridge — they are request-scoped and travel on the Channel (rule of thumb: one screen → Channel; global signal → bridged event).

**Consumed** (subscribed from the bus): `MetricsTick` (primary rate source), `ConnectionStatusChanged` (health + timeline), `ServerInfoUpdated`, `StreamUpdated` (JS timeline entries).

---

## 6. Frontend surface (`apps/desktop/src/features/dashboard/`)

### 6.1 Route
- `/dashboard/:connectionId` (React Router). Default landing after selecting/activating a connection. Composed inside the dockview workspace; panels below are dockview panels registered by this feature.

### 6.2 Panels / components
```
features/dashboard/
  DashboardPage.tsx              // route entry; owns the live stream hook; lays out panels
  panels/
    ClusterOverviewPanel.tsx     // cluster KPIs + server-count donut (ECharts)
    ServerHealthGrid.tsx         // ServerHealth cards; HealthIndicator per server
    TrafficChartsPanel.tsx       // msgs/s + bytes/s line charts (ECharts), in/out series
    ConnectionsPanel.tsx         // connection & subscription count area chart + KPI
    KpiTileRow.tsx               // KpiTile[] with embedded sparklines
    AlertsPanel.tsx              // active AlertState list + rule management entry
    EventTimelinePanel.tsx       // virtualized timeline feed
  components/
    KpiTile.tsx, Sparkline.tsx, TrafficChart.tsx (ECharts wrapper),
    HealthIndicator.tsx, AlertBadge.tsx, ThresholdEditor.tsx
  modals/ AlertRuleEditorModal.tsx
  hooks/ useDashboardStream.ts, useOverviewQuery.ts, useTrafficQuery.ts, useAlerts.ts
```

**ECharts smooth-update strategy (no jank):** one chart instance per panel, updated via `setOption(partial, { lazyUpdate:true, notMerge:false })` on `requestAnimationFrame`; `appendData` for the live tail rather than full redraws; disable ECharts animation on live append (`animation:false`) but keep it on range changes; a shared ring buffer in the store caps points (default 300) per series. Charts subscribe to the store slice, not directly to the Channel, so React re-render is decoupled from frame arrival (batched at ~1 Hz).

### 6.3 Zustand store (UI/session only — Spine state boundary)
```ts
// stores/dashboardStore.ts
interface DashboardUiState {
  timeRange: '5m'|'15m'|'1h'|'6h'|'24h';
  paused: boolean;                       // freeze live updates
  visibleMetrics: Record<MetricKind,'shown'|'hidden'>;
  selectedServerId?: string;
  alertFilter: 'all'|'firing'|'acknowledged';
  liveSeries: Record<string, RingBuffer<TimePoint>>; // key=`${scope}:${metric}` — folded from Channel
  lastSeqByConn: Record<string, number>;             // gap detection
  ingestFrame(f: OverviewFrame): void;   // append + evict; sets gap flag on seq skip
}
```
> `liveSeries` is a transient session mirror of *streaming* data folded from the Channel (allowed — it originates from a request-scoped stream, not cached server-state). Historical/backfill series and all discrete resources go through TanStack Query, never mirrored into Zustand.

### 6.4 TanStack Query keys
```ts
['dashboard','overview', connectionId]                         // dashboard_get_overview (initial + refetch on focus)
['dashboard','traffic', connectionId, metric, scope, range]    // dashboard_get_traffic_series (backfill)
['dashboard','alertRules', connectionId ?? 'global']           // dashboard_list_alert_rules
['dashboard','alertEvents', connectionId, ruleId ?? 'all']     // dashboard_list_alert_events (infinite)
['dashboard','timeline', connectionId]                         // dashboard_get_timeline (infinite)
```
- Live `OverviewFrame`s are folded into the `['dashboard','overview',cid]` cache via `queryClient.setQueryData` (cluster/kpis/alerts) from the stream hook; charts read the store ring buffers. Mutations (`create/update/delete/enable/ack`) invalidate `alertRules`/`alertEvents`.
- `IpcError.retriable` drives retry; `MONITOR_UNREACHABLE` shows a "monitoring endpoint unreachable" empty-state with retry.

### 6.5 IPC client wrappers (generated, `packages/ns-bindings`)
```ts
ipc.dashboard.getOverview(req)              ipc.dashboard.getTrafficSeries(req)
ipc.dashboard.subscribeOverview(req, chan)  ipc.dashboard.unsubscribeOverview(req)
ipc.dashboard.listAlertRules(req)           ipc.dashboard.createAlertRule(req)
ipc.dashboard.updateAlertRule(req)          ipc.dashboard.deleteAlertRule(req)
ipc.dashboard.setAlertRuleEnabled(req)      ipc.dashboard.testAlertRule(req)
ipc.dashboard.listAlertEvents(req)          ipc.dashboard.acknowledgeAlert(req)
ipc.dashboard.getTimeline(req)
```
Ambient events consumed via the shared `useAppEvents()` hook: `ns://dashboard/alert` → update alert cache + badge; `ns://notification` → toast; `ns://dashboard/timeline` → prepend to timeline cache.

---

## 7. Data model (SQLite tables owned by dashboard; implemented in `ns-storage`)

> Tables are **owned** (schema authored) by dashboard but live in `ns-storage` migrations (only crate with SQL). New forward-only migration `crates/ns-storage/migrations/00NN_dashboard_alerts.sql`, bumping `PRAGMA user_version`. Repos implement `ns-core` ports `AlertRuleRepo`/`AlertEventRepo`. **Secrets:** none stored (all fields non-secret). Panel layout uses the existing `LayoutRepo` (namespace `dashboard:<connectionId>`), no new table.

```sql
CREATE TABLE dashboard_alert_rule (
  id            TEXT PRIMARY KEY,             -- AlertRuleId (uuid)
  connection_id TEXT,                         -- NULL => applies to all connections
  name          TEXT NOT NULL,
  metric        TEXT NOT NULL,                -- MetricKind kind tag
  scope         TEXT NOT NULL,                -- 'cluster' | 'server:<id>'
  comparator    TEXT NOT NULL,                -- gt|gte|lt|lte
  threshold     REAL NOT NULL,
  for_ms        INTEGER NOT NULL DEFAULT 0,
  clear_ms      INTEGER NOT NULL DEFAULT 0,
  severity      TEXT NOT NULL,                -- info|warning|critical
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_alert_rule_conn ON dashboard_alert_rule(connection_id);

CREATE TABLE dashboard_alert_event (
  id            TEXT PRIMARY KEY,
  rule_id       TEXT NOT NULL REFERENCES dashboard_alert_rule(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  transition    TEXT NOT NULL,                -- fired|cleared|acknowledged
  value         REAL NOT NULL,
  threshold     REAL NOT NULL,
  severity      TEXT NOT NULL,
  message       TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE INDEX idx_alert_event_conn_at ON dashboard_alert_event(connection_id, at DESC);
CREATE INDEX idx_alert_event_rule ON dashboard_alert_event(rule_id);
```
- **Retention:** `dashboard_alert_event` bounded by count + TTL (settings, default 5 000 rows / 30 days), enforced by the storage worker's retention pass (same mechanism as message history).
- **Time-series are NOT persisted** — traffic/rate series are in-memory (dashboard rollup + `ns-monitor` ring buffers). Backfill on reopen comes from `ns-monitor` history, not SQLite. (Open question §11 covers optional long-term persistence.)

`ns-core` port signatures:
```rust
#[async_trait] pub trait AlertRuleRepo: Send + Sync {
    async fn list(&self, conn: Option<ConnectionId>) -> Result<Vec<AlertRule>, StorageError>;
    async fn get(&self, id: AlertRuleId) -> Result<Option<AlertRule>, StorageError>;
    async fn upsert(&self, rule: &AlertRule) -> Result<(), StorageError>;
    async fn delete(&self, id: AlertRuleId) -> Result<(), StorageError>;
}
#[async_trait] pub trait AlertEventRepo: Send + Sync {
    async fn insert(&self, ev: &AlertEvent) -> Result<(), StorageError>;
    async fn page(&self, q: AlertEventQuery) -> Result<AlertEventPage, StorageError>;
    async fn prune(&self, policy: RetentionPolicy) -> Result<u64, StorageError>;
}
```

---

## 8. Dependencies on other subsystems/crates

| Depends on | Why | Direction |
|---|---|---|
| `ns-types` (L0) | all DTOs, `MetricKind`, `AlertRule`, event payloads | compile |
| `ns-core` (L0) | `DomainError`, `ErrorCode`, `Clock`, `CancellationToken`, `EventPublisher`, the 3 narrow query ports, repo ports | compile |
| `ns-event` (L1) | subscribe `MetricsTick`/status; publish alert/timeline events | compile |
| `ns-connection` (L2) | `ConnectionQuery` impl (status, active list) | compile+wire |
| `ns-monitor` (L2) | `MonitorQuery` impl (snapshots, counter history) — **primary data source** | compile+wire |
| `ns-jetstream` (L2) | `JetStreamQuery` impl (aggregate JS snapshot) | compile+wire |
| `ns-storage` (L1) | `AlertRuleRepo`/`AlertEventRepo` impls | wire (via ports) |
| `ns-ipc` (L3) | Channel↔`OverviewSink` adapter, command envelopes, `EventBridge` | wire |
| `nats-studio` bin (L4) | composition root: builds `DashboardServiceImpl`, injects ports, registers commands | wire |
| `ns-testkit` (dev) | monitor/connection/JS mock ports, fake `Clock`, DTO builders | dev |

**Downstream consumers:** [frontend-shell] (renders route/panels), [tauri-shell] (bridge/commands). No L2 peer depends back on dashboard (invariant §1.3).

---

## 9. Concurrency, async & backpressure

- **One aggregation task per live overview subscription** (`tokio::spawn`, tracked in `TaskRegistry`, `CancellationToken` in `CancellationRegistry`). Multiple windows/tabs on the same connection each get their own task but share the `ns-monitor` upstream (monitor polls once; dashboard fans out). Consider a shared per-connection engine with ref-counting if many tabs (open question §11).
- **Data flow:** `ns-monitor` polls (its cadence) → emits `MetricsTick` on the bus → dashboard's `broadcast::Receiver` consumes → `RateCalculator` differentiates counters → `Rollup` ring buffers updated → `AlertEvaluator` steps its state machines → coalesced `OverviewFrame` emitted at `cadence` (default 1 s, decoupled from monitor poll rate).
- **Rate derivation:** rates are `Δcounter / Δt` between consecutive raw snapshots. Reset detection: if `curr < prev`, treat as server restart/counter reset → emit a `TimeGap` (no negative spike), reseed baseline. Clamp Δt to avoid divide-by-tiny on clock jitter.
- **Backpressure (producer never blocked — Spine §event_architecture):**
  - Bus receiver lag → `RecvError::Lagged(n)` → set `dropped_ticks=n` on next frame → UI shows gap indicator. Dashboard never stalls the monitor.
  - Channel to UI: bounded mpsc (cap 8), **keep-latest** coalescing; overflow increments `dropped_ticks`.
  - Sparkline/series ring buffers are fixed-capacity (drop-oldest); frame carries only *deltas* (`ServerHealthDelta`, `SeriesAppend`) to keep payloads small.
- **Alert evaluation** is O(rules × servers) per tick, done synchronously inside the aggregation task (cheap: a few comparisons + time bookkeeping). No extra locking — the evaluator is owned by the task. Firing/clearing publishes to the bus (non-blocking `try_send`; `Notification` policy is never-drop so it uses the reliable path).
- **Storage** writes (alert events) go through the async storage-worker port; the aggregation task `await`s the repo future but the write is off-loop — never blocks frame production (fire-and-log on error, alert still surfaces live).
- **Lazy init:** the service holds no per-connection state until the first `get_overview`/`subscribe` for that connection (fast startup, low memory — Spine state model).
- **UI thread:** all work is on tokio tasks; frames arrive on the Channel; the frontend batches store writes and updates ECharts on rAF. Nothing blocks the WebView.

---

## 10. Test plan

### 10.1 Unit (in-crate, no NATS, fake `Clock`)
- `RateCalculator`: monotonic increase → correct rate; counter reset (`curr<prev`) → gap + reseed, no negative; irregular Δt → clamped; zero Δt → skip.
- `AlertEvaluator` state machine: below→above for `< for_ms` stays `Pending`; sustained ≥ `for_ms` → `Firing` + one `fired` event; flapping under `clear_ms` does not clear; ack sets flag without changing phase; disabled rule never fires. Table-driven with a fake clock.
- `Rollup` ring buffers: capacity eviction, sparkline downsample correctness, delta computation (`ServerHealthDelta` only emits changed fields).
- `ClusterOverview` fusion: N `ServerHealth` → correct sums, healthy/degraded/down counts, version-skew detection, slow-consumer totals.
- DTO serde: `typeshare` round-trip snapshot (camelCase, tagged enums), `IpcError` mapping for each `DashboardError` variant (`code/retriable`).

### 10.2 Integration (crate + `ns-testkit` mocks)
- `DashboardServiceImpl` with **mock** `MonitorQuery`/`ConnectionQuery`/`JetStreamQuery` + in-memory repos: `get_overview` composes correctly across mixed server health; `MonitorUnavailable` when no snapshot; `stale=true` when snapshot age > 2× interval.
- Live stream: feed a scripted sequence of `MetricsTick` through a real `ns-event` bus → assert emitted `OverviewFrame` sequence (seq monotonic, coalescing at cadence, `dropped_ticks` on injected `Lagged`). Use `tokio::time` paused clock.
- Cancellation: trip token / close sink → task exits, no orphan (assert `TaskRegistry` empty, `JoinHandle` completes).
- Alert persistence: create rule → drive tick above threshold → assert `AlertEvent` row written, `AlertStateChanged` + `Notification` published; ack → row + state update; retention prune bounds rows.
- Repo integration against real `ns-storage` (bundled SQLite, temp db): migration applies, CRUD + pagination + cascade delete + prune.

### 10.3 End-to-end (real `nats-server` via `ns-testkit` fixture; full bin)
- Boot embedded `nats-server` with HTTP monitoring (`-m`), connect, open `/dashboard/:id`: `dashboard_subscribe_overview` yields frames; publish load via `nats` CLI / pubsub → assert msgs/s and bytes/s rise on the Channel; connection count reflects opened subs.
- Multi-server cluster fixture (2–3 servers): cluster overview aggregates; kill one server → `ServerDown` timeline entry + degraded cluster counts + (if rule set) alert fires end-to-end to a bridged `ns://dashboard/alert` event.
- Monitoring endpoint down mid-stream → in-band Channel `error` (`MONITOR_UNREACHABLE`), UI empty-state, auto-retry recovers.
- Frontend (Vitest + Testing Library / Playwright for the Tauri webview): store `ingestFrame` gap detection on seq skip; ECharts append does not full-redraw (spy on `setOption` vs `appendData`); pause freezes updates; alert editor `test` button calls `dashboard_test_alert_rule`.
- Performance/soak: 3 servers × high publish rate for 10 min → memory flat (ring buffers bounded), frame cadence steady ~1 Hz, no task leak, UI stays >50 fps (no jank) — verified via `tracing` span timings + a headless frame counter.

### 10.4 CI gates
- `cargo xtask check-layers` (no dep on L4/peers-upward), `cargo-deny`, `pnpm gen:types && git diff --exit-code` (DTO drift), clippy `-D warnings`, `cargo test -p ns-dashboard`, e2e job installs pinned `nats-server`/`nats` (Spine §ADR-0016).

---

## 11. Risks & open questions

**Risks**
1. **Rate accuracy depends on `ns-monitor` poll cadence & jitter.** Coarse/irregular polls make msgs/s noisy. Mitigation: derive rates from counters (not gauges), timestamp each snapshot at source, expose the effective interval in `TrafficSeries.intervalMs`, optional UI smoothing (EMA) — smoothing is display-only, raw kept.
2. **Counter resets on server restart** producing spikes — handled by reset detection, but multi-server aggregation must reset per-server baselines independently (don't sum across a reset boundary).
3. **`MetricsTick` payload sufficiency.** Dashboard needs per-server `in/out msgs/bytes`, connections, subs, slow-consumers, JS aggregate in the tick (or fetch-on-tick). If `MetricsTick` is thin, dashboard must pull `latest_snapshot` each tick → more coupling. **Needs alignment with [monitoring] on the `MetricsTick`/`ClusterMonitorSnapshot` shape.**
4. **ECharts update cost at high server counts** (large clusters) → jank. Mitigation: delta frames, capped points, virtualized server grid, downsampling; consider canvas renderer + `large: true`.
5. **Multi-window fan-out** duplicating aggregation work per tab.
6. **Alert evaluation across connections when a rule has `connectionId=None`** — needs an engine per active connection or a global evaluator; scoping/lifecycle must be explicit to avoid firing on inactive connections.

**Open questions**
1. **`MetricsTick` contract** — final field set + whether it carries per-server breakdown or just cluster totals (drives §9 pull-vs-push). Owner: [monitoring] + [dashboard].
2. **Shared vs per-subscription aggregation engine** — ref-counted per-connection engine (less CPU/mem, more complexity) vs simple per-subscription. Lean: per-connection shared engine with N sinks once >1 tab is common.
3. **Long-term time-series persistence** — do we persist downsampled rollups to SQLite for "last 7 days" traffic history, or stay in-memory (current design)? If yes, new `dashboard_series` table + retention; likely a fast-follow ADR.
4. **New `EventPayload` variants** (`AlertStateChanged`, `TimelineAppended`) and the 3 `ns-core` query ports — confirm PR ownership/timing with [core-runtime].
5. **Alert delivery beyond in-app** (OS notifications, webhook) — out of v1? Ties into [logging-observability]/notifications.
6. **Threshold defaults / templates** — ship a curated default rule set (slow consumers > 0, server down, high pending bytes) seeded on first run?
7. **Health scoring model** — exact thresholds that map a server to Degraded vs Down (e.g. missed poll count, slow-consumer count, mem %). Needs a documented, testable `HealthPolicy`.
