//! The JetStream half of the `async-nats` adapter: [`AsyncJetStream`] wraps an
//! `async_nats::jetstream::Context` and implements the `ns_core::JetStreamManager`
//! port, translating our DTOs <-> async-nats `stream::{Config, Info, State}` and a
//! [`PurgeSpec`] into the type-state purge builder. This is the ONLY place the
//! JetStream API is touched (single-import confinement, spine 5.2.6).

use std::fmt::Display;
use std::time::Duration;

use async_nats::jetstream::{
    self,
    consumer::{self, AckPolicy, DeliverPolicy},
    stream::{Config, DiscardPolicy, Info, RetentionPolicy, State, StorageType},
};
use async_trait::async_trait;
use futures::TryStreamExt;
use ns_core::{CoreError, JetStreamManager, PurgeSpec};
use ns_types::{
    ConsumerInfoDto, ErrorCode, StreamConfigDto, StreamDiscard, StreamInfoDto, StreamRetention,
    StreamStateDto, StreamStorage,
};
use time::format_description::well_known::Rfc3339;

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
