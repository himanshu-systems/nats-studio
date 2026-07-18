//! The `EventBridge` — the ONLY component that turns internal bus events into
//! Tauri events for the WebView (spine §9.3). Feature crates emit domain events
//! onto the `ns-event` bus; this forwards each one to the frontend.
//!
//! Phase 1: every event is emitted on a single Tauri channel (`ns://event`) as an
//! [`AppEvent`] carrying its own topic, so the frontend needs one listener. A
//! lagging subscriber (a slow WebView) yields `Lagged(n)`, which we surface as a
//! log warning (a synthetic UI gap indicator lands with the coalescing engine in
//! a later phase). Producers are never blocked by a slow UI.

use ns_core::Event;
use ns_event::EventBus;
use ns_types::AppEvent;
use tauri::{AppHandle, Emitter, Runtime};
use time::format_description::well_known::Rfc3339;
use tokio::sync::broadcast::error::RecvError;

/// The single Tauri event name every bridged [`AppEvent`] is emitted under.
pub const EVENT_CHANNEL: &str = "ns://event";

/// Start forwarding bus events to the WebView on a background task. Returns
/// immediately; the task runs until the bus is dropped.
pub fn start_event_bridge<R: Runtime>(app: AppHandle<R>, bus: &EventBus) {
    let mut rx = bus.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let app_event = to_app_event(&event);
                    if let Err(err) = app.emit(EVENT_CHANNEL, app_event) {
                        tracing::warn!(error = %err, "event bridge failed to emit");
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!(dropped = n, "event bridge lagged; events dropped");
                }
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Convert an internal [`Event`] into the wire [`AppEvent`].
fn to_app_event(event: &Event) -> AppEvent {
    AppEvent {
        topic: event.topic.as_uri().to_owned(),
        connection_id: event.connection_id.clone(),
        seq: event.seq,
        ts: event.ts.format(&Rfc3339).unwrap_or_default(),
        payload: event.payload.clone(),
    }
}
