# NATS Studio — JetStream Subsystem Design

> Document ID: `arch/sub-jetstream`
> Status: **DRAFT v1.0**
> Owner: JetStream Team (lead engineer)
> Crate: `ns-jetstream` (L2, `crates/ns-jetstream`)
> Binds to: `arch/00-conventions-and-workspace.md` (Source of Truth). Where this doc adds detail it MUST NOT contradict the spine; deviations require an ADR.

---

## 1. Scope, responsibilities & boundaries

The `[jetstream]` subsystem owns the entire JetStream feature surface of NATS Studio. It is implemented in **one cohesive crate, `ns-jetstream`**, organized into **four modules** sharing a single JetStream context per connection, plus one aggregate service facade.

### 1.1 In scope (owned)

| Area | Capabilities |
|---|---|
| **Streams** | list, get info/state, create, update/edit, delete, purge (by subject/seq/keep), config (retention, storage, replicas, subjects, discard, limits, dedupe window, placement/tags, sources, mirror), per-subject counts, leader/replica/cluster state |
| **Consumers** | list, get info, create/update durable & ephemeral, push & pull, ack policies (none/all/explicit), delivery policy, replay policy, filter subjects, backoff, max deliver, ack wait, consumer **lag** (pending/ack-floor/redelivered), pause/resume, delete |
| **Messages** | get by seq / by last-per-subject, replay/stream a range (start seq/time, filter), delete (erase/secure), purge; ack/nak/term/inProgress for pull consumers used in inspection |
| **KV** | bucket CRUD (create/update/delete/list/status), get/put/create/update(CAS)/delete/purge, history, watch (stream), keys listing, per-key revision |
| **Object Store** | bucket CRUD/list/status, put (chunked upload), get (chunked download), list objects, info, delete, watch, link handling |
| **Mirrors / sources / replication** | configure mirror & sources on stream create/edit; show replication/source lag; validate cross-account/domain sources |
| **Snapshots / backup / restore** | stream snapshot (download to file), stream restore (upload from file), progress streaming |
| **Account JetStream limits** | read account JS tier limits & usage (`$JS.API.INFO` / `jsz` cross-check) — memory/storage/streams/consumers/max-bytes reservations |

### 1.2 Explicitly NOT owned (boundaries)

- **Raw NATS transport / connection lifecycle** → `[connection-manager]` (`ns-connection`, `ns-nats`). We obtain a `JsContext` handle from the connection registry; we never create clients.
- **`async-nats` imports** → forbidden here. Only `ns-nats` may import `async-nats` (ADR-0001). We depend on the `JsContext`/`NatsClient` **traits** exposed by `ns-nats`.
- **Payload decoding/encoding/format detection** → `ns-inspector`. We pass raw bytes + headers to it and receive render models; we do not implement codecs.
- **HTTP `jsz` polling & time-series** → `ns-monitor`. For account-limits/usage we prefer the JetStream API (`$JS.API.INFO`); where the dashboard needs server-wide JS health we **read** monitor snapshots, we do not poll HTTP ourselves.
- **Persistence of secrets / SQL** → `ns-storage` + `ns-security`. We own a small set of repos *by port*, but the SQL lives in `ns-storage`.
- **Tauri imports** → forbidden here (only `ns-ipc` + bin). Our service is headless; commands live in the bin and call our trait.
- **Overview aggregation** → `ns-dashboard` composes our snapshots; we never depend back on it.

---

## 2. Crate architecture (`ns-jetstream`)

```
crates/ns-jetstream/
├─ Cargo.toml
├─ src/
│  ├─ lib.rs            # re-exports: JetStreamService trait, DTO glue, error, factory
│  ├─ error.rs         # JetStreamError (thiserror) + DomainError impl
│  ├─ service.rs       # JetStreamServiceImpl: composition of the 4 modules; ctor injects ports
│  ├─ context.rs       # JsContextResolver: connectionId -> Arc<dyn JsContext> (via ConnectionService port)
│  ├─ streams.rs       # StreamsModule  (StreamOps)
│  ├─ consumers.rs     # ConsumersModule (ConsumerOps)
│  ├─ messages.rs      # MessagesModule (message get/replay/purge/ack) — shared by streams UI
│  ├─ kv.rs            # KvModule (KvOps)
│  ├─ object.rs        # ObjectStoreModule (ObjectOps)
│  ├─ replication.rs   # mirror/source config builders + lag computation (pure)
│  ├─ snapshot.rs      # SnapshotOps: backup/restore streaming to/from file
│  ├─ limits.rs        # account JS limits/usage reader
│  ├─ mapping.rs       # async-nats-DTO <-> ns-types DTO conversions (pure, unit-tested)
│  ├─ validate.rs      # pure config validation (subjects overlap, replica bounds, etc.)
│  └─ watch.rs         # cancellable watch/replay task plumbing (mpsc producers)
└─ tests/              # integration tests against ns-testkit embedded nats-server
```

**Design rules**

- The public API is the **`JetStreamService` trait** (§4) plus DTOs (which live in **`ns-types`**, not here). `JetStreamServiceImpl` is the only impl the bin wires.
- Each module is a struct holding an `Arc<dyn JsContext>`-resolver + `EventPublisher` port + `Clock`. Modules are independently unit-testable via mock `JsContext` from `ns-testkit`.
- **No hidden "current connection"**: every method takes `connection_id: ConnectionId` (spine §8). The resolver looks up the live `JsContext` from `ConnectionService`.
- All conversion between `async-nats` shapes and our DTOs is confined to `mapping.rs` behind the `ns-nats` trait boundary — i.e. `ns-nats` returns *our* neutral structs or we map from `ns-nats`-exposed neutral types. (`ns-nats` owns the neutral wire structs; `ns-jetstream` maps them to typeshared `ns-types` DTOs.)

---

## 3. Dependency on `ns-nats` traits (the port we consume)

`ns-jetstream` never touches `async-nats`. It consumes a JetStream port surface that `ns-nats` exposes. The relevant trait shape we rely on (defined in `ns-nats`, listed here for the contract):

```rust
// in ns-nats (consumed here as a dependency)
#[async_trait::async_trait]
pub trait JsContext: Send + Sync {
    // Streams
    async fn stream_names(&self) -> Result<Vec<String>, NatsError>;
    async fn stream_info(&self, name: &str) -> Result<RawStreamInfo, NatsError>;
    async fn create_stream(&self, cfg: RawStreamConfig) -> Result<RawStreamInfo, NatsError>;
    async fn update_stream(&self, cfg: RawStreamConfig) -> Result<RawStreamInfo, NatsError>;
    async fn delete_stream(&self, name: &str) -> Result<(), NatsError>;
    async fn purge_stream(&self, name: &str, opts: RawPurgeOpts) -> Result<u64, NatsError>;

    // Messages
    async fn get_message(&self, stream: &str, req: RawGetMsg) -> Result<RawStoredMsg, NatsError>;
    async fn delete_message(&self, stream: &str, seq: u64, erase: bool) -> Result<(), NatsError>;

    // Consumers
    async fn consumer_names(&self, stream: &str) -> Result<Vec<String>, NatsError>;
    async fn consumer_info(&self, stream: &str, name: &str) -> Result<RawConsumerInfo, NatsError>;
    async fn create_consumer(&self, stream: &str, cfg: RawConsumerConfig) -> Result<RawConsumerInfo, NatsError>;
    async fn update_consumer(&self, stream: &str, cfg: RawConsumerConfig) -> Result<RawConsumerInfo, NatsError>;
    async fn delete_consumer(&self, stream: &str, name: &str) -> Result<(), NatsError>;
    async fn pause_consumer(&self, stream: &str, name: &str, until: Option<OffsetDateTime>) -> Result<RawPauseResp, NatsError>;

    // Pull batches (for replay/inspection)
    async fn pull_batch(&self, stream: &str, consumer: &str, batch: RawBatchReq)
        -> Result<BoxStream<'static, Result<RawStoredMsg, NatsError>>, NatsError>;

    // KV
    async fn kv_bucket(&self, name: &str) -> Result<Arc<dyn KvStore>, NatsError>;
    async fn create_kv(&self, cfg: RawKvConfig) -> Result<Arc<dyn KvStore>, NatsError>;
    async fn delete_kv(&self, name: &str) -> Result<(), NatsError>;

    // Object store
    async fn object_bucket(&self, name: &str) -> Result<Arc<dyn ObjectBucket>, NatsError>;
    async fn create_object_store(&self, cfg: RawObjConfig) -> Result<Arc<dyn ObjectBucket>, NatsError>;
    async fn delete_object_store(&self, name: &str) -> Result<(), NatsError>;

    // Account
    async fn account_info(&self) -> Result<RawAccountInfo, NatsError>;

    // Snapshot / restore (chunked)
    async fn snapshot(&self, stream: &str) -> Result<BoxStream<'static, Result<Bytes, NatsError>>, NatsError>;
    async fn restore(&self, cfg: RawStreamConfig, chunks: BoxStream<'static, Bytes>) -> Result<RawStreamInfo, NatsError>;
}
```

> If `ns-nats` does not yet expose this exact surface, the JetStream team files the interface request against `[connection-manager]`; this is the **single open contract dependency** (see §12). `Raw*` structs are neutral (no `async-nats` types leak). The `KvStore`/`ObjectBucket` sub-traits mirror `async-nats`' KV/OS handles behind neutral methods (`get/put/create/update/delete/purge/history/watch/keys/status`, `put/get/list/info/delete/watch`).

---

## 4. Rust public interface (`ns-jetstream`)

### 4.1 The service facade trait

```rust
// crates/ns-jetstream/src/service.rs (trait in lib.rs)
#[async_trait::async_trait]
pub trait JetStreamService: Send + Sync {
    // ---- Streams ----
    async fn list_streams(&self, req: ListStreamsRequest) -> Result<StreamPage, JetStreamError>;
    async fn get_stream(&self, req: GetStreamRequest) -> Result<StreamInfo, JetStreamError>;
    async fn create_stream(&self, req: CreateStreamRequest) -> Result<StreamInfo, JetStreamError>;
    async fn update_stream(&self, req: UpdateStreamRequest) -> Result<StreamInfo, JetStreamError>;
    async fn delete_stream(&self, req: DeleteStreamRequest) -> Result<(), JetStreamError>;
    async fn purge_stream(&self, req: PurgeStreamRequest) -> Result<PurgeResult, JetStreamError>;
    async fn stream_subjects(&self, req: StreamSubjectsRequest) -> Result<SubjectCountPage, JetStreamError>;

    // ---- Messages (stream inspection) ----
    async fn get_message(&self, req: GetMessageRequest) -> Result<StoredMessage, JetStreamError>;
    async fn delete_message(&self, req: DeleteMessageRequest) -> Result<(), JetStreamError>;
    // replay is streaming: see start_replay (returns id; pumps into a Channel wired in the bin)
    async fn start_replay(&self, req: ReplayRequest, sink: MessageSink) -> Result<ReplayHandle, JetStreamError>;
    async fn cancel_replay(&self, id: SubscriptionId) -> Result<(), JetStreamError>;

    // ---- Consumers ----
    async fn list_consumers(&self, req: ListConsumersRequest) -> Result<ConsumerPage, JetStreamError>;
    async fn get_consumer(&self, req: GetConsumerRequest) -> Result<ConsumerInfo, JetStreamError>;
    async fn create_consumer(&self, req: CreateConsumerRequest) -> Result<ConsumerInfo, JetStreamError>;
    async fn update_consumer(&self, req: UpdateConsumerRequest) -> Result<ConsumerInfo, JetStreamError>;
    async fn delete_consumer(&self, req: DeleteConsumerRequest) -> Result<(), JetStreamError>;
    async fn pause_consumer(&self, req: PauseConsumerRequest) -> Result<ConsumerInfo, JetStreamError>;
    async fn resume_consumer(&self, req: ResumeConsumerRequest) -> Result<ConsumerInfo, JetStreamError>;

    // ---- KV ----
    async fn list_kv_buckets(&self, req: ListKvRequest) -> Result<KvBucketPage, JetStreamError>;
    async fn create_kv_bucket(&self, req: CreateKvRequest) -> Result<KvBucketStatus, JetStreamError>;
    async fn delete_kv_bucket(&self, req: DeleteKvRequest) -> Result<(), JetStreamError>;
    async fn kv_status(&self, req: KvStatusRequest) -> Result<KvBucketStatus, JetStreamError>;
    async fn kv_list_keys(&self, req: KvListKeysRequest) -> Result<KvKeyPage, JetStreamError>;
    async fn kv_get(&self, req: KvGetRequest) -> Result<KvEntry, JetStreamError>;
    async fn kv_put(&self, req: KvPutRequest) -> Result<KvRevision, JetStreamError>;    // put or CAS update
    async fn kv_delete(&self, req: KvDeleteRequest) -> Result<(), JetStreamError>;      // delete or purge
    async fn kv_history(&self, req: KvHistoryRequest) -> Result<KvEntryPage, JetStreamError>;
    async fn start_kv_watch(&self, req: KvWatchRequest, sink: KvWatchSink) -> Result<WatchHandle, JetStreamError>;
    async fn cancel_kv_watch(&self, id: SubscriptionId) -> Result<(), JetStreamError>;

    // ---- Object store ----
    async fn list_object_buckets(&self, req: ListObjRequest) -> Result<ObjBucketPage, JetStreamError>;
    async fn create_object_bucket(&self, req: CreateObjRequest) -> Result<ObjBucketStatus, JetStreamError>;
    async fn delete_object_bucket(&self, req: DeleteObjRequest) -> Result<(), JetStreamError>;
    async fn object_status(&self, req: ObjStatusRequest) -> Result<ObjBucketStatus, JetStreamError>;
    async fn list_objects(&self, req: ListObjectsRequest) -> Result<ObjectInfoPage, JetStreamError>;
    async fn object_info(&self, req: ObjectInfoRequest) -> Result<ObjectInfo, JetStreamError>;
    async fn delete_object(&self, req: DeleteObjectRequest) -> Result<(), JetStreamError>;
    // chunked upload/download are streaming; see start_object_put/get
    async fn start_object_put(&self, req: ObjectPutRequest, src: ChunkSource, progress: ProgressSink)
        -> Result<ObjectTransferHandle, JetStreamError>;
    async fn start_object_get(&self, req: ObjectGetRequest, sink: ChunkSink, progress: ProgressSink)
        -> Result<ObjectTransferHandle, JetStreamError>;
    async fn cancel_object_transfer(&self, id: SubscriptionId) -> Result<(), JetStreamError>;

    // ---- Snapshot / backup / restore ----
    async fn start_backup(&self, req: BackupRequest, progress: ProgressSink) -> Result<BackupHandle, JetStreamError>;
    async fn start_restore(&self, req: RestoreRequest, progress: ProgressSink) -> Result<RestoreHandle, JetStreamError>;
    async fn cancel_transfer(&self, id: SubscriptionId) -> Result<(), JetStreamError>;

    // ---- Account limits ----
    async fn account_limits(&self, req: AccountLimitsRequest) -> Result<JsAccountInfo, JetStreamError>;

    // ---- Config validation (pure, no IO) ----
    fn validate_stream_config(&self, cfg: &StreamConfig) -> Result<(), Vec<ConfigViolation>>;
    fn validate_consumer_config(&self, cfg: &ConsumerConfig) -> Result<(), Vec<ConfigViolation>>;
}
```

### 4.2 Key concrete structs

```rust
pub struct JetStreamServiceImpl {
    ctx: Arc<dyn JsContextResolver>, // resolves ConnectionId -> Arc<dyn JsContext> from ConnectionService
    events: Arc<dyn EventPublisher>, // ns-core port; impl in ns-event
    clock: Arc<dyn Clock>,           // ns-core port
    cancels: CancellationRegistry,   // maps SubscriptionId -> CancellationToken for watch/replay/transfer
    inspector: Arc<dyn PayloadCodec>,// ns-inspector port for decode-on-read (optional per request)
    limits: JsLimitsCache,           // bounded TTL cache of account_info per connection
}

impl JetStreamServiceImpl {
    pub fn new(
        ctx: Arc<dyn JsContextResolver>,
        events: Arc<dyn EventPublisher>,
        clock: Arc<dyn Clock>,
        inspector: Arc<dyn PayloadCodec>,
    ) -> Self { /* ... */ }
}

// Sinks are thin adapters the bin supplies to bridge domain streams -> Tauri Channel.
pub type MessageSink   = BoundedSink<StreamedMessage>;
pub type KvWatchSink   = BoundedSink<KvWatchEvent>;
pub type ChunkSink     = BoundedSink<ObjectChunk>;
pub type ChunkSource   = BoundedSource<ObjectChunk>;
pub type ProgressSink  = BoundedSink<TransferProgress>;

// A handle carries the id + a JoinHandle abort guard; dropping cancels.
pub struct ReplayHandle { pub id: SubscriptionId, _guard: TaskAbortGuard }
```

### 4.3 The context resolver port

```rust
// Defined in ns-core (port), implemented by ns-connection.
#[async_trait::async_trait]
pub trait JsContextResolver: Send + Sync {
    async fn resolve(&self, connection_id: ConnectionId) -> Result<Arc<dyn JsContext>, CoreError>;
    // returns CONNECTION_CLOSED / JETSTREAM_NOT_ENABLED when appropriate
}
```

---

## 5. Error model

One public error enum (spine §7), `thiserror`, implementing `DomainError` (`code`/`retriable`/`user_message`).

```rust
#[derive(Debug, thiserror::Error)]
pub enum JetStreamError {
    #[error("connection is not available")]
    Connection(#[from] CoreError),                 // -> maps from resolver (CONNECTION_CLOSED, ...)
    #[error(transparent)]
    Nats(#[from] NatsError),                        // wraps ns-nats; delegates code()
    #[error("JetStream is not enabled on this account/server")]
    JetStreamNotEnabled,                            // JETSTREAM_NOT_ENABLED
    #[error("stream {0} not found")]
    StreamNotFound(String),                         // STREAM_NOT_FOUND
    #[error("consumer {0} not found")]
    ConsumerNotFound(String),                       // CONSUMER_NOT_FOUND
    #[error("kv key {0} not found")]
    KvKeyNotFound(String),                          // KV_KEY_NOT_FOUND
    #[error("kv update conflict (expected rev {expected})")]
    KvWrongLastRevision { expected: u64 },          // INVALID_ARGUMENT (CAS)
    #[error("object {0} not found")]
    ObjectNotFound(String),                         // OBJECT_NOT_FOUND
    #[error("invalid config")]
    InvalidConfig(Vec<ConfigViolation>),            // INVALID_ARGUMENT (structured detail)
    #[error("payload decode failed")]
    Decode(#[from] InspectorError),                 // PAYLOAD_DECODE_FAILED
    #[error("backup/restore io failed")]
    TransferIo(#[from] std::io::Error),             // IO
    #[error("operation was cancelled")]
    Cancelled,                                      // CANCELLED
    #[error("request timed out")]
    Timeout,                                        // TIMEOUT / REQUEST_TIMEOUT
}
```

`InvalidConfig` carries `Vec<ConfigViolation { field, code, message }>` surfaced as `IpcError.detail` so the UI can highlight offending form fields. Mapping to `ErrorCode` happens via `DomainError::code`; the single serialization surface remains `ns_ipc::to_ipc_error`.

---

## 6. Tauri IPC commands

All commands live in the bin (`apps/desktop/src-tauri/src/commands/jetstream.rs` + `kv.rs` + `objectstore.rs`), each `async`, each `Result<T, IpcError>`, one `req` arg, DTOs from `ns-types` (spine §8). Prefix: `jetstream_*`, `kv_*`, `objectstore_*`.

### 6.1 Streams

| Command | Kind | Params (`req`) | Returns | Key errors |
|---|---|---|---|---|
| `jetstream_list_streams` | request | `ListStreamsRequest { connectionId, cursor?, limit, filterSubject? }` | `StreamPage { items: StreamSummary[], nextCursor?, total? }` | CONNECTION_CLOSED, JETSTREAM_NOT_ENABLED |
| `jetstream_get_stream` | request | `GetStreamRequest { connectionId, name }` | `StreamInfo` | STREAM_NOT_FOUND |
| `jetstream_create_stream` | request | `CreateStreamRequest { connectionId, config: StreamConfig }` | `StreamInfo` | INVALID_ARGUMENT, PERMISSION_DENIED |
| `jetstream_update_stream` | request | `UpdateStreamRequest { connectionId, config: StreamConfig }` | `StreamInfo` | STREAM_NOT_FOUND, INVALID_ARGUMENT |
| `jetstream_delete_stream` | request | `DeleteStreamRequest { connectionId, name }` | `()` | STREAM_NOT_FOUND |
| `jetstream_purge_stream` | request | `PurgeStreamRequest { connectionId, name, filter?: PurgeFilter }` | `PurgeResult { purged }` | STREAM_NOT_FOUND |
| `jetstream_stream_subjects` | request | `StreamSubjectsRequest { connectionId, name, filter?, cursor?, limit }` | `SubjectCountPage` | STREAM_NOT_FOUND |

`PurgeFilter = { subject?: string, keep?: u64, upToSeq?: u64 }` (adjacently-tagged variants map to JS `purge` options).

### 6.2 Messages / replay

| Command | Kind | Params | Returns | Errors |
|---|---|---|---|---|
| `jetstream_get_message` | request | `GetMessageRequest { connectionId, stream, by: { seq } \| { lastForSubject } , decode?: bool }` | `StoredMessage` | STREAM_NOT_FOUND, NOT_FOUND, PAYLOAD_DECODE_FAILED |
| `jetstream_delete_message` | request | `DeleteMessageRequest { connectionId, stream, seq, secure?: bool }` | `()` | STREAM_NOT_FOUND, PERMISSION_DENIED |
| `jetstream_start_replay` | **stream** (Channel) | `ReplayRequest { connectionId, stream, from: DeliverStart, filterSubjects?, limit?, decode?, channel }` + `Channel<StreamedMessage>` | `ReplayStarted { subscriptionId }` | STREAM_NOT_FOUND, INVALID_ARGUMENT |
| `jetstream_cancel_replay` | command | `CancelRequest { subscriptionId }` | `()` | NOT_FOUND |

`DeliverStart = { kind: "all" } \| { kind: "last" } \| { kind: "lastPerSubject" } \| { kind: "bySeq", seq } \| { kind: "byTime", ts }`. Replay uses an **ephemeral** ordered-pull consumer created + torn down by `MessagesModule`.

### 6.3 Consumers

| Command | Kind | Params | Returns | Errors |
|---|---|---|---|---|
| `jetstream_list_consumers` | request | `ListConsumersRequest { connectionId, stream, cursor?, limit }` | `ConsumerPage` | STREAM_NOT_FOUND |
| `jetstream_get_consumer` | request | `GetConsumerRequest { connectionId, stream, name }` | `ConsumerInfo` | CONSUMER_NOT_FOUND |
| `jetstream_create_consumer` | request | `CreateConsumerRequest { connectionId, stream, config: ConsumerConfig }` | `ConsumerInfo` | INVALID_ARGUMENT |
| `jetstream_update_consumer` | request | `UpdateConsumerRequest { connectionId, stream, config: ConsumerConfig }` | `ConsumerInfo` | CONSUMER_NOT_FOUND, INVALID_ARGUMENT |
| `jetstream_delete_consumer` | request | `DeleteConsumerRequest { connectionId, stream, name }` | `()` | CONSUMER_NOT_FOUND |
| `jetstream_pause_consumer` | request | `PauseConsumerRequest { connectionId, stream, name, until?: ts }` | `ConsumerInfo` | CONSUMER_NOT_FOUND |
| `jetstream_resume_consumer` | request | `ResumeConsumerRequest { connectionId, stream, name }` | `ConsumerInfo` | CONSUMER_NOT_FOUND |

### 6.4 KV

| Command | Kind | Params | Returns | Errors |
|---|---|---|---|---|
| `kv_list_buckets` | request | `ListKvRequest { connectionId, cursor?, limit }` | `KvBucketPage` | JETSTREAM_NOT_ENABLED |
| `kv_create_bucket` | request | `CreateKvRequest { connectionId, config: KvConfig }` | `KvBucketStatus` | INVALID_ARGUMENT |
| `kv_delete_bucket` | request | `DeleteKvRequest { connectionId, bucket }` | `()` | NOT_FOUND |
| `kv_status` | request | `KvStatusRequest { connectionId, bucket }` | `KvBucketStatus` | NOT_FOUND |
| `kv_list_keys` | request | `KvListKeysRequest { connectionId, bucket, prefix?, cursor?, limit }` | `KvKeyPage` | NOT_FOUND |
| `kv_get` | request | `KvGetRequest { connectionId, bucket, key, revision?, decode? }` | `KvEntry` | KV_KEY_NOT_FOUND |
| `kv_put` | request | `KvPutRequest { connectionId, bucket, key, valueB64, encoding, expectedRevision?, mode: "put"\|"create"\|"update" }` | `KvRevision { revision }` | INVALID_ARGUMENT (CAS conflict) |
| `kv_delete` | request | `KvDeleteRequest { connectionId, bucket, key, purge?: bool }` | `()` | KV_KEY_NOT_FOUND |
| `kv_history` | request | `KvHistoryRequest { connectionId, bucket, key, cursor?, limit }` | `KvEntryPage` | KV_KEY_NOT_FOUND |
| `kv_start_watch` | **stream** (Channel) | `KvWatchRequest { connectionId, bucket, keyFilter?, includeHistory?, channel }` + `Channel<KvWatchEvent>` | `KvWatchStarted { subscriptionId }` | NOT_FOUND |
| `kv_cancel_watch` | command | `CancelRequest { subscriptionId }` | `()` | NOT_FOUND |

### 6.5 Object store

| Command | Kind | Params | Returns | Errors |
|---|---|---|---|---|
| `objectstore_list_buckets` | request | `ListObjRequest { connectionId, cursor?, limit }` | `ObjBucketPage` | JETSTREAM_NOT_ENABLED |
| `objectstore_create_bucket` | request | `CreateObjRequest { connectionId, config: ObjConfig }` | `ObjBucketStatus` | INVALID_ARGUMENT |
| `objectstore_delete_bucket` | request | `DeleteObjRequest { connectionId, bucket }` | `()` | NOT_FOUND |
| `objectstore_status` | request | `ObjStatusRequest { connectionId, bucket }` | `ObjBucketStatus` | NOT_FOUND |
| `objectstore_list_objects` | request | `ListObjectsRequest { connectionId, bucket, cursor?, limit }` | `ObjectInfoPage` | NOT_FOUND |
| `objectstore_object_info` | request | `ObjectInfoRequest { connectionId, bucket, name }` | `ObjectInfo` | OBJECT_NOT_FOUND |
| `objectstore_delete_object` | request | `DeleteObjectRequest { connectionId, bucket, name }` | `()` | OBJECT_NOT_FOUND |
| `objectstore_start_put` | **stream** (Channel) | `ObjectPutRequest { connectionId, bucket, name, filePath, meta?, channel }` + `Channel<TransferProgress>` | `ObjectPutStarted { transferId }` | IO, INVALID_ARGUMENT |
| `objectstore_start_get` | **stream** (Channel) | `ObjectGetRequest { connectionId, bucket, name, filePath, channel }` + `Channel<TransferProgress>` | `ObjectGetStarted { transferId }` | OBJECT_NOT_FOUND, IO |
| `objectstore_cancel_transfer` | command | `CancelRequest { transferId }` | `()` | NOT_FOUND |

> Object bytes never cross IPC as base64 for large blobs. `filePath` (a user-chosen path via the Tauri dialog plugin) is read/written by the Rust side directly; only **progress** streams to the UI. Small `kv`/message payloads use base64 per spine §6.

### 6.6 Snapshot / backup / restore & account limits

| Command | Kind | Params | Returns | Errors |
|---|---|---|---|---|
| `jetstream_start_backup` | **stream** (Channel) | `BackupRequest { connectionId, stream, filePath, channel }` + `Channel<TransferProgress>` | `BackupStarted { transferId }` | STREAM_NOT_FOUND, IO |
| `jetstream_start_restore` | **stream** (Channel) | `RestoreRequest { connectionId, filePath, overrideConfig?: StreamConfig, channel }` + `Channel<TransferProgress>` | `RestoreStarted { transferId }` | INVALID_ARGUMENT, IO |
| `jetstream_cancel_transfer` | command | `CancelRequest { transferId }` | `()` | NOT_FOUND |
| `jetstream_account_limits` | request | `AccountLimitsRequest { connectionId }` | `JsAccountInfo` | JETSTREAM_NOT_ENABLED |

---

## 7. Events emitted

Domain events published via the `EventPublisher` port (never Tauri directly). The `ns-ipc` `EventBridge` maps them to Tauri event names. New `EventPayload` variants (added to `ns-types` via PR + regen per spine §9):

| Domain event | Tauri name | Trigger | Backpressure policy |
|---|---|---|---|
| `StreamUpdated { connectionId, stream, state }` | `ns://jetstream/stream` | after create/update/delete/purge, or a periodic light refresh tick | dedupe consecutive identical states; keep-latest per (conn, stream) |
| `ConsumerLag { connectionId, stream, consumer, numPending, ackFloor, redelivered }` | `ns://jetstream/consumer-lag` | periodic lag sampler while a consumer detail view is open | keep-latest per (conn, stream, consumer) within tick |
| `TaskProgress { taskId, kind, done, total?, phase }` | `ns://task/progress` | backup/restore/object transfer progress | keep-latest per taskId (spine §9) |
| `Notification { level, code?, message }` | `ns://notification` | destructive op completion (purge/delete), CAS conflict hints | never drop |

> **Streamed** data (replay messages, KV watch events, object transfer chunk progress) flows on **request-scoped Tauri Channels**, not ambient events (spine §8, ADR-0009). `TaskProgress` above is an *ambient* mirror for a global "tasks" tray; the fine-grained per-chunk progress is on the Channel.

**Consumer-lag sampler**: a bounded background task (in `ConsumersModule`) started on demand when the UI opens a consumer/stream detail view (ref-counted subscription), polling `consumer_info` at a configurable interval (default 2s), emitting `ConsumerLag`. Stopped when the last viewer unsubscribes (`jetstream_watch_lag`/`jetstream_unwatch_lag` companion commands — request-scoped, id-keyed in `CancellationRegistry`).

---

## 8. Frontend surface

Feature folder: `apps/desktop/src/features/jetstream/` (+ `kv/`, `object-store/` share the same feature or sub-folders). Frontend calls **only** generated typed wrappers from `packages/ns-bindings` (`ipc.jetstream.*`, `ipc.kv.*`, `ipc.objectstore.*`).

### 8.1 Routes (React Router)

```
/c/:connectionId/jetstream                      -> JetStreamOverviewPage (streams list + account limits header)
/c/:connectionId/jetstream/streams/:name        -> StreamDetailPage (tabs: Overview | Config | Consumers | Messages | Replication)
/c/:connectionId/jetstream/streams/:name/consumers/:consumer -> ConsumerDetailPage
/c/:connectionId/kv                             -> KvBucketsPage
/c/:connectionId/kv/:bucket                     -> KvBrowserPage (keys table + value editor + history + watch)
/c/:connectionId/object-store                   -> ObjectBucketsPage
/c/:connectionId/object-store/:bucket           -> ObjectBrowserPage (objects table + upload/download)
```

Panels are dockable (dockview, ADR-0012); the routes above map to dock panels within the workspace shell.

### 8.2 Components / panels

- `StreamListPanel` (virtualized table: name, subjects, messages, bytes, consumers, replicas, leader) + create button.
- `StreamWizard` / `StreamConfigForm` — Monaco JSON view toggle + structured form; live client-side + server (`validate_stream_config`) validation; sections: General, Subjects, Retention/Limits, Storage/Replicas, Placement (cluster/tags), Sources & Mirror, Dedup/Discard.
- `StreamStatePanel` — state cards (msgs, bytes, first/last seq/ts, consumers), per-subject count table, cluster/replica health.
- `ConsumerListPanel`, `ConsumerConfigForm` (push/pull toggle, ack policy, deliver policy, filter subjects, backoff, maxDeliver, ackWait), `ConsumerLagPanel` (ECharts pending/ack-floor over time from `ConsumerLag` events).
- `MessageBrowserPanel` — replay controls (start=all/last/bySeq/byTime, filter, limit), virtualized message list, row → `ns-inspector` render; delete/purge actions.
- `KvBrowserPanel` — keys tree/table (prefix filter), value editor (Monaco), revision history drawer, live watch toggle, put/create/update(CAS)/delete/purge.
- `ObjectBrowserPanel` — objects table, drag-drop upload with progress bar (from Channel), download-to-file, delete, object metadata drawer.
- `BackupRestoreDialog` — file picker (Tauri dialog), progress bar, cancel.
- `JsAccountLimitsHeader` — usage vs limits meters (streams/consumers/memory/storage).

### 8.3 Zustand stores (UI/session only — never mirror server-state)

`useJetStreamUiStore`:
- `selectedStream`, `selectedConsumer`, `activeStreamTab`
- `streamConfigDraft` (unsaved Monaco/form buffer), `consumerConfigDraft`
- `replayControls` (start mode, filter, limit, live toggle), `messageListFilter`
- `kvDraft` (key, value buffer, mode), `kvPrefixFilter`, `kvWatchLive: boolean`
- `objectUploadQueue` (client-side pending file list), per-transfer progress map (ephemeral)
- `streamListFilter`, column visibility

`useTransfersStore` (shared with backup/restore/object): `transfers: Record<transferId, { kind, phase, done, total, cancel() }>` — fed by Channel/`TaskProgress`.

### 8.4 TanStack Query keys (all server-state)

```
['jetstream','streams', connectionId, filter]                 -> list_streams (infinite / cursor)
['jetstream','stream', connectionId, name]                    -> get_stream
['jetstream','stream','subjects', connectionId, name, filter] -> stream_subjects
['jetstream','consumers', connectionId, stream]               -> list_consumers
['jetstream','consumer', connectionId, stream, name]          -> get_consumer
['jetstream','account', connectionId]                         -> account_limits
['kv','buckets', connectionId]                                -> kv_list_buckets
['kv','status', connectionId, bucket]                         -> kv_status
['kv','keys', connectionId, bucket, prefix]                   -> kv_list_keys (infinite)
['kv','entry', connectionId, bucket, key, revision]           -> kv_get
['kv','history', connectionId, bucket, key]                   -> kv_history (infinite)
['objectstore','buckets', connectionId]                       -> objectstore_list_buckets
['objectstore','status', connectionId, bucket]                -> objectstore_status
['objectstore','objects', connectionId, bucket]               -> objectstore_list_objects (infinite)
['objectstore','object', connectionId, bucket, name]          -> objectstore_object_info
```

Mutations invalidate the relevant list/detail keys. `IpcError.retriable` drives TanStack retry. Streamed data (replay/watch) is **folded into the cache** via `queryClient.setQueryData` from Channel handlers, or held in local component state for high-rate message lists (ring-buffered client-side). A single `useJetStreamEvents()` hook (part of the app-wide `useAppEvents`) routes `ns://jetstream/*` events to cache invalidation / `setQueryData`.

### 8.5 IPC client calls (generated wrappers)

`ipc.jetstream.listStreams/getStream/createStream/updateStream/deleteStream/purgeStream/streamSubjects/getMessage/deleteMessage/startReplay(channel)/cancelReplay/listConsumers/getConsumer/createConsumer/updateConsumer/deleteConsumer/pauseConsumer/resumeConsumer/startBackup(channel)/startRestore(channel)/cancelTransfer/accountLimits/watchLag/unwatchLag`, `ipc.kv.*`, `ipc.objectstore.*` — each paired in `commands.manifest.ts` with its Request/Response type so a rename breaks the TS build.

---

## 9. Data model (SQLite tables / DTOs owned)

JetStream state itself lives in the NATS server, **not** persisted. We persist only **user productivity artifacts** via `ns-storage` repositories (ports in `ns-core`, SQL in `ns-storage`). Owned repos/tables:

| Table | Purpose | Key columns |
|---|---|---|
| `js_stream_templates` | saved stream config templates (reusable presets) | `id TEXT PK, name, connection_profile_id?, config_json, created_at, updated_at` |
| `js_consumer_templates` | saved consumer config templates | `id TEXT PK, name, config_json, created_at` |
| `js_kv_bookmarks` | pinned KV keys/buckets for quick access | `id TEXT PK, connection_profile_id, bucket, key?, label, created_at` |
| `js_backup_history` | record of backup/restore runs (audit) | `id TEXT PK, connection_profile_id, stream, kind ('backup'\|'restore'), file_path, bytes, status, started_at, finished_at` |

- `config_json` stores a `StreamConfig`/`ConsumerConfig` DTO (the same `ns-types` shape used over IPC) — no secrets ever (JetStream configs contain none; source/mirror creds are references only).
- Repos: `StreamTemplateRepo`, `ConsumerTemplateRepo`, `KvBookmarkRepo`, `JsBackupHistoryRepo` — all implement `ns-core` ports; migrations under `crates/ns-storage/migrations/NNNN_jetstream_*.sql`.
- **DTOs owned in `ns-types`** (typeshared, camelCase, tagged enums): `StreamConfig`, `StreamInfo`, `StreamSummary`, `StreamState`, `ClusterInfo`, `PeerInfo`, `RetentionPolicy`, `StorageType`, `DiscardPolicy`, `Placement`, `StreamSource`, `StreamMirror`, `SubjectCount`, `PurgeFilter`, `PurgeResult`, `StoredMessage`, `StreamedMessage`, `DeliverStart`, `ConsumerConfig`, `ConsumerInfo`, `AckPolicy`, `DeliverPolicy`, `ReplayPolicy`, `ConsumerSummary`, `KvConfig`, `KvBucketStatus`, `KvEntry`, `KvRevision`, `KvWatchEvent`, `ObjConfig`, `ObjBucketStatus`, `ObjectInfo`, `ObjectChunk`, `TransferProgress`, `JsAccountInfo`, `JsTierLimits`, `JsApiStats`, `ConfigViolation`, plus the paginated monomorphs `StreamPage/ConsumerPage/KvKeyPage/KvEntryPage/KvBucketPage/ObjBucketPage/ObjectInfoPage/SubjectCountPage`.

---

## 10. Dependencies on other subsystems

| Depends on | For | Contract |
|---|---|---|
| `ns-types` (L0) | all DTOs / errors | frozen SoT; we add DTOs via PR + regen |
| `ns-core` (L0) | ports: `EventPublisher`, `Clock`, `JsContextResolver`, repo traits, `CancellationRegistry`, `DomainError`, `ErrorCode` | consume traits only |
| `ns-event` (L1) | `EventPublisher` impl (injected) | via port |
| `ns-nats` (L1) | `JsContext`/`KvStore`/`ObjectBucket` traits (the ONLY async-nats access) | **primary functional dependency** — see §3/§12 |
| `ns-inspector` (L1) | decode-on-read payload rendering | `PayloadCodec` port |
| `ns-connection` (L2) | live `JsContext` per connection, JS-enabled status | via `JsContextResolver` |
| `ns-storage` (L2, by port) | template/bookmark/backup-history persistence | repo ports; SQL lives there |
| `ns-monitor` (read-only) | server-wide `jsz` for dashboard cross-checks (optional) | read snapshots; no dep back |

Consumed **by**: `ns-dashboard` (overview aggregation) and the bin (composition root). We depend on none of them (one-way, ADR-0007).

---

## 11. Concurrency, async & backpressure

- **Every method is async**; no blocking on the UI thread. Pure validation (`validate_*`) is sync and IO-free.
- **JsContext reuse**: one `Arc<dyn JsContext>` per connection resolved from `ns-connection`; cheap clones. No per-call client creation. Info calls run concurrently (`join_all`) when building list pages (bounded concurrency, e.g. `buffer_unordered(8)`) to avoid stampeding the server.
- **Replay**: creates an ephemeral ordered pull consumer, pumps `pull_batch` into a **bounded mpsc** feeding the Channel. Policy = high-rate subscribe stream: sample + count drops (`droppedSinceLast` on `StreamedMessage`), bounded buffer, preserve order best-effort. Terminal `error`/`complete` variant sent in-band (spine §7). Cancellation via `CancellationToken` keyed by `subscriptionId`; Channel drop-detection (bin watchdog) also cancels; ephemeral consumer is always torn down in a `Drop`/`finally`.
- **KV watch**: bounded queue, drop-oldest with overflow marker for high-churn buckets; `includeHistory` bootstrap streamed then live.
- **Object transfers / backup / restore**: chunked, bounded in-flight window (e.g. 8 chunks). Progress coalesced (keep-latest per taskId) to ~10 Hz to avoid flooding the UI. Backpressure between file IO (`spawn_blocking` for disk) and NATS is a bounded channel. Cancellation aborts mid-stream and cleans partial files (restore leaves the partially-created stream? — see risks).
- **Lag sampler**: one ref-counted task per (conn, stream[, consumer]); interval configurable; coalesced keep-latest; auto-stops when viewers drop to zero. Never blocks producers.
- **Limits cache**: `account_info` cached with short TTL (e.g. 3s) per connection to avoid hammering `$JS.API.INFO` when many panels read it.
- **Cancellation everywhere** via `CancellationRegistry` keyed by the id returned to the UI (ADR-0018). All background tasks tracked so shutdown/disconnect drains them.
- **Timeouts**: every JS API call wrapped in a configurable timeout (default from settings, e.g. 5s) → `JetStreamError::Timeout` (`retriable=true`).

---

## 12. Test plan

**Unit (no server; `cargo nextest`, mock `JsContext` from `ns-testkit`)**
- `mapping.rs`: round-trip every `Raw* <-> ns-types` DTO (golden files); enum tag/camelCase correctness.
- `validate.rs`: stream config (subject overlap across streams, replica bounds 1..=5, retention/limits coherence, mirror+subjects mutual exclusion, dedupe window vs maxAge), consumer config (pull vs push field conflicts, ackPolicy vs replayPolicy, filterSubjects subset of stream subjects).
- `replication.rs`: source/mirror lag math; config builder correctness.
- Error mapping: each `JetStreamError` → expected `ErrorCode`/`retriable`/`user_message` (secret-safe, no redaction leaks).
- Backpressure: mock high-rate stream → assert `droppedSinceLast` accounting and ordering guarantees.
- Cancellation: replay/watch/transfer cancel → task aborts, ephemeral consumer torn down, registry cleaned.

**Integration (embedded `nats-server` fixture from `ns-testkit`, JS enabled)**
- Stream lifecycle: create → info → update → purge (each filter) → delete; assert state transitions + emitted `StreamUpdated`.
- Consumer lifecycle: durable pull, ephemeral push, ack policies; pause/resume; lag reflects real pending after publishing N msgs.
- Messages: publish N, `get_message` by seq & lastForSubject, replay all/bySeq/byTime with filter, delete (secure + normal).
- KV: create bucket, put/create/update(CAS conflict path)/get/history/delete/purge, watch receives live + historical events.
- Object store: put a >chunk-size file, get it back byte-identical (hash compare), list/info/delete, progress events monotonic.
- Backup/restore: snapshot a populated stream to temp file, delete stream, restore, assert message count + config equal.
- Account limits: read `JsAccountInfo`; create streams until limit → `PERMISSION_DENIED`/limit error surfaced correctly.
- JS-not-enabled server → `JETSTREAM_NOT_ENABLED` from all entry points.

**E2E (Tauri app harness + real nats-server, per testing-strategy)**
- Create stream via `StreamWizard`, see it in list (cache invalidation), open detail, add consumer, publish from pub/sub view, watch messages appear in `MessageBrowserPanel`.
- KV browser: put/edit/delete a key with live watch on; assert UI updates from Channel.
- Object upload/download round-trip with progress bar reaching 100% and cancel mid-transfer.
- Backup then restore flow through `BackupRestoreDialog`.
- Fault injection: kill server mid-replay → in-band terminal error variant renders as a gap/error state, no WebView crash, no leaked task (assert via telemetry/task registry count).

**Property/fuzz (optional)**: `validate_stream_config` against random configs never panics; mapping never panics on malformed `Raw*`.

---

## 13. Risks & open questions

**Risks**
1. **`ns-nats` trait surface is the critical-path dependency.** If `ns-nats` exposes `async-nats` handles too thinly (e.g. leaks `async_nats::jetstream::stream::Stream`), our neutral-DTO boundary breaks. Mitigation: co-design `Raw*` structs with `[connection-manager]` up front (§3) — this is the first cross-team interface to lock.
2. **KV/Object handle lifetime**: `async-nats` KV/OS handles are derived from the JS context; caching `Arc<dyn KvStore>` per bucket must invalidate on reconnect. Mitigation: resolver returns fresh handles keyed to the connection generation; bump on reconnect.
3. **Large object / backup memory**: must stream to disk, never buffer whole payloads. Mitigation: `spawn_blocking` disk IO + bounded chunk window; enforced in review.
4. **Replay ephemeral-consumer leaks** on abrupt disconnect. Mitigation: `Drop` guard + server-side ephemeral inactivity threshold as backstop.
5. **High-cardinality streams/consumers** (thousands) — list pages must be cursor-paginated and info calls bounded-concurrent to avoid API storms. Mitigation: `buffer_unordered` + server-side pagination where async-nats supports it, else client windowing.
6. **CAS semantics surface**: KV update conflict must map to a distinct, non-retriable code the UI can turn into a "reload & retry" affordance, not a generic error.
7. **Restore partial state**: a cancelled/failed restore may leave a half-created stream. Mitigation: restore into a temp stream name then rename/replace, or document + offer cleanup; needs ADR.

**Open questions**
1. Does `ns-nats` expose ordered-consumer / direct-get (`get_last_msg_for_subject`, `DirectGet`) primitives, or must `MessagesModule` build them from pull consumers? (Affects replay & lastForSubject perf.)
2. Account limits source of truth: `$JS.API.INFO` (per-account, needs connection) vs `jsz` (server-wide, via `ns-monitor`). Proposal: JS API for per-account limits in JetStream views; monitor `jsz` only for the dashboard's server view. Confirm with `[monitoring]`/`[dashboard]`.
3. Cross-account / cross-domain **sources & mirrors** with external API prefixes + credentials — where do source creds live (they are secrets)? Likely `ns-security` reference stored in `StreamSource.external`, resolved at create time. Needs `[account-security]` alignment.
4. Should stream/consumer **live state** be pushed via a periodic `StreamUpdated` sampler (like lag) or pulled on-demand only? Proposal: on-demand + invalidate-on-mutation by default; opt-in sampler for an "auto-refresh" toggle to bound background load.
5. Snapshot file format/portability across server versions — do we guarantee restore compatibility across NATS versions, or gate by server version? Needs a compatibility policy (deployment-strategy).
6. Do we expose `jetstream_watch_lag`/`unwatch_lag` as explicit commands or fold lag sampling into the consumer detail query's `refetchInterval`? Trade-off: server push vs client poll; leaning explicit watch for coalescing + gap detection.
