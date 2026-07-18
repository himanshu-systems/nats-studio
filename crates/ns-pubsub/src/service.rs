//! [`PubSubService`] — core NATS publish / subscribe / request on top of the
//! `ns-core` NatsClientProvider port, decoding each message via `ns-inspector`.
//!
//! Streaming subscriptions are driven by the caller (the bin): it opens a
//! subscription, then loops `Subscription::next()` pumping decoded [`MessageView`]s
//! onto a Tauri Channel until cancelled. Keeping the loop in the bin avoids a
//! `tauri` dependency here.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ns_core::{Clock, IncomingMessage, NatsClientProvider, OutgoingMessage, Subscription};
use ns_inspector::{Compression, ContentFormat};
use ns_types::{
    MessageHeader, MessageView, PayloadEncoding, PublishRequest, RequestRequest, SubscribeRequest,
};

use crate::error::PubSubError;

/// Publish / subscribe / request over a live connection.
pub struct PubSubService {
    provider: Arc<dyn NatsClientProvider>,
    clock: Arc<dyn Clock>,
}

impl PubSubService {
    #[must_use]
    pub fn new(provider: Arc<dyn NatsClientProvider>, clock: Arc<dyn Clock>) -> Self {
        Self { provider, clock }
    }

    /// Publish a message to a subject.
    pub async fn publish(&self, req: PublishRequest) -> Result<(), PubSubError> {
        if req.subject.trim().is_empty() {
            return Err(PubSubError::InvalidSubject("subject is empty".to_owned()));
        }
        let client = self.provider.client(&req.connection_id).await?;
        let payload = decode_payload(&req.payload, req.encoding)?;
        client
            .publish(OutgoingMessage {
                subject: req.subject,
                payload,
                reply: req.reply,
                headers: to_pairs(req.headers),
            })
            .await?;
        Ok(())
    }

    /// Send a request and await a single decoded reply.
    pub async fn request(&self, req: RequestRequest) -> Result<MessageView, PubSubError> {
        if req.subject.trim().is_empty() {
            return Err(PubSubError::InvalidSubject("subject is empty".to_owned()));
        }
        let client = self.provider.client(&req.connection_id).await?;
        let payload = decode_payload(&req.payload, req.encoding)?;
        let reply = client
            .request(
                OutgoingMessage {
                    subject: req.subject,
                    payload,
                    reply: None,
                    headers: to_pairs(req.headers),
                },
                Duration::from_millis(req.timeout_ms),
            )
            .await?;
        Ok(self.view(1, &reply))
    }

    /// Open a subscription; the caller drives `next()` and decodes with [`Self::view`].
    pub async fn open_subscription(
        &self,
        req: &SubscribeRequest,
    ) -> Result<Box<dyn Subscription>, PubSubError> {
        if req.subject.trim().is_empty() {
            return Err(PubSubError::InvalidSubject("subject is empty".to_owned()));
        }
        let client = self.provider.client(&req.connection_id).await?;
        let sub = client
            .subscribe(&req.subject, req.queue_group.clone())
            .await?;
        Ok(sub)
    }

    /// Decode an incoming message into the UI view (detection + preview + base64).
    #[must_use]
    pub fn view(&self, seq: u64, msg: &IncomingMessage) -> MessageView {
        let inspection = ns_inspector::inspect(&msg.payload, 8192);
        MessageView {
            seq,
            subject: msg.subject.clone(),
            reply: msg.reply.clone(),
            headers: msg
                .headers
                .iter()
                .map(|(name, value)| MessageHeader {
                    name: name.clone(),
                    value: value.clone(),
                })
                .collect(),
            payload_base64: BASE64.encode(&msg.payload),
            size: msg.payload.len() as u64,
            format: format_label(inspection.detection.format).to_owned(),
            compression: compression_label(inspection.detection.compression).to_owned(),
            preview: inspection.preview,
            ts: self.clock.now_rfc3339(),
        }
    }
}

fn to_pairs(headers: Vec<MessageHeader>) -> Vec<(String, String)> {
    headers.into_iter().map(|h| (h.name, h.value)).collect()
}

fn decode_payload(payload: &str, encoding: PayloadEncoding) -> Result<Vec<u8>, PubSubError> {
    match encoding {
        PayloadEncoding::Utf8 => Ok(payload.as_bytes().to_vec()),
        PayloadEncoding::Base64 => BASE64
            .decode(payload)
            .map_err(|e| PubSubError::InvalidPayload(e.to_string())),
    }
}

fn format_label(format: ContentFormat) -> &'static str {
    match format {
        ContentFormat::Empty => "empty",
        ContentFormat::Json => "json",
        ContentFormat::Text => "text",
        ContentFormat::Binary => "binary",
    }
}

fn compression_label(compression: Compression) -> &'static str {
    match compression {
        Compression::None => "none",
        Compression::Gzip => "gzip",
        Compression::Zlib => "zlib",
        Compression::Zstd => "zstd",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use ns_core::{CoreError, NatsClient, SystemClock};
    use ns_types::{ErrorCode, ServerInfoDto};

    use super::*;

    #[derive(Default)]
    struct RecordingClient {
        published: Mutex<Vec<OutgoingMessage>>,
    }

    #[async_trait]
    impl NatsClient for RecordingClient {
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
        async fn publish(&self, message: OutgoingMessage) -> Result<(), CoreError> {
            self.published.lock().unwrap().push(message);
            Ok(())
        }
        async fn subscribe(
            &self,
            _subject: &str,
            _queue_group: Option<String>,
        ) -> Result<Box<dyn Subscription>, CoreError> {
            Err(CoreError::coded(
                ErrorCode::Internal,
                "no sub in test",
                false,
            ))
        }
        async fn request(
            &self,
            message: OutgoingMessage,
            _timeout: Duration,
        ) -> Result<IncomingMessage, CoreError> {
            // Echo the request payload back as the reply.
            Ok(IncomingMessage {
                subject: format!("_INBOX.{}", message.subject),
                payload: message.payload,
                reply: None,
                headers: vec![],
            })
        }
    }

    struct MockProvider {
        client: Arc<RecordingClient>,
    }

    #[async_trait]
    impl NatsClientProvider for MockProvider {
        async fn client(&self, _connection_id: &str) -> Result<Arc<dyn NatsClient>, CoreError> {
            Ok(self.client.clone())
        }
    }

    fn service() -> (PubSubService, Arc<RecordingClient>) {
        let client = Arc::new(RecordingClient::default());
        let provider = Arc::new(MockProvider {
            client: client.clone(),
        });
        (PubSubService::new(provider, Arc::new(SystemClock)), client)
    }

    #[tokio::test]
    async fn publish_decodes_payload_and_forwards() {
        let (svc, client) = service();
        svc.publish(PublishRequest {
            connection_id: "c1".into(),
            subject: "orders.new".into(),
            payload: "aGVsbG8=".into(), // "hello" base64
            encoding: PayloadEncoding::Base64,
            headers: vec![MessageHeader {
                name: "X-Trace".into(),
                value: "1".into(),
            }],
            reply: None,
        })
        .await
        .unwrap();

        let published = client.published.lock().unwrap();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].subject, "orders.new");
        assert_eq!(published[0].payload, b"hello");
        assert_eq!(published[0].headers, vec![("X-Trace".into(), "1".into())]);
    }

    #[tokio::test]
    async fn empty_subject_is_rejected() {
        let (svc, _) = service();
        let err = svc
            .publish(PublishRequest {
                connection_id: "c1".into(),
                subject: "   ".into(),
                payload: String::new(),
                encoding: PayloadEncoding::Utf8,
                headers: vec![],
                reply: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, PubSubError::InvalidSubject(_)));
    }

    #[tokio::test]
    async fn request_returns_decoded_reply() {
        let (svc, _) = service();
        let view = svc
            .request(RequestRequest {
                connection_id: "c1".into(),
                subject: "svc.echo".into(),
                payload: r#"{"ping":true}"#.into(),
                encoding: PayloadEncoding::Utf8,
                headers: vec![],
                timeout_ms: 1000,
            })
            .await
            .unwrap();
        assert_eq!(view.format, "json");
        assert!(view.preview.contains("\"ping\": true"));
        assert!(!view.ts.is_empty());
    }

    #[test]
    fn view_detects_and_base64_encodes() {
        let (svc, _) = service();
        let msg = IncomingMessage {
            subject: "s".into(),
            payload: b"hello".to_vec(),
            reply: None,
            headers: vec![],
        };
        let view = svc.view(5, &msg);
        assert_eq!(view.seq, 5);
        assert_eq!(view.format, "text");
        assert_eq!(view.payload_base64, "aGVsbG8=");
        assert_eq!(view.size, 5);
    }
}
