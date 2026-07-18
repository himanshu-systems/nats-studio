//! The [`SecurityError`] domain error for `ns-security`.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

/// A failure raised by `ns-security`'s public API — the [`crate::secret_store::KeyringSecretStore`]
/// port implementation, the [`crate::creds`] parser, and the [`crate::tls`] `rustls::ClientConfig`
/// builder.
#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    /// The OS keychain backend rejected an operation or is not reachable
    /// (locked wallet, no Secret Service bus on headless Linux, …).
    ///
    /// A *missing entry* is never this variant — `get` returns `Ok(None)` for
    /// that. This is reserved for the backend itself being unusable.
    #[error("secret store unavailable: {0}")]
    SecretStoreUnavailable(String),

    /// A `.creds` file failed to parse: a required armored block
    /// (`NATS USER JWT` or `USER NKEY SEED`) was missing, empty, or malformed.
    #[error("invalid .creds file: {0}")]
    CredsParse(String),

    /// Building a `rustls::ClientConfig` failed — a bad PEM, an unreadable
    /// CA/cert/key file, or a rustls-level configuration error.
    #[error("tls configuration error: {0}")]
    TlsBuild(String),

    /// A caller-supplied argument was invalid (e.g. an empty secret key).
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
}

impl DomainError for SecurityError {
    fn code(&self) -> ErrorCode {
        match self {
            SecurityError::SecretStoreUnavailable(_) => ErrorCode::SecretStoreUnavailable,
            SecurityError::CredsParse(_) => ErrorCode::AuthFailed,
            SecurityError::TlsBuild(_) => ErrorCode::TlsError,
            SecurityError::InvalidArgument(_) => ErrorCode::InvalidArgument,
        }
    }

    fn retriable(&self) -> bool {
        // A keychain that is momentarily locked/unreachable may succeed on a
        // later attempt; a parse or config error will not until the input
        // itself changes.
        matches!(self, SecurityError::SecretStoreUnavailable(_))
    }
}

impl From<SecurityError> for CoreError {
    fn from(err: SecurityError) -> Self {
        let retriable = err.retriable();
        CoreError::coded(err.code(), err.to_string(), retriable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_error_contract() {
        let unavailable = SecurityError::SecretStoreUnavailable("locked".into());
        assert_eq!(unavailable.code(), ErrorCode::SecretStoreUnavailable);
        assert!(unavailable.retriable());

        let creds = SecurityError::CredsParse("missing jwt block".into());
        assert_eq!(creds.code(), ErrorCode::AuthFailed);
        assert!(!creds.retriable());

        let tls = SecurityError::TlsBuild("bad PEM".into());
        assert_eq!(tls.code(), ErrorCode::TlsError);
        assert!(!tls.retriable());

        let invalid = SecurityError::InvalidArgument("empty key".into());
        assert_eq!(invalid.code(), ErrorCode::InvalidArgument);
        assert!(!invalid.retriable());
    }

    #[test]
    fn maps_into_core_error() {
        let core: CoreError = SecurityError::TlsBuild("x".into()).into();
        assert_eq!(core.code(), ErrorCode::TlsError);
        assert!(!core.retriable());
    }

    #[test]
    fn messages_are_preserved() {
        let err = SecurityError::CredsParse("boom".into());
        assert!(err.to_string().contains("boom"));
    }
}
