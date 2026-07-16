//! The [`TelemetryError`] domain error for `ns-telemetry`.

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;

/// A failure raised by `ns-telemetry`'s public API.
#[derive(Debug, thiserror::Error)]
pub enum TelemetryError {
    /// A directive string passed to [`crate::LogStore::set_level`] (or read
    /// from [`crate::NS_LOG_ENV_VAR`] at [`crate::init_telemetry`] time)
    /// failed to parse as an `EnvFilter` directive.
    #[error("invalid log filter directive {directive:?}")]
    InvalidDirective {
        directive: String,
        #[source]
        source: tracing_subscriber::filter::ParseError,
    },

    /// [`crate::LogStore::set_level`] was called on a store with no attached
    /// reload handle (built directly via [`crate::LogStore::new`] rather than
    /// returned by [`crate::init_telemetry`]).
    #[error("runtime log level control is unavailable on this store")]
    LevelControlUnavailable,

    /// The attached `EnvFilter` reload handle failed to apply the new
    /// filter. In practice this only occurs if the underlying subscriber has
    /// already been torn down.
    #[error("failed to reload the log level filter")]
    Reload(#[source] tracing_subscriber::reload::Error),

    /// [`crate::init_telemetry`] could not install the global `tracing`
    /// subscriber because one was already installed by a *different* caller
    /// (a repeat call from `ns-telemetry` itself is idempotent and returns
    /// `Ok` instead of this error — see [`crate::init_telemetry`]).
    #[error("a global tracing subscriber is already installed")]
    AlreadyInitialized,
}

impl From<tracing_subscriber::reload::Error> for TelemetryError {
    fn from(source: tracing_subscriber::reload::Error) -> Self {
        TelemetryError::Reload(source)
    }
}

impl DomainError for TelemetryError {
    fn code(&self) -> ErrorCode {
        match self {
            TelemetryError::InvalidDirective { .. } => ErrorCode::InvalidArgument,
            TelemetryError::LevelControlUnavailable
            | TelemetryError::Reload(_)
            | TelemetryError::AlreadyInitialized => ErrorCode::Internal,
        }
    }

    fn retriable(&self) -> bool {
        false
    }
}

impl From<TelemetryError> for CoreError {
    fn from(err: TelemetryError) -> Self {
        let retriable = err.retriable();
        CoreError::coded(err.code(), err.to_string(), retriable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::EnvFilter;

    #[test]
    fn domain_error_contract() {
        let unavailable = TelemetryError::LevelControlUnavailable;
        assert_eq!(unavailable.code(), ErrorCode::Internal);
        assert!(!unavailable.retriable());

        let already = TelemetryError::AlreadyInitialized;
        assert_eq!(already.code(), ErrorCode::Internal);
        assert!(!already.retriable());
    }

    #[test]
    fn invalid_directive_maps_to_invalid_argument() {
        let source = EnvFilter::try_new("bogus_target=not_a_real_level")
            .expect_err("not a valid level keyword");
        let err = TelemetryError::InvalidDirective {
            directive: "bogus_target=not_a_real_level".into(),
            source,
        };
        assert_eq!(err.code(), ErrorCode::InvalidArgument);
        assert!(err.to_string().contains("bogus_target"));
    }

    #[test]
    fn maps_into_core_error() {
        let core: CoreError = TelemetryError::LevelControlUnavailable.into();
        assert_eq!(core.code(), ErrorCode::Internal);
        assert!(!core.retriable());
    }
}
