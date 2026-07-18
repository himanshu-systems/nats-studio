//! nats-studio — the desktop application (composition root).
//!
//! Boots telemetry, builds the `AppState` service registry (adapters injected
//! into services), starts the bus->WebView `EventBridge`, and registers the
//! command surface. See docs/architecture/implementation-roadmap.md (Phase 1).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The gnu (MinGW) dev toolchain emits a benign ".rsrc merge failure: multiple
// non-default manifests" linker warning (tauri embeds a manifest + MinGW's
// default). It does not occur under the MSVC target used for release bundles.
#![allow(linker_messages)]

mod commands;
mod state;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Layered tracing + in-app log ring (installs the global subscriber).
            let log_store = ns_telemetry::init_telemetry(10_000).map_err(|e| e.to_string())?;
            tracing::info!("starting NATS Studio");

            // Composition root: build the service registry (opens the DB, etc.).
            let handle = app.handle().clone();
            let app_state = tauri::async_runtime::block_on(state::build_state(&handle, log_store))
                .map_err(|e| e.to_string())?;

            // Start the only bus->Tauri translator, then hand state to Tauri.
            let bus = app_state.events.clone();
            app.manage(app_state);
            ns_ipc::start_event_bridge(handle, &bus);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_health,
            commands::settings_get,
            commands::settings_update,
            commands::log_query,
            commands::connection_list_profiles,
            commands::connection_create_profile,
            commands::connection_update_profile,
            commands::connection_delete_profile,
            commands::connection_connect,
            commands::connection_disconnect,
            commands::connection_list,
            commands::connection_get_status,
            commands::pubsub_publish,
            commands::pubsub_request,
            commands::pubsub_subscribe,
            commands::pubsub_unsubscribe,
            commands::js_list_streams,
            commands::js_get_stream,
            commands::js_create_stream,
            commands::js_delete_stream,
            commands::js_purge_stream,
            commands::js_list_consumers,
            commands::js_create_consumer,
            commands::js_delete_consumer,
            commands::js_fetch_messages,
            commands::js_list_buckets,
            commands::js_kv_keys,
            commands::js_kv_get,
            commands::js_kv_put,
            commands::js_kv_delete,
            commands::monitor_varz,
            commands::monitor_connz,
            commands::connection_ping,
            commands::js_get_messages,
            commands::js_delete_message,
            commands::js_list_object_buckets,
            commands::js_list_objects,
            commands::js_get_object,
            commands::js_delete_object,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the NATS Studio application");
}
