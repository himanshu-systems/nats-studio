//! JetStream Object-Store wire contract: bucket summaries, object info, and the
//! list / get / delete request-response DTOs. Additive-only; shared with the
//! frontend via typeshare. Object bytes travel base64-encoded, exactly like
//! `KvEntryDto.valueBase64`.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

use crate::U64;

/// Summary of an Object-Store bucket (a JetStream stream named `OBJ_<bucket>`).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectBucketDto {
    pub bucket: String,
    /// Stored messages in the backing stream (object meta + chunks) — a rough
    /// object count, not exact (an exact count needs a per-bucket list).
    pub objects: U64,
    pub size: U64,
}

/// Metadata for a single stored object.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfoDto {
    pub name: String,
    pub size: U64,
    pub digest: Option<String>,
    pub modified_rfc3339: String,
    pub deleted: bool,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectBucketsRequest {
    pub connection_id: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectBucketsResponse {
    pub buckets: Vec<ObjectBucketDto>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectsRequest {
    pub connection_id: String,
    pub bucket: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectsResponse {
    pub objects: Vec<ObjectInfoDto>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetObjectRequest {
    pub connection_id: String,
    pub bucket: String,
    pub name: String,
}

/// A small object's bytes, base64-encoded. Capped by the adapter (larger objects
/// return an error rather than a body).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetObjectResponse {
    pub name: String,
    pub size: U64,
    pub data_base64: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteObjectRequest {
    pub connection_id: String,
    pub bucket: String,
    pub name: String,
}

/// Create an Object-Store bucket (a JetStream stream named `OBJ_<bucket>`).
/// `ttlSeconds` `None`/`0` = no object TTL; `storage` is `"file"` | `"memory"`.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectCreateBucketRequest {
    pub connection_id: String,
    pub bucket: String,
    pub ttl_seconds: Option<U64>,
    pub storage: String,
}

/// Upload an object into a bucket. `dataBase64` is the object's bytes,
/// base64-encoded (exactly like `KvPutRequest.valueBase64`).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectPutRequest {
    pub connection_id: String,
    pub bucket: String,
    pub name: String,
    pub data_base64: String,
}
