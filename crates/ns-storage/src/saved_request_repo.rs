//! [`SqliteSavedRequestRepo`]: the `ns_core::SavedRequestRepo` port over the
//! `saved_request` table.
//!
//! Rows store the template as JSON, same rationale as
//! `SqliteConnectionProfileRepo`: it keeps the schema stable as the DTO
//! evolves. A saved request never carries secrets.

use async_trait::async_trait;
use ns_core::{CoreError, SavedRequestRepo};
use ns_types::SavedRequestDto;
use rusqlite::{params, OptionalExtension};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::db::Db;
use crate::error::StorageError;

/// `SavedRequestRepo` backed by the `saved_request` table.
///
/// A clone-cheap wrapper around a [`Db`] handle — cloning a repo is cloning
/// the handle, and every clone talks to the same worker/connection.
#[derive(Clone)]
pub struct SqliteSavedRequestRepo {
    db: Db,
}

impl SqliteSavedRequestRepo {
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
impl SavedRequestRepo for SqliteSavedRequestRepo {
    async fn list(&self) -> Result<Vec<SavedRequestDto>, CoreError> {
        let rows: Vec<String> = self
            .db
            .call(|conn| {
                let mut stmt = conn.prepare("SELECT data FROM saved_request ORDER BY name, id")?;
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

    async fn get(&self, id: &str) -> Result<Option<SavedRequestDto>, CoreError> {
        let id = id.to_owned();
        let json: Option<String> = self
            .db
            .call(move |conn| {
                conn.query_row(
                    "SELECT data FROM saved_request WHERE id = ?1",
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

    async fn upsert(&self, request: &SavedRequestDto) -> Result<(), CoreError> {
        let json = serde_json::to_string(request).map_err(StorageError::from)?;
        let id = request.id.clone();
        let name = request.name.clone();
        let now = now_rfc3339();

        self.db
            .call(move |conn| {
                // `?4` is bound once (`now`) and reused for both timestamp
                // columns: on INSERT both `created_at`/`updated_at` get
                // `now`; on UPDATE only `updated_at` is touched, so
                // `created_at` is preserved from the original row.
                conn.execute(
                    "INSERT INTO saved_request (id, name, data, created_at, updated_at)
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
                conn.execute("DELETE FROM saved_request WHERE id = ?1", params![id])?;
                Ok(())
            })
            .await?;
        Ok(())
    }
}
