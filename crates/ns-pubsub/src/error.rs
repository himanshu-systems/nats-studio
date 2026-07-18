//! The [`PubSubError`] domain error.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

#[derive(Debug, thiserror::Error)]
pub enum PubSubError {
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    #[error("invalid subject: {0}")]
    InvalidSubject(String),
    /// Bubbled up from the NATS client port.
    #[error(transparent)]
    Core(#[from] CoreError),
}

impl DomainError for PubSubError {
    fn code(&self) -> ErrorCode {
        match self {
            PubSubError::InvalidPayload(_) => ErrorCode::PayloadDecodeFailed,
            PubSubError::InvalidSubject(_) => ErrorCode::SubjectInvalid,
            PubSubError::Core(inner) => inner.code(),
        }
    }

    fn retriable(&self) -> bool {
        matches!(self, PubSubError::Core(inner) if inner.retriable())
    }
}

impl From<PubSubError> for CoreError {
    fn from(err: PubSubError) -> Self {
        if let PubSubError::Core(inner) = err {
            return inner;
        }
        let (code, retriable) = (err.code(), err.retriable());
        CoreError::coded(code, err.to_string(), retriable)
    }
}
