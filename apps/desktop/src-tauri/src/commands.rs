//! The `#[tauri::command]` surface: thin handlers that delegate to the services
//! and map domain errors to the wire `IpcError` via `ns_ipc::map_ipc`.

use ns_core::SettingsRepo;
use ns_ipc::map_ipc;
use ns_types::{
    AppInfo, ConnectRequest, ConnectionProfile, ConnectionRef, ConnectionStatusDto,
    ConnectionSummary, CreateProfileRequest, DeleteProfileRequest, HealthStatus, IpcError,
    ListConnectionsResponse, ListProfilesResponse, LogRecordDto, Settings, UpdateProfileRequest,
    UpdateSettingsRequest,
};
use tauri::State;

use crate::state::AppState;

// --- app / settings ---------------------------------------------------------

#[tauri::command]
pub fn app_info() -> Result<AppInfo, IpcError> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        app_schema_version: ns_types::APP_SCHEMA_VERSION,
        plugin_api_version: "0.1.0".to_owned(),
        storage_schema_version: 1,
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        build_channel: if cfg!(debug_assertions) {
            "dev"
        } else {
            "stable"
        }
        .to_owned(),
    })
}

#[tauri::command]
pub async fn app_health(state: State<'_, AppState>) -> Result<HealthStatus, IpcError> {
    let uptime_ms = u64::try_from(state.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    let active =
        u32::try_from(state.connections.list_connections().await.len()).unwrap_or(u32::MAX);
    Ok(HealthStatus {
        healthy: true,
        uptime_ms,
        active_connections: active,
    })
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<Settings, IpcError> {
    let stored = map_ipc(state.settings_repo.load().await)?;
    Ok(stored.unwrap_or_else(ns_core::default_settings))
}

#[tauri::command]
pub async fn settings_update(
    req: UpdateSettingsRequest,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    map_ipc(state.settings_repo.save(&req.settings).await)
}

#[tauri::command]
pub async fn log_query(
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<LogRecordDto>, IpcError> {
    Ok(state.log_store.query(limit, None))
}

// --- connections ------------------------------------------------------------

#[tauri::command]
pub async fn connection_list_profiles(
    state: State<'_, AppState>,
) -> Result<ListProfilesResponse, IpcError> {
    let profiles = map_ipc(state.connections.list_profiles().await)?;
    Ok(ListProfilesResponse { profiles })
}

#[tauri::command]
pub async fn connection_create_profile(
    req: CreateProfileRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionProfile, IpcError> {
    map_ipc(state.connections.create_profile(req.profile).await)
}

#[tauri::command]
pub async fn connection_update_profile(
    req: UpdateProfileRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionProfile, IpcError> {
    map_ipc(state.connections.update_profile(req.profile).await)
}

#[tauri::command]
pub async fn connection_delete_profile(
    req: DeleteProfileRequest,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    map_ipc(state.connections.delete_profile(&req.id).await)
}

#[tauri::command]
pub async fn connection_connect(
    req: ConnectRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionSummary, IpcError> {
    map_ipc(state.connections.connect(&req.profile_id).await)
}

#[tauri::command]
pub async fn connection_disconnect(
    req: ConnectionRef,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    map_ipc(state.connections.disconnect(&req.connection_id).await)
}

#[tauri::command]
pub async fn connection_list(
    state: State<'_, AppState>,
) -> Result<ListConnectionsResponse, IpcError> {
    Ok(ListConnectionsResponse {
        connections: state.connections.list_connections().await,
    })
}

#[tauri::command]
pub async fn connection_get_status(
    req: ConnectionRef,
    state: State<'_, AppState>,
) -> Result<Option<ConnectionStatusDto>, IpcError> {
    Ok(state.connections.get_status(&req.connection_id).await)
}
