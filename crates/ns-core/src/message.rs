//! Message value types that cross the NATS client port. Payloads are raw bytes;
//! headers are name/value pairs (NATS allows repeats). These are domain types,
//! not wire DTOs — `ns-pubsub` maps them to `ns-types` for the UI.

/// A message to publish, or the body of a request.
#[derive(Debug, Clone, Default)]
pub struct OutgoingMessage {
    pub subject: String,
    pub payload: Vec<u8>,
    /// Optional reply subject (core NATS request/reply).
    pub reply: Option<String>,
    pub headers: Vec<(String, String)>,
}

impl OutgoingMessage {
    /// A minimal publish with no headers/reply.
    #[must_use]
    pub fn new(subject: impl Into<String>, payload: Vec<u8>) -> Self {
        Self {
            subject: subject.into(),
            payload,
            reply: None,
            headers: Vec::new(),
        }
    }
}

/// A message received from a subscription or as a reply.
#[derive(Debug, Clone)]
pub struct IncomingMessage {
    pub subject: String,
    pub payload: Vec<u8>,
    pub reply: Option<String>,
    pub headers: Vec<(String, String)>,
}
