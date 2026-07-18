//! The [`ConnectionError`] domain error for the connection service.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

/// A failure from [`ConnectionService`](crate::ConnectionService).
#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    #[error("connection profile not found: {0}")]
    ProfileNotFound(String),
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),
    #[error("missing credential: {0}")]
    MissingSecret(String),
    #[error("invalid profile: {0}")]
    Invalid(String),
    /// An error bubbled up from an injected port (repo/secret-store/factory).
    #[error(transparent)]
    Core(#[from] CoreError),
}

impl DomainError for ConnectionError {
    fn code(&self) -> ErrorCode {
        match self {
            ConnectionError::ProfileNotFound(_) | ConnectionError::ConnectionNotFound(_) => {
                ErrorCode::NotFound
            }
            ConnectionError::MissingSecret(_) => ErrorCode::AuthFailed,
            ConnectionError::Invalid(_) => ErrorCode::InvalidArgument,
            ConnectionError::Core(inner) => inner.code(),
        }
    }

    fn retriable(&self) -> bool {
        match self {
            ConnectionError::Core(inner) => inner.retriable(),
            _ => false,
        }
    }
}

impl From<ConnectionError> for CoreError {
    fn from(err: ConnectionError) -> Self {
        if let ConnectionError::Core(inner) = err {
            return inner;
        }
        let (code, retriable) = (err.code(), err.retriable());
        CoreError::coded(code, err.to_string(), retriable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_codes_and_delegates_core() {
        assert_eq!(
            ConnectionError::ProfileNotFound("p".into()).code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            ConnectionError::MissingSecret("password".into()).code(),
            ErrorCode::AuthFailed
        );
        let core = ConnectionError::Core(CoreError::coded(ErrorCode::TlsError, "x", false));
        assert_eq!(core.code(), ErrorCode::TlsError);
    }
}
