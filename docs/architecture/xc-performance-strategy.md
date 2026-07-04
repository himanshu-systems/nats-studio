# Cross-Cutting Strategy — Performance (`[performance-strategy]`)

**Owning strategy lead:** Performance Strategy
**Scope:** Whole application — every crate (`ns-*`), the bin (`nats-studio`), IPC, and the React frontend.
**Related ADRs:** ADR-0009 (Channels + bridged events), ADR-0010 (event bus + single bridge), ADR-0011 (state model), ADR-0015 (bounded monitoring ring buffers), ADR-0018 (cancellation & task model).
**Status:** Strategy v1 (binding — every subsystem must comply).

> This document conforms to THE ARCHITECTURAL SPINE. It introduces **no new runtime dependencies outside the pins** except the following dev-only / build-only tooling that every team already needs and which is hereby pinned centrally: `criterion` (benches), `divan` (optional micro-bench, opt-in), `dhat` (heap profiling, dev-feature), `tokio-console`/`console-subscriber` (async task diagnostics, dev-feature). All are `[dev-dependencies]` or behind a `perf-diag` feature and are **never** shipped in release. This is a policy document: it sets budgets, mandates techniques, and defines the compliance gate. It does not redefine any crate's public API — it constrains how those APIs must behave under load.

---

## 0) Executive summary — the performance contract

NATS Studio must feel instant on a developer laptop while remaining stable in front of an **abusive** NATS deployment: millions of messages/sec on a subject, `connz` with 100k+ connections, JetStream streams with hundreds of millions of messages, 50+ open connection profiles. The strategy rests on five pillars:

1. **Lazy everything.** Nothing initializes until first use. Startup does the minimum to paint a window and restore layout.
2. **The backend is the funnel, not the frontend.** All pagination, filtering, sorting, sampling, coalescing, and diffing happen in Rust (L2 services) so the WebView only ever receives bounded, screen-sized payloads.
3. **Bounded by construction.** Every buffer, ring, cache, channel, and task registry has a fixed capacity and an explicit drop/coalesce policy. There is no unbounded growth anywhere on a hot path.
4. **Zero-copy to the boundary.** `bytes::Bytes` flows from `async-nats` through the feature services to the IPC edge; the single serialization point is the IPC boundary, where bytes become base64 exactly once.
5. **Measured, gated, regression-proof.** `criterion` benches with committed baselines and CI regression gating on the hot paths; runtime budgets asserted in tests and surfaced in a debug HUD.

If a subsystem cannot meet a budget below, that is a design defect to escalate — not a number to quietly relax.

---

## 1) Startup time budget & lazy subsystem initialization

### 1.1 Budgets (cold start, mid-tier laptop: 4-core, SATA/NVMe SSD, release build)

| Phase | Budget (p50) | Budget (p95) | What must happen |
|---|---|---|---|
| Process spawn → Tauri window visible (first paint) | **≤ 400 ms** | ≤ 700 ms | Window created, splash/shell painted. |
| First paint → interactive shell (router + dockview layout restored) | **≤ 500 ms** | ≤ 900 ms | Layout read from SQLite, empty panels mounted. |
| Cold start → **time-to-interactive** (TTI, no auto-connect) | **≤ 900 ms** | ≤ 1.6 s | User can click, open a view, start a connection. |
| Auto-reconnect of one saved connection (if enabled) | **≤ +600 ms** | ≤ +1.2 s | Off the critical path; async, never blocks TTI. |
| Cold binary size (installer, per-platform) | **≤ 15 MB** | ≤ 25 MB | Tauri + rustls; no Electron bloat. |

These are asserted by a startup benchmark in `apps/desktop` (see §7.4) and tracked per release.

### 1.2 What `main` is allowed to do synchronously

The bin (`nats-studio`) composition root runs, in order, **only**:

1. Install the layered `tracing-subscriber` (`ns-telemetry`) — cheap, no IO beyond opening the rolling log file (non-blocking appender).
2. Resolve app-data dir (Tauri path API), open SQLite with WAL, run **pending migrations only** (`rusqlite_migration`; no-op fast path when `user_version` is current).
3. Construct the **service registry** `AppState` as a set of **lazy handles** (see §1.3). No network, no NATS, no keychain access.
4. Register `#[tauri::command]`s, start the `EventBridge`, start Tauri plugins, show the window.

Anything else — connecting, polling, spawning the terminal, loading plugins, warming caches — is **deferred**.

### 1.3 Lazy subsystem initialization pattern (mandatory)

Every L2/L3 service is registered in `AppState` as an `Arc<dyn Service>`, but the **expensive innards** are built on first use. Two allowed mechanisms:

```rust
// Mechanism A: OnceCell-guarded lazy inner (for services with heavy setup)
pub struct JetStreamServiceImpl {
    deps: JetStreamDeps,              // cheap: cloned ports/handles
    inner: tokio::sync::OnceCell<JsRuntime>, // heavy: built on first call
}

impl JetStreamServiceImpl {
    async fn runtime(&self) -> Result<&JsRuntime, JetStreamError> {
        self.inner.get_or_try_init(|| JsRuntime::build(&self.deps)).await
    }
}
```

```rust
// Mechanism B: the service itself is cheap; per-connection state is lazy
// (ConnectionService owns a DashMap<ConnectionId, ConnectionHandle>;
//  a handle is only created on connection_connect, never at startup.)
```

**Rules:**
- Constructing a service in the bin must be **allocation-cheap and IO-free** (clone `Arc` ports, no `connect`, no file scan, no keychain read).
- Background pollers (`ns-monitor` scheduler), the plugin host scan (`ns-plugin`), and the storage retention sweeper (`ns-storage`) start **on demand or on an idle callback**, never in `main`.
- The keychain (`ns-security`) is touched only when a connection actually needs a secret — first-run keychain unlock prompts must never appear during startup.
- Frontend: route-level `React.lazy` + `Suspense` for every subsystem view (JetStream, Monitor, Terminal, Inspector, Subject Explorer, Account/Security). Monaco, xterm.js, and ECharts are **dynamically imported** on first view mount, never in the initial bundle. Vite `manualChunks` splits `monaco`, `xterm`, `echarts`, and each feature into its own chunk. Target initial JS ≤ **250 KB gzip**.

### 1.4 Frontend startup specifics

- The app shell (router + Zustand store hydration + dockview layout) is the only thing in the entry chunk.
- Layout/prefs are read once via `settings_get`/`layout_get`; Zustand persisted slices are a **mirror** (per the spine) — hydrate from the fast local mirror immediately, reconcile with SQLite in the background.
- TanStack Query is created with `defaultOptions` tuned for desktop: `staleTime` per query family (see §2.6), `gcTime` bounded, `refetchOnWindowFocus: false` (desktop, not a browser tab).

---

## 2) Large datasets: virtualization, windowed loading, server-side pagination/filtering, diffing

This is the single most important area. The rule: **the frontend never holds an unbounded list**, and **the backend never returns one**.

### 2.1 Server-side pagination is mandatory (cursor-based, per the spine's IPC conventions)

Every list endpoint that can exceed ~1k rows is cursor-paginated in Rust:

```rust
// ns-types (shared, typeshared). Monomorphize where typeshare generics are weak.
pub struct PageRequest { pub cursor: Option<String>, pub limit: u32 } // limit clamped server-side
pub struct MessagePage { pub items: Vec<MessageRow>, pub next_cursor: Option<String>, pub total: Option<u64> }
```

Affected subsystems and their datasets:

| Subsystem | Dataset | Server-side technique |
|---|---|---|
| `ns-monitor` | `connz` (100k+ conns), `subsz` | offset/limit against the endpoint; cache + diff snapshots; never return the whole map. |
| `ns-jetstream` | stream messages (millions), consumer lists, KV keys, object listings | JetStream `get`/replay by seq range + `limit`; KV history windowed; object list paginated. |
| `ns-pubsub` | live subscription firehose | **sampling + coalescing**, not pagination (see §3). |
| `ns-subject` | subject tree (100k+ subjects) | server-builds the tree, returns **expanded node's children only** (lazy tree, one level at a time). |
| `ns-storage` | message history, saved queries | SQL `LIMIT`/`OFFSET` or keyset pagination; bounded by retention. |
| `ns-inspector` | large single payloads (10s of MB) | windowed hex/preview slices (offset+length), never ship the full decoded blob to render. |

**Clamp rule:** every `limit` is clamped server-side to a per-endpoint max (`MessagePage` ≤ 500, `connz` page ≤ 1000, subject children ≤ 2000). A client asking for more gets the clamp, logged at `debug`.

### 2.2 Server-side filtering & sorting

Filtering and sorting run in Rust, close to the data, before pagination:
- `ns-monitor` filters `connz` by cid/subject/state server-side; the UI sends predicates, not a "give me all then filter in JS" request.
- `ns-jetstream` filters messages by subject/header/time range and sorts by seq server-side.
- `ns-subject` filters/aggregates the tree server-side.
- SQL-backed lists push `WHERE`/`ORDER BY` into SQLite (indexed columns only; migrations must add indexes for any filterable column).

The frontend filter UI is **debounced (150–250 ms)** and issues a new paginated query; it does not re-filter a cached mega-list.

### 2.3 Frontend virtualization (mandatory for any scrollable list/table/tree)

- **Library:** TanStack Virtual (`@tanstack/react-virtual`) for rows, columns, and grid virtualization. It is already in the TanStack family we ship.
- **Every** long surface is virtualized: message tables, `connz` tables, KV entries, object listings, subject tree (windowed tree), log viewer, terminal scrollback (xterm.js handles its own), stream/consumer lists.
- Only the visible window + a small overscan (≈8 rows) is in the DOM. Row height is fixed or measured-and-cached; dynamic-height rows use TanStack Virtual's measurement, not layout thrash.
- **Infinite/windowed loading:** `useInfiniteQuery` + virtual scroll — fetch the next page when the sentinel enters the overscan zone. Pages are dropped from cache beyond a window (bounded `maxPages`) so scrolling a million-row stream never grows memory unbounded.

### 2.4 Diffing for incremental UI updates

High-churn read models are **diffed in Rust** so IPC carries deltas, not full snapshots:

```rust
// e.g. ns-monitor: snapshot cache + structural diff → patch DTO
pub enum RowDelta<T> { Upsert(T), Remove(RowId) }
pub struct TablePatch { pub base_seq: u64, pub deltas: Vec<RowDelta<MonitorRow>>, pub dropped: u32 }
```

- `ns-monitor` keeps the latest snapshot per `(connection, endpoint, serverId, scope)` and emits a `TablePatch` on each poll; the UI applies deltas to the TanStack cache via `setQueryData`. Full snapshot only on first load or after a gap.
- `ns-jetstream` stream/consumer info emits changed-fields patches for the live info panel.
- `ns-subject` emits per-node stat deltas (rate/count) rather than re-shipping the tree.
- Sequence numbers (`seq` on the event envelope, per the spine) drive **gap detection**: a missed `seq` forces a full re-fetch of that model, so a dropped delta never corrupts the view.

### 2.5 The "never materialize" rule

No service may build a `Vec` of the entire dataset in memory to then page/filter it, when the source supports streaming/ranged access. Stream from the source (JetStream ordered consumer, HTTP paged endpoint, SQL cursor) and apply `limit` as you go. `ns-inspector` must decode payloads **lazily and windowed** — a 50 MB message is previewed by decoding only the requested slice.

### 2.6 TanStack Query cache discipline

- Query keys namespaced per the spine (`['jetstream','streams',connectionId]`).
- `staleTime` tuned by family: monitor snapshots 1–2 s, stream/consumer lists 5–10 s, KV entries 10 s, static server info 30 s.
- `gcTime` bounded (e.g. 5 min) so background tabs release memory.
- Streaming data folds into the cache via `setQueryData` from Channel/event handlers — **never** poll a subject firehose through Query.
- `select` narrows large query results to the view's needs so components re-render on minimal slices.

---

## 3) Zero-copy, backpressure, sampling & coalescing on high-rate paths

### 3.1 Zero-copy with `bytes::Bytes`

`async-nats` yields message payloads as `bytes::Bytes` (ref-counted, cheap clone, no copy). The policy:

- **`bytes::Bytes` is the payload currency** from `ns-nats` through `ns-pubsub`/`ns-jetstream`/`ns-inspector` up to the IPC edge. Do not `.to_vec()` a payload on a hot path.
- Headers likewise borrow; parse lazily in `ns-inspector` on demand, not for every firehose message.
- **The single copy** is at the IPC boundary: `ns-ipc` base64-encodes `Bytes` → `String` exactly once, with an explicit `encoding` field (per the spine — never raw byte arrays over IPC). For the firehose we do **not** ship every payload: we ship metadata + a truncated/sampled preview (see §3.4).
- For large single payloads the inspector returns **windowed base64 slices**; the full blob is never encoded in one shot.
- Internal fan-out on the event bus (`ns-event`) clones `Bytes` handles (cheap), never the underlying buffer. `Arc<Payload>` where a payload is shared across subscribers.

### 3.2 Backpressure — bounded everywhere, producers never block on the UI

Per the spine's event architecture, **producers are never blocked by a slow UI**. Concretely:

- Every subscription task pumps a **bounded `tokio::mpsc`** (capacity e.g. 1024) into the Tauri `Channel`. On overflow, apply the declared policy (sample+count for high-rate subs; the terminal/log use bounded FIFO with an overflow marker preserving order).
- The internal bus uses `tokio::broadcast`; a lagging receiver yields `RecvError::Lagged(n)` → the `EventBridge` emits a synthetic "n dropped" so the UI shows a gap indicator (per spine). The producer side never awaits a full receiver.
- The `EventBridge` applies per-topic coalescing (MetricsTick keep-latest per 250 ms tick; SubjectActivity rate-limited; LogEmitted drop-oldest ring; Notification never drop) — this is the central backpressure valve for ambient events.
- **HTTP monitoring** (`ns-monitor`) uses bounded concurrency (a `Semaphore`) and adaptive backoff so a slow/large server never queues unbounded requests.
- **Storage** (`ns-storage`) is a single-writer worker with a bounded command queue; message-history inserts from a high-rate subscription are **batched** and dropped-with-count if the queue saturates rather than blocking the subscription.

### 3.3 Sampling on high-rate subscriptions (the firehose problem)

A subject doing 1M msg/s cannot and must not be rendered row-by-row. `ns-pubsub` implements, per subscription, a **declared delivery policy**:

```rust
pub enum DeliveryPolicy {
    All,                                   // only for low-rate; hard-capped
    Sample { max_per_sec: u32 },           // rate-limited sampling, count drops
    HeadTail { head: u32, window: u32 },   // first N + rolling last M
    CountOnly,                             // pure rate/throughput, no payloads
}
pub struct SubBatch {
    pub items: Vec<MessageRow>,   // coalesced batch, not one-per-frame
    pub dropped_since_last: u64,  // surfaced so the UI shows "sampling, N dropped/s"
    pub rate_per_sec: f64,
}
```

- Default for an interactive subscribe is `Sample { max_per_sec: 200 }` — enough to see traffic, cheap to render. The UI always shows the true rate and the dropped count so nothing is silently hidden.
- Messages are delivered in **coalesced batches** on a timer (e.g. every 100–250 ms) as one `SubBatch`, not one IPC event per message. Batching collapses N invokes into one and is the difference between smooth and melting.
- `CountOnly` powers throughput sparklines with essentially zero per-message cost.

### 3.4 Coalescing everywhere it matters

- **Metrics:** `ns-monitor` + `EventBridge` coalesce to one frame per 250 ms per `(connectionId, metric)`.
- **Subject activity:** `ns-subject` aggregates per-subject counts over a window and emits one activity delta, not per-message events.
- **Subscription rows:** batched per §3.3.
- **Log stream:** bounded ring, drop-oldest, coalesced flush; UI virtualizes the buffer.
- **Task progress:** keep-latest per task id.

### 3.5 Cancellation is a performance feature (ADR-0018)

Leaked tasks/subscriptions are a memory and CPU leak. Every stream/long op has a `CancellationToken` in the `CancellationRegistry` keyed by the id returned to the UI; Channel drop-detection (view unmount) trips it; a watchdog reaps orphans. **No task outlives its view.** This is mandatory and CI-testable (a leak test asserts task count returns to baseline after subscribe→unsubscribe).

---

## 4) Memory budget & measurement

### 4.1 Budgets

| Scenario | RSS budget (p95) |
|---|---|
| Idle, 1 connection, dashboard open | **≤ 250 MB** |
| Active: 3 connections, monitor polling, one live subscription (sampled) | **≤ 450 MB** |
| Heavy: 10 connections, JetStream browsing a huge stream, 100k `connz` | **≤ 800 MB** |
| Per additional idle connection | **≤ +15 MB** |
| Message-history DB on disk (default retention) | bounded by size+TTL policy (`ns-storage`) |

### 4.2 How memory stays flat

- **Bounded rings** for all time-series (`ns-monitor`, ADR-0015) — fixed capacity, overwrite oldest.
- **Bounded caches** — LRU with a max entry count/byte budget (monitor snapshots, decoded-payload cache in `ns-inspector`, subject subtree cache). Evict by bytes, not just count.
- **Windowed frontend lists** — TanStack Virtual + `maxPages` drop (§2.3).
- **`Bytes` ref-counting** — shared payloads, no duplication across the fan-out.
- **Retention sweeper** — `ns-storage` enforces message-history size+TTL on the storage worker; `PRAGMA` WAL checkpointing bounded.
- **Lazy decode** — inspector decodes on view, caches bounded, drops on eviction.
- **Drop on disconnect** — closing a connection reaps its handle, tasks, caches, and rings (`ConnectionHandle` drop).

### 4.3 Measurement & tooling

- **`dhat`** (dev-feature `perf-diag`) for heap profiling in benches and manual runs — allocation counts and peak bytes on hot paths (payload decode, diffing, tree build).
- **`tokio-console`** via `console-subscriber` (dev-feature) to watch task counts, poll times, and detect leaked/long-poll tasks.
- **RSS assertions** in an integration test that drives the heavy scenario against `ns-testkit`'s embedded `nats-server` and checks process RSS stays under budget (soft-gate: warns in CI, hard-gates on a nightly perf job to avoid flakiness).
- **Debug HUD** (dev builds only): a small overlay reading `app_perf_stats` (task count, bus lag events, per-topic drop counts, cache bytes, RSS) so regressions are visible during development.

---

## 5) Background workers, threading & the "never block the UI thread" rule

- **Async everywhere on IO** (spine principle). Every `#[tauri::command]` is `async`; nothing blocks the WebView.
- **CPU-bound work off the async reactor:** payload decode of large blobs, protobuf/avro schema work, diffing huge tables, subject-tree construction, and hex rendering run on `spawn_blocking` or a dedicated `rayon` pool — **never** inline on a tokio worker that also drives IO. (`rayon` is permitted only inside `ns-inspector`/`ns-subject` for pure CPU fan-out; it is not a new IO runtime.)
- **Storage worker:** single-writer task + small read pool via `spawn_blocking` (spine's storage conventions) — SQL never runs on the UI path.
- **Monitor scheduler / retention sweeper / plugin scan:** long-lived background tasks in the `TaskRegistry`, each cancellable, each with bounded work per tick.
- **Debounce/throttle at the source:** filters, resize, layout persistence (debounced mutations to SQLite), and metric emission are rate-limited so a burst never floods a worker.
- **Fairness:** long background scans yield (`tokio::task::yield_now`/chunked work) so a big JetStream replay doesn't starve interactive commands.

---

## 6) High-FPS chart rendering (ECharts)

Charts are a classic frame-killer. Rules for every metrics/topology visualization:

- **Bounded series length** — charts render from the `ns-monitor` ring buffers (fixed N points); the x-window slides, points don't accumulate.
- **Coalesced updates** — one frame per 250 ms max (§3.4). Use ECharts `setOption` with `notMerge:false` and **`appendData`** for streaming series instead of replacing the whole dataset.
- **Canvas renderer** (not SVG) for streaming charts; enable `large`/`largeThreshold` and `progressive` rendering for big scatter/line series; `sampling: 'lttb'` (downsampling) on dense lines.
- **Off the React render loop** — the chart instance is a ref; streaming updates call `chart.appendData`/`setOption` directly, never via React state (no per-tick re-render/reconcile).
- **rAF alignment** — batch incoming ticks and flush once per animation frame; never call `setOption` synchronously per event.
- **Dispose on unmount** — ECharts instances disposed with the view; no retained WebGL/canvas contexts.
- **Target:** dashboards with ~6 live charts stay at **60 FPS**; degraded gracefully to 30 FPS under extreme load by widening the coalesce window, never by dropping to jank.

---

## 7) Benchmark harness, perf targets & regression gating

### 7.1 Tooling

- **`criterion`** (`[dev-dependencies]`, pinned in `[workspace.dependencies]`) is the canonical Rust benchmark harness. Every performance-critical crate ships a `benches/` dir.
- **`divan`** permitted for fast micro-benchmarks where criterion's overhead is noise (opt-in, per crate).
- **`cargo xtask bench`** wraps criterion runs, stores baselines, and drives the CI comparison (xtask is the canonical repo automation per the spine).
- Frontend: a lightweight render-perf harness (React Profiler + a scripted virtualized-scroll test) measures frame times; not gated as hard as Rust but tracked.

### 7.2 What every subsystem must benchmark (mandatory `benches/`)

| Crate | Benchmark |
|---|---|
| `ns-inspector` | decode throughput (MB/s) per codec; format auto-detect cost; hex-window slice. |
| `ns-pubsub` | subscribe pipeline: msgs/s through sampling+coalescing; batch build cost. |
| `ns-jetstream` | message page fetch + map to DTO; KV get; replay window. |
| `ns-monitor` | `connz` parse (100k conns); snapshot diff cost; ring push. |
| `ns-subject` | tree build (100k subjects); wildcard match; subtree query. |
| `ns-storage` | history insert batch throughput; paged query latency. |
| `ns-event` | bus fan-out throughput; coalesce/backpressure under a slow receiver. |
| `ns-ipc` | IpcError mapping; base64 encode of a page; DTO serialize. |
| `ns-types` | serde serialize/deserialize of the largest DTOs. |

### 7.3 Perf targets (representative, on the reference machine, release)

| Path | Target |
|---|---|
| JSON payload decode | ≥ 500 MB/s (serde_json), auto-detect ≤ 2 µs for typical payloads |
| Subscribe pipeline (sampled, `CountOnly`) | ≥ 1M msg/s counted; sampled delivery adds ≤ 5% overhead |
| `connz` parse (100k conns) | ≤ 80 ms; snapshot diff ≤ 15 ms |
| Subject tree build (100k subjects) | ≤ 120 ms; single subtree query ≤ 1 ms |
| Message page (500 rows) fetch+map+serialize | ≤ 20 ms server-side |
| Bus fan-out | ≥ 2M events/s to a keeping-up receiver; no producer stall on a slow one |
| IPC page serialize (500 rows + base64 previews) | ≤ 10 ms |

Numbers are starting baselines; each owning team refines its target with its first bench and commits the baseline.

### 7.4 Regression gating (CI)

- Each crate commits its criterion **baseline** (`target/criterion` summary distilled into a committed `benches/baselines/*.json` by `cargo xtask bench --save`).
- CI runs `cargo xtask bench --check` on a **stable, dedicated runner** (perf runs are noisy on shared CI — use a pinned self-hosted or a nightly job) and **fails if any hot-path bench regresses > 10%** vs. baseline (configurable threshold per bench; some allow 15%). Improvements auto-refresh the baseline on a maintainer's opt-in.
- Startup + RSS integration checks run on the **nightly perf job** (soft on PRs to avoid flakiness, hard on nightly). A regression opens a tracking issue automatically.
- **No baseline bump without justification** in the PR description — silently regressing a budget is a blocked merge.

---

## 8) Per-subsystem compliance checklist (binding)

Every subsystem lead signs off that their design satisfies these. This is enforced in design review and by the benches above.

- **[core-runtime] `ns-core`/`ns-event`/`ns-types`:** lazy-init utilities (`OnceCell` helpers), `CancellationToken`/`TaskHandle` primitives, monotonic `seq` for gap detection, bounded broadcast/mpsc with documented capacities, `Bytes`-friendly payload types in DTOs (base64 at the edge only). `ns-event` owns the central backpressure/coalesce policy types.
- **[connection-manager] `ns-nats`/`ns-connection`:** `Bytes` payloads never copied; per-connection handle reaped on disconnect (memory); reconnection backoff bounded; connect is off the startup path.
- **[pubsub] `ns-pubsub`:** `DeliveryPolicy` sampling + coalesced `SubBatch` mandatory; bounded mpsc → Channel; `dropped_since_last` surfaced; `CountOnly` fast path.
- **[jetstream] `ns-jetstream`:** ranged/seq pagination, no full-stream materialization; KV/object listings paged; replay windowed + cancellable.
- **[monitoring] `ns-monitor`:** bounded rings (ADR-0015); snapshot cache + `TablePatch` diffing; `connz`/`subsz` paged; adaptive poll backoff + bounded concurrency; chart-shaped bounded series.
- **[subject-explorer] `ns-subject`:** lazy one-level tree; server-side filter/aggregate; per-node stat deltas; bounded subtree cache; CPU tree-build off the reactor.
- **[message-inspector] `ns-inspector`:** windowed decode of large payloads; bounded decoded-payload LRU (by bytes); `spawn_blocking`/`rayon` for heavy decode; lazy header parse.
- **[storage] `ns-storage`:** single-writer worker, bounded command queue, batched history inserts, retention sweeper, keyset/limit pagination, indexes for filterable columns, WAL checkpoint bounded.
- **[dashboard] `ns-dashboard`:** composes already-bounded snapshots; never re-fetches full datasets; aggregation is cheap and coalesced.
- **[terminal] `ns-terminal`:** bounded FIFO output, preserve order, overflow marker; xterm.js scrollback capped; PTY read off the UI path.
- **[tauri-shell] `ns-ipc` + bin:** single base64/serialize point; `EventBridge` coalescing + Lagged→gap; command panics caught (no WebView crash); lazy service registry; startup budget owner.
- **[logging-observability] `ns-telemetry`:** non-blocking appender; bounded in-app ring; log stream coalesced; `perf-diag` feature gates `dhat`/`tokio-console`; owns the debug HUD data (`app_perf_stats`).
- **[account-security] `ns-security`:** keychain access lazy (never at startup); crypto (sign/verify/derive) off the reactor for bulk ops; `Redacted<T>` cost negligible.
- **[frontend-shell] React app:** route-level `React.lazy`; dynamic import of Monaco/xterm/ECharts; TanStack Virtual on every long surface; `useInfiniteQuery` + `maxPages`; debounced filters; charts off the render loop; bounded query `gcTime`.
- **[plugin-architecture] `ns-plugin`:** plugin scan/load lazy and off startup; per-plugin CPU/time budget with cancellation; plugin events go through the coalescing bridge; a slow plugin cannot stall the host (bounded, cancellable invocation).

---

## 9) Failure modes & how the strategy handles them

| Failure mode | Symptom | Mitigation (owner) |
|---|---|---|
| Subject firehose (1M msg/s) | UI melts / OOM | Sampling `DeliveryPolicy` + coalesced batches + `dropped_since_last` (`ns-pubsub`). |
| `connz` with 100k connections | Multi-MB IPC payload, jank | Server-side paging + diffing `TablePatch` + virtualization (`ns-monitor` + FE). |
| Huge JetStream stream (100M msgs) | Unbounded fetch | Ranged/seq pagination, windowed replay, cancellable (`ns-jetstream`). |
| 50 MB single message | Decode stall / copy storm | Windowed lazy decode + `spawn_blocking` + bounded LRU (`ns-inspector`). |
| Slow WebView / user on another tab | Producer stall, backpressure into NATS client | Bounded channels, drop-with-count, Lagged→gap; producers never await UI (`ns-event`/`ns-ipc`). |
| Leaked subscription/task on unmount | Growing CPU/RSS | Channel drop-detection + `CancellationRegistry` reap + leak test (ADR-0018). |
| Many charts streaming | FPS collapse | Coalesce 250 ms, canvas + LTTB + `appendData`, off React render loop, degrade to 30 FPS not jank. |
| Startup crept up | Slow launch | Lazy init, split bundles, startup bench + budget gate (bin/FE). |
| Memory creep over a long session | RSS climbs | Bounded rings/caches/pages, retention sweeper, drop-on-disconnect, RSS assertion test. |
| History table unbounded growth | Disk bloat, slow queries | Size+TTL retention on storage worker, keyset pagination, indexes. |
| Perf regression slips into a release | Silent slowdown | criterion baselines + `xtask bench --check` 10% gate + nightly startup/RSS job. |

---

## 10) Definition of done (performance)

A subsystem is performance-complete when: (1) it hits every applicable budget in §1/§4/§7; (2) it ships the mandated `benches/` with committed baselines; (3) it obeys the §8 checklist items for its team; (4) its heavy paths are proven bounded (no full-dataset materialization, bounded buffers/caches); (5) cancellation/leak tests pass; and (6) the CI regression gate is green. Missing any of these blocks the subsystem's "implementable" sign-off.
