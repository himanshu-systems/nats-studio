//! Event contract: the ambient-event envelope and payloads bridged to the WebView
//! (spine section 9). The internal `ns-event` bus produces these; the `EventBridge`
//! in `ns-ipc` is the only component that turns them into Tauri events.
//!
//! Additive: new `EventPayload` variants are appended as later phases land.

use crate::U64;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

use crate::connection::{ConnectionStatus, ServerInfoDto};

/// The wire envelope for a bridged application event.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEvent {
    /// Namespaced topic string, e.g. `ns://connection/status`.
    pub topic: String,
    pub connection_id: Option<String>,
    /// Monotonic per-topic sequence for UI gap detection.
    pub seq: U64,
    /// RFC-3339 timestamp.
    pub ts: String,
    pub payload: EventPayload,
}

/// The tagged union of everything the backend can broadcast to the UI.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "topic", content = "data", rename_all = "camelCase")]
pub enum EventPayload {
    ConnectionStatusChanged(ConnectionStatusDto),
    ServerInfoUpdated(ServerInfoUpdatedDto),
    MetricsTick(MetricsTickDto),
    LogEmitted(LogRecordDto),
    TaskProgress(TaskProgressDto),
    Notification(NotificationDto),
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatusDto {
    pub connection_id: String,
    pub status: ConnectionStatus,
    pub last_error: Option<String>,
    pub rtt_ms: Option<U64>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfoUpdatedDto {
    pub connection_id: String,
    pub server_info: ServerInfoDto,
}

/// Where a metrics frame originated (client-side counters vs server monitoring).
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricSource {
    Client,
    Server,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsTickDto {
    pub connection_id: String,
    pub source: MetricSource,
    pub in_msgs: U64,
    pub out_msgs: U64,
    pub in_bytes: U64,
    pub out_bytes: U64,
    pub rtt_ms: Option<U64>,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecordDto {
    pub ts: String,
    pub level: LogLevel,
    pub target: String,
    pub message: String,
    pub connection_id: Option<String>,
    pub correlation_id: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressDto {
    pub task_id: String,
    pub label: String,
    /// 0.0..=1.0 where known.
    pub progress: Option<f32>,
    pub done: bool,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationLevel {
    Info,
    Success,
    Warning,
    Error,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDto {
    pub id: String,
    pub level: NotificationLevel,
    pub title: String,
    pub body: Option<String>,
    pub ts: String,
}
