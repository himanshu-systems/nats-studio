//! Messaging wire contract: publish/subscribe/request DTOs, the decoded message
//! view for the UI, and the subscription stream event carried over a Channel.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

use crate::{IpcError, U64};

/// How a `payload` string in a request should be interpreted into bytes.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PayloadEncoding {
    Utf8,
    Base64,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageHeader {
    pub name: String,
    pub value: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    pub connection_id: String,
    pub subject: String,
    pub payload: String,
    pub encoding: PayloadEncoding,
    pub headers: Vec<MessageHeader>,
    pub reply: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    pub connection_id: String,
    pub subject: String,
    pub queue_group: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRequest {
    pub connection_id: String,
    pub subject: String,
    pub payload: String,
    pub encoding: PayloadEncoding,
    pub headers: Vec<MessageHeader>,
    pub timeout_ms: U64,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeRequest {
    pub subscription_id: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionHandle {
    pub subscription_id: String,
}

/// A decoded message delivered to the UI (from a subscription or a reply).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub seq: U64,
    pub subject: String,
    pub reply: Option<String>,
    pub headers: Vec<MessageHeader>,
    /// The raw payload bytes, base64-encoded.
    pub payload_base64: String,
    pub size: U64,
    /// Detected format: `json` | `text` | `binary` | `empty`.
    pub format: String,
    /// Detected compression: `none` | `gzip` | `zlib` | `zstd`.
    pub compression: String,
    /// A human-readable decoded preview.
    pub preview: String,
    /// RFC-3339 receive timestamp.
    pub ts: String,
}

/// Events delivered over a subscription's Tauri Channel.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum SubStreamEvent {
    Message(MessageView),
    Error(IpcError),
    Ended,
}
