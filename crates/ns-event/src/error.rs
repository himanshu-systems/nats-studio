//! The `EventError` domain error for the internal bus.
//!
//! The producer side of the bus is infallible (publishing never blocks and never
//! errors — a send with no receivers is silently dropped). Errors only arise on
//! the *consumer* side of a [`tokio::sync::broadcast`] stream: a subscriber that
//! falls behind observes a `Lagged` gap, and a subscriber outliving the last
//! sender observes `Closed`. These are surfaced here as a typed [`DomainError`] so
//! the `EventBridge` in `ns-ipc` can turn a lag into the UI's synthetic gap
//! indicator (the per-topic `seq` is what makes the gap detectable).

use ns_core::{CoreError, DomainError};
use ns_types::ErrorCode;
use tokio::sync::broadcast::error::RecvError;

/// A failure observed while receiving from the event bus.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EventError {
    /// The receiver fell behind and `skipped` events were dropped from its view.
    /// Recoverable: subsequent `recv` calls resume from the oldest retained event.
    #[error("event stream lagged; {skipped} event(s) were dropped")]
    Lagged { skipped: u64 },
    /// Every sender has been dropped; no further events will ever arrive.
    #[error("event bus closed")]
    Closed,
}

impl EventError {
    /// Translate a broadcast [`RecvError`] into a domain [`EventError`].
    #[must_use]
    pub fn from_recv(err: RecvError) -> Self {
        match err {
            RecvError::Lagged(skipped) => EventError::Lagged { skipped },
            RecvError::Closed => EventError::Closed,
        }
    }

    /// Whether this error corresponds to a recoverable lag (vs. a closed bus).
    #[must_use]
    pub fn is_lagged(&self) -> bool {
        matches!(self, EventError::Lagged { .. })
    }
}

impl From<RecvError> for EventError {
    fn from(err: RecvError) -> Self {
        EventError::from_recv(err)
    }
}

impl DomainError for EventError {
    fn code(&self) -> ErrorCode {
        // The bus is a framework-internal transport; a gap or closure is an
        // internal condition rather than a user-actionable one.
        ErrorCode::Internal
    }

    fn retriable(&self) -> bool {
        // A lag clears itself on the next successful `recv`; a closed bus does not.
        self.is_lagged()
    }
}

impl From<EventError> for CoreError {
    fn from(err: EventError) -> Self {
        let retriable = err.retriable();
        CoreError::coded(err.code(), err.to_string(), retriable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_recv_maps_variants() {
        assert_eq!(
            EventError::from_recv(RecvError::Lagged(7)),
            EventError::Lagged { skipped: 7 }
        );
        assert_eq!(EventError::from_recv(RecvError::Closed), EventError::Closed);
    }

    #[test]
    fn domain_error_contract() {
        let lagged = EventError::Lagged { skipped: 3 };
        assert_eq!(lagged.code(), ErrorCode::Internal);
        assert!(lagged.retriable());
        assert!(lagged.user_message().contains('3'));

        let closed = EventError::Closed;
        assert_eq!(closed.code(), ErrorCode::Internal);
        assert!(!closed.retriable());
    }

    #[test]
    fn maps_into_core_error() {
        let core: CoreError = EventError::Lagged { skipped: 2 }.into();
        assert_eq!(core.code(), ErrorCode::Internal);
        assert!(core.retriable());
    }
}
