//! The `DomainError` contract and the neutral `CoreError` returned by ports.

use ns_types::ErrorCode;

/// Implemented by every crate's public error enum so the IPC boundary can map any
/// failure to a stable `ErrorCode` + a secret-safe user message (spine section 7.2).
pub trait DomainError: std::error::Error {
    fn code(&self) -> ErrorCode;
    fn retriable(&self) -> bool {
        false
    }
    fn user_message(&self) -> String {
        self.to_string()
    }
}

/// A neutral, adapter-agnostic error returned by `ns-core` ports. Adapter crates
/// map their own rich errors into this at the port boundary; feature services
/// wrap it via `#[from]`. Keeps ports decoupled from any concrete infrastructure.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid argument: {0}")]
    Invalid(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("secret store: {0}")]
    SecretStore(String),
    #[error("connection error: {0}")]
    Connection(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("tls error: {0}")]
    Tls(String),
    #[error("operation timed out: {0}")]
    Timeout(String),
    #[error("cancelled")]
    Cancelled,
    #[error("io error: {0}")]
    Io(String),
    /// Escape hatch carrying an explicit code + retriability.
    #[error("{message}")]
    Coded {
        code: ErrorCode,
        message: String,
        retriable: bool,
    },
}

impl CoreError {
    /// Construct a `CoreError` with an explicit `ErrorCode` and retriability.
    pub fn coded(code: ErrorCode, message: impl Into<String>, retriable: bool) -> Self {
        Self::Coded {
            code,
            message: message.into(),
            retriable,
        }
    }
}

impl DomainError for CoreError {
    fn code(&self) -> ErrorCode {
        match self {
            CoreError::NotFound(_) => ErrorCode::NotFound,
            CoreError::Invalid(_) => ErrorCode::InvalidArgument,
            CoreError::Storage(_) => ErrorCode::Storage,
            CoreError::SecretStore(_) => ErrorCode::SecretStoreUnavailable,
            CoreError::Connection(_) => ErrorCode::ConnectionClosed,
            CoreError::Auth(_) => ErrorCode::AuthFailed,
            CoreError::Tls(_) => ErrorCode::TlsError,
            CoreError::Timeout(_) => ErrorCode::Timeout,
            CoreError::Cancelled => ErrorCode::Cancelled,
            CoreError::Io(_) => ErrorCode::Io,
            CoreError::Coded { code, .. } => *code,
        }
    }

    fn retriable(&self) -> bool {
        match self {
            CoreError::Timeout(_) | CoreError::Connection(_) => true,
            CoreError::Coded { retriable, .. } => *retriable,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_variants_to_codes() {
        assert_eq!(CoreError::NotFound("x".into()).code(), ErrorCode::NotFound);
        assert!(CoreError::Timeout("slow".into()).retriable());
        assert!(!CoreError::Invalid("bad".into()).retriable());
        let coded = CoreError::coded(ErrorCode::AuthFailed, "nope", false);
        assert_eq!(coded.code(), ErrorCode::AuthFailed);
    }
}
