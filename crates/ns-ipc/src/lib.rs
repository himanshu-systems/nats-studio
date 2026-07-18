//! ns-ipc — the Tauri boundary glue: the single `DomainError` -> `IpcError`
//! mapping surface and the `EventBridge` (bus -> Tauri events). The only library
//! crate allowed to import `tauri` (spine §5.2.4).
//!
//! See docs/architecture/sub-tauri-shell.md.
#![forbid(unsafe_code)]

mod bridge;
mod error;

pub use bridge::{start_event_bridge, EVENT_CHANNEL};
pub use error::{map_ipc, to_ipc_error};
