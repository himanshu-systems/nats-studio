//! The JetStream management **port**: the trait seam feature services depend on
//! to operate on streams over a live connection. The `async-nats` JetStream
//! adapter (`ns-nats`) implements it; `ns-jetstream` depends only on this port +
//! the DTOs, so it never links `async-nats` (spine single-import confinement).

use async_trait::async_trait;
use ns_types::{ConsumerInfoDto, KvBucketDto, KvEntryDto, StreamConfigDto, StreamInfoDto};

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
    /// Delete a consumer from a stream by name.
    async fn delete_consumer(&self, stream: &str, name: &str) -> Result<(), CoreError>;

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
}
