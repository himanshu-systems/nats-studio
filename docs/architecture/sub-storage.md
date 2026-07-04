# Subsystem Design: Storage

Owner: Storage Team
Crates owned: `ns-storage` (L1 lib) — the ONLY crate in the workspace permitted to `use rusqlite` / emit SQL.
Subsystem key: `[storage]`
Status: Draft v1 — implementable
Related SoT: `docs/architecture/00-conventions-and-workspace.md`, `docs/architecture/sub-core-runtime.md` (ports), ADR-0003 (rusqlite), ADR-0013 (secrets).

---

## 1. Responsibilities & Boundaries

`ns-storage` is the single authority for **all local durable state** in NATS Studio. It owns the SQLite database file, the migration framework, the async access layer (storage worker), every **repository port implementation**, and the **backup / export / import** of the workspace database. It is the ground truth for everything the app must remember across restarts.

### 1.1 In scope (this team owns)

- **The database engine.** `rusqlite` (bundled SQLite, no system dependency, ADR-0003), the connection topology (one writer + N read-only readers over WAL), PRAGMA policy, and the file location resolved via the Tauri path API.
- **Migrations.** Forward-only, ordered SQL under `crates/ns-storage/migrations/NNNN_*.sql`, applied at startup, tracked in `PRAGMA user_version`. The migration runner, verification, and schema-version reporting.
- **Async access.** A dedicated storage worker so `async`-everywhere holds without a build-time `DATABASE_URL`. No SQL ever runs on the UI thread or the Tauri command thread directly.
- **Repository implementations** for every persisted aggregate: settings, connection profiles (schema hosted here; DTO shape owned by Connection Manager), workspaces, tabs/dock layout, publish/message history, saved requests, publish templates, bookmarks/favorites, recent connections, response cache, plugin state, and the encrypted-secret backing blob.
- **Backup / export / import.** Consistent hot backup (SQLite Online Backup + `VACUUM INTO`), portable workspace bundle export/import (`.nsbundle` = zip), schema-versioned with merge/replace strategies and id remapping.
- **Data hygiene.** Retention enforcement (size + TTL) for history and response cache, periodic `PRAGMA optimize`/incremental vacuum, integrity checks, and DB stats reporting.
- **Encryption-at-rest wiring.** Storage never holds crypto keys, but hosts the ciphertext table that `ns-security`'s encrypted-fallback `SecretStore` persists through (see §7). Secrets in plaintext are **never** written to SQLite.

### 1.2 Explicitly out of scope (delegated to / consumed from others)

- **Crypto & key management** → `ns-security` (`SecretStore`, keychain, XChaCha20/age fallback cipher). We persist only opaque ciphertext blobs and `SecretRef` strings; we never encrypt/decrypt.
- **DTO *shape* of domain aggregates** → the owning feature team. Connection Manager owns `ConnectionProfileDto` + `AuthConfigDto`; Pub/Sub owns the `MessageRecordDto` fields; we own the table, indices, retention, and repo impl.
- **Settings *defaults* + `Settings` DTO** → `ns-core` (defaults) / `ns-types` (DTO). We persist and version-migrate them; the `settings_get/update` commands are owned by Core Runtime.
- **Connection profile *commands*** (`connection_*` CRUD) → Connection Manager. They call our `ConnectionProfileRepo` port.
- **Event bus / Tauri glue** → `ns-event` / `ns-ipc`. We emit domain events via the `EventPublisher` port only; we never `use tauri`.
- **Path resolution primitives** → the bin passes us a resolved `data_dir: PathBuf` (from the Tauri path API); we never hardcode paths or import `tauri`.

### 1.3 Boundary rules (critical)

1. `ns-storage` is the **only** crate that may `use rusqlite` or contain SQL strings (CI-enforced via `cargo xtask check-layers` + `deny.toml` bans).
2. Every repository is exposed to the rest of the app **only** through a **port trait defined in `ns-core`**. Feature services depend on `ns-core` traits, never on `ns-storage` concrete types. The bin (composition root) is the only place that constructs `SqliteStorage` and injects the `Arc<dyn XxxRepo>` handles.
3. No secret plaintext is ever stored, logged, or exported unencrypted (§7, §9).

---

## 2. Crate layout

```
crates/ns-storage/
├─ Cargo.toml                # rusqlite{bundled, backup, functions, blob}, zip, serde, thiserror, tokio, tracing, async-trait
├─ migrations/
│  ├─ 0001_init.sql          # schema_meta, settings, response_cache scaffolding
│  ├─ 0002_connection_profiles.sql
│  ├─ 0003_workspaces_tabs_layout.sql
│  ├─ 0004_history.sql       # publish/message history
│  ├─ 0005_saved_requests_templates.sql
│  ├─ 0006_bookmarks_recents.sql
│  ├─ 0007_secret_blobs.sql
│  └─ 0008_plugin_state.sql
└─ src/
   ├─ lib.rs                 # pub API: SqliteStorage, StorageConfig, StorageError, repo re-exports
   ├─ engine/
   │  ├─ config.rs           # StorageConfig, PRAGMAs
   │  ├─ worker.rs           # StorageWorker: single writer task + read pool
   │  ├─ handle.rs           # WriteHandle, ReadPool, job submission
   │  └─ pragmas.rs
   ├─ migrate/
   │  ├─ runner.rs           # Migrator (embedded via include_str!/rust-embed), user_version bump
   │  └─ verify.rs           # integrity_check, schema fingerprint
   ├─ repos/
   │  ├─ mod.rs
   │  ├─ settings.rs         # SqliteSettingsRepo
   │  ├─ profiles.rs         # SqliteConnectionProfileRepo
   │  ├─ workspaces.rs       # SqliteWorkspaceRepo
   │  ├─ layout.rs           # SqliteLayoutRepo (tabs + dock layout)
   │  ├─ history.rs          # SqliteMessageHistoryRepo
   │  ├─ saved.rs            # SqliteSavedRequestRepo, SqlitePublishTemplateRepo
   │  ├─ bookmarks.rs        # SqliteBookmarkRepo, SqliteRecentRepo
   │  ├─ cache.rs            # SqliteResponseCacheRepo
   │  ├─ secrets.rs          # SqliteSecretBlobRepo (ciphertext only)
   │  └─ plugin_state.rs     # SqlitePluginStateRepo
   ├─ backup/
   │  ├─ mod.rs              # BackupService: hot backup, restore, vacuum-into
   │  ├─ bundle.rs           # WorkspaceBundle export/import (.nsbundle zip)
   │  └─ merge.rs            # merge/replace strategies, id remap
   ├─ retention.rs           # RetentionEnforcer (size/TTL sweeps)
   ├─ mapping.rs             # row<->DTO mapping helpers, serde_json column codecs
   └─ error.rs              # StorageError (thiserror) + RepoError conversion
```

---

## 3. Async / concurrency model (the storage worker)

`rusqlite::Connection` is synchronous and `!Sync`. We honor "async everywhere, never block the UI" with a **worker actor** (ADR-0003):

- **One writer.** A single dedicated task owns the sole read-write `Connection` (WAL mode). All mutations are serialized through it. This eliminates `SQLITE_BUSY` write contention entirely — there is exactly one writer by construction.
- **A read pool.** A bounded pool of `SQLITE_OPEN_READ_ONLY` connections (default `min(4, num_cpus)`), each guarded so reads run concurrently with the writer (WAL permits concurrent readers) on `tokio::task::spawn_blocking`.
- **Job submission.** Repos never touch SQL directly; they submit a boxed closure to the worker and await a `oneshot` reply.

```rust
// engine/handle.rs
type WriteJob = Box<dyn FnOnce(&mut rusqlite::Connection) -> Result<(), StorageError> + Send>;
type ReadJob<R> = Box<dyn FnOnce(&rusqlite::Connection) -> Result<R, StorageError> + Send>;

#[derive(Clone)]
pub struct Db {
    writer: mpsc::Sender<WriteEnvelope>,   // bounded (default 256) → natural backpressure
    readers: ReadPool,                     // Semaphore + Vec<Mutex<Connection>>
    metrics: Arc<DbMetrics>,               // queue depth, busy count, slow-query counter
}

impl Db {
    /// Serialized write; returns after the txn commits (or rolls back on Err).
    pub async fn write<R, F>(&self, f: F) -> Result<R, StorageError>
    where F: FnOnce(&rusqlite::Transaction) -> Result<R, StorageError> + Send + 'static, R: Send + 'static;

    /// Concurrent read on a pooled RO connection via spawn_blocking.
    pub async fn read<R, F>(&self, f: F) -> Result<R, StorageError>
    where F: FnOnce(&rusqlite::Connection) -> Result<R, StorageError> + Send + 'static, R: Send + 'static;

    /// Exclusive access for backup/restore/migration (drains + pauses the writer).
    pub async fn with_exclusive<R, F>(&self, f: F) -> Result<R, StorageError>
    where F: FnOnce(&mut rusqlite::Connection) -> Result<R, StorageError> + Send + 'static, R: Send + 'static;
}
```

- **Every write is wrapped in a transaction** by the worker (the closure receives a `&Transaction`); returning `Err` rolls back, `Ok` commits. Repos are therefore trivially atomic and never leak half-writes.
- **Cancellation.** Long operations (backup, import, retention sweep, big history query) accept a `CancellationToken` (ns-core) and check it between batches; they run on `TaskRegistry` tasks and report `TaskProgress`.

### 3.1 Backpressure

| Path | Policy |
|---|---|
| Writes | Bounded mpsc (256). A full queue makes callers `await` (natural backpressure). A `busy_timeout=5000` guards the rare exclusive contention; on exceed → `StorageError::Busy` → `ErrorCode::STORAGE` (`retriable=true`). |
| Reads | Semaphore-limited (pool size). Excess reads queue on permits, never spawn unbounded blocking threads. |
| History ingestion (hot path) | Pub/Sub records via `MessageHistoryRepo::append_batch`; writer coalesces bursts into one txn per drain tick (≤ 50ms) so a high-rate subscription doesn't thrash the DB. Overflow beyond a bounded in-worker buffer is dropped-oldest with a counted `droppedSinceLast` (history is best-effort, not a message store). |
| Retention/vacuum | Runs on a low-priority cadence; uses incremental vacuum + `LIMIT`-batched deletes so it never holds a long write lock. |

### 3.2 PRAGMAs (applied to every connection at open)

```
journal_mode = WAL          foreign_keys = ON         busy_timeout = 5000
synchronous  = NORMAL       temp_store   = MEMORY     cache_size  = -16000  (16 MiB)
wal_autocheckpoint = 1000   mmap_size    = 268435456  (readers)  auto_vacuum = INCREMENTAL
```

---

## 4. Rust public interface

### 4.1 Engine / composition-root surface (`ns-storage` public API)

```rust
// lib.rs
pub struct StorageConfig {
    pub data_dir: PathBuf,          // resolved by the bin via Tauri path API; db => {data_dir}/nats-studio/studio.db
    pub read_pool_size: usize,      // default min(4, num_cpus)
    pub busy_timeout: Duration,     // default 5s
    pub write_queue_capacity: usize,// default 256
    pub history_ingest_buffer: usize,// default 4096
}

/// The engine. Constructed ONCE in the bin. Opens the DB, runs migrations,
/// starts the worker, and hands out cheap Arc-cloneable repo handles.
pub struct SqliteStorage { /* Db, JoinHandles, Arc<dyn Clock>, EventPublisher */ }

impl SqliteStorage {
    pub async fn open(
        config: StorageConfig,
        clock: Arc<dyn ns_core::Clock>,
        events: Arc<dyn ns_core::EventPublisher>,
    ) -> Result<Self, StorageError>;

    // Port handles (each is a thin Arc over `Db`; clone is cheap).
    pub fn settings(&self)     -> Arc<dyn ns_core::SettingsRepo>;
    pub fn profiles(&self)     -> Arc<dyn ns_core::ConnectionProfileRepo>;
    pub fn workspaces(&self)   -> Arc<dyn ns_core::WorkspaceRepo>;
    pub fn layout(&self)       -> Arc<dyn ns_core::LayoutRepo>;
    pub fn history(&self)      -> Arc<dyn ns_core::MessageHistoryRepo>;
    pub fn saved_requests(&self)-> Arc<dyn ns_core::SavedRequestRepo>;
    pub fn templates(&self)    -> Arc<dyn ns_core::PublishTemplateRepo>;
    pub fn bookmarks(&self)    -> Arc<dyn ns_core::BookmarkRepo>;
    pub fn recents(&self)      -> Arc<dyn ns_core::RecentConnectionRepo>;
    pub fn response_cache(&self)-> Arc<dyn ns_core::ResponseCacheRepo>;
    pub fn secret_blobs(&self) -> Arc<dyn ns_core::SecretBlobRepo>;
    pub fn plugin_state(&self) -> Arc<dyn ns_core::PluginStateRepo>;

    // Cross-cutting services (used by the bin's storage_* commands).
    pub fn backup(&self)  -> Arc<BackupService>;
    pub fn maintenance(&self) -> Arc<MaintenanceService>;

    pub fn schema_version(&self) -> u32;                 // PRAGMA user_version
    pub async fn stats(&self) -> Result<DbStats, StorageError>;
    pub async fn shutdown(self, grace: Duration) -> Result<(), StorageError>; // checkpoint + close
}
```

### 4.2 Repository ports (declared in `ns-core`, implemented here)

`ns-core` gains the following ports next to the existing `SettingsRepo`. All are `#[async_trait]`, `Send + Sync + 'static`, return `Result<_, RepoError>`. DTOs live in `ns-types`.

```rust
// ns-core (ports) — signatures; DTOs are ns-types
#[async_trait] pub trait ConnectionProfileRepo: Send + Sync + 'static {
    async fn list(&self) -> Result<Vec<ConnectionProfileDto>, RepoError>;
    async fn get(&self, id: ProfileId) -> Result<Option<ConnectionProfileDto>, RepoError>;
    async fn upsert(&self, p: &ConnectionProfileDto) -> Result<(), RepoError>;
    async fn delete(&self, id: ProfileId) -> Result<(), RepoError>;
    async fn touch_used(&self, id: ProfileId, at: OffsetDateTime) -> Result<(), RepoError>; // feeds recents
}

#[async_trait] pub trait WorkspaceRepo: Send + Sync + 'static {
    async fn list(&self) -> Result<Vec<WorkspaceDto>, RepoError>;
    async fn get(&self, id: WorkspaceId) -> Result<Option<WorkspaceDto>, RepoError>;
    async fn upsert(&self, w: &WorkspaceDto) -> Result<(), RepoError>;
    async fn delete(&self, id: WorkspaceId) -> Result<(), RepoError>;
    async fn set_active(&self, id: WorkspaceId) -> Result<(), RepoError>; // single active flag, txn-atomic
    async fn active(&self) -> Result<Option<WorkspaceId>, RepoError>;
}

#[async_trait] pub trait LayoutRepo: Send + Sync + 'static {
    /// Opaque dockview layout JSON + the tab set for a workspace (one row per workspace).
    async fn load(&self, ws: WorkspaceId) -> Result<Option<WorkspaceLayoutDto>, RepoError>;
    async fn save(&self, ws: WorkspaceId, layout: &WorkspaceLayoutDto) -> Result<(), RepoError>; // debounced writer
    async fn clear(&self, ws: WorkspaceId) -> Result<(), RepoError>;
}

#[async_trait] pub trait MessageHistoryRepo: Send + Sync + 'static {
    async fn append_batch(&self, rows: Vec<MessageRecordDto>) -> Result<u64, RepoError>; // hot path, coalesced
    async fn query(&self, req: HistoryQuery) -> Result<HistoryPage, RepoError>;          // cursor pagination
    async fn get(&self, id: MessageRecordId) -> Result<Option<MessageRecordDto>, RepoError>;
    async fn delete(&self, ids: Vec<MessageRecordId>) -> Result<u64, RepoError>;
    async fn clear(&self, filter: HistoryClearFilter) -> Result<u64, RepoError>;
    async fn enforce_retention(&self, policy: RetentionPolicy) -> Result<u64, RepoError>;
}

#[async_trait] pub trait SavedRequestRepo: Send + Sync + 'static {
    async fn list(&self, folder: Option<String>) -> Result<Vec<SavedRequestDto>, RepoError>;
    async fn get(&self, id: SavedRequestId) -> Result<Option<SavedRequestDto>, RepoError>;
    async fn upsert(&self, r: &SavedRequestDto) -> Result<(), RepoError>;
    async fn delete(&self, id: SavedRequestId) -> Result<(), RepoError>;
}
// PublishTemplateRepo mirrors SavedRequestRepo (PublishTemplateDto).

#[async_trait] pub trait BookmarkRepo: Send + Sync + 'static {
    async fn list(&self, kind: Option<BookmarkKind>) -> Result<Vec<BookmarkDto>, RepoError>;
    async fn toggle(&self, b: &BookmarkDto) -> Result<bool, RepoError>; // returns new pinned state
    async fn delete(&self, id: BookmarkId) -> Result<(), RepoError>;
    async fn reorder(&self, ids_in_order: Vec<BookmarkId>) -> Result<(), RepoError>;
}

#[async_trait] pub trait RecentConnectionRepo: Send + Sync + 'static {
    async fn list(&self, limit: u32) -> Result<Vec<RecentConnectionDto>, RepoError>;
    async fn record(&self, profile_id: ProfileId, at: OffsetDateTime) -> Result<(), RepoError>;
    async fn pin(&self, profile_id: ProfileId, pinned: bool) -> Result<(), RepoError>;
    async fn clear(&self) -> Result<(), RepoError>;
}

#[async_trait] pub trait ResponseCacheRepo: Send + Sync + 'static {
    async fn get(&self, key: &str) -> Result<Option<CacheEntryDto>, RepoError>;   // honors expiry
    async fn put(&self, entry: &CacheEntryDto) -> Result<(), RepoError>;          // key, value(json/base64), ttl
    async fn invalidate(&self, key_prefix: &str) -> Result<u64, RepoError>;
    async fn sweep_expired(&self, now: OffsetDateTime) -> Result<u64, RepoError>;
}

#[async_trait] pub trait SecretBlobRepo: Send + Sync + 'static {  // ns-security is the ONLY caller
    async fn get(&self, ref_key: &str) -> Result<Option<SecretBlob>, RepoError>;  // opaque ciphertext + nonce + alg
    async fn put(&self, ref_key: &str, blob: &SecretBlob) -> Result<(), RepoError>;
    async fn delete(&self, ref_key: &str) -> Result<(), RepoError>;
}

#[async_trait] pub trait PluginStateRepo: Send + Sync + 'static {
    async fn get(&self, plugin_id: &str, key: &str) -> Result<Option<String>, RepoError>;
    async fn put(&self, plugin_id: &str, key: &str, value: &str) -> Result<(), RepoError>; // quota-enforced
    async fn list_keys(&self, plugin_id: &str) -> Result<Vec<String>, RepoError>;
    async fn purge_plugin(&self, plugin_id: &str) -> Result<(), RepoError>;
}
```

### 4.3 Backup / maintenance services

```rust
pub struct BackupService { /* Db, clock, events, security handle for bundle encryption */ }
impl BackupService {
    /// Consistent hot copy of the live DB via SQLite Online Backup API (no downtime).
    pub async fn backup_to(&self, dest: PathBuf, ct: CancellationToken) -> Result<BackupReport, StorageError>;
    /// Restore replaces the live DB: validates, checkpoints, swaps file, re-opens. Refuses on schema mismatch beyond migratable range.
    pub async fn restore_from(&self, src: PathBuf, ct: CancellationToken) -> Result<RestoreReport, StorageError>;
    /// Portable, human-diffable bundle (.nsbundle zip: manifest.json + per-entity JSON).
    pub async fn export_bundle(&self, req: ExportRequest, ct: CancellationToken) -> Result<PathBuf, StorageError>;
    pub async fn import_bundle(&self, req: ImportRequest, ct: CancellationToken) -> Result<ImportReport, StorageError>;
}

pub struct MaintenanceService { /* Db, clock */ }
impl MaintenanceService {
    pub async fn vacuum(&self) -> Result<(), StorageError>;                 // VACUUM (exclusive)
    pub async fn incremental_vacuum(&self, pages: u32) -> Result<(), StorageError>;
    pub async fn integrity_check(&self) -> Result<IntegrityReport, StorageError>; // PRAGMA integrity_check
    pub async fn optimize(&self) -> Result<(), StorageError>;              // PRAGMA optimize
    pub async fn stats(&self) -> Result<DbStats, StorageError>;            // size, per-table row counts, wal size
}
```

### 4.4 Error type

```rust
// error.rs — the crate's single public error enum (SoT error model)
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("not found")]                 NotFound,
    #[error("constraint conflict: {0}")]  Conflict(String),
    #[error("database busy")]             Busy,
    #[error("migration failed: {0}")]     Migration(String),
    #[error("integrity check failed: {0}")] Integrity(String),
    #[error("bundle schema unsupported: got {got}, supported {supported}")] BundleSchema { got: u32, supported: String },
    #[error(transparent)]                 Sql(#[from] rusqlite::Error),
    #[error(transparent)]                 Io(#[from] std::io::Error),
    #[error(transparent)]                 Serde(#[from] serde_json::Error),
    #[error("worker stopped")]            WorkerGone,
}

impl ns_core::DomainError for StorageError {
    fn code(&self) -> ErrorCode { match self {
        NotFound => ErrorCode::NOT_FOUND, Busy => ErrorCode::STORAGE,
        Migration(_) => ErrorCode::MIGRATION_FAILED, Serde(_) => ErrorCode::SERIALIZATION,
        Io(_) => ErrorCode::IO, _ => ErrorCode::STORAGE } }
    fn retriable(&self) -> bool { matches!(self, StorageError::Busy | StorageError::WorkerGone) }
    fn user_message(&self) -> String { /* secret-safe, never echoes row data */ }
}
```

`RepoError` (in `ns-core`) is the small, port-level error the ports return so domain services can handle failures without depending on `ns-storage`. `StorageError` converts into it at the port boundary (`From<StorageError> for RepoError`), preserving `code`/`retriable`. `ns-storage` returns `StorageError` from its *non-port* engine API (`open`, `backup`, `migrate`).

---

## 5. IPC commands (exposed by the bin, backed by `ns-storage`)

All are `#[tauri::command]`, take one `req` arg, return `Result<_, IpcError>`. Naming: `workspace_*`, `layout_*`, `history_*`, `savedrequest_*`, `template_*`, `bookmark_*`, `recent_*`, `storage_*`. (`settings_*` is owned by Core Runtime; `connection_*` CRUD by Connection Manager — both backed by our repos.)

| Command | Kind | Params (`req`) | Returns | Errors |
|---|---|---|---|---|
| `workspace_list` | request | `{}` | `Vec<WorkspaceDto>` | STORAGE |
| `workspace_get` | request | `{ id }` | `WorkspaceDto` | NOT_FOUND, STORAGE |
| `workspace_create` | command | `{ name, color? }` | `WorkspaceDto` | STORAGE |
| `workspace_update` | command | `{ id, patch }` | `WorkspaceDto` | NOT_FOUND, STORAGE |
| `workspace_delete` | command | `{ id }` | `{}` | STORAGE |
| `workspace_duplicate` | command | `{ id, name }` | `WorkspaceDto` | NOT_FOUND, STORAGE |
| `workspace_set_active` | command | `{ id }` | `{}` | NOT_FOUND, STORAGE |
| `layout_get` | request | `{ workspaceId }` | `WorkspaceLayoutDto?` | STORAGE |
| `layout_save` | command | `{ workspaceId, layout }` | `{}` | STORAGE |
| `layout_reset` | command | `{ workspaceId }` | `{}` | STORAGE |
| `history_query` | request | `HistoryQuery{ connectionId?, subjectGlob?, direction?, cursor?, limit }` | `HistoryPage{ items, nextCursor?, total? }` | STORAGE, INVALID_ARGUMENT |
| `history_get` | request | `{ id }` | `MessageRecordDto` | NOT_FOUND |
| `history_delete` | command | `{ ids }` | `{ deleted }` | STORAGE |
| `history_clear` | command | `HistoryClearFilter{ connectionId?, beforeTs? }` | `{ deleted }` | STORAGE |
| `savedrequest_list` | request | `{ folder? }` | `Vec<SavedRequestDto>` | STORAGE |
| `savedrequest_upsert` | command | `{ request }` | `SavedRequestDto` | STORAGE |
| `savedrequest_delete` | command | `{ id }` | `{}` | STORAGE |
| `template_list` | request | `{ folder? }` | `Vec<PublishTemplateDto>` | STORAGE |
| `template_upsert` | command | `{ template }` | `PublishTemplateDto` | STORAGE |
| `template_delete` | command | `{ id }` | `{}` | STORAGE |
| `bookmark_list` | request | `{ kind? }` | `Vec<BookmarkDto>` | STORAGE |
| `bookmark_toggle` | command | `{ bookmark }` | `{ pinned }` | STORAGE |
| `bookmark_reorder` | command | `{ idsInOrder }` | `{}` | STORAGE |
| `recent_list` | request | `{ limit }` | `Vec<RecentConnectionDto>` | STORAGE |
| `recent_pin` | command | `{ profileId, pinned }` | `{}` | STORAGE |
| `recent_clear` | command | `{}` | `{}` | STORAGE |
| `storage_stats` | request | `{}` | `DbStats` | STORAGE |
| `storage_backup` | command | `{ dest }` | `BackupReport` (progress via `ns://task/progress`) | IO, STORAGE, CANCELLED |
| `storage_restore` | command | `{ src }` | `RestoreReport` | IO, MIGRATION_FAILED, STORAGE |
| `storage_export_bundle` | command | `ExportRequest{ dest, include: [profiles?, secrets(passphrase)?, workspaces, templates, savedRequests, bookmarks, settings, history?] }` | `{ path }` | IO, STORAGE, CANCELLED |
| `storage_import_bundle` | command | `ImportRequest{ src, strategy: Merge\|Replace, passphrase? }` | `ImportReport{ counts, conflicts, remapped }` | IO, STORAGE, INVALID_ARGUMENT |
| `storage_vacuum` | command | `{}` | `{}` | STORAGE |
| `storage_integrity_check` | command | `{}` | `IntegrityReport` | STORAGE |

Backup/restore/import/export run on `TaskRegistry` tasks with a `CancellationToken`; they stream progress through the shared `ns://task/progress` event (reusing `TaskProgress`) and return the final report as the command result. `history_query` uses cursor pagination (opaque cursor = base64 of `(ts, id)`).

Response cache and secret blobs have **no public IPC** — they are internal ports consumed by feature services and `ns-security` respectively.

---

## 6. Events emitted

Storage does not own a dedicated Tauri event namespace; it emits through the `EventPublisher` port and reuses the frozen `EventPayload` variants:

| Bus payload | Tauri event | When | Policy |
|---|---|---|---|
| `TaskProgress` | `ns://task/progress` | backup/restore/export/import/vacuum progress | keep-latest per task id |
| `Notification` | `ns://notification` | backup completed/failed, restore requires restart, retention purge summary, integrity failure | never drop |

**Multi-window cache coherence (open question → ADR proposed).** When one window mutates shared data (e.g. saves a template), other windows' TanStack caches should invalidate. v1 handles this locally (the mutating window invalidates its own keys). For true multi-window sync we propose adding an `EventPayload::DataChanged { entity: DataEntity, id: Option<String> }` variant (bridged as `ns://storage/changed`) behind a small ADR; until then, cross-window staleness is bounded by TanStack `staleTime` + refetch-on-focus. This is the only storage change that would touch the frozen `ns-types` event enum, hence gated on an ADR.

---

## 7. Encryption-at-rest & secret handling (integration with `[security-model]`)

Per ADR-0013, secrets (creds/seeds/passwords/tokens/JWTs) are **never** in SQLite plaintext.

- **Primary path (keychain present):** `ns-security`'s `SecretStore` writes to the OS keychain (keyring). SQLite stores only a `SecretRef` string inside a profile row. Storage sees an opaque token, nothing more.
- **Fallback path (headless Linux / no keychain):** `ns-security` encrypts with XChaCha20-Poly1305 / age keyed by an OS-protected key, then persists the **ciphertext** through our `SecretBlobRepo` (`secret_blob` table). Storage stores `(ref_key, alg, nonce, ciphertext, created_at)` — all opaque. **Storage holds no keys and performs no crypto.** The security team owns the cipher; we own the durable bytes.
- **Redaction defense-in-depth:** no repo ever logs row *values*; `#[instrument]` fields carry ids/counts only. Secret-bearing DTO fields are `SecretRef`, never the secret. A log-path scrubber (ns-core) is the backstop.
- **Export safety:** `storage_export_bundle` **excludes secrets by default**. Including them requires an explicit `secrets(passphrase)` opt-in, where `ns-security` re-encrypts each secret under a user passphrase (age/XChaCha20) into the bundle. Import reverses this. The bundle never contains keychain-plaintext.

---

## 8. Data model (SQLite tables owned)

All timestamps are RFC-3339 TEXT (UTC); durations are `*_ms INTEGER`; ids are UUID TEXT; structured sub-objects are JSON TEXT (validated on read via serde). `strict` tables where supported.

```sql
-- 0001_init.sql -------------------------------------------------------------
CREATE TABLE schema_meta (               -- belt-and-suspenders alongside PRAGMA user_version
  key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE settings (                   -- single row (id=0); SettingsRepo
  id INTEGER PRIMARY KEY CHECK (id = 0),
  schema_version INTEGER NOT NULL,
  json TEXT NOT NULL);                     -- whole Settings DTO as JSON (versioned)

CREATE TABLE response_cache (             -- ResponseCacheRepo (varz/jsz snapshots, expensive derived reads)
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'json',  -- json | base64
  created_at TEXT NOT NULL,
  expires_at TEXT);                        -- NULL = no expiry
CREATE INDEX idx_cache_expiry ON response_cache(expires_at);

-- 0002_connection_profiles.sql (shape co-owned w/ Connection Manager) -------
CREATE TABLE connection_profile (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, folder TEXT,
  servers TEXT NOT NULL,                   -- JSON array
  auth_json TEXT NOT NULL,                 -- AuthConfigDto JSON (SecretRefs only, no secrets)
  tls_json TEXT, transport_json TEXT, options_json TEXT, reconnect_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT);
CREATE INDEX idx_profile_folder ON connection_profile(folder);

-- 0003_workspaces_tabs_layout.sql ------------------------------------------
CREATE TABLE workspace (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,    -- exactly one row =1 (enforced in txn)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX idx_ws_active ON workspace(is_active) WHERE is_active = 1;

CREATE TABLE workspace_layout (            -- one row per workspace; opaque dockview state
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  dock_json TEXT NOT NULL,                 -- serialized dockview layout
  updated_at TEXT NOT NULL);

CREATE TABLE workspace_tab (               -- normalized tab set (queryable / restorable)
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- pubsub|jetstream|monitor|subject|terminal|inspector|dashboard
  title TEXT NOT NULL,
  connection_id TEXT,                      -- runtime id may be null when persisted
  profile_id TEXT,                         -- stable reference for restore
  state_json TEXT,                         -- per-tab view state (filters, selection)
  ord INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_tab_ws ON workspace_tab(workspace_id, ord);

-- 0004_history.sql ----------------------------------------------------------
CREATE TABLE message_history (
  id TEXT PRIMARY KEY,
  connection_id TEXT, profile_id TEXT,
  direction TEXT NOT NULL,                 -- publish | received | request | reply
  subject TEXT NOT NULL, reply_to TEXT,
  headers_json TEXT,
  payload BLOB, payload_encoding TEXT NOT NULL DEFAULT 'binary',
  size_bytes INTEGER NOT NULL,
  ts TEXT NOT NULL);                        -- event time
CREATE INDEX idx_hist_conn_ts ON message_history(connection_id, ts DESC);
CREATE INDEX idx_hist_subject  ON message_history(subject);
-- optional FTS5 virtual table over subject+headers for search (feature-gated)

-- 0005_saved_requests_templates.sql ----------------------------------------
CREATE TABLE saved_request (               -- saved pub/req-reply "requests" (Postman-like)
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT,
  kind TEXT NOT NULL,                      -- publish | request
  subject TEXT NOT NULL, headers_json TEXT,
  payload TEXT, payload_encoding TEXT NOT NULL DEFAULT 'text',
  options_json TEXT,                       -- timeout, replyExpected, etc.
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_saved_folder ON saved_request(folder);

CREATE TABLE publish_template (            -- reusable payload templates w/ variables
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT,
  subject_pattern TEXT, body TEXT NOT NULL, body_encoding TEXT NOT NULL DEFAULT 'text',
  variables_json TEXT,                     -- [{name,default}]
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

-- 0006_bookmarks_recents.sql -----------------------------------------------
CREATE TABLE bookmark (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, -- subject | stream | consumer | kvBucket | objectStore | request
  connection_id TEXT, profile_id TEXT,
  target TEXT NOT NULL,                     -- subject/stream name/etc.
  label TEXT, ord INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);
CREATE INDEX idx_bookmark_kind ON bookmark(kind, ord);

CREATE TABLE recent_connection (
  profile_id TEXT PRIMARY KEY REFERENCES connection_profile(id) ON DELETE CASCADE,
  last_used_at TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_recent_used ON recent_connection(pinned DESC, last_used_at DESC);

-- 0007_secret_blobs.sql (ciphertext ONLY; keychain-fallback backing store) --
CREATE TABLE secret_blob (
  ref_key TEXT PRIMARY KEY,
  alg TEXT NOT NULL,                       -- e.g. xchacha20poly1305 | age
  nonce BLOB, ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL);

-- 0008_plugin_state.sql -----------------------------------------------------
CREATE TABLE plugin_state (
  plugin_id TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key));
```

### DTOs owned/hosted (in `ns-types`, camelCase, typeshared)

`WorkspaceDto`, `WorkspaceLayoutDto`, `WorkspaceTabDto`, `MessageRecordDto`, `HistoryQuery`, `HistoryPage`, `HistoryClearFilter`, `SavedRequestDto`, `PublishTemplateDto`, `BookmarkDto`, `BookmarkKind`, `RecentConnectionDto`, `CacheEntryDto`, `SecretBlob`, `DbStats`, `BackupReport`, `RestoreReport`, `ExportRequest`, `ImportRequest`, `ImportReport`, `IntegrityReport`, `RetentionPolicy`, plus id newtypes `WorkspaceId`, `TabId`, `MessageRecordId`, `SavedRequestId`, `BookmarkId` (`ProfileId`/`ConnectionId` reused from Connection Manager). `MessageRecordDto` field shape is owned by Pub/Sub; we host its persistence.

---

## 9. Frontend surface

Storage's frontend footprint is mostly a **persistence + data-hooks layer** other features consume, plus a few storage-owned screens (Settings › Data & Backup, Workspace switcher).

**Routes / panels (owned):**
- `Settings › Data & Backup` — DB stats (size, per-table counts, WAL size), Backup now / Restore, Export/Import bundle wizard (entity checkboxes, secrets-passphrase gate), Vacuum, Integrity check, retention config.
- `WorkspaceSwitcher` (top-bar dropdown) + `WorkspaceManagerDialog` — create/rename/duplicate/delete/set-active.
- Data hooks (no dedicated route): History drawer feed, Templates/Saved-Requests library palette, Bookmarks sidebar, Recents list on the connect screen. These surface inside other teams' views but are powered by our queries.

**Zustand stores (UI/session only):**
- `useWorkspaceUiStore` — active workspace id (mirror of persisted), open-tab ordering draft, unsaved dock layout diff, dirty flag. Source of truth stays SQLite; layout writes are debounced (500ms) via `layout_save`.
- `useBackupUiStore` — export wizard step/selection, in-flight backup task id + progress (fed from `ns://task/progress`).

**TanStack Query keys:**
```
['storage','workspaces']                 ['storage','workspace', id]
['storage','layout', workspaceId]        ['storage','stats']
['history', connectionId, filterHash]    (infinite query, cursor)
['storage','savedRequests', folder]      ['storage','templates', folder]
['storage','bookmarks', kind]            ['storage','recents']
```
Mutations invalidate their key family; `history_query` is a TanStack **infinite query** (cursor). Streaming history appends are folded into the cache via `queryClient.setQueryData` from the Pub/Sub subscription handler rather than refetching.

**IPC client calls (generated wrappers in `packages/ns-bindings`):**
`ipc.workspace.list/get/create/update/delete/duplicate/setActive`, `ipc.layout.get/save/reset`, `ipc.history.query/get/delete/clear`, `ipc.savedRequest.list/upsert/delete`, `ipc.template.list/upsert/delete`, `ipc.bookmark.list/toggle/reorder`, `ipc.recent.list/pin/clear`, `ipc.storage.stats/backup/restore/exportBundle/importBundle/vacuum/integrityCheck`.

---

## 10. Dependencies

**Depends on (per SoT):** `ns-types` (DTOs), `ns-core` (ports: `Clock`, `EventPublisher`, all repo traits, `RepoError`, `CancellationToken`). Dev-only: `ns-testkit`.

**Consumed by (via ports, never concretely):**
- Connection Manager → `ConnectionProfileRepo`, `RecentConnectionRepo`.
- Core Runtime → `SettingsRepo`.
- Pub/Sub → `MessageHistoryRepo` (append), `SavedRequestRepo`, `PublishTemplateRepo`.
- Frontend Shell / Dashboard → `WorkspaceRepo`, `LayoutRepo`, `BookmarkRepo`.
- Monitoring / JetStream → `ResponseCacheRepo` (optional derived-data cache), `BookmarkRepo`.
- `ns-security` → `SecretBlobRepo` (encrypted fallback only).
- `ns-plugin` → `PluginStateRepo`.
- The **bin** constructs `SqliteStorage`, injects repo handles into every service, and registers the `storage_*`/`workspace_*`/… commands.

**Third-party crates:** `rusqlite` (features `bundled`, `backup`, `functions`, `blob`), `zip`, `serde`/`serde_json`, `time`, `thiserror`, `tokio`, `tracing`, `async-trait`, `uuid`. `rusqlite_migration` optional — we may embed a hand-rolled runner to keep the `user_version` contract explicit.

---

## 11. Test plan

**Unit (no DB / in-memory):**
- Row↔DTO mapping round-trips for every repo (JSON column codecs, enum tags, base64 payloads).
- `StorageError → RepoError → IpcError` mapping table (code/retriable preserved; `user_message` never leaks values).
- Cursor encode/decode invariants for `HistoryQuery` (stable ordering, no dup/skip across pages).
- Retention math (size + TTL selection) with a `MockClock`.

**Integration (real SQLite, `:memory:` and tempfile, via `ns-testkit`):**
- Migration runner: apply `0001..N` from empty, assert `user_version==N`, schema fingerprint golden; forward-only guard (refuse a lower target); idempotent re-run.
- Every repo CRUD + concurrency: N concurrent `read`s alongside a stream of `write`s (WAL) with zero `SQLITE_BUSY` surfaced; `workspace_set_active` single-active invariant under concurrent setters.
- History hot path: `append_batch` at high rate, assert coalescing (txn count ≪ row count) and retention bounding to configured max rows/TTL.
- Backup/restore: hot backup while writes are in flight → restored DB passes `integrity_check` and equals a quiesced snapshot; restore across a schema gap runs migrations or refuses cleanly.
- Bundle export/import: round-trip with `Merge` (id remap on collision) and `Replace`; secrets excluded by default; secrets-with-passphrase round-trips only via a mock `ns-security` cipher.
- Crash safety: kill mid-write (drop worker), reopen → WAL recovers, no partial rows (FK + txn atomicity).
- `SecretBlobRepo` stores only opaque bytes; assert no plaintext ever reaches the file (scan the DB file for a canary secret — must be absent).

**E2E (Tauri harness, real nats-server via `ns-testkit`):**
- Create workspace → open tabs → relaunch app → layout + tabs restored (dockview JSON survives).
- Publish messages → history drawer populates → clear filter deletes expected rows; retention purges old rows on next launch.
- Save a request/template → reuse it to publish; bookmark a subject → appears in sidebar after restart.
- Settings › Data & Backup: Backup now → Restore into a fresh profile dir reproduces all data; Export bundle → Import into a clean install.
- Multi-window: mutate a template in window A, confirm window B refreshes within `staleTime`/focus (documents current bound; upgraded if `DataChanged` ADR lands).

**Perf / soak:** 1M-row history query p50/p95 under index; DB size growth + vacuum reclaim; startup time with migrations on a large DB (target < 150ms open+migrate on warm cache).

---

## 12. Risks & open questions

1. **Multi-window cache coherence.** No push invalidation in v1 (see §6). Proposed `EventPayload::DataChanged` needs an ADR + `appSchemaVersion` bump because it touches the frozen event enum. *Decision needed before multi-window ships.*
2. **History as a firehose.** High-rate subscriptions could overrun the ingest buffer; v1 is best-effort drop-oldest with a counter. Open question: do users expect a lossless "record to disk" mode (would need explicit backpressure onto the subscription, coupling storage to Pub/Sub flow control)?
3. **Payload storage cost.** Storing raw payloads in `message_history` inflates the DB. Options: size cap per row, offload large payloads to a content-addressed blob dir, or store only headers+preview. Needs a product call on retention vs. fidelity.
4. **Encrypted-fallback key custody.** The OS-protected key for the headless-Linux fallback is `ns-security`'s responsibility, but restore/import portability across machines is unclear when secrets are keychain-bound. Bundle passphrase re-encryption (§7) is the portable path; the non-portable keychain path must be documented for users.
5. **Restore requires app restart.** Swapping the live DB file cleanly implies re-opening the engine and rebinding every service. v1 gates restore behind a controlled restart; a hot re-open of `SqliteStorage` without process restart is a stretch goal.
6. **`rusqlite_migration` vs. hand-rolled runner.** Trade explicit `user_version` control vs. a maintained dep; leaning hand-rolled for the `PRAGMA user_version` contract. To confirm in ADR.
7. **FTS5 for history search.** Bundled SQLite includes FTS5, but it grows the DB and complicates migrations; gate behind a setting.
8. **Tab ↔ live connection binding.** Persisted tabs reference `profile_id` (stable) but runtime `connection_id` is ephemeral; restore must re-map after reconnect. Coordination point with Connection Manager on the restore handshake.
