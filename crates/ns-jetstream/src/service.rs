//! [`JetStreamService`] — JetStream stream management on top of the `ns-core`
//! `NatsClientProvider` + `JetStreamManager` ports. Each call resolves the live
//! client for the request's connection, obtains its JetStream handle, validates
//! inputs, then delegates to the port. No dependency on `async-nats`.

use std::sync::Arc;

use ns_core::{NatsClientProvider, PurgeSpec};
use ns_types::{
    CreateStreamRequest, DeleteConsumerRequest, DeleteStreamRequest, GetStreamRequest,
    ListConsumersRequest, ListConsumersResponse, ListStreamsRequest, ListStreamsResponse,
    PurgeStreamRequest, PurgeStreamResponse, StreamInfoDto,
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
        ConsumerInfoDto, ErrorCode, ServerInfoDto, StreamConfigDto, StreamDiscard, StreamInfoDto,
        StreamRetention, StreamStateDto, StreamStorage,
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

    #[derive(Default)]
    struct MockJetStream {
        created: Mutex<Vec<StreamConfigDto>>,
        purged: Mutex<Vec<(String, PurgeSpec)>>,
        deleted: Mutex<Vec<String>>,
        deleted_consumers: Mutex<Vec<(String, String)>>,
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
        async fn delete_consumer(&self, stream: &str, name: &str) -> Result<(), CoreError> {
            self.deleted_consumers
                .lock()
                .unwrap()
                .push((stream.to_owned(), name.to_owned()));
            Ok(())
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
}
