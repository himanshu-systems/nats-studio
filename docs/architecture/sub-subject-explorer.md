# NATS Studio — Subsystem Design: Subject Explorer

> Document ID: `arch/sub-subject-explorer`
> Subsystem: **[subject-explorer]**
> Owning crate: **`ns-subject`** (L2 feature service) + a slice of the React frontend
> Status: **DRAFT for implementation**
> Binding parent: `arch/00-conventions-and-workspace` (Source of Truth). This document refines the spine for the subject-explorer subsystem; where it needs to deviate it files an ADR. It never silently diverges.

---

## 1. Charter, responsibilities & boundaries

### 1.1 What we own

The Subject Explorer answers the question *"what subjects exist in this NATS system, who is allowed to touch them, and how much traffic flows through each?"* Concretely:

1. **Hierarchical subject tree** built from two data sources merged into one trie:
   - **Live traffic** — a sampled subscription (default scoped root, `>` only behind an explicit guardrail) that observes real subjects flowing on the connection.
   - **`subsz`** — the server's subscription-interest snapshot (subjects with registered interest, subscriber counts), obtained from the monitoring subsystem via a port.
2. **Wildcard analysis** — validate/parse subjects and patterns per NATS token rules; expand `*` (single-token) and `>` (trailing multi-token) against the observed tree; compute overlap between patterns.
3. **Per-subject statistics & traffic rates** — message/byte counts, EWMA message & byte rates, first/last-seen, average payload size — maintained in bounded in-memory structures.
4. **Permission overlay** — for the current connection's user, mark each node/pattern `Allowed | Denied | Partial | Unknown` for publish and subscribe, using NATS permission semantics (deny-wins, wildcard match).
5. **Favorites** — user-pinned subjects/patterns, persisted (schema owned here, physically stored by `ns-storage`).
6. **Fast search / filter** — substring/glob/regex search over the observed subject space with cursor pagination; client-side filters (only-favorites, hide-denied, min-rate).

### 1.2 What we explicitly do NOT own (boundaries)

- **We do not open, close, or own connections.** We resolve a live `NatsClient` for a `ConnectionId` through the `ClientResolver` port (impl: `ns-connection`). No hidden "current connection".
- **We do not poll HTTP monitoring endpoints.** `subsz` comes from `ns-monitor` via the `SubszSource` port. `reqwest` never appears in `ns-subject`.
- **We do not parse JWT/creds or evaluate account config.** The current user's effective publish/subscribe allow/deny lists come from `ns-security` via the `SubjectPermissionSource` port. We only run the *subject-matching* logic on top of those lists.
- **We do not decode payloads.** Sampling extracts only subject string, byte length, and header-presence — never payload bytes (privacy + memory). Deep payload inspection belongs to `[message-inspector]`.
- **We do not persist message history or time-series.** Stats are ephemeral (rebuilt on reconnect). History is `[message-inspector]`; metric ring buffers are `[monitoring]`.
- **We do not write SQL.** Favorites persistence goes through the `SubjectFavoriteRepo` port (impl + migrations in `ns-storage`).

### 1.3 Layering

`ns-subject` is **L2**. Per the fixed workspace layout its declared dependencies are exactly `ns-types, ns-core, ns-event, ns-nats`. Every other collaborator (connection registry, subsz, permissions, favorites persistence) is reached through a **port trait defined in `ns-core`** and injected by the bin — preserving DIP and the one-way dependency flow, and keeping L2 peers (`ns-monitor`, `ns-connection`, `ns-security`, `ns-storage`) decoupled.

---

## 2. Rust public interface

All types below are Rust-internal unless annotated `// ns-types (DTO)`. DTOs live in `ns-types`, are `#[serde(rename_all = "camelCase")]`, typeshared, and are the only things that cross IPC.

### 2.1 Error type (`ns-subject`)

```rust
// crates/ns-subject/src/error.rs
#[derive(Debug, thiserror::Error)]
pub enum SubjectError {
    #[error("subject or pattern is invalid: {0}")]
    InvalidSubject(String),
    #[error("no live client for connection {0}")]
    ConnectionClosed(ConnectionId),
    #[error("subscribe denied by server permissions for {subject}")]
    PermissionDenied { subject: String },
    #[error("subsz unavailable: {0}")]
    SubszUnavailable(String),          // wraps SubszSource port error
    #[error("sampling session {0} not found")]
    SessionNotFound(SamplingSessionId),
    #[error("favorite {0} not found")]
    FavoriteNotFound(FavoriteId),
    #[error("operation cancelled")]
    Cancelled,
    #[error(transparent)]
    Storage(#[from] FavoriteRepoError),  // port error, re-exported by ns-core
    #[error(transparent)]
    Nats(#[from] ns_nats::NatsError),
    #[error("internal: {0}")]
    Internal(String),
}

impl ns_core::DomainError for SubjectError {
    fn code(&self) -> ns_types::ErrorCode {
        use ns_types::ErrorCode::*;
        match self {
            SubjectError::InvalidSubject(_)        => SUBJECT_INVALID,
            SubjectError::ConnectionClosed(_)      => CONNECTION_CLOSED,
            SubjectError::PermissionDenied { .. }  => PERMISSION_DENIED,
            SubjectError::SubszUnavailable(_)      => MONITOR_UNREACHABLE,
            SubjectError::SessionNotFound(_)       => NOT_FOUND,
            SubjectError::FavoriteNotFound(_)      => NOT_FOUND,
            SubjectError::Cancelled                => CANCELLED,
            SubjectError::Storage(_)               => STORAGE,
            SubjectError::Nats(e)                  => e.code(),
            SubjectError::Internal(_)              => INTERNAL,
        }
    }
    fn retriable(&self) -> bool {
        matches!(self, SubjectError::SubszUnavailable(_) | SubjectError::Nats(_))
    }
    fn user_message(&self) -> String { /* secret-safe, localized copy key */ }
}
```

### 2.2 The service trait (held in `AppState` as `Arc<dyn SubjectService>`)

```rust
// crates/ns-subject/src/service.rs
#[async_trait::async_trait]
pub trait SubjectService: Send + Sync {
    /// Depth-limited snapshot of the merged trie (traffic ∪ subsz), optionally
    /// decorated with stats and permission verdicts. Children beyond `depth`
    /// are summarized (hasChildren/childCount) and fetched lazily.
    async fn get_tree(&self, req: GetSubjectTreeRequest)
        -> Result<SubjectTree, SubjectError>;

    /// Lazily expand one node's direct children.
    async fn get_children(&self, req: GetSubjectChildrenRequest)
        -> Result<Vec<SubjectTreeNode>, SubjectError>;

    /// Begin a cancellable live sampling session. Coalesced frames are pumped
    /// into `sink` (the Tauri Channel). Returns the session handle immediately.
    async fn start_sampling(&self, req: StartSamplingRequest, sink: SamplingSink)
        -> Result<SamplingSession, SubjectError>;

    async fn stop_sampling(&self, session_id: SamplingSessionId)
        -> Result<(), SubjectError>;

    /// Validate + classify a pattern and (if a tree exists) report matches/overlaps.
    async fn analyze_pattern(&self, req: AnalyzePatternRequest)
        -> Result<PatternAnalysis, SubjectError>;

    /// Concrete subjects in the observed tree matched by a wildcard pattern.
    async fn expand_wildcard(&self, req: ExpandWildcardRequest)
        -> Result<WildcardExpansion, SubjectError>;

    async fn get_stats(&self, req: GetSubjectStatsRequest)
        -> Result<SubjectStatsDto, SubjectError>;

    async fn search(&self, req: SearchSubjectsRequest)
        -> Result<SearchSubjectsResponse, SubjectError>;

    async fn check_permission(&self, req: CheckPermissionRequest)
        -> Result<SubjectPermissionDto, SubjectError>;

    /// Re-pull subsz via the port and merge into the trie. Returns a diff summary.
    async fn refresh_subsz(&self, connection_id: ConnectionId)
        -> Result<SubszMergeSummary, SubjectError>;

    // favorites CRUD
    async fn list_favorites(&self, connection_id: Option<ConnectionId>)
        -> Result<Vec<SubjectFavorite>, SubjectError>;
    async fn add_favorite(&self, req: AddFavoriteRequest)
        -> Result<SubjectFavorite, SubjectError>;
    async fn remove_favorite(&self, id: FavoriteId) -> Result<(), SubjectError>;
    async fn rename_favorite(&self, req: RenameFavoriteRequest)
        -> Result<SubjectFavorite, SubjectError>;
}
```

`SamplingSink` wraps the bounded producer side that ultimately writes to the Tauri `Channel<SubjectActivityFrame>`, so the service crate stays free of `tauri`:

```rust
pub struct SamplingSink {
    tx: tokio::sync::mpsc::Sender<SubjectActivityFrame>, // bounded
}
pub struct SamplingSession {
    pub id: SamplingSessionId,          // newtype over Uuid → String on the wire
    pub connection_id: ConnectionId,
    pub root: SubjectPattern,
}
```

### 2.3 Ports we CONSUME (defined in `ns-core`, injected by the bin)

```rust
// crates/ns-core/src/ports/... (defined by core-runtime, consumed here)
#[async_trait::async_trait]
pub trait ClientResolver: Send + Sync {                 // impl: ns-connection
    async fn resolve(&self, id: ConnectionId)
        -> Result<Arc<dyn ns_nats::NatsClient>, ClientResolveError>;
}

#[async_trait::async_trait]
pub trait SubszSource: Send + Sync {                    // impl: ns-monitor
    async fn fetch_subsz(&self, id: ConnectionId)
        -> Result<SubszSnapshot, SubszError>;           // subjects + subscriber counts
}

pub trait SubjectPermissionSource: Send + Sync {        // impl: ns-security
    /// Effective allow/deny subject lists for the connected user, or None if
    /// permissions are not knowable (→ verdict Unknown).
    fn permissions_for(&self, id: ConnectionId) -> Option<UserSubjectPermissions>;
}

#[async_trait::async_trait]
pub trait SubjectFavoriteRepo: Send + Sync {            // impl: ns-storage
    async fn list(&self, connection_id: Option<ConnectionId>)
        -> Result<Vec<SubjectFavoriteRow>, FavoriteRepoError>;
    async fn insert(&self, row: SubjectFavoriteRow) -> Result<(), FavoriteRepoError>;
    async fn rename(&self, id: FavoriteId, label: String, note: Option<String>)
        -> Result<(), FavoriteRepoError>;
    async fn delete(&self, id: FavoriteId) -> Result<(), FavoriteRepoError>;
}
```

Also consumed: `ns_core::EventPublisher` (impl `ns-event`), `ns_core::Clock`, and the bin's `CancellationRegistry` (the bin keys the sampling `CancellationToken` by `sessionId`).

### 2.4 The concrete service + internal engine

```rust
pub struct SubjectServiceImpl {
    clients:     Arc<dyn ClientResolver>,
    subsz:       Arc<dyn SubszSource>,
    perms:       Arc<dyn SubjectPermissionSource>,
    favorites:   Arc<dyn SubjectFavoriteRepo>,
    events:      EventBusHandle,          // ns_core::EventPublisher
    clock:       Arc<dyn Clock>,
    // per-connection trie + sampling registry, lazily created on first use:
    tries:       DashMap<ConnectionId, Arc<RwLock<SubjectTrie>>>,
    sessions:    DashMap<SamplingSessionId, SamplingHandle>,
    cfg:         SubjectConfig,           // caps: max_nodes, tick, coalesce_ms, sample_rate
}
```

Pure engine components (no IO, unit-tested exhaustively):

```rust
/// Trie keyed by subject token. Interior nodes may also be concrete (observed).
pub struct SubjectTrie { root: TrieNode, node_count: usize, cfg: TrieCaps }
struct TrieNode {
    token: Token,                 // "orders", "*", ">", or "" for root
    children: HashMap<Token, Box<TrieNode>>,
    concrete: bool,               // observed as a full subject and/or in subsz
    stats: SubjectStats,          // counts + EWMA rate state
    subscribers: u32,             // from subsz
    last_seen: Option<Instant>,
}
impl SubjectTrie {
    pub fn observe(&mut self, subject: &Subject, bytes: u64, now: Instant);
    pub fn merge_subsz(&mut self, snap: &SubszSnapshot) -> SubszMergeSummary;
    pub fn children_of(&self, prefix: &Subject) -> impl Iterator<Item = &TrieNode>;
    pub fn tick_rates(&mut self, now: Instant);   // recompute EWMA on 1s tick
    pub fn evict_if_over_cap(&mut self);          // LRU on low-rate leaves → truncated flag
    pub fn search(&self, q: &SearchQuery, cursor: Option<Cursor>, limit: usize)
        -> (Vec<SubjectSearchHit>, Option<Cursor>);
}

/// Pure NATS wildcard semantics — no IO.
pub mod matcher {
    pub fn validate(input: &str, allow_wildcards: bool) -> Result<ParsedSubject, InvalidSubject>;
    pub fn matches(pattern: &SubjectPattern, subject: &Subject) -> bool; // * one token, > trailing
    pub fn overlaps(a: &SubjectPattern, b: &SubjectPattern) -> bool;     // intersection non-empty
    pub fn classify(p: &ParsedSubject) -> PatternKind; // Literal | SingleWildcard | FullWildcard | Mixed
}

/// Pure permission overlay — deny-wins, wildcard match against allow/deny lists.
pub mod permission {
    pub fn verdict(node: &SubjectPattern, perms: &UserSubjectPermissions) -> SubjectPermissionDto;
    // Partial = a wildcard node where some descendants allowed and some denied.
}
```

**EWMA rate model:** each node keeps `count`, `bytes`, and two EWMA accumulators (`msg_rate`, `byte_rate`) updated by a per-connection 1 Hz tick task using `rate_new = α·(Δcount/Δt) + (1−α)·rate_old`, `α≈0.3`. The tick task exists only while ≥1 view (sampling or tree) is open for the connection (lazy start / teardown on last release).

---

## 3. Tauri IPC commands (all `subject_*`, all `async`, all `Result<T, IpcError>`)

Every command takes one `req: XxxRequest` (except trivial id-only ones) and returns `XxxResponse`/DTO. Request/Response DTOs live in `ns-types`.

| Command | Kind | Params (`req`) | Returns | Primary errors (`ErrorCode`) |
|---|---|---|---|---|
| `subject_get_tree` | request | `GetSubjectTreeRequest { connectionId, root?: string, depth: u32, includeStats: bool, includeSubsz: bool, permissionOverlay: bool }` | `SubjectTree` | `CONNECTION_CLOSED`, `MONITOR_UNREACHABLE` (subsz opt), `SUBJECT_INVALID` (bad root) |
| `subject_get_children` | request | `GetSubjectChildrenRequest { connectionId, subject: string, includeStats, permissionOverlay }` | `SubjectTreeNode[]` | `CONNECTION_CLOSED`, `NOT_FOUND` |
| `subject_start_sampling` | command (opens stream) | `StartSamplingRequest { connectionId, root?: string, policy: SamplingPolicy }` + `Channel<SubjectActivityFrame>` | `StartSamplingResponse { sessionId }` | `CONNECTION_CLOSED`, `PERMISSION_DENIED`, `SUBJECT_INVALID`, `INVALID_ARGUMENT` (unsafe `>` w/o confirm) |
| `subject_stop_sampling` | command | `StopSamplingRequest { sessionId }` | `()` | `NOT_FOUND` |
| `subject_analyze_pattern` | request | `AnalyzePatternRequest { connectionId?, pattern: string }` | `PatternAnalysis` | `SUBJECT_INVALID` |
| `subject_expand_wildcard` | request | `ExpandWildcardRequest { connectionId, pattern: string, limit: u32, cursor? }` | `WildcardExpansion { items, nextCursor?, total? }` | `SUBJECT_INVALID`, `CONNECTION_CLOSED` |
| `subject_get_stats` | request | `GetSubjectStatsRequest { connectionId, subject: string, windowMs?: u64 }` | `SubjectStatsDto` | `NOT_FOUND`, `CONNECTION_CLOSED` |
| `subject_search` | request | `SearchSubjectsRequest { connectionId, query: string, mode: SearchMode, limit: u32, cursor? }` | `SearchSubjectsResponse { items, nextCursor?, total? }` | `INVALID_ARGUMENT` (bad regex), `CONNECTION_CLOSED` |
| `subject_check_permission` | request | `CheckPermissionRequest { connectionId, subject: string }` | `SubjectPermissionDto` | `CONNECTION_CLOSED` |
| `subject_refresh_subsz` | command | `RefreshSubszRequest { connectionId }` | `SubszMergeSummary` | `MONITOR_UNREACHABLE` |
| `subject_list_favorites` | request | `ListFavoritesRequest { connectionId?: string }` | `SubjectFavorite[]` | `STORAGE` |
| `subject_add_favorite` | request | `AddFavoriteRequest { connectionId?, label, pattern, note? }` | `SubjectFavorite` | `SUBJECT_INVALID`, `STORAGE` |
| `subject_remove_favorite` | request | `RemoveFavoriteRequest { id }` | `()` | `NOT_FOUND`, `STORAGE` |
| `subject_rename_favorite` | request | `RenameFavoriteRequest { id, label, note? }` | `SubjectFavorite` | `NOT_FOUND`, `STORAGE` |

**Streaming rule (ADR-0009):** `subject_start_sampling` is a *request-scoped* stream → a Tauri **Channel**. The command spawns a cancellable task, registers the token in the `CancellationRegistry` under `sessionId`, and returns `sessionId`. `subject_stop_sampling` trips the token; **Channel drop** (view unmount) is detected by the bridge watchdog and also cancels — no leaked subscriptions. Mid-stream failures are delivered **in-band** as a terminal `error` variant on the frame enum, not by rejecting the promise.

### 3.1 Key DTO shapes (`ns-types`)

```rust
// ns-types (DTO) — camelCase on the wire, typeshared
pub struct SubjectTree {
    pub connection_id: ConnectionId,
    pub root: String,                 // "" = system root
    pub nodes: Vec<SubjectTreeNode>,  // depth-limited flat list (parent-linked)
    pub truncated: bool,              // node cap hit / depth cut
    pub source: TreeSource,           // Traffic | Subsz | Merged
    pub generated_ts: String,         // RFC-3339
}
pub struct SubjectTreeNode {
    pub subject: String,              // full token path to this node
    pub token: String,
    pub parent: Option<String>,
    pub is_concrete: bool,
    pub has_children: bool,
    pub child_count: u32,
    pub stats: Option<SubjectStatsDto>,
    pub subscribers: Option<u32>,
    pub permission: Option<SubjectPermissionDto>,
    pub favorite: bool,
}
pub struct SubjectStatsDto {
    pub messages: u64, pub bytes: u64,
    pub msg_rate: f64, pub byte_rate: f64,   // per second, EWMA
    pub avg_size_bytes: f64,
    pub first_seen_ts: Option<String>,
    pub last_seen_ts: Option<String>,
    pub sampled: bool,                        // true if sample-every-N was applied
}
#[serde(tag = "kind", content = "data")]      // adjacently tagged → TS discriminated union
pub enum PermissionVerdict { Allowed, Denied, Partial, Unknown }
pub struct SubjectPermissionDto { pub publish: PermissionVerdict, pub subscribe: PermissionVerdict }

pub struct SubjectActivityFrame {             // Channel item
    pub seq: u64,                             // monotonic → UI gap detection
    pub ts: String,
    pub window_ms: u64,
    pub subjects: Vec<ObservedSubject>,       // coalesced within the window
    pub dropped_since_last: u64,              // backpressure signal
    pub terminal: Option<IpcError>,           // in-band stream end (error variant)
}
pub struct ObservedSubject { pub subject: String, pub count: u64, pub bytes: u64, pub last_size_bytes: u32 }

pub struct SamplingPolicy {
    pub max_rate_per_sec: u32,        // token-bucket cap on observed msgs
    pub sample_every: u32,            // 1 = every msg; N = 1-in-N
    pub coalesce_ms: u64,             // frame window (default 250)
    pub allow_full_wildcard: bool,    // guardrail for root == ">"
    pub max_duration_ms: Option<u64>,
}
#[serde(tag = "kind", content = "data")]
pub enum PatternKind { Literal, SingleWildcard, FullWildcard, Mixed }
pub struct PatternAnalysis {
    pub pattern: String, pub valid: bool, pub kind: PatternKind,
    pub tokens: Vec<SubjectTokenDto>, pub errors: Vec<String>,
    pub matched_count: u64, pub sample_matches: Vec<String>, pub overlaps: Vec<String>,
}
pub struct SubjectFavorite {
    pub id: FavoriteId, pub connection_id: Option<ConnectionId>,
    pub label: String, pub pattern: String, pub note: Option<String>,
    pub created_ts: String, pub updated_ts: String,
}
pub struct SubszMergeSummary { pub added: u32, pub updated: u32, pub total_subjects: u32 }
```

---

## 4. Events emitted

We emit **domain events only**, via the `EventPublisher` port — never `tauri::emit`. The `EventBridge` (`ns-ipc`) is the sole translator to Tauri events.

| Bus payload (`ns-types` `EventPayload` variant) | Tauri event | When | Backpressure/coalesce policy (§9 spine) |
|---|---|---|---|
| `SubjectActivity { connectionId, topSubjects, rate, dropped }` | `ns://subject/activity` | Ambient, low-frequency aggregate for dashboard/other screens **not** actively sampling | Rate-limit **N/s per connection**, aggregate + surface `dropped`; dedupe idle |
| `TaskProgress { taskId, phase, pct }` | `ns://task/progress` | Long tree build / bulk subsz merge | Keep-latest per `taskId` |

The **high-rate per-view sampling stream is NOT an event** — it is the `Channel` from `subject_start_sampling` (request-scoped, per ADR-0009). The bridged `ns://subject/activity` event is the *ambient, coalesced* signal so a dashboard mini-view or the connection tree can show liveliness without opening a full sampling session. `SubjectActivity` already exists in the spine's `EventPayload` enum — we do not add a new variant.

---

## 5. Frontend surface (React slice)

### 5.1 Route & panels
- **Route:** `/connections/:connectionId/subjects` (React Router), mounted as a dockview panel **"Subject Explorer"** (ADR-0012). Openable as a tab or floating group.
- **Components** (`apps/desktop/src/features/subjects/`):
  - `SubjectExplorerPanel` — layout shell (tree | detail | analyzer).
  - `SubjectTreeView` — virtualized tree (windowed), lazy children via `subject_get_children`, permission badge + rate sparkbar per row.
  - `SubjectSearchBar` — mode toggle (substring/glob/regex), debounced.
  - `SubjectDetailPanel` — stats card + ECharts rate sparkline, subscriber count, permission verdict, favorite toggle.
  - `WildcardAnalyzerPanel` — pattern input → token breakdown, validity, `matchedCount`, sample matches, overlaps.
  - `SamplingControls` — start/stop, `SamplingPolicy` form, `>`-guardrail confirm dialog, live `droppedSinceLast` indicator + gap marker.
  - `FavoritesSidebar` — list/add/rename/remove; drag-to-tree.
  - `PermissionOverlayToggle`, `SubjectFiltersBar` (only-favorites, hide-denied, min-rate).

### 5.2 Zustand store (UI/session only — never mirrors server state)
`useSubjectExplorerStore`: `expandedNodes: Set<string>`, `selectedSubject`, `searchQuery`, `searchMode`, `filters { onlyFavorites, hideDenied, minRate }`, `permissionOverlayOn`, `samplingPolicyDraft`, `activeSessionId`, `viewMode: 'tree' | 'flat'`. Persisted slices (last root, expanded, policy draft) are a debounced **mirror** of SQLite via `layout_*`/`settings_*` — SQLite is source of truth.

### 5.3 TanStack Query keys (all server-state)
```
['subject','tree',      connectionId, root, {stats, subsz, perms}]
['subject','children',  connectionId, subject]
['subject','stats',     connectionId, subject]
['subject','search',    connectionId, query, mode]        // infinite query (cursor)
['subject','expand',    connectionId, pattern]            // infinite query (cursor)
['subject','analyze',   connectionId, pattern]
['subject','permission',connectionId, subject]
['subject','favorites', connectionId]
```
Mutations (`add/remove/rename favorite`, `refreshSubsz`) invalidate `['subject','favorites',…]` / `['subject','tree',…]`. `IpcError.retriable` drives retry.

### 5.4 Streaming hook
`useSubjectSampling(connectionId, policy)` — owns a Tauri `Channel<SubjectActivityFrame>`; calls `ipc.subject.startSampling`; folds each frame into `['subject','tree',…]` via `queryClient.setQueryData` (incrementing counts/rates) and surfaces `droppedSinceLast`/`seq`-gaps to the store; calls `ipc.subject.stopSampling` on unmount. `useAppEvents()` routes ambient `ns://subject/activity` into the cache when no local session is active.

### 5.5 IPC client wrappers (`packages/ns-bindings`, generated + `commands.manifest.ts`)
`ipc.subject.{ getTree, getChildren, startSampling(req, channel), stopSampling, analyzePattern, expandWildcard, getStats, search, checkPermission, refreshSubsz, listFavorites, addFavorite, removeFavorite, renameFavorite }`. Never raw `invoke` with string literals.

---

## 6. Data model (SQLite — schema owned here, migrations physically in `ns-storage`)

Only **favorites** are persisted. Subject trees and stats are ephemeral (in-memory, rebuilt on reconnect) by design — they reflect live traffic and would be stale/misleading if persisted.

```sql
-- crates/ns-storage/migrations/00NN_subject_favorite.sql (schema authored by subject-explorer)
CREATE TABLE subject_favorite (
    id            TEXT PRIMARY KEY,              -- Uuid string (FavoriteId)
    connection_id TEXT NULL,                     -- NULL = global favorite
    label         TEXT NOT NULL,
    pattern       TEXT NOT NULL,                 -- validated subject/pattern
    note          TEXT NULL,
    created_ts    TEXT NOT NULL,                 -- RFC-3339
    updated_ts    TEXT NOT NULL
);
CREATE INDEX idx_subject_favorite_conn ON subject_favorite(connection_id);
CREATE UNIQUE INDEX idx_subject_favorite_uniq
    ON subject_favorite(COALESCE(connection_id,''), pattern);
```

DTO/rows owned: `SubjectFavorite` (wire), `SubjectFavoriteRow` (repo). No secrets stored. View prefs (expanded nodes, last root) live in Zustand-persisted `LayoutRepo` state, not here.

---

## 7. Dependencies on other subsystems/crates

| Need | Mechanism | Provider subsystem |
|---|---|---|
| Live `NatsClient` for sampling subscribe | `ClientResolver` port (ns-core) | `[connection-manager]` (`ns-connection`) |
| `subsz` snapshot (subjects + subscriber counts) | `SubszSource` port (ns-core) | `[monitoring]` (`ns-monitor`) |
| Current user publish/subscribe allow/deny lists | `SubjectPermissionSource` port (ns-core) | `[account-security]` (`ns-security`) |
| Favorites persistence | `SubjectFavoriteRepo` port (ns-core) | `[storage]` (`ns-storage`) |
| Emit ambient events | `EventPublisher` port (ns-core) | `[core-runtime]`/`[logging-observability]` bus (`ns-event`) |
| Bridge bus → Tauri, Channel plumbing, cancellation registry | consumed by bin/`ns-ipc` | `[tauri-shell]` (`ns-ipc`) |
| Shared DTOs, `ErrorCode`, `EventPayload::SubjectActivity` | direct dep | `ns-types` |
| Subject subscribe primitive | direct dep | `ns-nats` |

**Coordination asks (must be filed before/with implementation):**
- `[core-runtime]`: add `ClientResolver`, `SubszSource`, `SubjectPermissionSource`, `SubjectFavoriteRepo` ports to `ns-core` (some already needed by `ns-pubsub`/`ns-jetstream` — `ClientResolver` is shared).
- `[monitoring]`: implement `SubszSource`; define `SubszSnapshot` shape (subject → subscriber count, cid list optional).
- `[account-security]`: implement `SubjectPermissionSource`; define `UserSubjectPermissions { publish_allow, publish_deny, subscribe_allow, subscribe_deny }`; when permissions are not knowable, return `None` → `Unknown` verdict.
- `[storage]`: land the `subject_favorite` migration + repo impl.
- `[core-runtime]`: confirm `EventPayload::SubjectActivity` field shape matches §4.

---

## 8. Concurrency / async & backpressure

1. **Per-connection lazy engine.** A `SubjectTrie` + 1 Hz rate-tick task are created on first `get_tree`/`start_sampling` for a `ConnectionId` and torn down when the last consumer releases (ref-count). Zero global mutable statics; `DashMap<ConnectionId, Arc<RwLock<SubjectTrie>>>`.
2. **Sampling pipeline.** `start_sampling` opens an async-nats subscription on the (scoped) root. A dedicated task pulls messages into a **bounded** `mpsc`; a token-bucket (`max_rate_per_sec`) + `sample_every` gate drop excess *before* aggregation. Only `(subject, len, has_headers)` are extracted — payloads are dropped immediately (memory + privacy). The aggregator folds into the trie and, every `coalesce_ms` (default 250ms), flushes one `SubjectActivityFrame` with per-subject counts and `dropped_since_last`. The producer is **never blocked** by a slow WebView: if the Channel `mpsc` is full, frames coalesce further and `dropped_since_last` grows; a broadcast `Lagged(n)` on any bus path yields a synthetic gap marker (`seq` discontinuity) the UI renders.
3. **`>` guardrail.** Sampling the full wildcard on a busy server can be catastrophic. Default root is required/scoped; `root == ">"` demands `policy.allow_full_wildcard == true` (UI confirm dialog) else `INVALID_ARGUMENT`.
4. **Cancellation (ADR-0018).** Each session gets a `CancellationToken` keyed by `sessionId` in the `CancellationRegistry`. `stop_sampling`, Channel-drop watchdog, and `max_duration_ms` all trip it; the subscription is unsubscribed and the task joined — no orphaned NATS subscriptions.
5. **Tree size cap.** `max_nodes` (e.g. 50k) with LRU eviction of lowest-rate leaves; `truncated=true` surfaced. `get_tree` is depth-limited + lazy-children so a single IPC payload stays bounded.
6. **subsz merge** runs on a `spawn_blocking`-free async path (port is async); merges under a short write-lock, emits `TaskProgress` for large snapshots.
7. **Reads vs writes.** Tree reads (`get_tree`, `search`, `expand`) take the `RwLock` read guard; observe/merge/tick take the write guard briefly. Search/expand pagination is cursor-based (stable ordering by subject) so concurrent mutation doesn't corrupt a page walk.
8. **`#[instrument]`** on every service method with `connection_id`/`session_id`/`correlation_id` span fields (spine §12).

---

## 9. Test plan

**Unit (pure, no IO — the bulk of coverage):**
- `matcher::validate` truth table: valid literals; `*`/`>` placement rules (`>` only last, single token per `*`); rejects empty tokens, spaces, leading/trailing `.`, `>` mid-subject.
- `matcher::matches` / `expand`: concrete subject matches pattern **iff** it appears in the pattern's expansion (cross-checked via proptest).
- `matcher::overlaps`: `a.>` vs `a.b`, `*.x` vs `y.*`, disjoint prefixes, identical patterns.
- `permission::verdict`: deny-wins; wildcard allow with narrower deny → `Partial`; no lists → `Unknown`; allow-only vs deny-only lists.
- `SubjectTrie`: observe/aggregate counts+bytes, EWMA convergence, `avg_size`, LRU eviction + `truncated`, `merge_subsz` diff summary, cursor-stable search pagination.
- DTO serde round-trips (camelCase, tagged enums) + typeshare golden compare.

**Property tests (`proptest`):** arbitrary token strings never panic the parser; match/expand consistency; trie `observe` is order-independent for final counts.

**Integration (`ns-testkit` embedded `nats-server`):**
- Publish a known subject set → `start_sampling` → assert coalesced frames and resulting tree (counts, rates within tolerance, `sampled` flag when `sample_every>1`).
- Permission-denied root → `start_sampling` returns `PERMISSION_DENIED`; in-band terminal error if denied mid-stream.
- `refresh_subsz` with a **mock `SubszSource`** → merge summary + subscriber counts appear on nodes; degrade gracefully to traffic-only when `SubszUnavailable`.
- Favorites CRUD against a **real bundled SQLite** via the repo impl (uniqueness index, global vs per-connection).
- Cancellation: `stop_sampling` and Channel-drop both unsubscribe (assert server `subsz` shows the interest gone) with no leaked tasks.

**e2e (Tauri harness + real `nats-server` + `nats` CLI traffic generator):**
- Open Subject Explorer, generate traffic, watch the tree populate live, expand lazily, toggle permission overlay, run the wildcard analyzer, add a favorite, restart app → favorite persists.
- Backpressure: flood traffic, assert `droppedSinceLast` increments and the UI shows a gap indicator while the app stays responsive (UI thread never blocks).

**Perf/bench (`criterion`):** 100k-subject trie build < target ms; `search` p95 under load; frame coalescing throughput at 100k msg/s ingest with bounded memory.

---

## 10. Risks & open questions

1. **subsz availability & shape.** Servers with monitoring disabled expose no `subsz` → we degrade to traffic-only (documented, `source=Traffic`). Need `ns-monitor` to finalize `SubszSnapshot` (does it include per-cid detail or only subject→count?). *Open with `[monitoring]`.*
2. **Knowability of permissions.** In decentralized auth, effective permissions live in the user JWT; in server-config auth they may not be visible to the client at all → many `Unknown` verdicts. Confirm `ns-security` can surface effective lists, and how `$SYS`/`accountz` could enrich them. *Open with `[account-security]`.*
3. **Full-wildcard sampling danger.** `>` on a high-volume production cluster is a foot-gun; guardrail + confirm dialog + default-scoped root mitigate but UX must make the cost obvious.
4. **Sampled-rate accuracy.** `sample_every=N` biases absolute counts; we mark `sampled=true` and could optionally extrapolate (×N) — decide default (raw vs extrapolated) with product.
5. **Memory cap tuning.** `max_nodes` / eviction thresholds need real-world tuning; wildcard-heavy subject spaces (per-entity subjects like `orders.<uuid>`) explode node counts — consider auto-collapsing high-cardinality wildcard levels into a synthetic `*` node.
6. **Cross-connection favorites semantics.** Global (`connection_id NULL`) vs per-connection favorites and how a global favorite's permission overlay resolves when opened on a connection lacking that subject. Current design: global favorites show `Unknown` until observed.
7. **`ClientResolver` sharing.** Confirmed shared with `ns-pubsub`/`ns-jetstream`; ensure one canonical port to avoid duplication. *Open with `[core-runtime]`.*
8. **Stats persistence.** Decided ephemeral. Revisit only if product wants historical subject trends (that would belong to `[monitoring]` time-series, not here).
