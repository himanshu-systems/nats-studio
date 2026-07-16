//! [`SqliteSettingsRepo`]: the `ns_core::SettingsRepo` port over the single
//! `settings` row, stored as [`Settings`] JSON.

use async_trait::async_trait;
use ns_core::{CoreError, SettingsRepo};
use ns_types::Settings;
use rusqlite::{params, OptionalExtension};

use crate::db::Db;
use crate::error::StorageError;

/// `SettingsRepo` backed by the `settings` table's single row (`id = 1`).
///
/// A clone-cheap wrapper around a [`Db`] handle — cloning a repo is cloning
/// the handle, and every clone talks to the same worker/connection.
#[derive(Clone)]
pub struct SqliteSettingsRepo {
    db: Db,
}

impl SqliteSettingsRepo {
    /// Wrap an already-open, already-migrated [`Db`] handle.
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }
}

#[async_trait]
impl SettingsRepo for SqliteSettingsRepo {
    async fn load(&self) -> Result<Option<Settings>, CoreError> {
        let json: Option<String> = self
            .db
            .call(|conn| {
                conn.query_row("SELECT data FROM settings WHERE id = 1", [], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(StorageError::from)
            })
            .await?;

        json.map(|json| serde_json::from_str(&json).map_err(StorageError::from))
            .transpose()
            .map_err(CoreError::from)
    }

    async fn save(&self, settings: &Settings) -> Result<(), CoreError> {
        let json = serde_json::to_string(settings).map_err(StorageError::from)?;
        self.db
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO settings (id, data) VALUES (1, ?1)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                    params![json],
                )?;
                Ok(())
            })
            .await?;
        Ok(())
    }
}
