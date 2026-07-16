//! [`SqliteConnectionProfileRepo`]: the `ns_core::ConnectionProfileRepo` port
//! over the `connection_profile` table.
//!
//! Rows store the profile as JSON. **The stored profile carries no secrets**
//! — the `password`/`token`/`seed` fields on `ns_types::ConnectionAuth` are
//! always redacted (`None`) by the time a profile reaches here; the real
//! secret material lives in the OS keychain via `ns-security`
//! (`ns_core::SecretStore`), keyed by profile id.

use async_trait::async_trait;
use ns_core::{ConnectionProfileRepo, CoreError};
use ns_types::ConnectionProfile;
use rusqlite::{params, OptionalExtension};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::db::Db;
use crate::error::StorageError;

/// `ConnectionProfileRepo` backed by the `connection_profile` table.
///
/// A clone-cheap wrapper around a [`Db`] handle — cloning a repo is cloning
/// the handle, and every clone talks to the same worker/connection.
#[derive(Clone)]
pub struct SqliteConnectionProfileRepo {
    db: Db,
}

impl SqliteConnectionProfileRepo {
    /// Wrap an already-open, already-migrated [`Db`] handle.
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }
}

/// Current time as RFC 3339, for the `created_at`/`updated_at` columns.
/// `OffsetDateTime::format` only fails for dates outside what RFC 3339 can
/// represent, which "now" never is — the fallback exists purely so this
/// stays a total function rather than something that can panic in a repo
/// call.
fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[async_trait]
impl ConnectionProfileRepo for SqliteConnectionProfileRepo {
    async fn list(&self) -> Result<Vec<ConnectionProfile>, CoreError> {
        let rows: Vec<String> = self
            .db
            .call(|conn| {
                let mut stmt =
                    conn.prepare("SELECT data FROM connection_profile ORDER BY name, id")?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await?;

        rows.iter()
            .map(|json| serde_json::from_str(json).map_err(StorageError::from))
            .collect::<Result<Vec<_>, _>>()
            .map_err(CoreError::from)
    }

    async fn get(&self, id: &str) -> Result<Option<ConnectionProfile>, CoreError> {
        let id = id.to_owned();
        let json: Option<String> = self
            .db
            .call(move |conn| {
                conn.query_row(
                    "SELECT data FROM connection_profile WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(StorageError::from)
            })
            .await?;

        json.map(|json| serde_json::from_str(&json).map_err(StorageError::from))
            .transpose()
            .map_err(CoreError::from)
    }

    async fn upsert(&self, profile: &ConnectionProfile) -> Result<(), CoreError> {
        let json = serde_json::to_string(profile).map_err(StorageError::from)?;
        let id = profile.id.clone();
        let name = profile.name.clone();
        let now = now_rfc3339();

        self.db
            .call(move |conn| {
                // `?4` is bound once (`now`) and reused for both timestamp
                // columns: on INSERT both `created_at`/`updated_at` get
                // `now`; on UPDATE only `updated_at` is touched, so
                // `created_at` is preserved from the original row.
                conn.execute(
                    "INSERT INTO connection_profile (id, name, data, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)
                     ON CONFLICT(id) DO UPDATE SET
                         name = excluded.name,
                         data = excluded.data,
                         updated_at = excluded.updated_at",
                    params![id, name, json, now],
                )?;
                Ok(())
            })
            .await?;
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), CoreError> {
        let id = id.to_owned();
        self.db
            .call(move |conn| {
                conn.execute("DELETE FROM connection_profile WHERE id = ?1", params![id])?;
                Ok(())
            })
            .await?;
        Ok(())
    }
}
