//! The JetStream management **port**: the trait seam feature services depend on
//! to operate on streams over a live connection. The `async-nats` JetStream
//! adapter (`ns-nats`) implements it; `ns-jetstream` depends only on this port +
//! the DTOs, so it never links `async-nats` (spine single-import confinement).

use async_trait::async_trait;
use ns_types::{
    ConsumerConfigDto, ConsumerInfoDto, FetchMessagesResponse, GetMessagesResponse,
    GetObjectResponse, KvBucketDto, KvEntryDto, ObjectBucketDto, ObjectInfoDto, StreamConfigDto,
    StreamInfoDto,
};

use crate::CoreError;

/// A stream purge specification. `keep` and `up_to_seq` are mutually exclusive at
/// the server; the adapter prefers `keep`, then `up_to_seq`, else purges all.
#[derive(Debug, Clone, Default)]
pub struct PurgeSpec {
    /// Purge only messages on this subject.
    pub filter: Option<String>,
    /// Keep this many of the newest messages, purge the rest.
    pub keep: Option<u64>,
    /// Purge up to (but not including) this sequence.
    pub up_to_seq: Option<u64>,
}

/// Management operations on JetStream streams, resolved from a live client.
#[async_trait]
pub trait JetStreamManager: Send + Sync {
    /// All streams' info for the account.
    async fn list_streams(&self) -> Result<Vec<StreamInfoDto>, CoreError>;
    /// Info for a single stream by name.
    async fn get_stream(&self, name: &str) -> Result<StreamInfoDto, CoreError>;
    /// Create a stream from the given configuration.
    async fn create_stream(&self, config: StreamConfigDto) -> Result<StreamInfoDto, CoreError>;
    /// Update an existing stream's configuration.
    async fn update_stream(&self, config: StreamConfigDto) -> Result<StreamInfoDto, CoreError>;
    /// Delete a stream by name.
    async fn delete_stream(&self, name: &str) -> Result<(), CoreError>;
    /// Purge messages from a stream; returns the number of purged messages.
    async fn purge_stream(&self, name: &str, spec: PurgeSpec) -> Result<u64, CoreError>;
    /// All consumers of a given stream.
    async fn list_consumers(&self, stream: &str) -> Result<Vec<ConsumerInfoDto>, CoreError>;
    /// Create a durable pull consumer on a stream from the given configuration.
    async fn create_consumer(
        &self,
        stream: &str,
        config: ConsumerConfigDto,
    ) -> Result<ConsumerInfoDto, CoreError>;
    /// Delete a consumer from a stream by name.
    async fn delete_consumer(&self, stream: &str, name: &str) -> Result<(), CoreError>;
    /// Pull up to `batch` messages from a pull consumer WITHOUT acking them, so the
    /// caller can ack/nak/term each via its ACK reply subject. Errors if the named
    /// consumer is not a pull consumer.
    async fn fetch_messages(
        &self,
        stream: &str,
        consumer: &str,
        batch: u32,
    ) -> Result<FetchMessagesResponse, CoreError>;
    /// Read up to `limit` stored messages from `start_seq`, skipping deleted gaps;
    /// the response carries the stream's first/last sequence for pagination.
    async fn get_messages(
        &self,
        stream: &str,
        start_seq: u64,
        limit: u32,
    ) -> Result<GetMessagesResponse, CoreError>;
    /// Delete a single message from a stream by sequence.
    async fn delete_message(&self, stream: &str, seq: u64) -> Result<(), CoreError>;

    // --- Key-Value ---------------------------------------------------------

    /// All KV buckets in the account.
    async fn list_buckets(&self) -> Result<Vec<KvBucketDto>, CoreError>;
    /// The (non-deleted) keys of a KV bucket.
    async fn kv_keys(&self, bucket: &str) -> Result<Vec<String>, CoreError>;
    /// The latest entry for a key, or `None` if it was never written.
    async fn kv_get(&self, bucket: &str, key: &str) -> Result<Option<KvEntryDto>, CoreError>;
    /// Put a value into a key; returns the new revision.
    async fn kv_put(&self, bucket: &str, key: &str, value: Vec<u8>) -> Result<u64, CoreError>;
    /// Delete a key (writes a delete marker).
    async fn kv_delete(&self, bucket: &str, key: &str) -> Result<(), CoreError>;

    // --- Object Store ------------------------------------------------------

    /// All Object-Store buckets in the account.
    async fn list_object_buckets(&self) -> Result<Vec<ObjectBucketDto>, CoreError>;
    /// Info for every (non-deleted) object in a bucket.
    async fn list_objects(&self, bucket: &str) -> Result<Vec<ObjectInfoDto>, CoreError>;
    /// Fetch a small object's bytes (base64-encoded by the adapter); errors if the
    /// object exceeds the preview cap.
    async fn get_object(&self, bucket: &str, name: &str) -> Result<GetObjectResponse, CoreError>;
    /// Delete an object from a bucket.
    async fn delete_object(&self, bucket: &str, name: &str) -> Result<(), CoreError>;
}
