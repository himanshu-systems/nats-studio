//! Monitoring wire contract: DTOs for the NATS server HTTP monitoring endpoint
//! (`/varz` server metrics, `/connz` client connections).

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

use crate::U64;

/// Request carrying the monitoring base URL (e.g. `http://127.0.0.1:8222`).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRequest {
    pub base_url: String,
}

/// Selected fields from the server's `/varz` general-metrics endpoint.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VarzDto {
    pub server_name: String,
    pub version: String,
    pub connections: u32,
    pub in_msgs: U64,
    pub out_msgs: U64,
    pub in_bytes: U64,
    pub out_bytes: U64,
    pub slow_consumers: U64,
    pub subscriptions: U64,
    pub uptime: String,
    pub cpu: f64,
    pub mem: U64,
}

/// The server's `/connz` connection listing.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnzDto {
    pub num_connections: u32,
    pub total: u32,
    pub connections: Vec<ConnInfoDto>,
}

/// A single client connection from `/connz`.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfoDto {
    pub cid: U64,
    pub name: Option<String>,
    pub ip: String,
    pub port: u32,
    pub subscriptions: u32,
    pub in_msgs: U64,
    pub out_msgs: U64,
    pub in_bytes: U64,
    pub out_bytes: U64,
    pub lang: Option<String>,
    pub version: Option<String>,
    pub uptime: String,
}
