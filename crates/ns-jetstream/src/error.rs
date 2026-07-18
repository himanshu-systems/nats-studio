//! The [`JetStreamError`] domain error.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

#[derive(Debug, thiserror::Error)]
pub enum JetStreamError {
    #[error("invalid stream name: {0}")]
    InvalidName(String),
    #[error("invalid subject: {0}")]
    InvalidSubject(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// Bubbled up from the NATS client / JetStream port.
    #[error(transparent)]
    Core(#[from] CoreError),
}

impl DomainError for JetStreamError {
    fn code(&self) -> ErrorCode {
        match self {
            JetStreamError::InvalidName(_) => ErrorCode::StreamNotFound,
            JetStreamError::InvalidSubject(_) => ErrorCode::SubjectInvalid,
            JetStreamError::InvalidArgument(_) => ErrorCode::InvalidArgument,
            JetStreamError::Core(inner) => inner.code(),
        }
    }

    fn retriable(&self) -> bool {
        matches!(self, JetStreamError::Core(inner) if inner.retriable())
    }
}

impl From<JetStreamError> for CoreError {
    fn from(err: JetStreamError) -> Self {
        if let JetStreamError::Core(inner) = err {
            return inner;
        }
        let (code, retriable) = (err.code(), err.retriable());
        CoreError::coded(code, err.to_string(), retriable)
    }
}
