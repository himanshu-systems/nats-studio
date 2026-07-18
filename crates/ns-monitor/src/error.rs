//! The [`MonitorError`] domain error.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

#[derive(Debug, thiserror::Error)]
pub enum MonitorError {
    /// The monitoring endpoint could not be reached (connect / timeout / HTTP status).
    #[error("monitor endpoint unreachable: {0}")]
    Unreachable(String),
    /// The response body was not the JSON we expected.
    #[error("failed to parse monitor response: {0}")]
    Parse(String),
}

impl DomainError for MonitorError {
    fn code(&self) -> ErrorCode {
        match self {
            MonitorError::Unreachable(_) => ErrorCode::MonitorUnreachable,
            MonitorError::Parse(_) => ErrorCode::MonitorParseError,
        }
    }

    fn retriable(&self) -> bool {
        matches!(self, MonitorError::Unreachable(_))
    }
}

impl From<MonitorError> for CoreError {
    fn from(err: MonitorError) -> Self {
        let (code, retriable) = (err.code(), err.retriable());
        CoreError::coded(code, err.to_string(), retriable)
    }
}

impl From<reqwest::Error> for MonitorError {
    fn from(err: reqwest::Error) -> Self {
        // A decode failure means we reached the server but the body was bad JSON;
        // everything else (connect, timeout, non-2xx status) is unreachable.
        if err.is_decode() {
            MonitorError::Parse(err.to_string())
        } else {
            MonitorError::Unreachable(err.to_string())
        }
    }
}
