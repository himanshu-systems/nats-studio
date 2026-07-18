//! ns-inspector — payload codecs & inspection: content-format and compression
//! detection, hex dumps, JSON pretty-printing/validation, and bomb-capped
//! decompression. Pure functions over `&[u8]`; consumed server-side by ns-pubsub
//! (to decode messages before they reach the UI) and directly by the inspector UI.
//!
//! See docs/architecture/sub-message-inspector.md.
#![forbid(unsafe_code)]

mod decode;
mod error;
mod format;

pub use decode::{decompress, hexdump, inspect, is_valid_json, pretty_json, Inspection};
pub use error::InspectorError;
pub use format::{
    detect, detect_compression, detect_format, Compression, ContentFormat, Detection,
};
