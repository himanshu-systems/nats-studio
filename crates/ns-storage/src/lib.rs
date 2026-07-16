//! `ns-storage` — SQLite-backed persistence for NATS Studio (spine ADR-0003).
//!
//! Owns the single [`Db`] handle: a dedicated OS thread holds the
//! `rusqlite::Connection` (which is `Send` but not `Sync`) and receives work
//! over a bounded `tokio::sync::mpsc` channel, each job carrying a
//! `tokio::sync::oneshot` sender for its result. `Db` itself is a clone-cheap
//! async handle — cloning shares the same worker thread and channel, so
//! callers never touch a `Connection` directly and the async reactor is
//! never blocked by SQLite I/O.
//!
//! [`SqliteSettingsRepo`] and [`SqliteConnectionProfileRepo`] implement the
//! `ns_core::SettingsRepo` / `ns_core::ConnectionProfileRepo` ports over this
//! handle, storing both DTOs as JSON (`serde_json`) so the schema stays
//! stable as the DTOs evolve. Neither stored record carries secrets — those
//! live in the OS keychain via `ns-security`, keyed by connection id.
//!
//! Migrations are forward-only and hand-rolled: a `const` array of embedded
//! SQL blocks, tracked via `PRAGMA user_version`, each pending version
//! applied inside its own transaction. On open we also set
//! `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, and
//! `synchronous=NORMAL`.
//!
//! See docs/architecture/ (ADR-0003) and `ns_core::ports` for the port
//! contracts implemented here.
#![forbid(unsafe_code)]

mod db;
mod error;
mod profile_repo;
mod settings_repo;

pub use db::Db;
pub use error::StorageError;
pub use profile_repo::SqliteConnectionProfileRepo;
pub use settings_repo::SqliteSettingsRepo;

#[cfg(test)]
mod tests {
    use super::*;
    use ns_core::{default_settings, ConnectionProfileRepo, SettingsRepo};
    use ns_types::{ConnectionAuth, ConnectionOptions, ConnectionProfile};

    async fn open() -> Db {
        Db::open_in_memory().await.expect("open in-memory db")
    }

    fn sample_profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_owned(),
            name: name.to_owned(),
            servers: vec!["nats://127.0.0.1:4222".to_owned()],
            auth: ConnectionAuth::None,
            tls: None,
            options: ConnectionOptions {
                max_reconnects: None,
                reconnect_delay_ms: 1_000,
                connect_timeout_ms: 5_000,
                ping_interval_ms: 2_000,
                no_echo: false,
            },
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn settings_round_trip_defaults_to_none_then_persists() {
        let repo = SqliteSettingsRepo::new(open().await);

        assert!(
            repo.load().await.expect("load").is_none(),
            "a fresh db has no settings row yet"
        );

        let settings = default_settings();
        repo.save(&settings).await.expect("save");

        let loaded = repo
            .load()
            .await
            .expect("load")
            .expect("present after save");
        assert_eq!(loaded.log_level, settings.log_level);
        assert_eq!(loaded.telemetry_enabled, settings.telemetry_enabled);
        assert_eq!(
            loaded.default_request_timeout_ms,
            settings.default_request_timeout_ms
        );
        assert_eq!(loaded.max_history_entries, settings.max_history_entries);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn settings_save_overwrites_the_single_row_rather_than_duplicating() {
        let repo = SqliteSettingsRepo::new(open().await);
        let mut settings = default_settings();
        repo.save(&settings).await.expect("save 1");

        settings.log_level = "debug".to_owned();
        settings.telemetry_enabled = true;
        repo.save(&settings).await.expect("save 2");

        let loaded = repo.load().await.expect("load").expect("present");
        assert_eq!(loaded.log_level, "debug");
        assert!(loaded.telemetry_enabled);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn profile_get_of_missing_id_returns_none() {
        let repo = SqliteConnectionProfileRepo::new(open().await);
        assert!(repo.get("does-not-exist").await.expect("get").is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn profile_round_trips_upsert_get_list_update_delete() {
        let repo = SqliteConnectionProfileRepo::new(open().await);

        let profile = sample_profile("p1", "Local");
        repo.upsert(&profile).await.expect("insert");

        let fetched = repo.get("p1").await.expect("get").expect("present");
        assert_eq!(fetched.name, "Local");
        assert_eq!(fetched.servers, profile.servers);

        let listed = repo.list().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "p1");

        let mut updated = profile.clone();
        updated.name = "Local (renamed)".to_owned();
        updated.servers = vec![
            "nats://127.0.0.1:4222".to_owned(),
            "nats://127.0.0.1:4223".to_owned(),
        ];
        repo.upsert(&updated).await.expect("update");

        let refetched = repo
            .get("p1")
            .await
            .expect("get")
            .expect("present after update");
        assert_eq!(refetched.name, "Local (renamed)");
        assert_eq!(refetched.servers.len(), 2);
        assert_eq!(
            repo.list().await.expect("list").len(),
            1,
            "an update must not duplicate the row"
        );

        repo.delete("p1").await.expect("delete");
        assert!(repo.get("p1").await.expect("get").is_none());
        assert!(repo.list().await.expect("list").is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn repo_clones_share_state_across_concurrent_tasks() {
        let repo = SqliteConnectionProfileRepo::new(open().await);
        let mut handles = Vec::new();
        for i in 0..5 {
            let repo = repo.clone();
            handles.push(tokio::spawn(async move {
                repo.upsert(&sample_profile(&format!("c{i}"), &format!("Conn {i}")))
                    .await
            }));
        }
        for h in handles {
            h.await.expect("task join").expect("upsert");
        }
        assert_eq!(repo.list().await.expect("list").len(), 5);
    }
}
