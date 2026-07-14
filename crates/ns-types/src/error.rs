//! Error wire contract: the stable `ErrorCode` enum and the `IpcError` DTO.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// Stable, machine-actionable error codes shared verbatim with the frontend.
/// Serialized as SCREAMING_SNAKE_CASE strings (e.g. `CONNECTION_TIMEOUT`).
///
/// This enum is append-only. New codes are added at the end of their group.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    // --- connection ---
    ConnectionTimeout,
    ConnectionClosed,
    AuthFailed,
    TlsError,
    PermissionDenied,
    // --- messaging ---
    RequestTimeout,
    NoResponders,
    SubjectInvalid,
    PayloadDecodeFailed,
    // --- jetstream / kv / object store ---
    JetstreamNotEnabled,
    StreamNotFound,
    ConsumerNotFound,
    KvKeyNotFound,
    KvWrongLastRevision,
    ObjectNotFound,
    // --- monitoring ---
    MonitorUnreachable,
    MonitorParseError,
    // --- storage / security ---
    Storage,
    MigrationFailed,
    SecretStoreUnavailable,
    // --- inspection / schema ---
    SchemaInvalid,
    DecompressionLimit,
    // --- terminal / plugin ---
    TerminalSpawnFailed,
    PluginError,
    PluginIncompatible,
    // --- generic ---
    Cancelled,
    Timeout,
    Serialization,
    Io,
    NotFound,
    InvalidArgument,
    Internal,
}

/// The single wire error DTO delivered to the frontend for every failed command.
/// Secret-safe: `message`/`causes` are redacted upstream. See spine section 7.4.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
    pub retriable: bool,
    pub correlation_id: Option<String>,
    pub causes: Vec<String>,
}

impl IpcError {
    /// Build an `IpcError` from its parts. Callers must pass a secret-safe message.
    pub fn new(code: ErrorCode, message: impl Into<String>, retriable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retriable,
            correlation_id: None,
            causes: Vec::new(),
        }
    }
}
