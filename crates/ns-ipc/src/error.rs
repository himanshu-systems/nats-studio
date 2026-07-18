//! The single mapping surface from any [`DomainError`] to the wire [`IpcError`]
//! (spine §7). Every `#[tauri::command]` funnels its error through here.

use ns_core::DomainError;
use ns_types::IpcError;

/// Convert any domain error into the secret-safe wire DTO, walking the
/// `std::error::Error::source()` chain into `causes`.
///
/// Callers pass a secret-safe error: `user_message()` must not contain secrets
/// (secret-bearing types are `Redacted`/`SecretString` and never render). This is
/// defense-in-depth's last hop, not its only one.
#[must_use]
pub fn to_ipc_error(err: &dyn DomainError) -> IpcError {
    let mut causes = Vec::new();
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        causes.push(cause.to_string());
        source = cause.source();
    }
    IpcError {
        code: err.code(),
        message: err.user_message(),
        retriable: err.retriable(),
        correlation_id: None,
        causes,
    }
}

/// Adapt a `Result<T, E: DomainError>` into the `Result<T, IpcError>` every
/// command returns. Use as `map_ipc(service.do_thing().await)`.
///
/// # Errors
/// Propagates the mapped [`IpcError`] when the input is `Err`.
pub fn map_ipc<T, E: DomainError>(result: Result<T, E>) -> Result<T, IpcError> {
    result.map_err(|e| to_ipc_error(&e))
}
