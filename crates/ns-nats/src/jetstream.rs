//! The JetStream half of the `async-nats` adapter: [`AsyncJetStream`] wraps an
//! `async_nats::jetstream::Context` and implements the `ns_core::JetStreamManager`
//! port, translating our DTOs <-> async-nats `stream::{Config, Info, State}` and a
//! [`PurgeSpec`] into the type-state purge builder. This is the ONLY place the
//! JetStream API is touched (single-import confinement, spine 5.2.6).

use std::fmt::Display;
use std::time::Duration;

use async_nats::jetstream::{
    self,
    consumer::{self, AckPolicy, DeliverPolicy, PullConsumer},
    kv::{self, Operation},
    object_store::ObjectInfo,
    stream::{Config, DiscardPolicy, Info, RetentionPolicy, State, StorageType},
};
use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use futures::{StreamExt as _, TryStreamExt};
use ns_core::{CoreError, JetStreamManager, PurgeSpec};
use ns_types::{
    ConsumerConfigDto, ConsumerInfoDto, ErrorCode, FetchMessagesResponse, FetchedMessageDto,
    GetMessagesResponse, GetObjectResponse, KvBucketDto, KvEntryDto, MessageHeader,
    ObjectBucketDto, ObjectInfoDto, StoredMessageDto, StreamConfigDto, StreamDiscard,
    StreamInfoDto, StreamRetention, StreamStateDto, StreamStorage,
};
use time::format_description::well_known::Rfc3339;
use tokio::io::AsyncReadExt as _;

/// Largest object we'll pull into memory for a preview/download over IPC.
const MAX_OBJECT_PREVIEW: usize = 4 * 1024 * 1024;

/// A JetStream management handle over a live `async-nats` client.
pub struct AsyncJetStream {
    ctx: jetstream::Context,
}

impl AsyncJetStream {
    /// Build a JetStream context from a live client handle.
    #[must_use]
    pub fn new(client: async_nats::Client) -> Self {
        Self {
            ctx: async_nats::jetstream::new(client),
        }
    }
}

#[async_trait]
impl JetStreamManager for AsyncJetStream {
    async fn list_streams(&self) -> Result<Vec<StreamInfoDto>, CoreError> {
        let mut streams = self.ctx.streams();
        let mut out = Vec::new();
        while let Some(info) = streams
            .try_next()
            .await
            .map_err(|e| js_err("list streams", &e, ErrorCode::Internal))?
        {
            out.push(info_to_dto(&info)?);
        }
        Ok(out)
    }

    async fn get_stream(&self, name: &str) -> Result<StreamInfoDto, CoreError> {
        let stream = self
            .ctx
            .get_stream(name)
            .await
            .map_err(|e| js_err("get stream", &e, ErrorCode::StreamNotFound))?;
        info_to_dto(stream.cached_info())
    }

    async fn create_stream(&self, config: StreamConfigDto) -> Result<StreamInfoDto, CoreError> {
        let stream = self
            .ctx
            .create_stream(dto_to_config(config))
            .await
            .map_err(|e| js_err("create stream", &e, ErrorCode::Internal))?;
        info_to_dto(stream.cached_info())
    }

    async fn update_stream(&self, config: StreamConfigDto) -> Result<StreamInfoDto, CoreError> {
        let info = self
            .ctx
            .update_stream(&dto_to_config(config))
            .await
            .map_err(|e| js_err("update stream", &e, ErrorCode::Internal))?;
        info_to_dto(&info)
    }

    async fn delete_stream(&self, name: &str) -> Result<(), CoreError> {
        self.ctx
            .delete_stream(name)
            .await
            .map_err(|e| js_err("delete stream", &e, ErrorCode::StreamNotFound))?;
        Ok(())
    }

    async fn purge_stream(&self, name: &str, spec: PurgeSpec) -> Result<u64, CoreError> {
        let stream = self
            .ctx
            .get_stream(name)
            .await
            .map_err(|e| js_err("get stream", &e, ErrorCode::StreamNotFound))?;

        // `keep` and `up_to_seq` are mutually exclusive in the type-state builder;
        // prefer `keep`, then `up_to_seq`, else purge all. `filter` applies to any.
        let base = stream.purge();
        let response = match (spec.keep, spec.up_to_seq) {
            (Some(keep), _) => {
                let p = base.keep(keep);
                match spec.filter {
                    Some(f) => p.filter(f).await,
                    None => p.await,
                }
            }
            (None, Some(seq)) => {
                let p = base.sequence(seq);
                match spec.filter {
                    Some(f) => p.filter(f).await,
                    None => p.await,
                }
            }
            (None, None) => match spec.filter {
                Some(f) => base.filter(f).await,
                None => base.await,
            },
        }
        .map_err(|e| js_err("purge stream", &e, ErrorCode::Internal))?;
        Ok(response.purged)
    }

    async fn list_consumers(&self, stream: &str) -> Result<Vec<ConsumerInfoDto>, CoreError> {
        let stream = self
            .ctx
            .get_stream(stream)
            .await
            .map_err(|e| js_err("get stream", &e, ErrorCode::StreamNotFound))?;
        let mut consumers = stream.consumers();
        let mut out = Vec::new();
        while let Some(info) = consumers
            .try_next()
            .await
            .map_err(|e| js_err("list consumers", &e, ErrorCode::Internal))?
        {
            out.push(consumer_to_dto(&info));
        }
        Ok(out)
    }

    async fn create_consumer(
        &self,
        stream: &str,
        config: ConsumerConfigDto,
    ) -> Result<ConsumerInfoDto, CoreError> {
        let stream_h = self
            .ctx
            .get_stream(stream)
            .await
            .map_err(|e| js_err("get stream", &e, ErrorCode::StreamNotFound))?;
        let consumer = stream_h
            .create_consumer(dto_to_consumer_config(config))
            .await
            .map_err(|e| js_err("create consumer", &e, ErrorCode::Internal))?;
        // `create_consumer` returns the server's info already cached on the handle.
        Ok(consumer_to_dto(consumer.cached_info()))
    }

    async fn delete_consumer(&self, stream: &str, name: &str) -> Result<(), CoreError> {
        let stream = self
            .ctx
            .get_stream(stream)
            .await
            .map_err(|e| js_err("get stream", &e, ErrorCode::StreamNotFound))?;
        stream
            .delete_consumer(name)
            .await
            .map_err(|e| js_err("delete consumer", &e, ErrorCode::ConsumerNotFound))?;
        Ok(())
    }

    async fn fetch_messages(
        &self,
        stream: &str,
        consumer: &str,
        batch: u32,
    ) -> Result<FetchMessagesResponse, CoreError> {
        let stream_h = self
            .ctx
            .get_stream(stream)
            .await
            .map_err(|e| js_err("get stream", &e, ErrorCode::StreamNotFound))?;
        // Bind as a PULL consumer; a push consumer's config fails the pull cast.
        let consumer: PullConsumer = stream_h
            .get_consumer(consumer)
            .await
            .map_err(|e| js_err("not a pull consumer", &e, ErrorCode::ConsumerNotFound))?;
        // `expires` bounds the wait so we return promptly with whatever is
        // available (fewer than `batch`); messages are left pending / un-acked.
        let cap = (batch as usize).clamp(1, 100);
        let mut msgs = consumer
            .batch()
            .max_messages(cap)
            .expires(Duration::from_secs(2))
            .messages()
            .await
            .map_err(|e| js_err("fetch messages", &e, ErrorCode::Internal))?;
        let mut out = Vec::new();
        while let Some(Ok(msg)) = msgs.next().await {
            out.push(fetched_to_dto(&msg));
        }
        Ok(FetchMessagesResponse { messages: out })
    }

    async fn get_messages(
        &self,
        stream: &str,
        start_seq: u64,
        limit: u32,
    ) -> Result<GetMessagesResponse, CoreError> {
        let s = self
            .ctx
            .get_stream(stream)
            .await
            .map_err(|e| js_err("get stream", &e, ErrorCode::StreamNotFound))?;
        let state = s
            .get_info()
            .await
            .map_err(|e| js_err("stream info", &e, ErrorCode::Internal))?
            .state;
        let (first, last) = (state.first_sequence, state.last_sequence);
        let cap = (limit as usize).min(200);
        let mut messages = Vec::new();
        let mut seq = start_seq.max(first);
        while seq <= last && messages.len() < cap {
            // Deleted/purged sequences return an error; skip the gap and advance.
            if let Ok(msg) = s.get_raw_message(seq).await {
                messages.push(stored_to_dto(&msg));
            }
            seq += 1;
        }
        Ok(GetMessagesResponse {
            messages,
            first_seq: first,
            last_seq: last,
        })
    }

    async fn delete_message(&self, stream: &str, seq: u64) -> Result<(), CoreError> {
        let s = self
            .ctx
            .get_stream(stream)
            .await
            .map_err(|e| js_err("get stream", &e, ErrorCode::StreamNotFound))?;
        s.delete_message(seq)
            .await
            .map_err(|e| js_err("delete message", &e, ErrorCode::Internal))?;
        Ok(())
    }

    async fn list_buckets(&self) -> Result<Vec<KvBucketDto>, CoreError> {
        // KV buckets are streams named `KV_<bucket>`; list streams and strip.
        let mut streams = self.ctx.streams();
        let mut out = Vec::new();
        while let Some(info) = streams
            .try_next()
            .await
            .map_err(|e| js_err("list buckets", &e, ErrorCode::Internal))?
        {
            if let Some(bucket) = info.config.name.strip_prefix("KV_") {
                out.push(bucket_to_dto(bucket, &info));
            }
        }
        Ok(out)
    }

    async fn kv_keys(&self, bucket: &str) -> Result<Vec<String>, CoreError> {
        let store = self
            .ctx
            .get_key_value(bucket)
            .await
            .map_err(|e| js_err("open bucket", &e, ErrorCode::StreamNotFound))?;
        let keys = store
            .keys()
            .await
            .map_err(|e| js_err("list keys", &e, ErrorCode::Internal))?
            .try_collect::<Vec<String>>()
            .await
            .map_err(|e| js_err("list keys", &e, ErrorCode::Internal))?;
        Ok(keys)
    }

    async fn kv_get(&self, bucket: &str, key: &str) -> Result<Option<KvEntryDto>, CoreError> {
        let store = self
            .ctx
            .get_key_value(bucket)
            .await
            .map_err(|e| js_err("open bucket", &e, ErrorCode::StreamNotFound))?;
        // `entry` (not `get`) so we can surface delete/purge markers + revision.
        let entry = store
            .entry(key)
            .await
            .map_err(|e| js_err("kv get", &e, ErrorCode::Internal))?;
        Ok(entry.map(|e| entry_to_dto(&e)))
    }

    async fn kv_put(&self, bucket: &str, key: &str, value: Vec<u8>) -> Result<u64, CoreError> {
        let store = self
            .ctx
            .get_key_value(bucket)
            .await
            .map_err(|e| js_err("open bucket", &e, ErrorCode::StreamNotFound))?;
        store
            .put(key, value.into())
            .await
            .map_err(|e| js_err("kv put", &e, ErrorCode::Internal))
    }

    async fn kv_delete(&self, bucket: &str, key: &str) -> Result<(), CoreError> {
        let store = self
            .ctx
            .get_key_value(bucket)
            .await
            .map_err(|e| js_err("open bucket", &e, ErrorCode::StreamNotFound))?;
        store
            .delete(key)
            .await
            .map_err(|e| js_err("kv delete", &e, ErrorCode::Internal))?;
        Ok(())
    }

    async fn list_object_buckets(&self) -> Result<Vec<ObjectBucketDto>, CoreError> {
        // Object buckets are streams named `OBJ_<bucket>`; list streams and strip.
        let mut streams = self.ctx.streams();
        let mut out = Vec::new();
        while let Some(info) = streams
            .try_next()
            .await
            .map_err(|e| js_err("list object buckets", &e, ErrorCode::Internal))?
        {
            if let Some(bucket) = info.config.name.strip_prefix("OBJ_") {
                // ponytail: `objects`/`size` are the backing stream's message/byte
                // totals (meta + chunks), a rough proxy — an exact object count
                // needs a per-bucket list(). Fine for a summary picker.
                out.push(ObjectBucketDto {
                    bucket: bucket.to_owned(),
                    objects: info.state.messages,
                    size: info.state.bytes,
                });
            }
        }
        Ok(out)
    }

    async fn list_objects(&self, bucket: &str) -> Result<Vec<ObjectInfoDto>, CoreError> {
        let store = self
            .ctx
            .get_object_store(bucket)
            .await
            .map_err(|e| js_err("open object bucket", &e, ErrorCode::StreamNotFound))?;
        let mut list = store
            .list()
            .await
            .map_err(|e| js_err("list objects", &e, ErrorCode::Internal))?;
        let mut out = Vec::new();
        while let Some(info) = list
            .try_next()
            .await
            .map_err(|e| js_err("list objects", &e, ErrorCode::Internal))?
        {
            out.push(object_to_dto(&info));
        }
        Ok(out)
    }

    async fn get_object(&self, bucket: &str, name: &str) -> Result<GetObjectResponse, CoreError> {
        let store = self
            .ctx
            .get_object_store(bucket)
            .await
            .map_err(|e| js_err("open object bucket", &e, ErrorCode::StreamNotFound))?;
        // `get` resolves the object's info (and rejects deleted objects) before any
        // bytes stream, so we can cap on `info.size` without downloading first.
        let mut object = store
            .get(name)
            .await
            .map_err(|e| js_err("get object", &e, ErrorCode::StreamNotFound))?;
        if object.info.size > MAX_OBJECT_PREVIEW {
            return Err(CoreError::coded(
                ErrorCode::InvalidArgument,
                format!(
                    "object '{name}' is {} bytes; too large to preview (max {MAX_OBJECT_PREVIEW})",
                    object.info.size
                ),
                false,
            ));
        }
        let out_name = object.info.name.clone();
        let mut bytes = Vec::with_capacity(object.info.size);
        object
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| js_err("read object", &e, ErrorCode::Internal))?;
        Ok(GetObjectResponse {
            name: out_name,
            size: bytes.len() as u64,
            data_base64: BASE64.encode(&bytes),
        })
    }

    async fn delete_object(&self, bucket: &str, name: &str) -> Result<(), CoreError> {
        let store = self
            .ctx
            .get_object_store(bucket)
            .await
            .map_err(|e| js_err("open object bucket", &e, ErrorCode::StreamNotFound))?;
        store
            .delete(name)
            .await
            .map_err(|e| js_err("delete object", &e, ErrorCode::Internal))?;
        Ok(())
    }
}

fn object_to_dto(info: &ObjectInfo) -> ObjectInfoDto {
    ObjectInfoDto {
        name: info.name.clone(),
        size: info.size as u64,
        digest: info.digest.clone(),
        modified_rfc3339: info
            .modified
            .and_then(|t| t.format(&Rfc3339).ok())
            .unwrap_or_default(),
        deleted: info.deleted,
    }
}

fn bucket_to_dto(bucket: &str, info: &Info) -> KvBucketDto {
    KvBucketDto {
        bucket: bucket.to_owned(),
        values: info.state.messages,
        history: info
            .config
            .max_messages_per_subject
            .clamp(0, u8::MAX as i64) as u8,
        ttl_seconds: info.config.max_age.as_secs(),
        bytes: info.state.bytes,
    }
}

fn entry_to_dto(entry: &kv::Entry) -> KvEntryDto {
    KvEntryDto {
        key: entry.key.clone(),
        value_base64: BASE64.encode(&entry.value),
        revision: entry.revision,
        is_deleted: matches!(entry.operation, Operation::Delete | Operation::Purge),
    }
}

fn stored_to_dto(msg: &jetstream::message::StreamMessage) -> StoredMessageDto {
    let headers = msg
        .headers
        .iter()
        .flat_map(|(name, values)| {
            values.iter().map(move |v| MessageHeader {
                name: name.to_string(),
                value: v.to_string(),
            })
        })
        .collect();
    StoredMessageDto {
        seq: msg.sequence,
        subject: msg.subject.to_string(),
        time_rfc3339: msg.time.format(&Rfc3339).unwrap_or_default(),
        payload_base64: BASE64.encode(&msg.payload),
        size: msg.payload.len() as u64,
        headers,
    }
}

fn fetched_to_dto(msg: &jetstream::Message) -> FetchedMessageDto {
    // `info()` parses the `$JS.ACK` reply subject; a fetched message always has
    // one, but degrade to zeros rather than drop the message if it's missing.
    let info = msg.info().ok();
    let headers = msg
        .headers
        .as_ref()
        .map(|h| {
            h.iter()
                .flat_map(|(name, values)| {
                    values.iter().map(move |v| MessageHeader {
                        name: name.to_string(),
                        value: v.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    FetchedMessageDto {
        stream_seq: info.as_ref().map_or(0, |i| i.stream_sequence),
        num_delivered: info.as_ref().map_or(0, |i| i.delivered.max(0) as u64),
        subject: msg.subject.to_string(),
        payload_base64: BASE64.encode(&msg.payload),
        size: msg.payload.len() as u64,
        ack_subject: msg
            .reply
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default(),
        headers,
    }
}

fn consumer_to_dto(info: &consumer::Info) -> ConsumerInfoDto {
    let filter = info.config.filter_subject.trim();
    ConsumerInfoDto {
        name: info.name.clone(),
        stream_name: info.stream_name.clone(),
        durable_name: info.config.durable_name.clone(),
        deliver_policy: deliver_policy_str(&info.config.deliver_policy).to_owned(),
        ack_policy: ack_policy_str(&info.config.ack_policy).to_owned(),
        filter_subject: (!filter.is_empty()).then(|| filter.to_owned()),
        num_pending: info.num_pending,
        num_ack_pending: info.num_ack_pending as u64,
        num_redelivered: info.num_redelivered as u64,
        num_waiting: info.num_waiting as u64,
        ack_floor_stream_seq: info.ack_floor.stream_sequence,
        delivered_stream_seq: info.delivered.stream_sequence,
    }
}

/// Build a durable pull consumer config from the DTO. Unknown policy tags fall
/// back to the safe defaults (`explicit` ack, `all` deliver); `maxDeliver` None
/// -> `-1` (unlimited) matching the stream limits convention.
fn dto_to_consumer_config(dto: ConsumerConfigDto) -> consumer::pull::Config {
    consumer::pull::Config {
        durable_name: Some(dto.durable_name),
        filter_subject: dto.filter_subject.unwrap_or_default(),
        ack_policy: match dto.ack_policy.as_str() {
            "none" => AckPolicy::None,
            "all" => AckPolicy::All,
            _ => AckPolicy::Explicit,
        },
        deliver_policy: match dto.deliver_policy.as_str() {
            "last" => DeliverPolicy::Last,
            "new" => DeliverPolicy::New,
            "lastPerSubject" => DeliverPolicy::LastPerSubject,
            _ => DeliverPolicy::All,
        },
        max_deliver: dto.max_deliver.map_or(-1, |v| v as i64),
        ack_wait: dto
            .ack_wait_seconds
            .filter(|s| *s > 0)
            .map(Duration::from_secs)
            .unwrap_or_default(),
        ..Default::default()
    }
}

fn deliver_policy_str(p: &DeliverPolicy) -> &'static str {
    match p {
        DeliverPolicy::All => "all",
        DeliverPolicy::Last => "last",
        DeliverPolicy::New => "new",
        DeliverPolicy::ByStartSequence { .. } => "byStartSequence",
        DeliverPolicy::ByStartTime { .. } => "byStartTime",
        DeliverPolicy::LastPerSubject => "lastPerSubject",
    }
}

fn ack_policy_str(p: &AckPolicy) -> &'static str {
    match p {
        AckPolicy::None => "none",
        AckPolicy::All => "all",
        AckPolicy::Explicit => "explicit",
        // e.g. `FlowControl` under the `server_2_14` feature.
        _ => "unknown",
    }
}

/// Map an async-nats JetStream error (any `Display`) to a `CoreError`, sniffing
/// the message for a more specific `ErrorCode` than the caller's fallback.
fn js_err(context: &str, err: &impl Display, fallback: ErrorCode) -> CoreError {
    let message = err.to_string();
    let lower = message.to_lowercase();
    let code = if lower.contains("not found") {
        ErrorCode::StreamNotFound
    } else if lower.contains("no responders")
        || lower.contains("not enabled")
        || lower.contains("jetstream is disabled")
    {
        ErrorCode::JetstreamNotEnabled
    } else {
        fallback
    };
    CoreError::coded(code, format!("{context}: {message}"), false)
}

fn info_to_dto(info: &Info) -> Result<StreamInfoDto, CoreError> {
    let created_rfc3339 = info.created.format(&Rfc3339).map_err(|e| {
        CoreError::coded(
            ErrorCode::Internal,
            format!("format stream created timestamp: {e}"),
            false,
        )
    })?;
    Ok(StreamInfoDto {
        config: config_to_dto(&info.config),
        state: state_to_dto(&info.state),
        created_rfc3339,
        cluster: info.cluster.as_ref().and_then(|c| c.name.clone()),
    })
}

fn config_to_dto(c: &Config) -> StreamConfigDto {
    StreamConfigDto {
        name: c.name.clone(),
        subjects: c.subjects.clone(),
        retention: match c.retention {
            RetentionPolicy::Limits => StreamRetention::Limits,
            RetentionPolicy::Interest => StreamRetention::Interest,
            RetentionPolicy::WorkQueue => StreamRetention::WorkQueue,
        },
        storage: match c.storage {
            StorageType::File => StreamStorage::File,
            StorageType::Memory => StreamStorage::Memory,
        },
        discard: match c.discard {
            DiscardPolicy::Old => StreamDiscard::Old,
            DiscardPolicy::New => StreamDiscard::New,
        },
        max_messages: pos_i64(c.max_messages),
        max_bytes: pos_i64(c.max_bytes),
        max_age_ms: dur_ms(c.max_age),
        max_message_size: pos_i32(c.max_message_size),
        num_replicas: c.num_replicas as u64,
        duplicate_window_ms: dur_ms(c.duplicate_window),
        description: c.description.clone(),
    }
}

fn dto_to_config(dto: StreamConfigDto) -> Config {
    Config {
        name: dto.name,
        subjects: dto.subjects,
        retention: match dto.retention {
            StreamRetention::Limits => RetentionPolicy::Limits,
            StreamRetention::Interest => RetentionPolicy::Interest,
            StreamRetention::WorkQueue => RetentionPolicy::WorkQueue,
        },
        storage: match dto.storage {
            StreamStorage::File => StorageType::File,
            StreamStorage::Memory => StorageType::Memory,
        },
        discard: match dto.discard {
            StreamDiscard::Old => DiscardPolicy::Old,
            StreamDiscard::New => DiscardPolicy::New,
        },
        // `-1` = unlimited on the wire; `None` in the DTO means the same.
        max_messages: dto.max_messages.map_or(-1, |v| v as i64),
        max_bytes: dto.max_bytes.map_or(-1, |v| v as i64),
        max_age: dto
            .max_age_ms
            .map(Duration::from_millis)
            .unwrap_or_default(),
        max_message_size: dto.max_message_size.map_or(-1, |v| v as i32),
        num_replicas: dto.num_replicas as usize,
        duplicate_window: dto
            .duplicate_window_ms
            .map(Duration::from_millis)
            .unwrap_or_default(),
        description: dto.description,
        ..Default::default()
    }
}

fn state_to_dto(s: &State) -> StreamStateDto {
    StreamStateDto {
        messages: s.messages,
        bytes: s.bytes,
        first_seq: s.first_sequence,
        last_seq: s.last_sequence,
        consumer_count: s.consumer_count as u64,
        num_subjects: s.subjects_count,
        num_deleted: s.deleted_count.unwrap_or(0),
    }
}

/// `-1` (or any non-positive) sentinel for "unlimited" -> `None`.
fn pos_i64(v: i64) -> Option<u64> {
    (v > 0).then_some(v as u64)
}

fn pos_i32(v: i32) -> Option<u64> {
    (v > 0).then_some(v as u64)
}

/// A zero duration means "unlimited / server default" -> `None`.
fn dur_ms(d: Duration) -> Option<u64> {
    (!d.is_zero()).then_some(d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use ns_core::DomainError;

    use super::*;

    #[test]
    fn dto_config_round_trips_limits_and_kinds() {
        let dto = StreamConfigDto {
            name: "orders".into(),
            subjects: vec!["orders.>".into()],
            retention: StreamRetention::WorkQueue,
            storage: StreamStorage::Memory,
            discard: StreamDiscard::New,
            max_messages: Some(1000),
            max_bytes: None,
            max_age_ms: Some(60_000),
            max_message_size: None,
            num_replicas: 3,
            duplicate_window_ms: None,
            description: Some("test".into()),
        };
        let config = dto_to_config(dto);
        assert_eq!(config.name, "orders");
        assert_eq!(config.max_messages, 1000);
        assert_eq!(config.max_bytes, -1); // None -> unlimited
        assert_eq!(config.max_age, Duration::from_millis(60_000));
        assert_eq!(config.max_message_size, -1);
        assert_eq!(config.num_replicas, 3);
        assert!(matches!(config.retention, RetentionPolicy::WorkQueue));
        assert!(matches!(config.storage, StorageType::Memory));
        assert!(matches!(config.discard, DiscardPolicy::New));

        // Back to a DTO: unlimited sentinels collapse to None.
        let back = config_to_dto(&config);
        assert_eq!(back.max_messages, Some(1000));
        assert_eq!(back.max_bytes, None);
        assert_eq!(back.max_message_size, None);
        assert_eq!(back.max_age_ms, Some(60_000));
    }

    #[test]
    fn err_sniffs_not_found() {
        let e = js_err("get stream", &"stream not found", ErrorCode::Internal);
        assert_eq!(e.code(), ErrorCode::StreamNotFound);
        let e = js_err("x", &"no responders on request", ErrorCode::Internal);
        assert_eq!(e.code(), ErrorCode::JetstreamNotEnabled);
        let e = js_err("x", &"boom", ErrorCode::Internal);
        assert_eq!(e.code(), ErrorCode::Internal);
    }
}
