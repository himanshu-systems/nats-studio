//! [`MonitorService`] — stateless reader of the NATS server HTTP monitoring
//! endpoint. GETs `{base}/varz` and `{base}/connz` and maps the (snake_case)
//! server JSON into the camelCase `ns-types` DTOs.

use ns_types::{ConnInfoDto, ConnzDto, VarzDto};
use serde::Deserialize;

use crate::error::MonitorError;

/// Reads server metrics (`/varz`) and client connections (`/connz`). Holds a
/// pooled `reqwest::Client`; the base URL is supplied per call.
#[derive(Debug, Clone, Default)]
pub struct MonitorService {
    http: reqwest::Client,
}

impl MonitorService {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// GET `{base_url}/varz` — general server metrics.
    pub async fn varz(&self, base_url: &str) -> Result<VarzDto, MonitorError> {
        let wire: VarzWire = self.get_json(base_url, "varz").await?;
        Ok(wire.into())
    }

    /// GET `{base_url}/connz` — the server's current client connections.
    pub async fn connz(&self, base_url: &str) -> Result<ConnzDto, MonitorError> {
        let wire: ConnzWire = self.get_json(base_url, "connz").await?;
        Ok(wire.into())
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        base_url: &str,
        path: &str,
    ) -> Result<T, MonitorError> {
        let url = format!("{}/{path}", base_url.trim_end_matches('/'));
        let json = self
            .http
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .json::<T>()
            .await?;
        Ok(json)
    }
}

// --- wire structs: the NATS monitoring JSON is snake_case (serde default), so
// these deserialize the raw response, then map into the camelCase DTOs. Missing
// fields default rather than fail, since the field set varies by server version.

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct VarzWire {
    server_name: String,
    version: String,
    connections: u32,
    in_msgs: u64,
    out_msgs: u64,
    in_bytes: u64,
    out_bytes: u64,
    slow_consumers: u64,
    subscriptions: u64,
    uptime: String,
    cpu: f64,
    mem: u64,
}

impl From<VarzWire> for VarzDto {
    fn from(w: VarzWire) -> Self {
        VarzDto {
            server_name: w.server_name,
            version: w.version,
            connections: w.connections,
            in_msgs: w.in_msgs,
            out_msgs: w.out_msgs,
            in_bytes: w.in_bytes,
            out_bytes: w.out_bytes,
            slow_consumers: w.slow_consumers,
            subscriptions: w.subscriptions,
            uptime: w.uptime,
            cpu: w.cpu,
            mem: w.mem,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConnzWire {
    num_connections: u32,
    total: u32,
    connections: Vec<ConnInfoWire>,
}

impl From<ConnzWire> for ConnzDto {
    fn from(w: ConnzWire) -> Self {
        ConnzDto {
            num_connections: w.num_connections,
            total: w.total,
            connections: w.connections.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConnInfoWire {
    cid: u64,
    name: Option<String>,
    ip: String,
    port: u32,
    subscriptions: u32,
    in_msgs: u64,
    out_msgs: u64,
    in_bytes: u64,
    out_bytes: u64,
    lang: Option<String>,
    version: Option<String>,
    uptime: String,
}

impl From<ConnInfoWire> for ConnInfoDto {
    fn from(w: ConnInfoWire) -> Self {
        ConnInfoDto {
            cid: w.cid,
            name: w.name,
            ip: w.ip,
            port: w.port,
            subscriptions: w.subscriptions,
            in_msgs: w.in_msgs,
            out_msgs: w.out_msgs,
            in_bytes: w.in_bytes,
            out_bytes: w.out_bytes,
            lang: w.lang,
            version: w.version,
            uptime: w.uptime,
        }
    }
}

#[cfg(test)]
mod tests {
    use ns_core::DomainError;
    use ns_types::ErrorCode;

    use super::*;

    #[test]
    fn varz_json_maps_to_dto() {
        // Field names taken verbatim from a real `/varz` response.
        let json = r#"{
            "server_name": "nats-1",
            "version": "2.10.7",
            "connections": 3,
            "in_msgs": 100,
            "out_msgs": 200,
            "in_bytes": 1024,
            "out_bytes": 2048,
            "slow_consumers": 0,
            "subscriptions": 12,
            "uptime": "1h2m3s",
            "cpu": 1.5,
            "mem": 40960,
            "ignored_extra_field": true
        }"#;
        let dto: VarzDto = serde_json::from_str::<VarzWire>(json).unwrap().into();
        assert_eq!(dto.server_name, "nats-1");
        assert_eq!(dto.version, "2.10.7");
        assert_eq!(dto.connections, 3);
        assert_eq!(dto.in_msgs, 100);
        assert_eq!(dto.out_msgs, 200);
        assert_eq!(dto.subscriptions, 12);
        assert_eq!(dto.uptime, "1h2m3s");
        assert_eq!(dto.mem, 40960);
    }

    #[test]
    fn connz_json_maps_to_dto() {
        let json = r#"{
            "num_connections": 1,
            "total": 1,
            "connections": [
                {
                    "cid": 5,
                    "name": "publisher",
                    "ip": "127.0.0.1",
                    "port": 52344,
                    "subscriptions": 2,
                    "in_msgs": 10,
                    "out_msgs": 20,
                    "in_bytes": 30,
                    "out_bytes": 40,
                    "lang": "rust",
                    "version": "0.49.0",
                    "uptime": "5s"
                }
            ]
        }"#;
        let dto: ConnzDto = serde_json::from_str::<ConnzWire>(json).unwrap().into();
        assert_eq!(dto.num_connections, 1);
        assert_eq!(dto.total, 1);
        assert_eq!(dto.connections.len(), 1);
        let c = &dto.connections[0];
        assert_eq!(c.cid, 5);
        assert_eq!(c.name.as_deref(), Some("publisher"));
        assert_eq!(c.ip, "127.0.0.1");
        assert_eq!(c.port, 52344);
        assert_eq!(c.subscriptions, 2);
        assert_eq!(c.lang.as_deref(), Some("rust"));
    }

    #[test]
    fn tolerates_missing_fields() {
        // A sparse/older server response must not fail the parse.
        let dto: VarzDto = serde_json::from_str::<VarzWire>("{}").unwrap().into();
        assert_eq!(dto.connections, 0);
        assert_eq!(dto.server_name, "");
        let dto: ConnzDto = serde_json::from_str::<ConnzWire>("{}").unwrap().into();
        assert!(dto.connections.is_empty());
    }

    #[test]
    fn error_codes_and_retriability() {
        assert_eq!(
            MonitorError::Unreachable("x".into()).code(),
            ErrorCode::MonitorUnreachable
        );
        assert_eq!(
            MonitorError::Parse("x".into()).code(),
            ErrorCode::MonitorParseError
        );
        assert!(MonitorError::Unreachable("x".into()).retriable());
        assert!(!MonitorError::Parse("x".into()).retriable());
    }
}
