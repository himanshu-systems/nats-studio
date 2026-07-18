//! The `#[tauri::command]` surface: thin handlers that delegate to the services
//! and map domain errors to the wire `IpcError` via `ns_ipc::map_ipc`.

use ns_core::{SettingsRepo, SubscriptionId};
use ns_ipc::map_ipc;
use ns_types::{
    AppInfo, ConnectRequest, ConnectionProfile, ConnectionRef, ConnectionStatusDto,
    ConnectionSummary, ConnzDto, CreateProfileRequest, CreateStreamRequest, DeleteConsumerRequest,
    DeleteProfileRequest, DeleteStreamRequest, GetStreamRequest, HealthStatus, IpcError,
    KvDeleteRequest, KvGetRequest, KvGetResponse, KvPutRequest, KvPutResponse, ListBucketsRequest,
    ListBucketsResponse, ListConnectionsResponse, ListConsumersRequest, ListConsumersResponse,
    ListKeysRequest, ListKeysResponse, ListProfilesResponse, ListStreamsRequest,
    ListStreamsResponse, LogRecordDto, MessageView, MonitorRequest, PublishRequest,
    PurgeStreamRequest, PurgeStreamResponse, RequestRequest, Settings, StreamInfoDto,
    SubStreamEvent, SubscribeRequest, SubscriptionHandle, UnsubscribeRequest, UpdateProfileRequest,
    UpdateSettingsRequest, VarzDto,
};
use tauri::ipc::Channel;
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

// --- pub/sub ----------------------------------------------------------------

#[tauri::command]
pub async fn pubsub_publish(
    req: PublishRequest,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    map_ipc(state.pubsub.publish(req).await)
}

#[tauri::command]
pub async fn pubsub_request(
    req: RequestRequest,
    state: State<'_, AppState>,
) -> Result<MessageView, IpcError> {
    map_ipc(state.pubsub.request(req).await)
}

/// Open a streaming subscription. Each decoded message (and a final `ended`) is
/// delivered on `on_event` (a Tauri Channel). Cancel with `pubsub_unsubscribe`.
#[tauri::command]
pub async fn pubsub_subscribe(
    req: SubscribeRequest,
    on_event: Channel<SubStreamEvent>,
    state: State<'_, AppState>,
) -> Result<SubscriptionHandle, IpcError> {
    let mut subscription = map_ipc(state.pubsub.open_subscription(&req).await)?;
    let subscription_id = SubscriptionId::new().to_string();
    let cancel = state.subscriptions.register(&subscription_id);
    let pubsub = state.pubsub.clone();
    let registry = state.subscriptions.clone();
    let task_id = subscription_id.clone();

    tauri::async_runtime::spawn(async move {
        let mut seq: u64 = 0;
        loop {
            tokio::select! {
                () = cancel.cancelled() => {
                    let _ = subscription.unsubscribe().await;
                    break;
                }
                message = subscription.next() => match message {
                    Some(msg) => {
                        seq += 1;
                        if on_event.send(SubStreamEvent::Message(pubsub.view(seq, &msg))).is_err() {
                            break; // the WebView listener went away
                        }
                    }
                    None => {
                        let _ = on_event.send(SubStreamEvent::Ended);
                        break;
                    }
                }
            }
        }
        registry.remove(&task_id);
    });

    Ok(SubscriptionHandle { subscription_id })
}

#[tauri::command]
pub async fn pubsub_unsubscribe(
    req: UnsubscribeRequest,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    state.subscriptions.cancel(&req.subscription_id);
    Ok(())
}

// --- jetstream: streams ------------------------------------------------------

#[tauri::command]
pub async fn js_list_streams(
    req: ListStreamsRequest,
    state: State<'_, AppState>,
) -> Result<ListStreamsResponse, IpcError> {
    map_ipc(state.jetstream.list_streams(req).await)
}

#[tauri::command]
pub async fn js_get_stream(
    req: GetStreamRequest,
    state: State<'_, AppState>,
) -> Result<StreamInfoDto, IpcError> {
    map_ipc(state.jetstream.get_stream(req).await)
}

#[tauri::command]
pub async fn js_create_stream(
    req: CreateStreamRequest,
    state: State<'_, AppState>,
) -> Result<StreamInfoDto, IpcError> {
    map_ipc(state.jetstream.create_stream(req).await)
}

#[tauri::command]
pub async fn js_delete_stream(
    req: DeleteStreamRequest,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    map_ipc(state.jetstream.delete_stream(req).await)
}

#[tauri::command]
pub async fn js_purge_stream(
    req: PurgeStreamRequest,
    state: State<'_, AppState>,
) -> Result<PurgeStreamResponse, IpcError> {
    map_ipc(state.jetstream.purge_stream(req).await)
}

// --- jetstream: consumers ----------------------------------------------------

#[tauri::command]
pub async fn js_list_consumers(
    req: ListConsumersRequest,
    state: State<'_, AppState>,
) -> Result<ListConsumersResponse, IpcError> {
    map_ipc(state.jetstream.list_consumers(req).await)
}

#[tauri::command]
pub async fn js_delete_consumer(
    req: DeleteConsumerRequest,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    map_ipc(state.jetstream.delete_consumer(req).await)
}

// --- monitoring --------------------------------------------------------------

#[tauri::command]
pub async fn monitor_varz(
    req: MonitorRequest,
    state: State<'_, AppState>,
) -> Result<VarzDto, IpcError> {
    map_ipc(state.monitor.varz(&req.base_url).await)
}

#[tauri::command]
pub async fn monitor_connz(
    req: MonitorRequest,
    state: State<'_, AppState>,
) -> Result<ConnzDto, IpcError> {
    map_ipc(state.monitor.connz(&req.base_url).await)
}

// --- jetstream: key-value ----------------------------------------------------

#[tauri::command]
pub async fn js_list_buckets(
    req: ListBucketsRequest,
    state: State<'_, AppState>,
) -> Result<ListBucketsResponse, IpcError> {
    map_ipc(state.jetstream.list_buckets(req).await)
}

#[tauri::command]
pub async fn js_kv_keys(
    req: ListKeysRequest,
    state: State<'_, AppState>,
) -> Result<ListKeysResponse, IpcError> {
    map_ipc(state.jetstream.kv_keys(req).await)
}

#[tauri::command]
pub async fn js_kv_get(
    req: KvGetRequest,
    state: State<'_, AppState>,
) -> Result<KvGetResponse, IpcError> {
    map_ipc(state.jetstream.kv_get(req).await)
}

#[tauri::command]
pub async fn js_kv_put(
    req: KvPutRequest,
    state: State<'_, AppState>,
) -> Result<KvPutResponse, IpcError> {
    map_ipc(state.jetstream.kv_put(req).await)
}

#[tauri::command]
pub async fn js_kv_delete(
    req: KvDeleteRequest,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    map_ipc(state.jetstream.kv_delete(req).await)
}

// --- connection: ping (RTT) --------------------------------------------------

#[tauri::command]
pub async fn connection_ping(
    req: ConnectionRef,
    state: State<'_, AppState>,
) -> Result<u64, IpcError> {
    map_ipc(state.connections.ping(&req.connection_id).await)
}
