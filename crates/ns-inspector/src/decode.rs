//! Payload rendering + safe decompression.

use std::fmt::Write as _;
use std::io::Read;

use serde::{Deserialize, Serialize};

use crate::error::InspectorError;
use crate::format::{detect, Compression, ContentFormat, Detection};

/// A combined inspection result: size, detection, and a human preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub size: usize,
    pub detection: Detection,
    pub preview: String,
}

/// Pretty-print a JSON payload.
///
/// # Errors
/// [`InspectorError::InvalidJson`] if the bytes are not valid JSON.
pub fn pretty_json(data: &[u8]) -> Result<String, InspectorError> {
    let value: serde_json::Value =
        serde_json::from_slice(data).map_err(|e| InspectorError::InvalidJson(e.to_string()))?;
    serde_json::to_string_pretty(&value).map_err(|e| InspectorError::InvalidJson(e.to_string()))
}

/// Whether the payload is well-formed JSON.
#[must_use]
pub fn is_valid_json(data: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(data).is_ok()
}

/// A classic offset / hex / ASCII dump (16 bytes per line).
#[must_use]
pub fn hexdump(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() / 16 * 80 + 16);
    for (row, chunk) in data.chunks(16).enumerate() {
        let offset = row * 16;
        let mut hex = String::with_capacity(48);
        for byte in chunk {
            let _ = write!(hex, "{byte:02x} ");
        }
        let ascii: String = chunk
            .iter()
            .map(|&b| {
                if (0x20..0x7f).contains(&b) {
                    b as char
                } else {
                    '.'
                }
            })
            .collect();
        let _ = writeln!(out, "{offset:08x}  {hex:<48} |{ascii}|");
    }
    out
}

/// Decompress a payload, capping the output at `max_output` bytes to defuse a
/// decompression bomb.
///
/// # Errors
/// [`InspectorError::DecompressionLimit`] if the output would exceed `max_output`;
/// [`InspectorError::Decompress`] on malformed input or an unsupported algorithm.
pub fn decompress(
    data: &[u8],
    compression: Compression,
    max_output: usize,
) -> Result<Vec<u8>, InspectorError> {
    match compression {
        Compression::None => Ok(data.to_vec()),
        Compression::Gzip => read_capped(flate2::read::GzDecoder::new(data), max_output),
        Compression::Zlib => read_capped(flate2::read::ZlibDecoder::new(data), max_output),
        Compression::Zstd => Err(InspectorError::Decompress(
            "zstd decompression is not supported yet".to_owned(),
        )),
    }
}

fn read_capped<R: Read>(reader: R, max_output: usize) -> Result<Vec<u8>, InspectorError> {
    let mut limited = reader.take(max_output as u64 + 1);
    let mut out = Vec::new();
    limited
        .read_to_end(&mut out)
        .map_err(|e| InspectorError::Decompress(e.to_string()))?;
    if out.len() > max_output {
        return Err(InspectorError::DecompressionLimit { limit: max_output });
    }
    Ok(out)
}

/// Inspect a payload: detect format/compression and build a human preview.
/// Binary payloads are hex-dumped up to `preview_limit` bytes.
#[must_use]
pub fn inspect(data: &[u8], preview_limit: usize) -> Inspection {
    let detection = detect(data);
    let preview = match detection.format {
        ContentFormat::Json => {
            pretty_json(data).unwrap_or_else(|_| String::from_utf8_lossy(data).into_owned())
        }
        ContentFormat::Text => String::from_utf8_lossy(data).into_owned(),
        ContentFormat::Binary | ContentFormat::Empty => {
            hexdump(&data[..data.len().min(preview_limit)])
        }
    };
    Inspection {
        size: data.len(),
        detection,
        preview,
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::write::GzEncoder;
    use flate2::Compression as GzLevel;

    use super::*;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), GzLevel::default());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn pretty_json_formats_and_rejects() {
        let pretty = pretty_json(br#"{"a":1,"b":[2,3]}"#).unwrap();
        assert!(pretty.contains("\"a\": 1"));
        assert!(pretty_json(b"not json").is_err());
    }

    #[test]
    fn hexdump_layout() {
        let dump = hexdump(b"AB");
        assert!(dump.starts_with("00000000  41 42 "));
        assert!(dump.trim_end().ends_with("|AB|"));
    }

    #[test]
    fn gzip_roundtrip() {
        let compressed = gzip(b"hello nats");
        let out = decompress(&compressed, Compression::Gzip, 1024).unwrap();
        assert_eq!(out, b"hello nats");
    }

    #[test]
    fn decompression_bomb_is_capped() {
        let compressed = gzip(&vec![b'x'; 100_000]);
        let err = decompress(&compressed, Compression::Gzip, 1024).unwrap_err();
        assert!(matches!(
            err,
            InspectorError::DecompressionLimit { limit: 1024 }
        ));
    }

    #[test]
    fn inspect_json_gives_pretty_preview() {
        let ins = inspect(br#"{"x":1}"#, 256);
        assert_eq!(ins.detection.format, ContentFormat::Json);
        assert!(ins.preview.contains("\"x\": 1"));
        assert_eq!(ins.size, 7);
    }

    #[test]
    fn inspect_binary_gives_hex_preview() {
        let ins = inspect(&[0x00, 0xff, 0x10], 256);
        assert_eq!(ins.detection.format, ContentFormat::Binary);
        assert!(ins.preview.starts_with("00000000  00 ff 10"));
    }
}
