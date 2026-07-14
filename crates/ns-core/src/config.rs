//! Default application settings (the values used before the user changes anything
//! and the source of truth for a fresh SQLite install).

use ns_types::{Settings, ThemePreference};

/// The out-of-the-box settings for a new workspace.
#[must_use]
pub fn default_settings() -> Settings {
    Settings {
        theme: ThemePreference::System,
        log_level: "info".to_owned(),
        telemetry_enabled: false,
        default_request_timeout_ms: 5_000,
        max_history_entries: 5_000,
        confirm_destructive_actions: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let s = default_settings();
        assert!(!s.telemetry_enabled, "telemetry must be opt-in");
        assert!(s.confirm_destructive_actions);
        assert!(s.default_request_timeout_ms >= 1_000);
    }
}
