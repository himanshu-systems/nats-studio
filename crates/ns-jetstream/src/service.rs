//! [`JetStreamService`] — JetStream stream management on top of the `ns-core`
//! `NatsClientProvider` + `JetStreamManager` ports. Each call resolves the live
//! client for the request's connection, obtains its JetStream handle, validates
//! inputs, then delegates to the port. No dependency on `async-nats`.

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ns_core::{NatsClientProvider, PurgeSpec};
use ns_types::{
    ConsumerInfoDto, CreateConsumerRequest, CreateStreamRequest, DeleteConsumerRequest,
    DeleteMessageRequest, DeleteObjectRequest, DeleteStreamRequest, FetchMessagesRequest,
    FetchMessagesResponse, GetMessagesRequest, GetMessagesResponse, GetObjectRequest,
    GetObjectResponse, GetStreamRequest, KvCreateBucketRequest, KvDeleteRequest, KvGetRequest,
    KvGetResponse, KvPutRequest, KvPutResponse, ListBucketsRequest, ListBucketsResponse,
    ListConsumersRequest, ListConsumersResponse, ListKeysRequest, ListKeysResponse,
    ListObjectBucketsRequest, ListObjectBucketsResponse, ListObjectsRequest, ListObjectsResponse,
    ListStreamsRequest, ListStreamsResponse, ObjectCreateBucketRequest, ObjectInfoDto,
    ObjectPutRequest, ObjectStreamRequest, PurgeStreamRequest, PurgeStreamResponse, StreamInfoDto,
};

use crate::error::JetStreamError;

/// Stream management (list / get / create / delete / purge) over a live connection.
pub struct JetStreamService {
    provider: Arc<dyn NatsClientProvider>,
}

impl JetStreamService {
    #[must_use]
    pub fn new(provider: Arc<dyn NatsClientProvider>) -> Self {
        Self { provider }
    }

    /// List every stream in the account.
    pub async fn list_streams(
        &self,
        req: ListStreamsRequest,
    ) -> Result<ListStreamsResponse, JetStreamError> {
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let streams = js.list_streams().await?;
        Ok(ListStreamsResponse { streams })
    }

    /// Fetch a single stream by name.
    pub async fn get_stream(&self, req: GetStreamRequest) -> Result<StreamInfoDto, JetStreamError> {
        let name = require_name(&req.name)?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        Ok(js.get_stream(name).await?)
    }

    /// Create a stream from the given configuration.
    pub async fn create_stream(
        &self,
        req: CreateStreamRequest,
    ) -> Result<StreamInfoDto, JetStreamError> {
        require_name(&req.config.name)?;
        if req.config.subjects.iter().all(|s| s.trim().is_empty()) {
            return Err(JetStreamError::InvalidSubject(
                "at least one non-empty subject is required".to_owned(),
            ));
        }
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        Ok(js.create_stream(req.config).await?)
    }

    /// Delete a stream by name.
    pub async fn delete_stream(&self, req: DeleteStreamRequest) -> Result<(), JetStreamError> {
        let name = require_name(&req.name)?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        js.delete_stream(name).await?;
        Ok(())
    }

    /// Purge messages from a stream (all / by subject / keep N / up-to-seq).
    pub async fn purge_stream(
        &self,
        req: PurgeStreamRequest,
    ) -> Result<PurgeStreamResponse, JetStreamError> {
        let name = require_name(&req.name)?;
        let spec = PurgeSpec {
            filter: req.filter.filter(|f| !f.trim().is_empty()),
            keep: req.keep,
            up_to_seq: req.up_to_seq,
        };
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let purged = js.purge_stream(name, spec).await?;
        Ok(PurgeStreamResponse { purged })
    }

    /// List a stream's consumers.
    pub async fn list_consumers(
        &self,
        req: ListConsumersRequest,
    ) -> Result<ListConsumersResponse, JetStreamError> {
        let stream = require_name(&req.stream_name)?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let consumers = js.list_consumers(stream).await?;
        Ok(ListConsumersResponse { consumers })
    }

    /// Create a durable pull consumer on a stream.
    pub async fn create_consumer(
        &self,
        req: CreateConsumerRequest,
    ) -> Result<ConsumerInfoDto, JetStreamError> {
        let stream = require_name(&req.stream_name)?;
        if req.config.durable_name.trim().is_empty() {
            return Err(JetStreamError::InvalidName(
                "consumer durable name is empty".to_owned(),
            ));
        }
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        Ok(js.create_consumer(stream, req.config).await?)
    }

    /// Delete a consumer from a stream by name.
    pub async fn delete_consumer(&self, req: DeleteConsumerRequest) -> Result<(), JetStreamError> {
        let stream = require_name(&req.stream_name)?;
        let name = req.name.trim();
        if name.is_empty() {
            return Err(JetStreamError::InvalidName(
                "consumer name is empty".to_owned(),
            ));
        }
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        js.delete_consumer(stream, name).await?;
        Ok(())
    }

    /// Pull a batch of messages from a pull consumer, left un-acked so the caller
    /// can ack / nak / term each via its ACK reply subject.
    pub async fn fetch_messages(
        &self,
        req: FetchMessagesRequest,
    ) -> Result<FetchMessagesResponse, JetStreamError> {
        let stream = require_name(&req.stream)?;
        let consumer = req.consumer.trim();
        if consumer.is_empty() {
            return Err(JetStreamError::InvalidName(
                "consumer name is empty".to_owned(),
            ));
        }
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        Ok(js.fetch_messages(stream, consumer, req.batch).await?)
    }

    // --- Message browser -----------------------------------------------------

    /// Read a page of stored messages from a stream, starting at `start_seq`.
    pub async fn get_messages(
        &self,
        req: GetMessagesRequest,
    ) -> Result<GetMessagesResponse, JetStreamError> {
        let stream = require_name(&req.stream)?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        Ok(js.get_messages(stream, req.start_seq, req.limit).await?)
    }

    /// Delete a single message from a stream by sequence.
    pub async fn delete_message(&self, req: DeleteMessageRequest) -> Result<(), JetStreamError> {
        let stream = require_name(&req.stream)?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        js.delete_message(stream, req.seq).await?;
        Ok(())
    }

    // --- Key-Value -----------------------------------------------------------

    /// List every KV bucket in the account.
    pub async fn list_buckets(
        &self,
        req: ListBucketsRequest,
    ) -> Result<ListBucketsResponse, JetStreamError> {
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let buckets = js.list_buckets().await?;
        Ok(ListBucketsResponse { buckets })
    }

    /// List the keys in a bucket.
    pub async fn kv_keys(&self, req: ListKeysRequest) -> Result<ListKeysResponse, JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let keys = js.kv_keys(bucket).await?;
        Ok(ListKeysResponse { keys })
    }

    /// Get the latest entry for a key (value base64-encoded by the adapter).
    pub async fn kv_get(&self, req: KvGetRequest) -> Result<KvGetResponse, JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let key = require_arg(&req.key, "key")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let entry = js.kv_get(bucket, key).await?;
        Ok(KvGetResponse { entry })
    }

    /// Put a value (base64) into a key; returns the new revision.
    pub async fn kv_put(&self, req: KvPutRequest) -> Result<KvPutResponse, JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let key = require_arg(&req.key, "key")?;
        let value = BASE64.decode(req.value_base64.trim()).map_err(|e| {
            JetStreamError::InvalidArgument(format!("value is not valid base64: {e}"))
        })?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let revision = js.kv_put(bucket, key, value).await?;
        Ok(KvPutResponse { revision })
    }

    /// Delete a key from a bucket.
    pub async fn kv_delete(&self, req: KvDeleteRequest) -> Result<(), JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let key = require_arg(&req.key, "key")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        js.kv_delete(bucket, key).await?;
        Ok(())
    }

    /// Create a KV bucket.
    pub async fn kv_create_bucket(&self, req: KvCreateBucketRequest) -> Result<(), JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        js.kv_create_bucket(bucket, req.history, req.ttl_seconds, &req.storage)
            .await?;
        Ok(())
    }

    // --- Object Store --------------------------------------------------------

    /// List every Object-Store bucket in the account.
    pub async fn list_object_buckets(
        &self,
        req: ListObjectBucketsRequest,
    ) -> Result<ListObjectBucketsResponse, JetStreamError> {
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let buckets = js.list_object_buckets().await?;
        Ok(ListObjectBucketsResponse { buckets })
    }

    /// List the objects in a bucket.
    pub async fn list_objects(
        &self,
        req: ListObjectsRequest,
    ) -> Result<ListObjectsResponse, JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        let objects = js.list_objects(bucket).await?;
        Ok(ListObjectsResponse { objects })
    }

    /// Fetch a small object's bytes (base64-encoded by the adapter).
    pub async fn get_object(
        &self,
        req: GetObjectRequest,
    ) -> Result<GetObjectResponse, JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let name = require_arg(&req.name, "name")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        Ok(js.get_object(bucket, name).await?)
    }

    /// Delete an object from a bucket.
    pub async fn delete_object(&self, req: DeleteObjectRequest) -> Result<(), JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let name = require_arg(&req.name, "name")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        js.delete_object(bucket, name).await?;
        Ok(())
    }

    /// Create an Object-Store bucket.
    pub async fn object_create_bucket(
        &self,
        req: ObjectCreateBucketRequest,
    ) -> Result<(), JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        js.object_create_bucket(bucket, req.ttl_seconds, &req.storage)
            .await?;
        Ok(())
    }

    /// Upload an object (base64) into a bucket; returns its stored info.
    pub async fn object_put(&self, req: ObjectPutRequest) -> Result<ObjectInfoDto, JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let name = require_arg(&req.name, "name")?;
        let data = BASE64.decode(req.data_base64.trim()).map_err(|e| {
            JetStreamError::InvalidArgument(format!("data is not valid base64: {e}"))
        })?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        Ok(js.object_put(bucket, name, data).await?)
    }

    /// Stream a local file into an object (uncapped), forwarding progress ticks.
    pub async fn object_put_file(
        &self,
        req: ObjectStreamRequest,
        progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<ObjectInfoDto, JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let name = require_arg(&req.name, "name")?;
        let path = require_arg(&req.path, "path")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        Ok(js.object_put_file(bucket, name, path, progress).await?)
    }

    /// Stream an object to a local file (uncapped), forwarding progress ticks.
    pub async fn object_get_file(
        &self,
        req: ObjectStreamRequest,
        progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), JetStreamError> {
        let bucket = require_arg(&req.bucket, "bucket")?;
        let name = require_arg(&req.name, "name")?;
        let path = require_arg(&req.path, "path")?;
        let js = self
            .provider
            .client(&req.connection_id)
            .await?
            .jetstream()
            .await?;
        js.object_get_file(bucket, name, path, progress).await?;
        Ok(())
    }
}

/// Validate a stream name is non-empty, returning the trimmed borrow.
fn require_name(name: &str) -> Result<&str, JetStreamError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(JetStreamError::InvalidName(
            "stream name is empty".to_owned(),
        ));
    }
    Ok(trimmed)
}

/// Validate a KV bucket/key argument is non-empty, returning the trimmed borrow.
fn require_arg<'a>(value: &'a str, what: &str) -> Result<&'a str, JetStreamError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(JetStreamError::InvalidArgument(format!("{what} is empty")));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use ns_core::{
        CoreError, IncomingMessage, JetStreamManager, NatsClient, NatsClientProvider,
        OutgoingMessage, PurgeSpec, Subscription,
    };
    use ns_types::{
        ConsumerConfigDto, ConsumerInfoDto, CreateConsumerRequest, ErrorCode,
        FetchMessagesResponse, FetchedMessageDto, GetMessagesResponse, GetObjectResponse,
        KvBucketDto, KvCreateBucketRequest, KvEntryDto, ObjectBucketDto, ObjectCreateBucketRequest,
        ObjectInfoDto, ObjectPutRequest, ServerInfoDto, StoredMessageDto, StreamConfigDto,
        StreamDiscard, StreamInfoDto, StreamRetention, StreamStateDto, StreamStorage,
    };

    use super::*;

    fn sample_info(name: &str) -> StreamInfoDto {
        StreamInfoDto {
            config: StreamConfigDto {
                name: name.to_owned(),
                subjects: vec![format!("{name}.>")],
                retention: StreamRetention::Limits,
                storage: StreamStorage::File,
                discard: StreamDiscard::Old,
                max_messages: None,
                max_bytes: None,
                max_age_ms: None,
                max_message_size: None,
                num_replicas: 1,
                duplicate_window_ms: None,
                description: None,
            },
            state: StreamStateDto {
                messages: 0,
                bytes: 0,
                first_seq: 0,
                last_seq: 0,
                consumer_count: 0,
                num_subjects: 1,
                num_deleted: 0,
            },
            created_rfc3339: "2024-01-01T00:00:00Z".to_owned(),
            cluster: None,
        }
    }

    fn sample_consumer(stream: &str, name: &str) -> ConsumerInfoDto {
        ConsumerInfoDto {
            name: name.to_owned(),
            stream_name: stream.to_owned(),
            durable_name: Some(name.to_owned()),
            deliver_policy: "all".to_owned(),
            ack_policy: "explicit".to_owned(),
            filter_subject: None,
            num_pending: 0,
            num_ack_pending: 0,
            num_redelivered: 0,
            num_waiting: 0,
            ack_floor_stream_seq: 0,
            delivered_stream_seq: 0,
        }
    }

    fn sample_consumer_config(durable: &str) -> ConsumerConfigDto {
        ConsumerConfigDto {
            durable_name: durable.to_owned(),
            filter_subject: None,
            ack_policy: "explicit".to_owned(),
            deliver_policy: "all".to_owned(),
            max_deliver: None,
            ack_wait_seconds: None,
        }
    }

    fn sample_bucket(name: &str) -> KvBucketDto {
        KvBucketDto {
            bucket: name.to_owned(),
            values: 3,
            history: 5,
            ttl_seconds: 0,
            bytes: 128,
        }
    }

    fn sample_object_bucket(name: &str) -> ObjectBucketDto {
        ObjectBucketDto {
            bucket: name.to_owned(),
            objects: 2,
            size: 4096,
        }
    }

    fn sample_object(name: &str) -> ObjectInfoDto {
        ObjectInfoDto {
            name: name.to_owned(),
            size: 5,
            digest: Some("SHA-256=abc".to_owned()),
            modified_rfc3339: "2024-01-01T00:00:00Z".to_owned(),
            deleted: false,
        }
    }

    #[derive(Default)]
    struct MockJetStream {
        created: Mutex<Vec<StreamConfigDto>>,
        purged: Mutex<Vec<(String, PurgeSpec)>>,
        deleted: Mutex<Vec<String>>,
        created_consumers: Mutex<Vec<(String, ConsumerConfigDto)>>,
        deleted_consumers: Mutex<Vec<(String, String)>>,
        deleted_messages: Mutex<Vec<(String, u64)>>,
        kv_puts: Mutex<Vec<(String, String, Vec<u8>)>>,
        kv_deletes: Mutex<Vec<(String, String)>>,
        deleted_objects: Mutex<Vec<(String, String)>>,
        #[allow(clippy::type_complexity)] // test mock: records call args, not a public type
        kv_created_buckets: Mutex<Vec<(String, u8, Option<u64>, String)>>,
        object_created_buckets: Mutex<Vec<(String, Option<u64>, String)>>,
        object_puts: Mutex<Vec<(String, String, Vec<u8>)>>,
    }

    #[async_trait]
    impl JetStreamManager for MockJetStream {
        async fn list_streams(&self) -> Result<Vec<StreamInfoDto>, CoreError> {
            Ok(vec![sample_info("orders"), sample_info("events")])
        }
        async fn get_stream(&self, name: &str) -> Result<StreamInfoDto, CoreError> {
            if name == "missing" {
                return Err(CoreError::coded(ErrorCode::StreamNotFound, "nope", false));
            }
            Ok(sample_info(name))
        }
        async fn create_stream(&self, config: StreamConfigDto) -> Result<StreamInfoDto, CoreError> {
            let info = sample_info(&config.name);
            self.created.lock().unwrap().push(config);
            Ok(info)
        }
        async fn update_stream(&self, config: StreamConfigDto) -> Result<StreamInfoDto, CoreError> {
            Ok(sample_info(&config.name))
        }
        async fn delete_stream(&self, name: &str) -> Result<(), CoreError> {
            self.deleted.lock().unwrap().push(name.to_owned());
            Ok(())
        }
        async fn purge_stream(&self, name: &str, spec: PurgeSpec) -> Result<u64, CoreError> {
            self.purged.lock().unwrap().push((name.to_owned(), spec));
            Ok(42)
        }
        async fn list_consumers(&self, stream: &str) -> Result<Vec<ConsumerInfoDto>, CoreError> {
            Ok(vec![
                sample_consumer(stream, "worker"),
                sample_consumer(stream, "audit"),
            ])
        }
        async fn create_consumer(
            &self,
            stream: &str,
            config: ConsumerConfigDto,
        ) -> Result<ConsumerInfoDto, CoreError> {
            let info = sample_consumer(stream, &config.durable_name);
            self.created_consumers
                .lock()
                .unwrap()
                .push((stream.to_owned(), config));
            Ok(info)
        }
        async fn delete_consumer(&self, stream: &str, name: &str) -> Result<(), CoreError> {
            self.deleted_consumers
                .lock()
                .unwrap()
                .push((stream.to_owned(), name.to_owned()));
            Ok(())
        }
        async fn fetch_messages(
            &self,
            _stream: &str,
            _consumer: &str,
            batch: u32,
        ) -> Result<FetchMessagesResponse, CoreError> {
            let n = (batch as u64).min(2);
            let messages = (0..n)
                .map(|i| FetchedMessageDto {
                    stream_seq: i + 1,
                    num_delivered: 1,
                    subject: "orders.new".to_owned(),
                    payload_base64: BASE64.encode(b"hi"),
                    size: 2,
                    ack_subject: format!("$JS.ACK.orders.worker.1.{}.1.0.0", i + 1),
                    headers: vec![],
                })
                .collect();
            Ok(FetchMessagesResponse { messages })
        }
        async fn get_messages(
            &self,
            _stream: &str,
            start_seq: u64,
            limit: u32,
        ) -> Result<GetMessagesResponse, CoreError> {
            let n = (limit as u64).min(2);
            let messages = (0..n)
                .map(|i| StoredMessageDto {
                    seq: start_seq + i,
                    subject: "orders.new".to_owned(),
                    time_rfc3339: "2024-01-01T00:00:00Z".to_owned(),
                    payload_base64: BASE64.encode(b"hi"),
                    size: 2,
                    headers: vec![],
                })
                .collect();
            Ok(GetMessagesResponse {
                messages,
                first_seq: 1,
                last_seq: 10,
            })
        }
        async fn delete_message(&self, stream: &str, seq: u64) -> Result<(), CoreError> {
            self.deleted_messages
                .lock()
                .unwrap()
                .push((stream.to_owned(), seq));
            Ok(())
        }
        async fn list_buckets(&self) -> Result<Vec<KvBucketDto>, CoreError> {
            Ok(vec![sample_bucket("config"), sample_bucket("sessions")])
        }
        async fn kv_keys(&self, _bucket: &str) -> Result<Vec<String>, CoreError> {
            Ok(vec!["alpha".to_owned(), "beta".to_owned()])
        }
        async fn kv_get(&self, _bucket: &str, key: &str) -> Result<Option<KvEntryDto>, CoreError> {
            Ok(Some(KvEntryDto {
                key: key.to_owned(),
                value_base64: BASE64.encode(b"hello"),
                revision: 7,
                is_deleted: false,
            }))
        }
        async fn kv_put(&self, bucket: &str, key: &str, value: Vec<u8>) -> Result<u64, CoreError> {
            self.kv_puts
                .lock()
                .unwrap()
                .push((bucket.to_owned(), key.to_owned(), value));
            Ok(99)
        }
        async fn kv_delete(&self, bucket: &str, key: &str) -> Result<(), CoreError> {
            self.kv_deletes
                .lock()
                .unwrap()
                .push((bucket.to_owned(), key.to_owned()));
            Ok(())
        }
        async fn kv_create_bucket(
            &self,
            bucket: &str,
            history: u8,
            ttl_secs: Option<u64>,
            storage: &str,
        ) -> Result<(), CoreError> {
            self.kv_created_buckets.lock().unwrap().push((
                bucket.to_owned(),
                history,
                ttl_secs,
                storage.to_owned(),
            ));
            Ok(())
        }
        async fn list_object_buckets(&self) -> Result<Vec<ObjectBucketDto>, CoreError> {
            Ok(vec![
                sample_object_bucket("assets"),
                sample_object_bucket("images"),
            ])
        }
        async fn list_objects(&self, _bucket: &str) -> Result<Vec<ObjectInfoDto>, CoreError> {
            Ok(vec![sample_object("logo.png")])
        }
        async fn get_object(
            &self,
            _bucket: &str,
            name: &str,
        ) -> Result<GetObjectResponse, CoreError> {
            Ok(GetObjectResponse {
                name: name.to_owned(),
                size: 5,
                data_base64: BASE64.encode(b"hello"),
            })
        }
        async fn delete_object(&self, bucket: &str, name: &str) -> Result<(), CoreError> {
            self.deleted_objects
                .lock()
                .unwrap()
                .push((bucket.to_owned(), name.to_owned()));
            Ok(())
        }
        async fn object_create_bucket(
            &self,
            bucket: &str,
            ttl_secs: Option<u64>,
            storage: &str,
        ) -> Result<(), CoreError> {
            self.object_created_buckets.lock().unwrap().push((
                bucket.to_owned(),
                ttl_secs,
                storage.to_owned(),
            ));
            Ok(())
        }
        async fn object_put(
            &self,
            bucket: &str,
            name: &str,
            data: Vec<u8>,
        ) -> Result<ObjectInfoDto, CoreError> {
            self.object_puts
                .lock()
                .unwrap()
                .push((bucket.to_owned(), name.to_owned(), data));
            Ok(sample_object(name))
        }
    }

    struct MockClient {
        js: Arc<MockJetStream>,
    }

    #[async_trait]
    impl NatsClient for MockClient {
        async fn server_info(&self) -> Option<ServerInfoDto> {
            None
        }
        async fn rtt(&self) -> Result<Duration, CoreError> {
            Ok(Duration::from_millis(1))
        }
        async fn flush(&self) -> Result<(), CoreError> {
            Ok(())
        }
        async fn drain(&self) -> Result<(), CoreError> {
            Ok(())
        }
        async fn publish(&self, _message: OutgoingMessage) -> Result<(), CoreError> {
            Ok(())
        }
        async fn subscribe(
            &self,
            _subject: &str,
            _queue_group: Option<String>,
        ) -> Result<Box<dyn Subscription>, CoreError> {
            Err(CoreError::coded(ErrorCode::Internal, "no sub", false))
        }
        async fn request(
            &self,
            _message: OutgoingMessage,
            _timeout: Duration,
        ) -> Result<IncomingMessage, CoreError> {
            Err(CoreError::coded(ErrorCode::Internal, "no request", false))
        }
        async fn jetstream(&self) -> Result<Arc<dyn JetStreamManager>, CoreError> {
            Ok(self.js.clone())
        }
    }

    struct MockProvider {
        js: Arc<MockJetStream>,
    }

    #[async_trait]
    impl NatsClientProvider for MockProvider {
        async fn client(&self, _connection_id: &str) -> Result<Arc<dyn NatsClient>, CoreError> {
            Ok(Arc::new(MockClient {
                js: self.js.clone(),
            }))
        }
    }

    fn service() -> (JetStreamService, Arc<MockJetStream>) {
        let js = Arc::new(MockJetStream::default());
        let provider = Arc::new(MockProvider { js: js.clone() });
        (JetStreamService::new(provider), js)
    }

    #[tokio::test]
    async fn list_streams_returns_all() {
        let (svc, _) = service();
        let resp = svc
            .list_streams(ListStreamsRequest {
                connection_id: "c1".into(),
            })
            .await
            .unwrap();
        assert_eq!(resp.streams.len(), 2);
        assert_eq!(resp.streams[0].config.name, "orders");
    }

    #[tokio::test]
    async fn create_requires_name_and_subject() {
        let (svc, js) = service();

        // Empty name -> InvalidName, never reaches the port.
        let err = svc
            .create_stream(CreateStreamRequest {
                connection_id: "c1".into(),
                config: {
                    let mut c = sample_info("x").config;
                    c.name = "  ".into();
                    c
                },
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidName(_)));

        // Empty subjects -> InvalidSubject.
        let err = svc
            .create_stream(CreateStreamRequest {
                connection_id: "c1".into(),
                config: {
                    let mut c = sample_info("orders").config;
                    c.subjects = vec![];
                    c
                },
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidSubject(_)));
        assert!(js.created.lock().unwrap().is_empty());

        // Valid -> delegates to the port.
        let info = svc
            .create_stream(CreateStreamRequest {
                connection_id: "c1".into(),
                config: sample_info("orders").config,
            })
            .await
            .unwrap();
        assert_eq!(info.config.name, "orders");
        assert_eq!(js.created.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn purge_maps_spec_and_returns_count() {
        let (svc, js) = service();
        let resp = svc
            .purge_stream(PurgeStreamRequest {
                connection_id: "c1".into(),
                name: "orders".into(),
                filter: Some("orders.eu".into()),
                keep: Some(10),
                up_to_seq: None,
            })
            .await
            .unwrap();
        assert_eq!(resp.purged, 42);

        let purged = js.purged.lock().unwrap();
        assert_eq!(purged.len(), 1);
        assert_eq!(purged[0].0, "orders");
        assert_eq!(purged[0].1.keep, Some(10));
        assert_eq!(purged[0].1.filter.as_deref(), Some("orders.eu"));
    }

    #[tokio::test]
    async fn get_missing_stream_bubbles_not_found() {
        let (svc, _) = service();
        let err = svc
            .get_stream(GetStreamRequest {
                connection_id: "c1".into(),
                name: "missing".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::Core(_)));
        assert_eq!(ns_core::DomainError::code(&err), ErrorCode::StreamNotFound);
    }

    #[tokio::test]
    async fn list_consumers_requires_stream_then_delegates() {
        let (svc, js) = service();

        // Blank stream name -> InvalidName, never reaches the port.
        let err = svc
            .list_consumers(ListConsumersRequest {
                connection_id: "c1".into(),
                stream_name: "  ".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidName(_)));

        // Valid -> returns the stream's consumers.
        let resp = svc
            .list_consumers(ListConsumersRequest {
                connection_id: "c1".into(),
                stream_name: "orders".into(),
            })
            .await
            .unwrap();
        assert_eq!(resp.consumers.len(), 2);
        assert_eq!(resp.consumers[0].name, "worker");
        assert_eq!(resp.consumers[0].stream_name, "orders");

        // Blank consumer name -> InvalidName; delete of a valid one delegates.
        let err = svc
            .delete_consumer(DeleteConsumerRequest {
                connection_id: "c1".into(),
                stream_name: "orders".into(),
                name: " ".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidName(_)));

        svc.delete_consumer(DeleteConsumerRequest {
            connection_id: "c1".into(),
            stream_name: "orders".into(),
            name: "worker".into(),
        })
        .await
        .unwrap();
        let deleted = js.deleted_consumers.lock().unwrap();
        assert_eq!(deleted.as_slice(), &[("orders".into(), "worker".into())]);
    }

    #[tokio::test]
    async fn create_consumer_requires_durable_name_then_delegates() {
        let (svc, js) = service();

        // Blank durable name -> InvalidName, never reaches the port.
        let err = svc
            .create_consumer(CreateConsumerRequest {
                connection_id: "c1".into(),
                stream_name: "orders".into(),
                config: sample_consumer_config("  "),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidName(_)));
        assert!(js.created_consumers.lock().unwrap().is_empty());

        // Valid -> delegates to the port and returns the created consumer.
        let info = svc
            .create_consumer(CreateConsumerRequest {
                connection_id: "c1".into(),
                stream_name: "orders".into(),
                config: sample_consumer_config("worker"),
            })
            .await
            .unwrap();
        assert_eq!(info.name, "worker");
        assert_eq!(info.stream_name, "orders");

        let created = js.created_consumers.lock().unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].0, "orders");
        assert_eq!(created[0].1.durable_name, "worker");
    }

    #[tokio::test]
    async fn get_messages_requires_stream_then_delegates() {
        let (svc, js) = service();

        // Blank stream name -> InvalidName, never reaches the port.
        let err = svc
            .get_messages(GetMessagesRequest {
                connection_id: "c1".into(),
                stream: "  ".into(),
                start_seq: 1,
                limit: 50,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidName(_)));

        // Valid -> returns a page plus the stream's first/last bounds.
        let resp = svc
            .get_messages(GetMessagesRequest {
                connection_id: "c1".into(),
                stream: "orders".into(),
                start_seq: 5,
                limit: 50,
            })
            .await
            .unwrap();
        assert_eq!(resp.messages.len(), 2);
        assert_eq!(resp.messages[0].seq, 5);
        assert_eq!(resp.last_seq, 10);

        // Delete delegates the (stream, seq) pair to the port.
        svc.delete_message(DeleteMessageRequest {
            connection_id: "c1".into(),
            stream: "orders".into(),
            seq: 7,
        })
        .await
        .unwrap();
        assert_eq!(
            js.deleted_messages.lock().unwrap().as_slice(),
            &[("orders".into(), 7)]
        );
    }

    #[tokio::test]
    async fn fetch_messages_validates_stream_and_consumer_then_delegates() {
        let (svc, _) = service();

        // Blank consumer -> InvalidName, never reaches the port.
        let err = svc
            .fetch_messages(FetchMessagesRequest {
                connection_id: "c1".into(),
                stream: "orders".into(),
                consumer: "  ".into(),
                batch: 10,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidName(_)));

        // Valid -> returns a batch of un-acked messages carrying their ack subjects.
        let resp = svc
            .fetch_messages(FetchMessagesRequest {
                connection_id: "c1".into(),
                stream: "orders".into(),
                consumer: "worker".into(),
                batch: 10,
            })
            .await
            .unwrap();
        assert_eq!(resp.messages.len(), 2);
        assert_eq!(resp.messages[0].stream_seq, 1);
        assert!(resp.messages[0].ack_subject.starts_with("$JS.ACK."));
    }

    #[tokio::test]
    async fn kv_put_validates_and_base64_decodes() {
        let (svc, js) = service();

        // Blank bucket -> InvalidArgument, never reaches the port.
        let err = svc
            .kv_put(KvPutRequest {
                connection_id: "c1".into(),
                bucket: "  ".into(),
                key: "k".into(),
                value_base64: BASE64.encode(b"x"),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidArgument(_)));
        assert!(js.kv_puts.lock().unwrap().is_empty());

        // Bad base64 -> InvalidArgument, never reaches the port.
        let err = svc
            .kv_put(KvPutRequest {
                connection_id: "c1".into(),
                bucket: "config".into(),
                key: "k".into(),
                value_base64: "not base64!!".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidArgument(_)));

        // Valid -> base64 is decoded to raw bytes at the port.
        let resp = svc
            .kv_put(KvPutRequest {
                connection_id: "c1".into(),
                bucket: "config".into(),
                key: "greeting".into(),
                value_base64: BASE64.encode(b"hello"),
            })
            .await
            .unwrap();
        assert_eq!(resp.revision, 99);

        let puts = js.kv_puts.lock().unwrap();
        assert_eq!(puts.len(), 1);
        assert_eq!(puts[0].0, "config");
        assert_eq!(puts[0].1, "greeting");
        assert_eq!(puts[0].2, b"hello");
    }

    #[tokio::test]
    async fn object_store_lists_gets_and_validates() {
        let (svc, js) = service();

        // Buckets come straight from the port.
        let resp = svc
            .list_object_buckets(ListObjectBucketsRequest {
                connection_id: "c1".into(),
            })
            .await
            .unwrap();
        assert_eq!(resp.buckets.len(), 2);
        assert_eq!(resp.buckets[0].bucket, "assets");

        // Blank bucket -> InvalidArgument, never reaches the port.
        let err = svc
            .list_objects(ListObjectsRequest {
                connection_id: "c1".into(),
                bucket: "  ".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidArgument(_)));

        let objs = svc
            .list_objects(ListObjectsRequest {
                connection_id: "c1".into(),
                bucket: "assets".into(),
            })
            .await
            .unwrap();
        assert_eq!(objs.objects.len(), 1);
        assert_eq!(objs.objects[0].name, "logo.png");

        // Get returns the (base64) bytes from the port.
        let got = svc
            .get_object(GetObjectRequest {
                connection_id: "c1".into(),
                bucket: "assets".into(),
                name: "logo.png".into(),
            })
            .await
            .unwrap();
        assert_eq!(got.data_base64, BASE64.encode(b"hello"));

        // Blank name on delete -> InvalidArgument; a valid one delegates.
        let err = svc
            .delete_object(DeleteObjectRequest {
                connection_id: "c1".into(),
                bucket: "assets".into(),
                name: " ".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidArgument(_)));

        svc.delete_object(DeleteObjectRequest {
            connection_id: "c1".into(),
            bucket: "assets".into(),
            name: "logo.png".into(),
        })
        .await
        .unwrap();
        assert_eq!(
            js.deleted_objects.lock().unwrap().as_slice(),
            &[("assets".into(), "logo.png".into())]
        );
    }

    #[tokio::test]
    async fn create_buckets_and_object_put_validate_then_delegate() {
        let (svc, js) = service();

        // KV + object bucket creation delegate their params to the port.
        svc.kv_create_bucket(KvCreateBucketRequest {
            connection_id: "c1".into(),
            bucket: "config".into(),
            history: 5,
            ttl_seconds: Some(3600),
            storage: "file".into(),
        })
        .await
        .unwrap();
        assert_eq!(
            js.kv_created_buckets.lock().unwrap().as_slice(),
            &[("config".into(), 5, Some(3600), "file".into())]
        );

        svc.object_create_bucket(ObjectCreateBucketRequest {
            connection_id: "c1".into(),
            bucket: "assets".into(),
            ttl_seconds: None,
            storage: "memory".into(),
        })
        .await
        .unwrap();
        assert_eq!(
            js.object_created_buckets.lock().unwrap().as_slice(),
            &[("assets".into(), None, "memory".into())]
        );

        // Blank name -> InvalidArgument, never reaches the port.
        let err = svc
            .object_put(ObjectPutRequest {
                connection_id: "c1".into(),
                bucket: "assets".into(),
                name: "  ".into(),
                data_base64: BASE64.encode(b"x"),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidArgument(_)));

        // Bad base64 -> InvalidArgument, never reaches the port.
        let err = svc
            .object_put(ObjectPutRequest {
                connection_id: "c1".into(),
                bucket: "assets".into(),
                name: "hello.txt".into(),
                data_base64: "not base64!!".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, JetStreamError::InvalidArgument(_)));
        assert!(js.object_puts.lock().unwrap().is_empty());

        // Valid -> base64 decoded to raw bytes at the port, info returned.
        let info = svc
            .object_put(ObjectPutRequest {
                connection_id: "c1".into(),
                bucket: "assets".into(),
                name: "hello.txt".into(),
                data_base64: BASE64.encode(b"hello"),
            })
            .await
            .unwrap();
        assert_eq!(info.name, "hello.txt");

        let puts = js.object_puts.lock().unwrap();
        assert_eq!(puts.len(), 1);
        assert_eq!(puts[0].0, "assets");
        assert_eq!(puts[0].1, "hello.txt");
        assert_eq!(puts[0].2, b"hello");
    }
}
