//! nats-studio — the desktop application (composition root).
//!
//! Phase 0: registers the `app_info` command and opens the main window. The full
//! `AppState` service registry, the `EventBridge`, and the subsystem commands
//! land in Phase 1 (see docs/architecture/implementation-roadmap.md).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ns_types::{AppInfo, IpcError};
use tracing_subscriber::EnvFilter;

/// The first real IPC round-trip. Returns the superset `AppInfo` DTO (README section 8).
#[tauri::command]
fn app_info() -> Result<AppInfo, IpcError> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        app_schema_version: ns_types::APP_SCHEMA_VERSION,
        plugin_api_version: "0.1.0".to_string(),
        storage_schema_version: 0, // no migrations applied yet (ns-storage lands next)
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        build_channel: if cfg!(debug_assertions) {
            "dev"
        } else {
            "stable"
        }
        .to_string(),
    })
}

fn main() {
    // Minimal tracing for Phase 0; the layered subscriber lands in ns-telemetry (Phase 1).
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("NS_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    tracing::info!("starting NATS Studio");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running the NATS Studio application");
}
