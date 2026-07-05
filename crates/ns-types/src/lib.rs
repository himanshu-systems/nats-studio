//! ns-types — the frozen source of truth for every value that crosses the IPC
//! boundary. Rust -> TypeScript via typeshare. Additive-only; breaking changes
//! require an ADR + an `appSchemaVersion` bump.
//!
//! See docs/architecture/00-conventions-and-workspace.md (sections 6 & 7).
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// Stable, machine-actionable error codes shared verbatim with the frontend.
/// Serialized as SCREAMING_SNAKE_CASE strings (e.g. `CONNECTION_TIMEOUT`).
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ConnectionTimeout,
    ConnectionClosed,
    AuthFailed,
    TlsError,
    PermissionDenied,
    RequestTimeout,
    NoResponders,
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

/// Returned by the `app_info` command. Superset DTO per reconciliation (README section 8).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub app_schema_version: u32,
    pub plugin_api_version: String,
    pub os: String,
    pub arch: String,
    pub build_channel: String,
}
