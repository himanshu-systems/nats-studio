//! The [`InspectorError`] domain error.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

#[derive(Debug, thiserror::Error)]
pub enum InspectorError {
    #[error("invalid json: {0}")]
    InvalidJson(String),
    #[error("decompression failed: {0}")]
    Decompress(String),
    #[error("decompression limit exceeded (>{limit} bytes)")]
    DecompressionLimit { limit: usize },
    #[error("payload is not valid UTF-8")]
    NotUtf8,
}

impl DomainError for InspectorError {
    fn code(&self) -> ErrorCode {
        match self {
            InspectorError::InvalidJson(_)
            | InspectorError::Decompress(_)
            | InspectorError::NotUtf8 => ErrorCode::PayloadDecodeFailed,
            InspectorError::DecompressionLimit { .. } => ErrorCode::DecompressionLimit,
        }
    }
}

impl From<InspectorError> for CoreError {
    fn from(err: InspectorError) -> Self {
        CoreError::coded(err.code(), err.to_string(), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_codes() {
        assert_eq!(
            InspectorError::InvalidJson("x".into()).code(),
            ErrorCode::PayloadDecodeFailed
        );
        assert_eq!(
            InspectorError::DecompressionLimit { limit: 10 }.code(),
            ErrorCode::DecompressionLimit
        );
    }
}
