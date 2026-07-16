//! The internal async event bus.
//!
//! [`EventBus`] is a clone-cheap handle (an `Arc` inside) stored in `AppState` and
//! injected everywhere a service needs to emit. It fans events out to every
//! subscriber over a single bounded [`tokio::sync::broadcast`] channel and stamps
//! each event with a monotonic **per-topic** sequence number (an [`AtomicU64`] per
//! [`Topic`]) so that a lagging [`broadcast::Receiver`] yields a *detectable* gap.
//!
//! Publishing never blocks the producer: `broadcast::Sender::send` is non-blocking,
//! and a send with no live receivers returns an error that we deliberately ignore
//! (the event is simply dropped). Consumers observe drops on their own side as
//! [`RecvError::Lagged`](tokio::sync::broadcast::error::RecvError::Lagged), which
//! the bridge maps to [`EventError`](crate::EventError).
//!
//! Phase-1 scope: a single bounded broadcast channel + `Lagged` handling. The
//! richer per-topic coalescing/backpressure policy engine described in
//! `docs/architecture/sub-core-runtime.md` (§h) layers on top of this handle in a
//! later phase; the `seq` machinery it relies on lives here.

use std::array;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use ns_core::{Event, EventPublisher, Topic};
use tokio::sync::broadcast;

/// Number of [`Topic`] variants; the width of the per-topic `seq` counter array.
const TOPIC_COUNT: usize = 6;

/// The default broadcast channel capacity (events retained per subscriber before
/// the oldest are dropped and the subscriber sees a `Lagged` gap).
pub const DEFAULT_CAPACITY: usize = 1024;

/// Stable array index for a topic's `seq` counter. Exhaustive over [`Topic`] so a
/// newly added variant is a compile error here (and must bump [`TOPIC_COUNT`]).
const fn topic_index(topic: Topic) -> usize {
    match topic {
        Topic::ConnectionStatus => 0,
        Topic::ServerInfo => 1,
        Topic::Metrics => 2,
        Topic::Log => 3,
        Topic::TaskProgress => 4,
        Topic::Notification => 5,
    }
}

#[derive(Debug)]
struct Inner {
    tx: broadcast::Sender<Arc<Event>>,
    /// One monotonic sequence counter per topic. Holds the last-assigned `seq`;
    /// the next published event of that topic gets `load + 1`.
    seqs: [AtomicU64; TOPIC_COUNT],
}

/// A clone-cheap handle to the internal event bus.
///
/// Cloning shares the same underlying channel and per-topic counters, so a clone
/// held by one service publishes into the same stream every subscriber reads.
#[derive(Debug, Clone)]
pub struct EventBus {
    inner: Arc<Inner>,
}

impl EventBus {
    /// Create a bus with [`DEFAULT_CAPACITY`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }

    /// Create a bus whose broadcast channel retains `capacity` events per
    /// subscriber before the oldest are dropped.
    ///
    /// # Panics
    /// Panics if `capacity` is `0` (a broadcast channel requires capacity ≥ 1).
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(capacity);
        Self {
            inner: Arc::new(Inner {
                tx,
                seqs: array::from_fn(|_| AtomicU64::new(0)),
            }),
        }
    }

    /// Subscribe to the fan-out stream of every published event.
    ///
    /// The returned receiver only sees events published *after* it subscribes.
    /// Used by the `EventBridge` in `ns-ipc` to translate events into Tauri events.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.inner.tx.subscribe()
    }

    /// The number of currently-live subscribers.
    #[must_use]
    pub fn receiver_count(&self) -> usize {
        self.inner.tx.receiver_count()
    }

    /// The last `seq` assigned to `topic` (`0` if none has been published yet).
    #[must_use]
    pub fn current_seq(&self, topic: Topic) -> u64 {
        self.inner.seqs[topic_index(topic)].load(Ordering::Relaxed)
    }

    /// Assign the next per-topic `seq` to `event`, broadcast it, and return the
    /// stamped, shared event.
    ///
    /// Never blocks and never returns an error: if there are no live receivers the
    /// event is dropped. The returned `Arc<Event>` carries the assigned `seq` (and
    /// is the exact instance delivered to subscribers), which is convenient for
    /// callers that want to observe what they just emitted.
    pub fn emit(&self, mut event: Event) -> Arc<Event> {
        let idx = topic_index(event.topic);
        // `fetch_add` returns the previous value; first published seq is therefore
        // `1`, leaving `0` to mean "never published" (matches `Event::new`).
        let seq = self.inner.seqs[idx].fetch_add(1, Ordering::Relaxed) + 1;
        event.seq = seq;
        let shared = Arc::new(event);
        // Ignore the "no receivers" error — publishing must never fail a producer.
        let _ = self.inner.tx.send(Arc::clone(&shared));
        shared
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventPublisher for EventBus {
    /// Assign the per-topic `seq` and fan the event out. Stamps nothing else
    /// (`ts`/`connection_id` are set by the producer via `Event::new`) and never
    /// blocks; a send with no receivers is silently dropped.
    fn publish(&self, event: Event) {
        self.emit(event);
    }
}
