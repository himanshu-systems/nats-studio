# Subsystem Design — Message Inspector `[message-inspector]`

> Owner: Message Inspector Team · Crate: `ns-inspector` (L1 lib) · Frontend slice: the Inspector panel/drawer + standalone `/inspector` view.
> Source of truth: `docs/architecture/00-conventions-and-workspace.md` (the spine). This document must not contradict it.

---

## 0. One-paragraph summary

The Message Inspector turns an opaque NATS message payload (`&[u8]` + headers + subject context) into something a human can read and validate: it **auto-detects compression** (gzip/zstd/snappy/deflate), **content-encoding/charset**, and **payload format** (JSON/MsgPack/CBOR/Protobuf/Avro/text/binary); renders **raw / pretty-JSON / tree / hex-dump / binary-preview** view models plus a **header + metadata** panel; runs **pluggable schema validation** (JSON Schema, Protobuf, Avro); and provides **search/filter, copy, and export**. `ns-inspector` is a **pure, CPU-bound, IO-free leaf-domain crate** (no `async-nats`, no `tokio` IO, no SQL, no `tauri`). It is consumed *server-side* by `ns-pubsub` and `ns-jetstream` to decode messages they fetch, and exposed to the UI through `inspector_*` IPC commands. It exposes a **codec / validator plugin extension point** so `ns-plugin` can register new formats at composition time.

---

## 1. Responsibilities & boundaries

### 1.1 In scope (this team owns)
- **Detection pipeline**: compression sniff → decompress (bounded) → format detect → charset detect. Cheap `detect()` fast-path vs. full `inspect()`.
- **Codecs**: JSON, text, MsgPack, CBOR, Protobuf (schema-aware + best-effort schemaless wire dump), Avro (schema-required), raw binary. Each behind a `Codec` trait; registered in a `CodecRegistry`.
- **View models**: pretty/minified JSON, JSON *tree* nodes, paged **hex dump**, binary preview (magic-type guess + entropy), header table, metadata (subject, reply, seq, timestamps, size, JetStream meta).
- **Schema registry**: CRUD + validation of JSON Schema / Protobuf `.proto`+FileDescriptorSet / Avro `.avsc`. Persistence via a **port** (`SchemaRepo`) implemented by `ns-storage`.
- **Search / filter** over a caller-supplied in-memory corpus (JSONPath-ish, substring, regex, header/field predicates).
- **Convert / copy / export**: pretty↔minify, decode→JSON, hex, base64; export one or many messages to `json` / `ndjson` / `csv` / raw `binary`.
- **Plugin extension point**: register third-party `dyn Codec` / `dyn SchemaValidator` into the registries.

### 1.2 Out of scope (explicitly *not* ours)
- **Fetching messages off the wire** — that is `ns-pubsub` (live subscribe/request) and `ns-jetstream` (get/replay). Inspector only ever receives bytes.
- **Message history storage / retention** — owned by `ns-storage` (`MessageHistoryRepo`) and produced by `ns-pubsub`. We *read* it via DTOs but never own the table.
- **Secret handling / redaction primitives** — `ns-security` / `ns-core` (`Redacted<T>`). We consume the scrubber; we never touch keychains.
- **The Tauri/event bridge** — `ns-ipc`. We emit *domain* facts, never `tauri::emit`.

### 1.3 Boundary contract
`ns-inspector` depends **only** on `ns-types` + `ns-core` (per the spine). Everything IO-shaped (schema persistence) enters through a **ns-core port trait** injected by the composition root. This keeps the crate headless-testable and reusable by a future CLI.

---

## 2. Crate layout (`crates/ns-inspector`)

```
ns-inspector/
├─ src/
│  ├─ lib.rs                 # re-exports: Inspector, InspectorService, registries, error
│  ├─ service.rs            # InspectorService trait + DefaultInspectorService (async facade)
│  ├─ inspector.rs          # Inspector (sync core engine): detect/inspect/hexdump/convert
│  ├─ error.rs              # InspectorError (thiserror) + DomainError impl
│  ├─ config.rs             # InspectorConfig (limits, defaults)
│  ├─ detect/
│  │  ├─ compression.rs     # CompressionRegistry + gzip/zstd/snappy/deflate sniff+decompress
│  │  ├─ format.rs          # FormatDetector (magic bytes + structural probes + confidence)
│  │  └─ charset.rs         # CharsetDetector (BOM, UTF-8 validation, heuristic)
│  ├─ codec/
│  │  ├─ mod.rs             # Codec trait, CodecRegistry, CodecCaps, DecodeOptions
│  │  ├─ json.rs · text.rs · msgpack.rs · cbor.rs · binary.rs
│  │  ├─ protobuf.rs        # descriptor-driven + schemaless wire walker (feature = "protobuf")
│  │  └─ avro.rs            # (feature = "avro")
│  ├─ schema/
│  │  ├─ mod.rs             # SchemaValidator trait, ValidatorRegistry, CompiledSchema, SchemaRepo port re-export
│  │  ├─ jsonschema.rs · protobuf.rs · avro.rs
│  ├─ view/
│  │  ├─ hex.rs             # paged hex model
│  │  ├─ tree.rs            # JSON/decoded → TreeNode
│  │  └─ preview.rs         # binary preview + entropy + magic-type guess
│  ├─ search.rs            # SearchEngine over a corpus
│  └─ export.rs            # exporters (json/ndjson/csv/binary)
└─ Cargo.toml               # features: protobuf, avro, brotli (default = ["protobuf","avro"])
```

Key third-party deps (all confined here): `serde_json`, `rmpv` (MsgPack), `ciborium` (CBOR), `flate2`/`zstd`/`snap` (compression), `prost`/`prost-reflect` (protobuf), `apache-avro`, `jsonschema` (validation), `chardetng`+`encoding_rs` (charset), `base64`, `hex`, `regex`. Heavy validators are feature-gated to keep the default binary lean.

---

## 3. Rust public interface

### 3.1 Error type

```rust
// crates/ns-inspector/src/error.rs
#[derive(Debug, thiserror::Error)]
pub enum InspectorError {
    #[error("no codec registered for '{0}'")]
    UnknownCodec(String),
    #[error("decode failed for {codec}: {reason}")]
    DecodeFailed { codec: CodecId, reason: String },
    #[error("payload is {size} bytes, exceeds limit {limit}")]
    PayloadTooLarge { size: usize, limit: usize },
    #[error("decompression output exceeded limit (ratio {ratio}x / {out} bytes)")]
    DecompressionLimit { ratio: u32, out: usize },
    #[error("schema compile failed ({kind:?}): {reason}")]
    SchemaCompileFailed { kind: SchemaKind, reason: String },
    #[error("schema '{0}' not found")]
    SchemaNotFound(SchemaId),
    #[error("operation not supported by codec '{0}'")]
    Unsupported(CodecId),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("operation cancelled")]
    Cancelled,
    #[error("schema store: {0}")]
    Store(#[source] Box<dyn std::error::Error + Send + Sync>), // wraps StorageError via port; no ns-storage dep
    #[error(transparent)]
    Internal(#[from] anyhow::Error), // internal only; never crosses IPC as anyhow (mapped by DomainError)
}

impl ns_core::DomainError for InspectorError {
    fn code(&self) -> ns_types::ErrorCode {
        use ns_types::ErrorCode::*;
        match self {
            Self::UnknownCodec(_) | Self::DecodeFailed { .. }        => PayloadDecodeFailed,
            Self::PayloadTooLarge { .. } | Self::DecompressionLimit { .. }
                | Self::InvalidArgument(_)                            => InvalidArgument,
            Self::SchemaCompileFailed { .. }                         => SchemaInvalid,   // NEW code (see §12)
            Self::SchemaNotFound(_)                                  => NotFound,
            Self::Unsupported(_)                                     => InvalidArgument,
            Self::Cancelled                                          => Cancelled,
            Self::Store(_)                                           => Storage,
            Self::Internal(_)                                        => Internal,
        }
    }
    fn retriable(&self) -> bool { matches!(self, Self::Store(_)) }
    fn user_message(&self) -> String { /* secret-safe, localizable copy per variant */ }
}
```

### 3.2 Extension traits (the plugin surface)

```rust
// codec/mod.rs
pub type CodecId = ns_types::CodecId;          // newtype over &'static str-ish String

pub struct DecodeOptions { pub charset: Option<Charset>, pub max_output: usize, pub schema: Option<Arc<CompiledSchema>> }
pub struct CodecCaps { pub can_encode: bool, pub needs_schema: bool, pub structured: bool }

pub trait Codec: Send + Sync + 'static {
    fn id(&self) -> CodecId;
    fn display_name(&self) -> &str;
    /// Cheap structural probe. Returns 0.0..=1.0 confidence. MUST NOT allocate the full decode.
    fn detect(&self, input: &DetectInput) -> f32;
    /// Full decode → normalized DecodedValue (serde_json::Value-shaped tree or Text/Bytes leaf).
    fn decode(&self, bytes: &[u8], opts: &DecodeOptions) -> Result<DecodedValue, InspectorError>;
    /// Optional (encode for round-trip / convert). Default: Err(Unsupported).
    fn encode(&self, _v: &DecodedValue, _opts: &EncodeOptions) -> Result<Vec<u8>, InspectorError> {
        Err(InspectorError::Unsupported(self.id()))
    }
    fn capabilities(&self) -> CodecCaps;
}

pub trait CompressionCodec: Send + Sync + 'static {
    fn id(&self) -> CompressionId;
    fn sniff(&self, bytes: &[u8]) -> bool;                 // magic-byte match
    fn decompress(&self, bytes: &[u8], limit: DecompressLimit) -> Result<Vec<u8>, InspectorError>;
    fn compress(&self, bytes: &[u8]) -> Result<Vec<u8>, InspectorError>;
}

pub trait SchemaValidator: Send + Sync + 'static {
    fn kind(&self) -> SchemaKind;
    fn compile(&self, src: &SchemaSource) -> Result<CompiledSchema, InspectorError>;
    fn validate(&self, compiled: &CompiledSchema, decoded: &DecodedValue) -> ValidationReport;
}
```

`CodecRegistry` / `CompressionRegistry` / `ValidatorRegistry` are `Arc`-shared, `RwLock`-guarded maps supporting `register(...)` (used by `ns-plugin` at composition time) and ordered `detect_best(...)`.

### 3.3 Port for schema persistence (defined in `ns-core`, impl in `ns-storage`)

```rust
// ns-core::ports (added by this team via PR)
#[async_trait::async_trait]
pub trait SchemaRepo: Send + Sync {
    async fn list(&self, filter: SchemaFilter) -> Result<Vec<SchemaRecord>, StorageError>;
    async fn get(&self, id: SchemaId) -> Result<Option<SchemaRecord>, StorageError>;
    async fn upsert(&self, rec: SchemaRecord) -> Result<SchemaRecord, StorageError>;
    async fn delete(&self, id: SchemaId) -> Result<(), StorageError>;
    /// Resolve the best schema bound to a subject (glob match, longest-wins).
    async fn resolve_for_subject(&self, connection: Option<ConnectionId>, subject: &str)
        -> Result<Option<SchemaRecord>, StorageError>;
}
```

### 3.4 Sync core engine

```rust
// inspector.rs — pure, no async, no IO. This is the reusable heart.
pub struct Inspector {
    codecs: Arc<CodecRegistry>,
    compressions: Arc<CompressionRegistry>,
    validators: Arc<ValidatorRegistry>,
    cfg: InspectorConfig,
}

impl Inspector {
    /// HOT-PATH SAFE. Compression sniff + format probe + charset guess only. No full decode, no alloc of decoded tree.
    pub fn detect(&self, input: &DetectInput) -> DetectionReport;

    /// Full pipeline: sniff→(bounded decompress)→detect→decode→build primary + available views.
    pub fn inspect(&self, input: &InspectInput) -> Result<InspectionReport, InspectorError>;

    /// Force a specific codec / compression (user override from the UI).
    pub fn inspect_as(&self, input: &InspectInput, force: ForceCodec) -> Result<InspectionReport, InspectorError>;

    /// Paged hex model for arbitrarily large payloads (never materializes the whole dump).
    pub fn hexdump(&self, bytes: &[u8], page: HexPage) -> HexModel;

    pub fn convert(&self, req: ConvertRequest) -> Result<ConvertOutput, InspectorError>;
    pub fn validate(&self, decoded: &DecodedValue, compiled: &CompiledSchema) -> ValidationReport;
    pub fn search(&self, corpus: &[MessageEntry], q: &SearchQuery, cancel: &CancellationToken) -> SearchResult;
}
```

`InspectorConfig` (defaults live in `ns-core::Settings`): `max_payload_bytes` (default 16 MiB), `max_decompressed_bytes` (default 64 MiB), `max_decompress_ratio` (default 100×), `pretty_json_indent`, `hex_bytes_per_line` (16), `default_charset`, `enable_schemaless_protobuf`.

### 3.5 Async service facade (the AppState port)

```rust
// service.rs — what AppState holds: inspector: Arc<dyn InspectorService>
#[async_trait::async_trait]
pub trait InspectorService: Send + Sync {
    async fn detect(&self, req: DetectRequest) -> Result<DetectionReport, InspectorError>;
    async fn inspect(&self, req: InspectRequest) -> Result<InspectionReport, InspectorError>;
    async fn inspect_as(&self, req: InspectAsRequest) -> Result<InspectionReport, InspectorError>;
    async fn hexdump(&self, req: HexdumpRequest) -> Result<HexModel, InspectorError>;
    async fn convert(&self, req: ConvertRequest) -> Result<ConvertResponse, InspectorError>;
    async fn validate(&self, req: ValidateRequest) -> Result<ValidationReport, InspectorError>;
    async fn search(&self, req: SearchRequest, cancel: CancellationToken) -> Result<SearchResponse, InspectorError>;
    async fn export(&self, req: ExportRequest, progress: mpsc::Sender<ExportProgress>) -> Result<ExportSummary, InspectorError>;

    async fn list_codecs(&self) -> Vec<CodecInfo>;
    async fn list_validators(&self) -> Vec<ValidatorInfo>;

    // Schema registry (delegates to SchemaRepo port)
    async fn list_schemas(&self, req: ListSchemasRequest) -> Result<Vec<SchemaDto>, InspectorError>;
    async fn get_schema(&self, id: SchemaId) -> Result<SchemaDto, InspectorError>;
    async fn save_schema(&self, req: SaveSchemaRequest) -> Result<SchemaDto, InspectorError>;
    async fn delete_schema(&self, id: SchemaId) -> Result<(), InspectorError>;

    // Plugin extension (called by ns-plugin host at composition/registration time)
    fn register_codec(&self, codec: Arc<dyn Codec>);
    fn register_validator(&self, v: Arc<dyn SchemaValidator>);
}
```

`DefaultInspectorService` wraps the sync `Inspector` and a `SchemaRepo`. **All CPU-heavy calls (`inspect`, `hexdump`, `convert`, `validate`, `search`, `export`) run inside `tokio::task::spawn_blocking`** (or a dedicated `rayon` pool) so decode never stalls the async runtime — see §9. Compiled schemas are cached in a small `moka`/LRU keyed by `SchemaId + content hash`.

### 3.6 Server-side decode helper (for `ns-pubsub` / `ns-jetstream`)

Those crates depend on `ns-inspector` and call the **sync** `Inspector` directly. To keep the subscription hot-path cheap, they use `detect()` per message (cheap) and attach a `DetectionReport` + raw bytes to the streamed DTO; the **full `inspect()` runs on demand** when the user opens a message (via `inspector_inspect`). A shared convenience:

```rust
/// Used by ns-pubsub/ns-jetstream to enrich a streamed message cheaply (no full decode).
pub fn quick_annotate(ins: &Inspector, bytes: &[u8], headers: &MessageHeaders) -> MessagePreviewMeta;
```

---

## 4. IPC commands (`inspector_*`)

All take one `req: XxxRequest`, return `Result<XxxResponse, IpcError>`, snake_case, namespaced. Payload bytes cross as base64 with an explicit `encoding` field (never raw arrays), per spine §5.

| Command | Kind | Request (key fields) | Returns | Notable errors (`ErrorCode`) |
|---|---|---|---|---|
| `inspector_detect` | request | `{ payload: WireBytes, headers?, contentType?, subject? }` | `DetectionReport` | `INVALID_ARGUMENT` |
| `inspector_inspect` | request | `{ payload: WireBytes, headers?, subject?, connectionId?, schemaId?, options? }` | `InspectionReport` | `PAYLOAD_DECODE_FAILED`, `INVALID_ARGUMENT` |
| `inspector_inspect_as` | request | `{ payload, force: { codecId?, compressionId?, charset? } }` | `InspectionReport` | `PAYLOAD_DECODE_FAILED` |
| `inspector_hexdump` | request | `{ payload, offset: u64, limit: u32 }` (cursor-paged) | `HexModel` `{ lines, offset, totalBytes, nextCursor? }` | `INVALID_ARGUMENT` |
| `inspector_convert` | request | `{ payload, from?, to: TargetForm, pretty?: bool }` | `ConvertResponse { output: WireBytes, form }` | `PAYLOAD_DECODE_FAILED`, `INVALID_ARGUMENT` |
| `inspector_validate` | request | `{ payload OR decodedRef, schemaId? OR inlineSchema? }` | `ValidationReport` | `SCHEMA_NOT_FOUND`→`NOT_FOUND`, `SCHEMA_INVALID` |
| `inspector_search` | request | `{ messages: MessageEntry[] OR sessionRef, query: SearchQuery, cursor?, limit }` | `SearchResponse { hits, nextCursor?, total }` | `INVALID_ARGUMENT`, `CANCELLED` |
| `inspector_search_cancel` | command | `{ searchId }` | `()` | — |
| `inspector_export` | request (spawns task) | `{ messages OR sessionRef, format: ExportFormat, path, options }` | `ExportSummary { taskId, path, count, bytes }` | `IO`, `CANCELLED` |
| `inspector_export_cancel` | command | `{ taskId }` | `()` | — |
| `inspector_list_codecs` | request | `{}` | `CodecInfo[]` | — |
| `inspector_list_validators` | request | `{}` | `ValidatorInfo[]` | — |
| `inspector_list_schemas` | request | `{ kind?, subject?, cursor?, limit }` | `SchemaPage` | `STORAGE` |
| `inspector_get_schema` | request | `{ id }` | `SchemaDto` | `NOT_FOUND` |
| `inspector_save_schema` | request | `{ id?, name, kind, source, subjectPattern? }` | `SchemaDto` | `SCHEMA_INVALID`, `STORAGE` |
| `inspector_delete_schema` | request | `{ id }` | `()` | `NOT_FOUND`, `STORAGE` |
| `inspector_import_schema` | request | `{ name, kind, filePath OR content }` | `SchemaDto` | `IO`, `SCHEMA_INVALID` |

Notes:
- **Progress streaming for export** uses a Tauri **Channel** on the `inspector_export` command signature: `on_progress: Channel<ExportProgress>` (spine §8.3A). It returns `{ taskId }` immediately; drop-detection + `inspector_export_cancel` trip the `CancellationToken`.
- `inspector_search` is a **paged request** by default; for very large corpora it may also expose an optional `on_hit: Channel<SearchHit>` streaming variant. Cancel via `inspector_search_cancel`.
- A convenience command **`inspector_inspect_ref`** `{ connectionId, source: History|Stream|Kv|Object, ref }` lives in the *command layer* (`ns-ipc`/bin), which fetches bytes via `ns-pubsub`/`ns-jetstream`/`ns-storage` then calls our `inspect`. Composition happens outside `ns-inspector` so the crate stays IO-free.

---

## 5. Events emitted

The inspector is mostly request/response. It emits only two **domain** events on the bus (`EventPublisher` port), bridged to Tauri by `ns-ipc` (we never `emit` directly):

| Domain event (`EventPayload` variant) | Tauri name | When | Backpressure |
|---|---|---|---|
| `SchemaRegistryChanged { op, schemaId, kind }` | `ns://inspector/schema` | save/delete/import schema (multi-window sync + TanStack invalidation) | dedupe consecutive identical |
| `TaskProgress { taskId, kind: Export, done, total, state }` | `ns://task/progress` | during `inspector_export` | keep-latest per `taskId` |

Everything else (per-request decode) returns inline — no event needed. `TaskProgress` reuses the shared spine variant; `SchemaRegistryChanged` is a **new `EventPayload` variant** we add to `ns-types` via PR (§12).

---

## 6. Frontend surface

### 6.1 Routes
- `/inspector` — **standalone Inspector workbench**: paste / drag-drop / import a payload or `.creds`-free file, choose codec/schema, inspect. Also the target of "Open in Inspector" from other views.
- The Inspector is *primarily* a **reusable panel** embedded as a dockview panel/drawer inside pubsub, jetstream, subject-explorer, and KV/object views. Same component, different data source.

### 6.2 Components (`apps/desktop/src/features/inspector/`)
- `MessageInspectorPanel` — top-level composition; hosts the tabs + side panels.
- `ViewerTabs` → `RawView` · `PrettyJsonView` (Monaco, read-only, folding) · `TreeView` (virtualized) · `HexView` (virtualized, paged via `inspector_hexdump`) · `BinaryPreview`.
- `DetectionBadges` — compression / format / charset chips with confidence + "decoded as X (override)" affordance → `CodecPicker`.
- `HeaderPanel` — NATS headers table (+ known-header decorators). `MetadataPanel` — subject, reply, size, JS seq/stream/consumer, timestamps.
- `SchemaValidationPanel` — bind schema (by subject auto-resolve or manual), show pass/fail + per-path `ValidationIssue` list; jump-to-path in TreeView.
- `SchemaManager` (under `/inspector/schemas`) — CRUD list, Monaco editor for JSON Schema / `.proto` / `.avsc`, subject-pattern binding.
- `SearchBar` + `SearchResults` — query builder (substring / regex / JSONPath / header predicate) over the current message list.
- `ExportDialog` — format picker + destination + progress bar (Channel).
- `CopyMenu` — copy raw / pretty / hex / base64 / cURL-ish reproduce.

### 6.3 Zustand store (`inspectorUiStore`) — UI/session only
`activeViewerTab`, `codecOverride`, `compressionOverride`, `charsetOverride`, `hexSettings {bytesPerLine, ascii}`, `treeExpandedPaths`, `searchDraft`, `wrapLines`, `pinnedMessageIds`, `boundSchemaId`, `panelSizes`. **Never** mirrors decoded server data.

### 6.4 TanStack Query keys (all server-state)
```
['inspector','codecs']
['inspector','validators']
['inspector','schemas', {kind, subject}]
['inspector','schema', schemaId]
['inspector','inspect', payloadHash, {codecOverride, schemaId}]   // decode result, cached by content hash
['inspector','hexdump', payloadHash, page]
['inspector','detect', payloadHash]
```
Mutations (`save_schema`/`delete_schema`/`import_schema`) invalidate `['inspector','schemas']` + the specific `['inspector','schema',id]`. Export/search are imperative (mutation/Channel), not cached long-term. `payloadHash` is a fast client-side hash so switching viewers on the same message is free.

### 6.5 IPC client calls
Only via generated wrappers: `ipc.inspector.detect/inspect/inspectAs/hexdump/convert/validate/search/export/listCodecs/listValidators/listSchemas/getSchema/saveSchema/deleteSchema/importSchema`. `useAppEvents()` routes `ns://inspector/schema` → invalidate schema queries; `ns://task/progress` (Export) → progress UI.

---

## 7. Data model (SQLite tables owned)

Physically in `ns-storage` (only crate with SQL); **logically owned by us** via migration `NNNN_inspector_schemas.sql` and the `SchemaRepo` port. Secrets never appear here.

```sql
CREATE TABLE inspector_schemas (
    id             TEXT PRIMARY KEY,          -- SchemaId (Uuid string)
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL,             -- 'jsonSchema' | 'protobuf' | 'avro'
    source_kind    TEXT NOT NULL,             -- 'inline' | 'file'
    content        TEXT,                      -- inline schema text (json/proto/avsc)  (nullable if file)
    file_path      TEXT,                      -- last-imported path (reference only)
    message_type   TEXT,                      -- protobuf fully-qualified message name (nullable)
    subject_pattern TEXT,                     -- glob binding, e.g. 'orders.>'  (nullable)
    connection_id  TEXT,                      -- optional scoping to a connection (nullable = global)
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,             -- RFC-3339
    updated_at     TEXT NOT NULL
);
CREATE INDEX idx_inspector_schemas_subject ON inspector_schemas(subject_pattern);
CREATE INDEX idx_inspector_schemas_kind    ON inspector_schemas(kind);

-- Per-subject decode preferences (remember "always show orders.> as protobuf/MyMsg")
CREATE TABLE inspector_decode_prefs (
    id              TEXT PRIMARY KEY,
    connection_id   TEXT,                     -- nullable = global
    subject_pattern TEXT NOT NULL,
    codec_id        TEXT,                     -- forced codec (nullable)
    compression_id  TEXT,                     -- forced compression (nullable)
    charset         TEXT,                     -- forced charset (nullable)
    schema_id       TEXT REFERENCES inspector_schemas(id) ON DELETE SET NULL,
    updated_at      TEXT NOT NULL
);

-- Saved inspector search filters
CREATE TABLE inspector_saved_filters (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    query_json  TEXT NOT NULL,                -- serialized SearchQuery DTO
    created_at  TEXT NOT NULL
);
```

Owned DTOs (in `ns-types`, typeshared, camelCase): `WireBytes{encoding,data}`, `DetectionReport`, `InspectionReport`, `DecodedView` (tagged `kind`/`data`), `HexModel`/`HexLine`, `TreeNode`, `BinaryPreview`, `MessageHeaders`, `MessageMetadata`, `SchemaDto`, `SchemaKind`, `ValidationReport`/`ValidationIssue`, `CodecInfo`, `ValidatorInfo`, `SearchQuery`/`SearchHit`, `ExportFormat`/`ExportProgress`/`ExportSummary`, plus the request/response pairs in §4. Enums use `#[serde(tag="kind",content="data")]`; timestamps are RFC-3339 strings; durations `*Ms`.

---

## 8. Dependencies

**We depend on** (per spine): `ns-types`, `ns-core` (ports, `Redacted<T>`, `CancellationToken`, `Settings`, `DomainError`).

**We are depended on by**: `ns-pubsub` and `ns-jetstream` (server-side `detect`/`inspect`), and the `nats-studio` bin (wires `DefaultInspectorService`).

**Cross-team asks (coordinated via PR + ADR note)**:
- `ns-core`: add `SchemaRepo` + `DecodePrefsRepo` port traits; add `SchemaId`/`CodecId`/`CompressionId` newtypes.
- `ns-storage`: implement those repos + the migration above (we author the SQL; they review).
- `ns-types`: add inspector DTOs, new `ErrorCode` variants (`SCHEMA_INVALID`, `SCHEMA_NOT_FOUND` if not folding into `NOT_FOUND`), new `EventPayload::SchemaRegistryChanged`.
- `ns-plugin`: at composition time, plugin-provided `dyn Codec`/`dyn SchemaValidator` are registered via `InspectorService::register_codec/validator`. `ns-inspector` **does not** depend on `ns-plugin` (would violate layering); the bin bridges the two.
- `ns-ipc`/bin: register `inspector_*` commands; host the `inspector_inspect_ref` composition command; bridge our two events.
- `ns-frontend`: dockview panel registration + `/inspector` route.

No new edges that create cycles; all IO enters through ports (DIP). Layer check (`cargo xtask check-layers`) stays green.

---

## 9. Concurrency, async & backpressure

- **`ns-inspector` is sync + CPU-bound.** The async boundary is *only* in `DefaultInspectorService`, which offloads every heavy op to `spawn_blocking` (bounded semaphore, default = `num_cpus`) so a 16 MiB protobuf decode or a regex search never blocks the tokio reactor or the WebView.
- **Hot-path discipline**: `ns-pubsub` subscriptions call the cheap `detect()` only (magic-byte sniff + tiny structural probe, O(few bytes)); full `inspect()` is on-demand. This is essential under high message rates — we never fully decode+allocate a tree for every message flying past the UI.
- **Decompression-bomb guards**: `decompress()` enforces both an absolute output cap (`max_decompressed_bytes`) and a ratio cap (`max_decompress_ratio`), streaming into a limited writer that aborts early with `DecompressionLimit`. Never trust `Content-Length`-style hints.
- **Large payloads**: `hexdump` is cursor-paged; the raw/binary views request byte windows, never the whole 100 MiB blob at once. `inspect` short-circuits to `PayloadTooLarge` above `max_payload_bytes`, offering hex/preview instead of structured decode.
- **Cancellation**: `search` and `export` take a `CancellationToken` from `ns-ipc`'s `CancellationRegistry` (keyed by `searchId`/`taskId`); the blocking loop polls it between chunks. Channel drop-detection also cancels (spine §8.3).
- **Export backpressure**: writes to disk via a bounded `mpsc` → `ExportProgress` coalesced keep-latest per `taskId`; producer never blocked by a slow UI.
- **Schema compile caching**: compiled JSON Schema / Avro / protobuf descriptors are LRU-cached (keyed by content hash) — compilation is the expensive part; validation is cheap and reused across many messages.
- **Untrusted schema resource limits**: protobuf/avro compilation runs under a size cap + timeout to bound the blast radius of a pathological user-supplied schema.

---

## 10. Test plan

**Unit (per module, `ns-testkit` builders + golden files)**
- Codec round-trips: `decode∘encode` identity for JSON/MsgPack/CBOR; decode of known fixtures → expected `DecodedValue`.
- Detection tables: parametric fixtures asserting `(bytes, headers) → DetectionReport{format,compression,charset,confidence}`; ambiguous cases (MsgPack vs. binary, CBOR vs. binary) assert *confidence*, not just class.
- Compression: gzip/zstd/snappy/deflate round-trip; **decompression-bomb** fixtures assert `DecompressionLimit` (ratio + absolute).
- Charset: BOM detection, valid/invalid UTF-8, UTF-16LE/BE, Latin-1 heuristic.
- Hexdump paging: offset/limit math, last partial line, `totalBytes`, `nextCursor` correctness; huge-size (mock) never allocates full buffer.
- Schema validation: valid/invalid docs per engine; `ValidationIssue.path` correctness; `SchemaCompileFailed` on malformed schema; protobuf schemaless best-effort wire-walk output.
- Search: substring/regex/JSONPath/header predicates; cancellation mid-scan yields partial + `Cancelled`.
- Error mapping: every `InspectorError` → expected `ErrorCode`; `user_message` contains no secrets (property test over redaction).

**Property / fuzz**
- `cargo-fuzz` target: `inspect(arbitrary bytes, arbitrary headers)` **never panics and never exceeds memory caps** — the single most important invariant (untrusted payloads).

**Integration (real `nats-server` via `ns-testkit`)**
- `ns-pubsub` publishes gzip'd JSON / raw protobuf / MsgPack → subscribe → `detect()` on hot path → `inspector_inspect` fully decodes → assert `InspectionReport`.
- `ns-jetstream` get/replay a stored message → inspect + validate against a repo-persisted schema.
- `SchemaRepo` against a real SQLite (migration applied): CRUD + `resolve_for_subject` longest-glob-wins.

**E2E (Tauri + WebView, driven by the testing-strategy harness)**
- Open a message → switch Raw/Pretty/Tree/Hex tabs; override codec; confirm re-decode.
- Bind a JSON Schema by subject → red/green validation + click-to-path.
- Search a 10k-message buffer → results + cancel.
- Export selection to NDJSON → progress bar completes → file diffed against golden.
- Drift check: `pnpm gen:types` clean (inspector DTOs), `cargo xtask check-layers` green.

---

## 11. Risks & open questions

**Risks**
- **Decompression / schema bombs** — mitigated by ratio+absolute caps and compile timeouts; needs a security review sign-off ([security-model]).
- **Protobuf without a schema** — only a best-effort field-number/wire-type dump is possible; UX must communicate "schemaless — bind a `.proto` for field names."
- **Avro requires the writer schema** — single Avro object (no container header) is undecodable without a bound schema; we surface a clear prompt rather than a raw error.
- **In-process plugin codecs are trusted** (Phase-1 plugin model) — a malicious codec can panic/hang; we run decode in `spawn_blocking` with catch + timeout, but true isolation waits on the WASM phase (ADR-0014).
- **Format-detection false positives** (e.g. valid-UTF-8 MsgPack) — surface confidence + one-click override; persist the override via `inspector_decode_prefs`.
- **Very large payloads** freezing the UI — mitigated by paging + `PayloadTooLarge` short-circuit, but the "how big is too big" default needs field tuning.

**Open questions**
1. Should schemas be scoped per-connection, per-workspace, or global by default? (Table supports optional `connection_id`; default policy TBD with [connection-manager].)
2. Do we own a **Confluent/Apicurio Schema Registry** client (subject→schema by ID embedded in a 5-byte magic prefix), or is that a plugin? Leaning plugin, but the magic-prefix detection belongs in our detect pipeline.
3. Search over the **history table** — do we push predicates into SQL (`ns-storage`) for large corpora, or always load into memory? Proposal: small corpora in-memory here; large/historical search delegated to a `MessageHistoryRepo` query owned by [storage].
4. Streaming-search Channel vs. paged request as the default — decide after perf measurement.
5. New `ErrorCode`s (`SCHEMA_INVALID`, etc.) vs. reusing `INVALID_ARGUMENT`/`NOT_FOUND` — needs an ErrorCode-owners PR decision.

---

## 12. Contract changes this subsystem requests (tracked for ADR/PR)
- `ns-types`: inspector DTOs; `EventPayload::SchemaRegistryChanged`; `ErrorCode::{SchemaInvalid, DecompressionLimit?}` (or fold into existing) — bump `appSchemaVersion`.
- `ns-core`: `SchemaRepo`, `DecodePrefsRepo` ports; `SchemaId`/`CodecId`/`CompressionId` newtypes; inspector defaults on `Settings`.
- `ns-storage`: migration `NNNN_inspector_schemas.sql` + repo impls.
- `ns-plugin`/bin: codec/validator registration bridge.
```
