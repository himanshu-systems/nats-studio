//! The single-writer SQLite worker: [`Db`] is a clone-cheap async handle to a
//! dedicated OS thread that owns the one `rusqlite::Connection` for this
//! database.
//!
//! `Connection` is `Send` but not `Sync`, and its transactional API
//! (`Connection::transaction`) takes `&mut self` — wrapping it in a `Mutex`
//! would work, but holding that lock across blocking SQLite I/O would stall
//! the async reactor. Instead we give the connection a home thread and talk
//! to it over a channel: every [`Db::call`] sends a boxed closure plus a
//! `oneshot` reply channel, the worker thread runs the closure against the
//! connection and sends the result back. Cloning [`Db`] just clones the
//! `mpsc::Sender`, so every clone shares the same worker (and therefore the
//! same connection) — there is never more than one writer.
//!
//! The worker thread needs no explicit shutdown: once every [`Db`] clone (and
//! therefore every `Sender`) is dropped, the channel closes, `blocking_recv`
//! returns `None`, and the loop — and the thread — ends on its own.

use std::path::{Path, PathBuf};
use std::thread;

use rusqlite::Connection;
use tokio::sync::{mpsc, oneshot};

use crate::error::StorageError;

/// Bound on in-flight jobs queued to the worker thread before [`Db::call`]
/// starts backpressuring the caller. Generous enough that normal traffic
/// never blocks on it.
const COMMAND_BUFFER: usize = 256;

/// Forward-only, embedded schema migrations. Index `i` (0-based) is schema
/// version `i + 1`; the applied version is tracked in `PRAGMA user_version`.
/// Append new entries for new versions — never edit one that has already
/// shipped.
const MIGRATIONS: &[&str] = &[
    // v1: the settings singleton + connection profiles, both stored as JSON
    // (see module docs on `crate` for why: it keeps the schema stable as the
    // DTOs evolve). Profiles carry no secrets — those live in the OS keychain
    // via `ns-security`, keyed by profile id.
    r#"
    CREATE TABLE settings (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
    );

    CREATE TABLE connection_profile (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        data       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    "#,
];

/// A job dispatched to the worker thread: a boxed closure that runs against
/// the connection and is responsible for sending its own result back (it
/// closes over the `oneshot::Sender` set up in [`Db::call`]).
type Job = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

/// A clone-cheap async handle to a SQLite database.
///
/// Every method that touches the connection goes through [`Db::call`], which
/// hands a closure to the dedicated worker thread and awaits its result — the
/// async reactor is never blocked on SQLite I/O.
#[derive(Clone)]
pub struct Db {
    tx: mpsc::Sender<Job>,
}

impl Db {
    /// Open (creating if absent) the SQLite database at `path`, apply any
    /// pending migrations, and spawn its dedicated worker thread.
    ///
    /// # Errors
    /// Returns [`StorageError`] if the file cannot be opened or a migration
    /// fails; either way the worker thread never starts serving requests.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path: PathBuf = path.as_ref().to_path_buf();
        Self::spawn_worker(move || Connection::open(&path)).await
    }

    /// Open a private, in-memory database (fresh schema, migrated up) —
    /// handy for tests and any ephemeral session that shouldn't touch disk.
    ///
    /// # Errors
    /// Returns [`StorageError`] if a migration fails.
    pub async fn open_in_memory() -> Result<Self, StorageError> {
        Self::spawn_worker(Connection::open_in_memory).await
    }

    /// The current applied schema version (`PRAGMA user_version`). Exposed
    /// mainly for tests and diagnostics — application code has no reason to
    /// care what version it's on.
    ///
    /// # Errors
    /// Returns [`StorageError`] on a connection-level failure.
    pub async fn schema_version(&self) -> Result<i64, StorageError> {
        self.call(|conn| read_user_version(conn)).await
    }

    /// Spawn the worker thread, open the connection with `open_fn` on it,
    /// configure pragmas and migrate, then report readiness back to the
    /// caller before returning the handle.
    async fn spawn_worker<F>(open_fn: F) -> Result<Self, StorageError>
    where
        F: FnOnce() -> rusqlite::Result<Connection> + Send + 'static,
    {
        let (tx, mut rx) = mpsc::channel::<Job>(COMMAND_BUFFER);
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), StorageError>>();

        thread::Builder::new()
            .name("ns-storage-db".to_owned())
            .spawn(move || {
                let mut conn = match open_fn().map_err(StorageError::from) {
                    Ok(conn) => conn,
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                        return;
                    }
                };

                if let Err(err) = configure(&conn).and_then(|()| migrate(&mut conn)) {
                    let _ = ready_tx.send(Err(err));
                    return;
                }
                let _ = ready_tx.send(Ok(()));

                while let Some(job) = rx.blocking_recv() {
                    job(&mut conn);
                }
            })
            .expect("failed to spawn ns-storage worker thread");

        ready_rx
            .await
            .map_err(|_| StorageError::WorkerUnavailable)??;
        Ok(Self { tx })
    }

    /// Run `f` against the connection on the worker thread and await its
    /// result. The primitive every repo method is built on.
    ///
    /// # Errors
    /// Propagates whatever `f` returns, plus [`StorageError::WorkerUnavailable`]
    /// if the worker thread is gone (never happens in normal operation —
    /// only if it already panicked, which itself indicates a bug).
    pub(crate) async fn call<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
        T: Send + 'static,
    {
        let (resp_tx, resp_rx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let _ = resp_tx.send(f(conn));
        });
        self.tx
            .send(job)
            .await
            .map_err(|_| StorageError::WorkerUnavailable)?;
        resp_rx.await.map_err(|_| StorageError::WorkerUnavailable)?
    }
}

/// Set the per-connection pragmas the charter calls for. `journal_mode` and
/// `foreign_keys` are connection-scoped in SQLite (the latter must be set on
/// every connection that wants FK enforcement — it does not persist in the
/// file). Run as one `execute_batch`: `PRAGMA journal_mode` returns the
/// resulting mode as a row, which `execute_batch` (unlike `execute`)
/// tolerates. WAL is silently downgraded to `memory` on an in-memory
/// database, which is fine — tests never rely on WAL specifically.
fn configure(conn: &Connection) -> Result<(), StorageError> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;",
    )?;
    Ok(())
}

/// Bring the database from its current `PRAGMA user_version` up to
/// [`MIGRATIONS`]'s latest, applying each pending step inside its own
/// transaction (schema + version bump commit atomically together). A no-op
/// if already current — safe to call on every open.
fn migrate(conn: &mut Connection) -> Result<(), StorageError> {
    let current = read_user_version(conn)?;
    let current = usize::try_from(current)
        .map_err(|_| StorageError::MigrationFailed(format!("negative user_version: {current}")))?;

    if current > MIGRATIONS.len() {
        return Err(StorageError::MigrationFailed(format!(
            "database schema version {current} is newer than the {} migration(s) this build knows about",
            MIGRATIONS.len()
        )));
    }

    for (offset, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let version = offset + 1;
        let tx = conn.transaction().map_err(|err| {
            StorageError::MigrationFailed(format!("opening transaction for v{version}: {err}"))
        })?;
        tx.execute_batch(sql).map_err(|err| {
            StorageError::MigrationFailed(format!("applying migration v{version}: {err}"))
        })?;
        tx.execute_batch(&format!("PRAGMA user_version = {version}"))
            .map_err(|err| {
                StorageError::MigrationFailed(format!("recording user_version {version}: {err}"))
            })?;
        tx.commit().map_err(|err| {
            StorageError::MigrationFailed(format!("committing migration v{version}: {err}"))
        })?;
    }
    Ok(())
}

fn read_user_version(conn: &Connection) -> Result<i64, StorageError> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn fresh_db_migrates_to_latest_and_is_idempotent() {
        let db = Db::open_in_memory().await.expect("open");
        let version = db.schema_version().await.expect("schema_version");
        assert_eq!(version, MIGRATIONS.len() as i64);

        // Exercise the hand-rolled migration function directly: running it
        // twice against an already-current connection must be a no-op.
        let mut conn = Connection::open_in_memory().expect("raw open");
        configure(&conn).expect("configure");
        migrate(&mut conn).expect("first migrate brings it to latest");
        migrate(&mut conn).expect("second migrate is a no-op");
        assert_eq!(
            read_user_version(&conn).expect("version"),
            MIGRATIONS.len() as i64
        );

        // Tables still exist and are usable after the no-op re-run.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM connection_profile", [], |r| r.get(0))
            .expect("table survives re-migration");
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_a_schema_from_the_future() {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA user_version = 999")
            .expect("bump version");
        let err = migrate(&mut conn).expect_err("future version must be rejected");
        assert!(matches!(err, StorageError::MigrationFailed(_)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn handle_clones_share_one_worker_and_serve_concurrent_callers() {
        let db = Db::open_in_memory().await.expect("open");
        let mut handles = Vec::new();
        for i in 0..8 {
            let db = db.clone();
            handles.push(tokio::spawn(async move {
                db.call(move |conn| {
                    conn.execute(
                        "INSERT INTO connection_profile (id, name, data, created_at, updated_at)
                         VALUES (?1, ?1, '{}', 't', 't')",
                        [format!("p{i}")],
                    )?;
                    Ok(())
                })
                .await
            }));
        }
        for h in handles {
            h.await.expect("task join").expect("insert");
        }

        let count: i64 = db
            .call(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM connection_profile", [], |r| r.get(0))?)
            })
            .await
            .expect("count");
        assert_eq!(count, 8);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn worker_thread_exits_when_last_handle_drops() {
        let db = Db::open_in_memory().await.expect("open");
        let clone = db.clone();
        drop(db);
        // The clone still works: the worker only shuts down once every
        // handle is gone.
        let version = clone.schema_version().await.expect("schema_version");
        assert_eq!(version, MIGRATIONS.len() as i64);
        drop(clone);
        // Nothing to assert post-drop (the thread exit is not observable from
        // here without racy sleeps) — this documents the intended lifecycle.
    }
}
