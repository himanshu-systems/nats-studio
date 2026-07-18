//! Heuristic content-format and compression detection for message payloads.

use serde::{Deserialize, Serialize};

/// The detected logical content type of a payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentFormat {
    Empty,
    Json,
    Text,
    Binary,
}

/// The detected on-the-wire compression of a payload (by magic bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Compression {
    None,
    Gzip,
    Zlib,
    Zstd,
}

/// A full detection result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub format: ContentFormat,
    pub compression: Compression,
    /// `true` if the payload is valid UTF-8 text.
    pub is_utf8: bool,
}

/// Detect compression from the leading magic bytes.
#[must_use]
pub fn detect_compression(data: &[u8]) -> Compression {
    match data {
        [0x1f, 0x8b, ..] => Compression::Gzip,
        [0x28, 0xb5, 0x2f, 0xfd, ..] => Compression::Zstd,
        // zlib: 0x78 followed by one of the common FLG check bytes.
        [0x78, 0x01 | 0x5e | 0x9c | 0xda, ..] => Compression::Zlib,
        _ => Compression::None,
    }
}

/// Detect the logical content format of an (already decompressed) payload.
#[must_use]
pub fn detect_format(data: &[u8]) -> ContentFormat {
    if data.is_empty() {
        return ContentFormat::Empty;
    }
    if serde_json::from_slice::<serde_json::Value>(data).is_ok() {
        return ContentFormat::Json;
    }
    if std::str::from_utf8(data).is_ok() {
        ContentFormat::Text
    } else {
        ContentFormat::Binary
    }
}

/// Full detection: compression by magic bytes + format of the raw payload.
#[must_use]
pub fn detect(data: &[u8]) -> Detection {
    Detection {
        format: detect_format(data),
        compression: detect_compression(data),
        is_utf8: std::str::from_utf8(data).is_ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_json() {
        assert_eq!(detect_format(br#"{"a":1}"#), ContentFormat::Json);
        assert_eq!(detect_format(b"[1,2,3]"), ContentFormat::Json);
    }

    #[test]
    fn detects_text_and_binary() {
        assert_eq!(detect_format(b"hello world"), ContentFormat::Text);
        assert_eq!(
            detect_format(&[0xff, 0xfe, 0x00, 0x01]),
            ContentFormat::Binary
        );
        assert_eq!(detect_format(b""), ContentFormat::Empty);
    }

    #[test]
    fn detects_compression_magic() {
        assert_eq!(
            detect_compression(&[0x1f, 0x8b, 0x08, 0x00]),
            Compression::Gzip
        );
        assert_eq!(
            detect_compression(&[0x28, 0xb5, 0x2f, 0xfd, 0x00]),
            Compression::Zstd
        );
        assert_eq!(detect_compression(&[0x78, 0x9c, 0x00]), Compression::Zlib);
        assert_eq!(detect_compression(b"plain"), Compression::None);
    }
}
