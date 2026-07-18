//! JetStream wire contract: stream configuration, live state, info, and the
//! request/response DTOs for list / get / create / delete / purge. Additive-only;
//! shared with the frontend via typeshare. Unlimited limits are modelled as
//! `Option<U64>` (`None` = unlimited) rather than the `-1` sentinel the server
//! uses on the wire.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

use crate::{MessageHeader, U64};

/// Where a stream keeps its data. Mirrors async-nats `StorageType`.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamStorage {
    File,
    Memory,
}

/// How messages are retained in a stream. Mirrors async-nats `RetentionPolicy`.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamRetention {
    Limits,
    Interest,
    WorkQueue,
}

/// What happens when a stream reaches its limits. Mirrors async-nats `DiscardPolicy`.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamDiscard {
    Old,
    New,
}

/// The editable configuration of a JetStream stream.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamConfigDto {
    pub name: String,
    pub subjects: Vec<String>,
    pub retention: StreamRetention,
    pub storage: StreamStorage,
    pub discard: StreamDiscard,
    /// Max messages before the discard policy kicks in. `None` = unlimited.
    pub max_messages: Option<U64>,
    /// Max total bytes before the discard policy kicks in. `None` = unlimited.
    pub max_bytes: Option<U64>,
    /// Max age of any message, in milliseconds. `None` = unlimited.
    pub max_age_ms: Option<U64>,
    /// Largest accepted message size, in bytes. `None` = unlimited.
    pub max_message_size: Option<U64>,
    /// Number of replicas (clustered JetStream). `0` lets the server default it.
    pub num_replicas: U64,
    /// Duplicate-tracking window, in milliseconds. `None` = server default.
    pub duplicate_window_ms: Option<U64>,
    pub description: Option<String>,
}

/// Live metrics for a stream.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStateDto {
    pub messages: U64,
    pub bytes: U64,
    pub first_seq: U64,
    pub last_seq: U64,
    pub consumer_count: U64,
    pub num_subjects: U64,
    pub num_deleted: U64,
}

/// A stream's configuration plus its current state.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfoDto {
    pub config: StreamConfigDto,
    pub state: StreamStateDto,
    /// RFC-3339 stream creation timestamp.
    pub created_rfc3339: String,
    /// Cluster name, if the stream is clustered.
    pub cluster: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStreamsRequest {
    pub connection_id: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStreamsResponse {
    pub streams: Vec<StreamInfoDto>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetStreamRequest {
    pub connection_id: String,
    pub name: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStreamRequest {
    pub connection_id: String,
    pub config: StreamConfigDto,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteStreamRequest {
    pub connection_id: String,
    pub name: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeStreamRequest {
    pub connection_id: String,
    pub name: String,
    /// Purge only messages on this subject.
    pub filter: Option<String>,
    /// Keep this many of the newest messages, purge the rest.
    pub keep: Option<U64>,
    /// Purge up to (but not including) this sequence.
    pub up_to_seq: Option<U64>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeStreamResponse {
    pub purged: U64,
}

/// A JetStream consumer's config summary plus its live delivery/ack counters.
/// `deliverPolicy`/`ackPolicy` are lowercase string tags of the async-nats enums.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerInfoDto {
    pub name: String,
    pub stream_name: String,
    /// `Some` for durable consumers, `None` for ephemeral.
    pub durable_name: Option<String>,
    pub deliver_policy: String,
    pub ack_policy: String,
    /// The single subject filter, if any (empty on the wire -> `None`).
    pub filter_subject: Option<String>,
    pub num_pending: U64,
    pub num_ack_pending: U64,
    pub num_redelivered: U64,
    pub num_waiting: U64,
    pub ack_floor_stream_seq: U64,
    pub delivered_stream_seq: U64,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConsumersRequest {
    pub connection_id: String,
    pub stream_name: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConsumersResponse {
    pub consumers: Vec<ConsumerInfoDto>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConsumerRequest {
    pub connection_id: String,
    pub stream_name: String,
    pub name: String,
}

// --- Message browser --------------------------------------------------------

/// A single stored JetStream message, fetched by sequence for the browser.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessageDto {
    pub seq: U64,
    pub subject: String,
    /// RFC-3339 store timestamp.
    pub time_rfc3339: String,
    /// The raw payload bytes, base64-encoded.
    pub payload_base64: String,
    pub size: U64,
    pub headers: Vec<MessageHeader>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMessagesRequest {
    pub connection_id: String,
    pub stream: String,
    /// First sequence to read from (clamped up to the stream's first seq).
    pub start_seq: U64,
    /// Max messages to return; the adapter caps this at 200.
    pub limit: u32,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMessagesResponse {
    pub messages: Vec<StoredMessageDto>,
    pub first_seq: U64,
    pub last_seq: U64,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMessageRequest {
    pub connection_id: String,
    pub stream: String,
    pub seq: U64,
}
