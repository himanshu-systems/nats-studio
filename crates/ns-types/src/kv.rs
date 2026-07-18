//! JetStream Key-Value wire contract: bucket summaries, key entries, and the
//! list / get / put / delete request-response DTOs. Additive-only; shared with
//! the frontend via typeshare. Binary values travel base64-encoded, exactly like
//! `MessageView.payloadBase64`.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

use crate::U64;

/// Summary of a KV bucket (a JetStream stream named `KV_<bucket>`).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBucketDto {
    pub bucket: String,
    /// Stored messages (keys incl. history revisions) — a rough "size".
    pub values: U64,
    /// Max history kept per key.
    pub history: u8,
    /// Per-key TTL in seconds; `0` = no TTL.
    pub ttl_seconds: U64,
    pub bytes: U64,
}

/// The latest entry for a key. `valueBase64` is the base64-encoded value bytes;
/// empty when the entry is a delete/purge marker.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvEntryDto {
    pub key: String,
    pub value_base64: String,
    pub revision: U64,
    /// True if the last operation on the key was a delete / purge.
    pub is_deleted: bool,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBucketsRequest {
    pub connection_id: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBucketsResponse {
    pub buckets: Vec<KvBucketDto>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListKeysRequest {
    pub connection_id: String,
    pub bucket: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListKeysResponse {
    pub keys: Vec<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvGetRequest {
    pub connection_id: String,
    pub bucket: String,
    pub key: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvGetResponse {
    pub entry: Option<KvEntryDto>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvPutRequest {
    pub connection_id: String,
    pub bucket: String,
    pub key: String,
    pub value_base64: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvPutResponse {
    pub revision: U64,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvDeleteRequest {
    pub connection_id: String,
    pub bucket: String,
    pub key: String,
}

/// Create a KV bucket (a JetStream stream named `KV_<bucket>`). `history` is the
/// max revisions kept per key; `ttlSeconds` `None`/`0` = no per-key TTL; `storage`
/// is `"file"` | `"memory"`.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvCreateBucketRequest {
    pub connection_id: String,
    pub bucket: String,
    pub history: u8,
    pub ttl_seconds: Option<U64>,
    pub storage: String,
}
