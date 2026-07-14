//! Application-level DTOs: `app_info`, `app_health`.

use crate::U64;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// The ns-types wire-contract version. Bumped on any breaking change to the DTOs
/// that cross the IPC boundary (ADR-0006). The frontend bindings are pinned to it.
pub const APP_SCHEMA_VERSION: u32 = 1;

/// Returned by the `app_info` command. Superset DTO per reconciliation (README section 8).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub app_schema_version: u32,
    pub plugin_api_version: String,
    pub storage_schema_version: u32,
    pub os: String,
    pub arch: String,
    pub build_channel: String,
}

/// Returned by the `app_health` command.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub healthy: bool,
    pub uptime_ms: U64,
    pub active_connections: u32,
}
