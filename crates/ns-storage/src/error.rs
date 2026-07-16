//! The [`StorageError`] domain error for `ns-storage`.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

/// A failure raised by `ns-storage`'s public API — the [`crate::Db`] handle and
/// the `Sqlite*Repo` port implementations built on it.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    /// A failure from SQLite itself (constraint violation, I/O, a malformed
    /// query…). Covers everything raised through `rusqlite`.
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// A stored JSON blob failed to (de)serialize into/from its DTO. Since
    /// every write round-trips through the same DTO, in practice this can
    /// only mean the on-disk row predates a breaking DTO change.
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// A schema migration could not be applied — including the case where
    /// the database reports a `PRAGMA user_version` newer than any migration
    /// this build knows about (an old build opening a newer database).
    #[error("migration failed: {0}")]
    MigrationFailed(String),

    /// The dedicated worker thread backing a [`crate::Db`] handle is gone.
    /// Only reachable if the worker thread panicked, which itself would
    /// indicate a bug elsewhere (a job closure unwinding).
    #[error("storage worker is unavailable")]
    WorkerUnavailable,
}

impl DomainError for StorageError {
    fn code(&self) -> ErrorCode {
        match self {
            StorageError::Sqlite(_) | StorageError::Serde(_) | StorageError::WorkerUnavailable => {
                ErrorCode::Storage
            }
            StorageError::MigrationFailed(_) => ErrorCode::MigrationFailed,
        }
    }

    fn retriable(&self) -> bool {
        // Nothing here self-heals: a bad query/connection or a gone worker
        // needs a fresh `Db`, a migration failure needs a code fix, and a
        // serde failure needs a schema/DTO fix. None of that clears on a bare
        // retry of the same operation.
        false
    }
}

impl From<StorageError> for CoreError {
    fn from(err: StorageError) -> Self {
        let retriable = err.retriable();
        CoreError::coded(err.code(), err.to_string(), retriable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_error_contract() {
        assert_eq!(StorageError::WorkerUnavailable.code(), ErrorCode::Storage);
        assert!(!StorageError::WorkerUnavailable.retriable());

        let migration = StorageError::MigrationFailed("boom".into());
        assert_eq!(migration.code(), ErrorCode::MigrationFailed);
        assert!(!migration.retriable());
        assert!(migration.to_string().contains("boom"));
    }

    #[test]
    fn maps_into_core_error() {
        let core: CoreError = StorageError::MigrationFailed("x".into()).into();
        assert_eq!(core.code(), ErrorCode::MigrationFailed);
        assert!(!core.retriable());
    }

    #[test]
    fn wraps_rusqlite_and_serde_errors_via_from() {
        let sqlite_err: StorageError = rusqlite::Error::QueryReturnedNoRows.into();
        assert_eq!(sqlite_err.code(), ErrorCode::Storage);
        assert!(matches!(sqlite_err, StorageError::Sqlite(_)));

        let bad_json =
            serde_json::from_str::<serde_json::Value>("{not json").expect_err("malformed");
        let serde_err: StorageError = bad_json.into();
        assert_eq!(serde_err.code(), ErrorCode::Storage);
        assert!(matches!(serde_err, StorageError::Serde(_)));
    }
}
