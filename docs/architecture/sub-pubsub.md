# Subsystem Design — Publish / Subscribe + Request/Reply `[pubsub]`

> Crate: `ns-pubsub` (L2 feature service) · Owning team: Publish/Subscribe + Request/Reply
> Status: Design v1 · Aligns with `docs/architecture/00-conventions-and-workspace.md` (the spine). Where this doc and the spine disagree, the spine wins.

---

## 1. Responsibilities & Boundaries

### 1.1 In scope (what `ns-pubsub` owns)

The `PubSubService` is the single L2 service for **ephemeral, connection-scoped NATS messaging** that is *not* JetStream-persisted:

1. **Publish** — core NATS publish and JetStream publish (`js.publish` with ack), with headers, optional reply subject, and an arbitrary payload supplied as bytes + declared encoding (JSON / text / binary / base64). Payload editing UX is Monaco on the frontend; the backend only receives already-encoded bytes + an `encoding` tag.
2. **Subscribe** — streaming core subscribe with wildcard subjects (`*`, `>`) and optional **queue groups**, delivering a live message stream to a Tauri `Channel<SubscriptionEvent>` with pause/resume, server-side decode (via `ns-inspector`), and per-subscription rate/drop stats.
3. **Request / Reply** — one-shot request with timeout, surfacing `NO_RESPONDERS` and `REQUEST_TIMEOUT` distinctly; multi-response ("scatter/gather") request that collects N replies until timeout/max.
4. **Responder simulator** — a managed, long-lived subscription that auto-replies to requests on a subject/queue-group with a canned or scripted payload (fixed reply, echo, template with delay/jitter, or round-robin over several replies). Used to exercise request/reply flows without a real service.
5. **`$SRV` service requests** — micro/Service-API request helpers: `PING`, `INFO`, `STATS`, `SCHEMA` discovery over `$SRV.>` with fan-in collection. (Discovery/aggregation of $SRV for the *monitoring dashboard* is `ns-monitor`'s job; `ns-pubsub` only provides the ad-hoc request/collect primitive so a user can hit a service by hand.)
6. **Publish history & replay** — record every publish (and request) into `ns-storage`, expose paged history, and re-publish (replay) single or batched historical messages against the same or a different connection.
7. **Templates & saved requests** — CRUD over reusable publish templates and saved request definitions (subject + headers + payload + options), persisted via `ns-storage` repos owned by this subsystem.

### 1.2 Out of scope (explicit non-goals — delegated)

| Concern | Owner |
|---|---|
| Opening/closing/reconnecting NATS connections, connection handles | `ns-connection` (we borrow a `NatsClient` by `ConnectionId`) |
| Any `async-nats` call site | `ns-nats` adapter (we depend on its traits only) |
| Payload codec/format-detection/hex rendering logic | `ns-inspector` (we call its `Codec`/`FormatDetector`) |
| JetStream stream/consumer CRUD, KV, Object store, replay *from a stream* | `ns-jetstream` (we only do `js.publish` for ack'd producing) |
| HTTP monitoring endpoints, `$SRV` fleet aggregation dashboards | `ns-monitor` |
| SQL execution / migration mechanics | `ns-storage` (we define repo ports + own our tables) |
| Tauri command registration, `AppError`→`IpcError`, event bridge | `ns-ipc` + the bin |
| Subject tree / wildcard *analysis* UI | `ns-subject` (we only *validate* a subject before use) |

**Boundary rule:** `ns-pubsub` never imports `async-nats`, `tauri`, `rusqlite`, or `reqwest`. It depends only on ports/traits (`ns-core`, `ns-nats` traits, `ns-inspector`, `ns-event`) and DTOs (`ns-types`). This keeps it headless-testable with mock ports.

### 1.3 Where we sit

```
ns-types  ns-core  ns-event  ns-nats(traits)  ns-inspector
   \        |        |            |                |
    \-------+--------+------------+----------------+
                        ns-pubsub  (L2)
                            |
                 ns-ipc (L3) → nats-studio bin (L4)
```

We do **not** depend on `ns-connection` directly at the type level. Instead the bin injects a `ClientProvider` port (defined in `ns-core`, implemented by `ns-connection`) so we can resolve a `ConnectionId` → `Arc<dyn NatsClient>` without a crate cycle. (See §7.)

---

## 2. Rust Public Interface (`ns-pubsub`)

### 2.1 Module layout

```
crates/ns-pubsub/
├─ src/
│  ├─ lib.rs              # re-exports: PubSubService trait, DefaultPubSubService, PubSubError
│  ├─ service.rs          # PubSubService trait + DefaultPubSubService impl
│  ├─ publish.rs          # publish (core + JS), header build, encoding resolution
│  ├─ subscribe.rs        # subscription task, pause/resume, rate meter, drop policy
│  ├─ request.rs          # request/reply (single + scatter-gather), $SRV helpers
│  ├─ responder.rs        # responder simulator (managed auto-reply subs)
│  ├─ history.rs          # publish/request history recording + replay orchestration
│  ├─ templates.rs        # template & saved-request CRUD over repo ports
│  ├─ registry.rs         # SubscriptionRegistry, ResponderRegistry (id → handle+token)
│  ├─ meter.rs            # RateMeter (EWMA msg/s + bytes/s), DropCounter
│  ├─ ports.rs            # repo port traits owned here (PublishHistoryRepo used via ns-core)
│  └─ error.rs            # PubSubError (thiserror) + DomainError impl
└─ Cargo.toml
```

### 2.2 The service trait (port consumed by `ns-ipc`)

```rust
use std::sync::Arc;
use async_trait::async_trait;
use ns_core::{CancellationToken, cancel::CancellationRegistry};
use ns_types::pubsub::*;          // all DTOs below live in ns-types
use ns_types::ids::{ConnectionId, SubscriptionId, ResponderId, HistoryId};

/// The single L2 entry point for core pub/sub + request/reply.
/// All methods are async; nothing blocks the caller. Streaming methods take a
/// `sink` the caller (ns-ipc) uses to bridge into a Tauri Channel, plus a token.
#[async_trait]
pub trait PubSubService: Send + Sync + 'static {
    // ---- Publish -------------------------------------------------------
    async fn publish(&self, req: PublishRequest) -> Result<PublishResponse, PubSubError>;

    /// JetStream publish that waits for a PubAck (stream/seq/duplicate).
    async fn publish_jetstream(&self, req: JsPublishRequest)
        -> Result<JsPublishResponse, PubSubError>;

    // ---- Subscribe (streaming) ----------------------------------------
    /// Registers a subscription, spawns a pump task feeding `sink`, returns id.
    /// Cancellation via the token in the registry, or by dropping the sink.
    async fn subscribe(
        &self,
        req: SubscribeRequest,
        sink: Arc<dyn MessageSink>,
        token: CancellationToken,
    ) -> Result<SubscribeResponse, PubSubError>;

    async fn set_subscription_paused(&self, id: SubscriptionId, paused: bool)
        -> Result<(), PubSubError>;

    async fn subscription_stats(&self, id: SubscriptionId)
        -> Result<SubscriptionStats, PubSubError>;

    async fn unsubscribe(&self, id: SubscriptionId) -> Result<(), PubSubError>;

    // ---- Request / Reply ----------------------------------------------
    async fn request(&self, req: RequestRequest) -> Result<RequestResponse, PubSubError>;

    /// Scatter/gather: collect up to `maxResponses` (or until timeout) replies.
    async fn request_many(
        &self,
        req: RequestManyRequest,
        sink: Arc<dyn MessageSink>,
        token: CancellationToken,
    ) -> Result<RequestManyHandle, PubSubError>;

    // ---- $SRV service helpers -----------------------------------------
    async fn service_request(&self, req: ServiceRequest)
        -> Result<ServiceResponse, PubSubError>;

    // ---- Responder simulator ------------------------------------------
    async fn start_responder(&self, req: StartResponderRequest)
        -> Result<StartResponderResponse, PubSubError>;
    async fn stop_responder(&self, id: ResponderId) -> Result<(), PubSubError>;
    async fn list_responders(&self, connection_id: ConnectionId)
        -> Result<Vec<ResponderInfo>, PubSubError>;

    // ---- History & replay ---------------------------------------------
    async fn list_history(&self, req: ListHistoryRequest)
        -> Result<HistoryPage, PubSubError>;
    async fn replay(&self, req: ReplayRequest) -> Result<ReplayResponse, PubSubError>;
    async fn clear_history(&self, req: ClearHistoryRequest)
        -> Result<u64, PubSubError>;

    // ---- Templates & saved requests -----------------------------------
    async fn save_template(&self, req: SaveTemplateRequest)
        -> Result<PublishTemplate, PubSubError>;
    async fn list_templates(&self, req: ListTemplatesRequest)
        -> Result<Vec<PublishTemplate>, PubSubError>;
    async fn delete_template(&self, id: TemplateId) -> Result<(), PubSubError>;

    async fn save_request(&self, req: SaveRequestRequest)
        -> Result<SavedRequest, PubSubError>;
    async fn list_saved_requests(&self, req: ListSavedRequestsRequest)
        -> Result<Vec<SavedRequest>, PubSubError>;
    async fn delete_saved_request(&self, id: SavedRequestId) -> Result<(), PubSubError>;
}
```

### 2.3 Streaming sink abstraction (keeps `tauri` out of `ns-pubsub`)

```rust
/// Implemented in ns-ipc over tauri::ipc::Channel; mocked in tests.
/// `try_send` is non-blocking: on a full buffer the impl records a drop and the
/// service surfaces `droppedSinceLast` on the next stats frame.
pub trait MessageSink: Send + Sync + 'static {
    fn try_send(&self, event: SubscriptionEvent) -> SinkOutcome;
    /// Called once when the pump task ends (terminal frame already sent).
    fn close(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkOutcome { Delivered, Dropped, Closed }
```

### 2.4 Key structs / internal handles

```rust
pub struct DefaultPubSubService {
    clients: Arc<dyn ClientProvider>,     // ns-core port, impl in ns-connection
    codecs:  Arc<dyn CodecRegistry>,      // ns-inspector
    events:  ns_event::EventPublisher,    // domain events → bus
    history: Arc<dyn PublishHistoryRepo>, // ns-core port, impl in ns-storage
    templates: Arc<dyn TemplateRepo>,
    saved:   Arc<dyn SavedRequestRepo>,
    subs:    SubscriptionRegistry,        // DashMap<SubscriptionId, SubHandle>
    responders: ResponderRegistry,        // DashMap<ResponderId, ResponderHandle>
    clock:   Arc<dyn ns_core::Clock>,
}

struct SubHandle {
    subject: String,
    queue_group: Option<String>,
    paused: Arc<AtomicBool>,             // flips buffering without dropping the NATS sub
    cancel: CancellationToken,
    meter: Arc<RateMeter>,
    dropped: Arc<AtomicU64>,
    task: TaskHandle,                    // from ns-core TaskRegistry
}

struct ResponderHandle {
    subject: String,
    queue_group: Option<String>,
    behavior: ResponderBehavior,
    served: Arc<AtomicU64>,
    cancel: CancellationToken,
    task: TaskHandle,
}

/// EWMA over a sliding window; cheap to read for the stats frame.
pub struct RateMeter { /* msgs_per_sec, bytes_per_sec, last_tick */ }
```

### 2.5 Ports we *define* (implemented elsewhere)

```rust
// Declared in ns-core (so ns-connection can impl without depending on ns-pubsub),
// re-exported here for convenience.
#[async_trait]
pub trait ClientProvider: Send + Sync {
    async fn client(&self, id: ConnectionId) -> Result<Arc<dyn ns_nats::NatsClient>, ClientProviderError>;
    async fn js(&self, id: ConnectionId) -> Result<Arc<dyn ns_nats::JsContext>, ClientProviderError>;
}

// Repo ports (ns-core), implemented by ns-storage:
#[async_trait]
pub trait PublishHistoryRepo: Send + Sync {
    async fn insert(&self, rec: NewHistoryRecord) -> Result<HistoryId, StorageError>;
    async fn page(&self, q: HistoryQuery) -> Result<HistoryPage, StorageError>;
    async fn get(&self, id: HistoryId) -> Result<Option<HistoryRecord>, StorageError>;
    async fn delete(&self, q: HistoryDeleteQuery) -> Result<u64, StorageError>;
    async fn enforce_retention(&self, policy: RetentionPolicy) -> Result<u64, StorageError>;
}
// TemplateRepo, SavedRequestRepo: standard CRUD, same shape.
```

### 2.6 Error type

```rust
#[derive(Debug, thiserror::Error)]
pub enum PubSubError {
    #[error("connection {0} is not available")]
    ConnectionUnavailable(ConnectionId),
    #[error("subject is invalid: {0}")]
    InvalidSubject(String),
    #[error("payload decode/encode failed: {0}")]
    PayloadCodec(#[from] ns_inspector::CodecError),
    #[error("request timed out after {0} ms")]
    RequestTimeout(u64),
    #[error("no responders for subject {0}")]
    NoResponders(String),
    #[error("jetstream publish rejected: {0}")]
    JsPublish(String),
    #[error("subscription {0} not found")]
    SubscriptionNotFound(SubscriptionId),
    #[error("responder {0} not found")]
    ResponderNotFound(ResponderId),
    #[error("history record {0} not found")]
    HistoryNotFound(HistoryId),
    #[error(transparent)]
    Nats(#[from] ns_nats::NatsError),
    #[error(transparent)]
    Storage(#[from] ns_storage::StorageError),
    #[error("operation cancelled")]
    Cancelled,
}

impl ns_core::DomainError for PubSubError {
    fn code(&self) -> ns_types::ErrorCode { /* map each variant to a stable ErrorCode */ }
    fn retriable(&self) -> bool { matches!(self, Self::RequestTimeout(_) | Self::ConnectionUnavailable(_) | Self::Nats(_)) }
    fn user_message(&self) -> String { /* secret-safe copy */ }
}
```

ErrorCode mapping: `InvalidSubject → SUBJECT_INVALID`, `PayloadCodec → PAYLOAD_DECODE_FAILED`, `RequestTimeout → REQUEST_TIMEOUT`, `NoResponders → NO_RESPONDERS`, `ConnectionUnavailable → CONNECTION_CLOSED`, `Cancelled → CANCELLED`, `Storage → STORAGE`, `JsPublish → INTERNAL` (with detail), else per `NatsError`.

---

## 3. Tauri IPC Commands (namespace `pubsub_*`)

All commands take one arg `req: XxxRequest`, return `Result<XxxResponse, IpcError>`, live in `ns-ipc` thin wrappers delegating to `PubSubService`. Streaming commands additionally take a `tauri::ipc::Channel<T>`.

| Command | Kind | Params (`req`) | Returns | Notable errors |
|---|---|---|---|---|
| `pubsub_publish` | request | `PublishRequest { connectionId, subject, replyTo?, headers[], payload{encoding,data}, }` | `PublishResponse { historyId, bytes, ts }` | `SUBJECT_INVALID`, `PAYLOAD_DECODE_FAILED`, `CONNECTION_CLOSED` |
| `pubsub_publish_jetstream` | request | `JsPublishRequest { connectionId, subject, headers[], payload, expectedStream?, expectedLastSeq?, msgId?, timeoutMs }` | `JsPublishResponse { stream, seq, duplicate, historyId }` | `JETSTREAM_NOT_ENABLED`, `REQUEST_TIMEOUT` |
| `pubsub_subscribe` | **stream** (Channel) | `SubscribeRequest { connectionId, subject, queueGroup?, decode: bool, maxInFlight?, rate: RatePolicy, startPaused? }` + `Channel<SubscriptionEvent>` | `SubscribeResponse { subscriptionId }` | `SUBJECT_INVALID`, `CONNECTION_CLOSED` |
| `pubsub_set_paused` | command | `SetPausedRequest { subscriptionId, paused }` | `()` | `NOT_FOUND` |
| `pubsub_subscription_stats` | request | `{ subscriptionId }` | `SubscriptionStats` | `NOT_FOUND` |
| `pubsub_unsubscribe` | command | `{ subscriptionId }` | `()` | `NOT_FOUND` |
| `pubsub_request` | request | `RequestRequest { connectionId, subject, headers[], payload, timeoutMs, decode }` | `RequestResponse { reply: DecodedMessage, elapsedMs, historyId }` | `REQUEST_TIMEOUT`, `NO_RESPONDERS` |
| `pubsub_request_many` | **stream** (Channel) | `RequestManyRequest { connectionId, subject, payload, timeoutMs, maxResponses?, stallMs? }` + `Channel<SubscriptionEvent>` | `RequestManyHandle { requestId }` | `NO_RESPONDERS` (in-band if 0 arrive) |
| `pubsub_request_many_cancel` | command | `{ requestId }` | `()` | `NOT_FOUND` |
| `pubsub_service_request` | request | `ServiceRequest { connectionId, verb: Ping\|Info\|Stats\|Schema, service?, id?, timeoutMs }` | `ServiceResponse { responses[] }` | `REQUEST_TIMEOUT` |
| `pubsub_start_responder` | command | `StartResponderRequest { connectionId, subject, queueGroup?, behavior, }` | `StartResponderResponse { responderId }` | `SUBJECT_INVALID`, `CONNECTION_CLOSED` |
| `pubsub_stop_responder` | command | `{ responderId }` | `()` | `NOT_FOUND` |
| `pubsub_list_responders` | request | `{ connectionId }` | `ResponderInfo[]` | — |
| `pubsub_list_history` | request | `ListHistoryRequest { connectionId?, subjectFilter?, kind?, cursor?, limit }` | `HistoryPage { items[], nextCursor?, total? }` | `STORAGE` |
| `pubsub_replay` | request | `ReplayRequest { connectionId, historyIds[], overrideSubject?, delayMs?, jetstream? }` | `ReplayResponse { published, failed[] }` | `CONNECTION_CLOSED` |
| `pubsub_clear_history` | command | `ClearHistoryRequest { connectionId?, olderThanTs? }` | `{ deleted: u64 }` | `STORAGE` |
| `pubsub_save_template` | request | `SaveTemplateRequest { id?, name, subject, headers[], payload, tags[] }` | `PublishTemplate` | `STORAGE` |
| `pubsub_list_templates` | request | `ListTemplatesRequest { tagFilter? }` | `PublishTemplate[]` | `STORAGE` |
| `pubsub_delete_template` | command | `{ templateId }` | `()` | `NOT_FOUND` |
| `pubsub_save_request` | request | `SaveRequestRequest { id?, name, subject, headers[], payload, timeoutMs, tags[] }` | `SavedRequest` | `STORAGE` |
| `pubsub_list_saved_requests` | request | `ListSavedRequestsRequest { tagFilter? }` | `SavedRequest[]` | `STORAGE` |
| `pubsub_delete_saved_request` | command | `{ savedRequestId }` | `()` | `NOT_FOUND` |

### 3.1 Streaming event enum (in-band, on the Channel)

```rust
// ns-types, adjacently tagged: { "kind": "...", "data": {...} }
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum SubscriptionEvent {
    Message(DecodedMessage),          // one delivered message
    Stats(SubscriptionStats),         // periodic (every ~500ms): rate, totals, droppedSinceLast
    Paused { at: String },            // ack of pause (buffer still draining server-side)
    Resumed { at: String },
    Overflow { droppedSinceLast: u64, totalDropped: u64 }, // sampling/backpressure marker
    Error(IpcError),                  // TERMINAL: stream ended because of this
    Complete { reason: CompleteReason }, // TERMINAL: unsub / connection closed / request_many done
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedMessage {
    pub seq: u64,                     // monotonic per-subscription (UI gap detection)
    pub subject: String,
    pub replyTo: Option<String>,
    pub headers: Vec<Header>,
    pub payload: EncodedPayload,      // { encoding, data(base64|text), sizeBytes }
    pub decoded: Option<DecodedView>, // ns-inspector: detectedFormat, pretty, hexPreview
    pub ts: String,                   // RFC-3339, receive time
}
```

The terminal `Error`/`Complete` rule satisfies the spine's "streaming errors delivered in-band" requirement — a partial subscription always reports *why* it ended.

---

## 4. Events Emitted (bus → bridge → Tauri)

`ns-pubsub` emits **domain events** through the injected `EventPublisher` port only; it never touches Tauri. The `ns-ipc::EventBridge` forwards UI-relevant ones.

| Domain `EventPayload` variant | Tauri event name | When | Coalescing (bridge) |
|---|---|---|---|
| `SubjectActivity { connectionId, subject, msgsPerSec, bytesPerSec }` | `ns://subject/activity` | periodic aggregate per active subscription | rate-limit N/s per connection, aggregate + surface dropped |
| `Notification { level, code, text }` | `ns://notification` | responder started/stopped, replay finished, history retention pruned | never drop |
| `TaskProgress { taskId, done, total }` | `ns://task/progress` | batched `replay` progress | keep-latest per taskId |

Per-subscription **message** delivery and per-subscription **stats** are *not* ambient events — they go on the request-scoped `Channel` (§3.1), per the spine's "belongs to one screen → Channel" rule. `SubjectActivity` on the bus is the *ambient* aggregate the Subject Explorer / Dashboard also observe.

---

## 5. Frontend Surface

### 5.1 Routes (React Router, under the workspace shell)

- `/pubsub/publish` — Publisher panel
- `/pubsub/subscribe` — Subscriber panel (live stream)
- `/pubsub/request` — Request/Reply workbench
- `/pubsub/responders` — Responder simulator manager
- `/pubsub/history` — Publish/Request history + replay
- Saved templates/requests appear as a side rail in publish/request, not a route.

These are dockview panels (ADR-0012) so users can tile Publisher next to Subscriber.

### 5.2 Components / panels (`apps/desktop/src/features/pubsub/`)

- `PublisherPanel` — subject input (with `ns-subject` validation hint), `HeadersEditor`, `PayloadEditor` (Monaco: language toggle JSON/text/binary-hex/base64; base64 encode/decode helpers), reply-subject field, Publish + Publish-to-JetStream buttons, "save as template" action.
- `SubscriberPanel` — subject + queueGroup inputs, decode toggle, rate-policy selector (sampleAll / sample N/s / countOnly), Pause/Resume, live `MessageList` (virtualized), `RateBadge` (msg/s, bytes/s, dropped), per-message `MessageInspector` (from `ns-inspector` FE). Multiple subscriptions as sub-tabs.
- `RequestPanel` — subject/headers/payload, timeout slider, single vs "collect many" toggle, `ResponseView` (elapsed, decoded reply, or NO_RESPONDERS/timeout state), scatter/gather response list.
- `ResponderSimulatorPanel` — list of running responders + create form (subject, queueGroup, behavior: fixed/echo/template/roundRobin, delay/jitter ms), served-count badges.
- `HistoryPanel` — virtualized table (ts, direction, subject, size, connection), filters, multi-select → `ReplayDialog` (override subject, inter-message delay, target connection, JS toggle), progress bar.
- `TemplateRail` / `SavedRequestRail` — pick/apply/delete.

### 5.3 Zustand stores (UI/session only — never mirror server-state)

- `usePublisherStore` — draft subject/headers/payload buffer, selected encoding, selected template id, "unsaved" flag (Monaco buffers).
- `useSubscriberStore` — open subscription tabs, per-tab { subscriptionId, subject, paused, ratePolicy, decode, filter, autoScroll }, ring buffer of displayed messages (client-side cap, e.g. 5k), selected message.
- `useRequestStore` — request draft, last response, collect-many buffer.
- `useResponderUiStore` — create-form draft.
- `useHistoryUiStore` — filters, selection set, replay dialog state.

Live messages are held in the Zustand subscriber ring buffer (they are transient UI stream data owned by the initiating view), **not** TanStack Query. Query cache is used for *retrievable* server-state (history, templates, saved requests, responder list, subscription stats snapshots).

### 5.4 TanStack Query keys

```
['pubsub','history', connectionId, filters]        // infinite query (cursor)
['pubsub','templates', tagFilter]
['pubsub','savedRequests', tagFilter]
['pubsub','responders', connectionId]
['pubsub','subStats', subscriptionId]              // optional snapshot poll; live via Channel
```

Mutations (`publish`, `save_template`, `replay`, `start_responder`, …) invalidate the relevant keys. `IpcError.retriable` drives retry.

### 5.5 IPC client calls (generated wrappers, `packages/ns-bindings`)

`ipc.pubsub.publish(req)`, `.publishJetstream(req)`, `.subscribe(req, channel)`, `.setPaused(req)`, `.unsubscribe(req)`, `.request(req)`, `.requestMany(req, channel)`, `.serviceRequest(req)`, `.startResponder(req)`, `.stopResponder(req)`, `.listHistory(req)`, `.replay(req)`, `.saveTemplate(req)`, etc. A `useSubscription()` hook owns the Channel lifecycle: creates it on mount, folds `Message`/`Stats`/`Overflow` into the subscriber store, calls `unsubscribe` and closes the Channel on unmount (watchdog also cancels backend-side).

---

## 6. Data Model (SQLite tables owned by `[pubsub]`)

Owned migrations live in `crates/ns-storage/migrations/` but are authored by this team. Tables:

```sql
-- 00xx_pubsub.sql
CREATE TABLE pubsub_history (
  id            TEXT PRIMARY KEY,          -- HistoryId (uuid)
  connection_id TEXT NOT NULL,             -- profile at time of send (nullable-safe)
  direction     TEXT NOT NULL,             -- 'publish' | 'request' | 'js_publish' | 'replay'
  subject       TEXT NOT NULL,
  reply_to      TEXT,
  headers_json  TEXT NOT NULL,             -- JSON array of {name,value}
  payload_b64   BLOB NOT NULL,             -- raw bytes (BLOB, not text)
  encoding      TEXT NOT NULL,             -- 'json'|'text'|'binary'|'base64'
  size_bytes    INTEGER NOT NULL,
  result_code   TEXT,                      -- ErrorCode or NULL on success
  reply_b64     BLOB,                      -- for 'request': the reply payload
  elapsed_ms    INTEGER,                   -- for 'request'
  ts            TEXT NOT NULL              -- RFC-3339
);
CREATE INDEX ix_history_conn_ts ON pubsub_history(connection_id, ts DESC);
CREATE INDEX ix_history_subject ON pubsub_history(subject);

CREATE TABLE pubsub_template (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  payload_b64  BLOB NOT NULL,
  encoding     TEXT NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  created_ts   TEXT NOT NULL,
  updated_ts   TEXT NOT NULL
);

CREATE TABLE pubsub_saved_request (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  payload_b64  BLOB NOT NULL,
  encoding     TEXT NOT NULL,
  timeout_ms   INTEGER NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  created_ts   TEXT NOT NULL,
  updated_ts   TEXT NOT NULL
);
```

**Retention:** `pubsub_history` is bounded by a user-configurable size + TTL policy (Settings), enforced by the storage worker on a schedule via `PublishHistoryRepo::enforce_retention`. Payloads stored as `BLOB`; over IPC they become base64 + encoding per spine rule (never raw byte arrays). No secrets ever land here (payloads are user data; auth material lives in the keychain via `ns-security` and is never part of a message body we persist — if a user pastes a token into a payload that is their content, but we still run the log scrubber before any *logging*, not before storage).

Responders and live subscriptions are **runtime-only** (registries in memory) — not persisted.

DTOs owned in `ns-types::pubsub`: `PublishRequest/Response`, `JsPublishRequest/Response`, `SubscribeRequest/Response`, `SubscriptionEvent`, `DecodedMessage`, `EncodedPayload`, `Header`, `SubscriptionStats`, `RatePolicy`, `RequestRequest/Response`, `RequestManyRequest/Handle`, `ServiceRequest/Response`, `ResponderBehavior`, `StartResponderRequest/Response`, `ResponderInfo`, `HistoryRecord/Page/Query`, `ReplayRequest/Response`, `PublishTemplate`, `SavedRequest` and their list/CRUD envelopes.

---

## 7. Dependencies

**Crate deps (Cargo):** `ns-types`, `ns-core`, `ns-event`, `ns-nats` (traits only), `ns-inspector`. Dev: `ns-testkit`. No `async-nats`/`tauri`/`rusqlite`/`reqwest`.

**Runtime port injections (from the bin composition root):**
- `ClientProvider` (port in `ns-core`, impl in **ns-connection**) — resolve `ConnectionId` → `NatsClient`/`JsContext`. Avoids an `ns-pubsub → ns-connection` crate edge (no cycle, respects layering; both are L2 peers).
- `CodecRegistry` (**ns-inspector**) — decode/encode payloads, format detect, hex preview.
- `PublishHistoryRepo` / `TemplateRepo` / `SavedRequestRepo` (ports in `ns-core`, impl in **ns-storage**).
- `EventPublisher` (**ns-event**).
- `Clock`, `CancellationRegistry`, `TaskRegistry` (**ns-core**).

**Consumed by:** `ns-ipc` (wraps our trait in `pubsub_*` commands + bridges our events). `ns-dashboard` may read `SubjectActivity` events but does not call us directly.

---

## 8. Concurrency / Async & Backpressure

- **Every method is async**, non-blocking. Long-lived work (subscription pump, responder loop, batched replay) runs as tokio tasks registered in the `TaskRegistry`, each holding a `CancellationToken` keyed by the id returned to the UI (`SubscriptionId`/`ResponderId`/`requestId`). Cancellation paths: explicit `unsubscribe`/`stop_responder`/`*_cancel` command, Channel drop watchdog (view unmount), or connection close.
- **Subscription pump:** the NATS subscription's async stream is read in a `select!` loop against the cancel token. Each message is decoded (if `decode`) and pushed to the `MessageSink` via `try_send` (non-blocking). The sink is backed by a **bounded** mpsc→Channel. On `SinkOutcome::Dropped` we bump `dropped` and, per `RatePolicy`, either sample-and-count (high-rate) or apply the declared policy; a periodic (~500ms) `Stats`/`Overflow` frame surfaces `droppedSinceLast`. **The consumer/UI can never block the NATS read** — we drop, we never await a full buffer.
- **Pause/resume:** pause flips an `AtomicBool` that makes the pump *stop forwarding* to the sink while keeping the NATS subscription alive; incoming messages during pause are counted (and optionally kept in a small bounded backlog for "resume shows recent") — default is drop-with-count to bound memory. This avoids server-side slow-consumer disconnects that a true un/re-subscribe or an unbounded buffer would cause.
- **Rate meter:** EWMA updated on each message; read cheaply for stats frames. No lock on the hot path (atomics + a periodic aggregator task).
- **Request/reply:** single request uses `tokio::time::timeout`; distinguishes `NoResponders` (async-nats surfaces the no-responder header/`503`) from `Elapsed → REQUEST_TIMEOUT`. `request_many` uses an ephemeral inbox subscription drained until `maxResponses`, a hard `timeoutMs`, or a `stallMs` idle gap; results streamed via the Channel.
- **Responder simulator:** a queue-group-aware subscription loop; for each request it computes a reply per `ResponderBehavior` (with optional delay/jitter via `tokio::time::sleep`) and publishes to `msg.reply`. Bounded concurrency (semaphore) so a flood can't spawn unbounded reply tasks.
- **Replay:** batched publish with optional inter-message delay, emitting `TaskProgress`; cancellable mid-batch; failures collected per-message (partial success) rather than aborting.
- **History writes:** fire-and-forget onto the storage worker's single-writer queue — a publish never awaits the DB on its latency path (we return `historyId` optimistically from a pre-generated id; the insert is enqueued). Retention enforced off the hot path.
- **Ordering/gap detection:** per-subscription monotonic `seq` on `DecodedMessage` lets the UI detect drops even when the bridge coalesces. A lagging broadcast receiver (for ambient `SubjectActivity`) yields a synthetic gap marker from the bridge.

---

## 9. Test Plan

### 9.1 Unit (headless, mock ports — `ns-testkit` mocks)
- Subject validation (accept `a.b.*`, `a.>`, reject `a..b`, trailing `.`, `>` mid-subject) → `SUBJECT_INVALID`.
- Payload encoding resolution: json/text/binary/base64 round-trips; malformed base64 → `PAYLOAD_DECODE_FAILED`.
- Header build (multi-value, dup names) → NATS `HeaderMap`.
- `RateMeter` EWMA math; `DropCounter` under simulated overflow; `Stats`/`Overflow` frame cadence.
- Error mapping: every `PubSubError` variant → correct `ErrorCode`, `retriable`, secret-safe `user_message`.
- Registry lifecycle: subscribe→unsubscribe idempotency; cancel token trips pump; double-stop responder → `NOT_FOUND`.
- Pause semantics: paused pump does not forward but keeps counting; resume forwards again.
- History record shape; replay override-subject and failure-collection logic with a mock `NatsClient`.

### 9.2 Integration (embedded `nats-server` via `ns-testkit` fixture)
- Publish then subscribe on a wildcard, assert receipt, headers, decoded view.
- Queue group: two subscriptions on same group, N messages → roughly split, none duplicated.
- Request/reply happy path (with a real responder) → reply + `elapsedMs`.
- Request with no responder → `NO_RESPONDERS`; slow responder beyond timeout → `REQUEST_TIMEOUT`.
- `request_many`: 3 responders → 3 replies collected; `maxResponses=2` stops early; `stallMs` idle cutoff.
- Responder simulator (fixed / echo / roundRobin) actually answers a real `request`.
- JetStream publish to a stream → `PubAck` with stream+seq; duplicate `msgId` → `duplicate=true`.
- Backpressure: high-rate publisher (e.g. 50k msg/s) into a slow sink → subscription survives, `droppedSinceLast` reported, NATS sub not slow-consumer-disconnected.
- History persisted (real `ns-storage` temp db) + retention prune; replay re-publishes and re-subscribe observes them.

### 9.3 E2E (Tauri harness + WebView + real nats-server)
- Publisher panel → type JSON in Monaco → Publish → appears in a Subscriber panel live stream.
- Pause/resume visibly halts/resumes the stream; rate badge non-zero; dropped counter increments under load.
- Request workbench → hit a running responder → response rendered; kill responder → `NO_RESPONDERS` state.
- Save template → reload app → template still present (storage) → apply → publish.
- History → select 3 → replay to a different connection → observed on subscriber.
- Channel cancellation: unmount subscriber panel → backend task cancelled (assert via task registry / no leaked subscription in `connz`).

### 9.4 Property / fuzz
- Round-trip: arbitrary bytes → encode(encoding) → store → load → decode == original.
- Subject validator vs a reference NATS subject grammar (proptest).

---

## 10. Risks & Open Questions

**Risks**
1. **Slow-consumer disconnects.** If our pump ever awaits a full buffer instead of dropping, the NATS server disconnects the whole connection (shared with other subsystems). Mitigation: strictly non-blocking `try_send`, bounded buffers, explicit drop accounting; integration test at 50k msg/s.
2. **Memory blow-up on high-rate subscriptions.** Client-side ring buffer + server-side bounded buffer both capped; UI virtualization mandatory. Risk if a user sets `sampleAll` on a firehose — surface a warning and auto-suggest `countOnly`.
3. **History payload bloat.** Large/binary payloads persisted per publish can grow the DB fast. Mitigation: size cap per record + TTL retention + optional "don't persist payloads over N KB" setting.
4. **Shared connection contention.** We borrow the same `NatsClient` as other subsystems; a runaway responder/replay could saturate it. Mitigation: bounded concurrency, and consider a dedicated subscribe-connection option per profile (defer to `ns-connection`).
5. **`request_many` inbox leakage.** Ephemeral inbox subs must be reliably dropped on timeout/cancel. Covered by cancel-token + Drop, tested via `connz`.
6. **Ordering across bridge coalescing.** Ambient `SubjectActivity` may be coalesced; per-message `seq` on the Channel is authoritative for the live view — keep message delivery off the coalesced ambient path (already the design).

**Open questions**
1. Should pause **buffer** recent messages (bounded backlog to "catch up" on resume) or **drop-and-count**? Default drop-and-count; revisit with a per-subscription setting. (Needs UX decision.)
2. Do we expose a **dedicated subscription connection** toggle to isolate firehose subs from request/reply latency, or always share the profile's connection? Coordinate with `[connection-manager]`.
3. Responder simulator **scripting** depth: fixed/echo/roundRobin now; do we want a JS/template expression engine (and where does eval run — sandboxed)? Possible `ns-plugin` extension point later.
4. `$SRV` helper overlap with `[monitoring]`: confirm the split — we own ad-hoc single-service requests, they own fleet discovery/aggregation. Needs an explicit interface agreement to avoid duplicate `$SRV` code.
5. Should JetStream publish live here or in `[jetstream]`? Spine assigns `js.publish` to us (producing), stream/consumer mgmt to them — confirm they expose the `JsContext` producer path we call and that ack semantics aren't duplicated.
6. Do we need **schema-aware** payload validation (e.g. validate JSON against a registered schema before publish)? Hook exists in `ns-inspector`; decide if pubsub surfaces it pre-publish.
