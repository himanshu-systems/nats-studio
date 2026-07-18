//! The [`NatsError`] domain error for the `async-nats` adapter.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

/// A failure from the NATS client adapter.
#[derive(Debug, thiserror::Error)]
pub enum NatsError {
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("authentication setup failed: {0}")]
    Auth(String),
    #[error("tls setup failed: {0}")]
    Tls(String),
    #[error("invalid server address: {0}")]
    InvalidAddress(String),
    #[error("no responders for subject")]
    NoResponders,
    #[error("operation timed out: {0}")]
    Timeout(String),
    #[error("nats io error: {0}")]
    Io(String),
    #[error("feature not yet supported: {0}")]
    Unsupported(String),
}

impl DomainError for NatsError {
    fn code(&self) -> ErrorCode {
        match self {
            NatsError::Connect(_) => ErrorCode::ConnectionTimeout,
            NatsError::Auth(_) => ErrorCode::AuthFailed,
            NatsError::Tls(_) => ErrorCode::TlsError,
            NatsError::InvalidAddress(_) | NatsError::Unsupported(_) => ErrorCode::InvalidArgument,
            NatsError::NoResponders => ErrorCode::NoResponders,
            NatsError::Timeout(_) => ErrorCode::Timeout,
            NatsError::Io(_) => ErrorCode::Io,
        }
    }

    fn retriable(&self) -> bool {
        matches!(
            self,
            NatsError::Connect(_) | NatsError::Timeout(_) | NatsError::Io(_)
        )
    }
}

impl From<NatsError> for CoreError {
    fn from(err: NatsError) -> Self {
        let retriable = err.retriable();
        CoreError::coded(err.code(), err.to_string(), retriable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_to_codes() {
        assert_eq!(NatsError::Auth("x".into()).code(), ErrorCode::AuthFailed);
        assert_eq!(NatsError::Tls("x".into()).code(), ErrorCode::TlsError);
        assert!(NatsError::Connect("x".into()).retriable());
        assert!(!NatsError::Auth("x".into()).retriable());
        let core: CoreError = NatsError::InvalidAddress("bad".into()).into();
        assert_eq!(core.code(), ErrorCode::InvalidArgument);
    }
}
