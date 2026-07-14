//! Application settings contract (`settings_*` commands).

use crate::U64;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// User-facing application settings. Persisted in SQLite; hot-reloadable.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: ThemePreference,
    pub log_level: String,
    pub telemetry_enabled: bool,
    pub default_request_timeout_ms: U64,
    pub max_history_entries: u32,
    pub confirm_destructive_actions: bool,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    pub settings: Settings,
}
