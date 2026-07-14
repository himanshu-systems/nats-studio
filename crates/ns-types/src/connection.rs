//! Connection contract: profiles, auth, TLS, live status, server info, metrics,
//! and the request/response DTOs for the `connection_*` commands.
//!
//! Secret fields (`password`, `token`, `seed`) are `Option<String>`: the frontend
//! sends them on create/update, and they are returned as `null` (redacted) on read
//! — the real secret lives in the OS keychain (ns-security), never in SQLite.

use crate::U64;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// Authentication strategy for a connection profile.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum ConnectionAuth {
    None,
    UserPassword(UserPasswordAuth),
    Token(TokenAuth),
    Creds(CredsAuth),
    NKey(NKeyAuth),
    Jwt(JwtAuth),
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPasswordAuth {
    pub username: String,
    pub password: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAuth {
    pub token: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredsAuth {
    pub creds_path: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NKeyAuth {
    pub seed: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtAuth {
    pub jwt: String,
    pub seed: Option<String>,
}

/// TLS / mTLS configuration for a connection.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsConfig {
    pub enabled: bool,
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
    pub insecure_skip_verify: bool,
    pub sni: Option<String>,
}

/// Tunable connection behaviour. Reconnection is driven by our own supervisor,
/// so `max_reconnects: None` means "retry forever".
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionOptions {
    pub max_reconnects: Option<u32>,
    pub reconnect_delay_ms: U64,
    pub connect_timeout_ms: U64,
    pub ping_interval_ms: U64,
    pub no_echo: bool,
}

/// A stored connection profile (has an `id`).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub servers: Vec<String>,
    pub auth: ConnectionAuth,
    pub tls: Option<TlsConfig>,
    pub options: ConnectionOptions,
}

/// A profile being created (no `id` yet).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfileInput {
    pub name: String,
    pub servers: Vec<String>,
    pub auth: ConnectionAuth,
    pub tls: Option<TlsConfig>,
    pub options: ConnectionOptions,
}

/// The lifecycle state of a live connection.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}

/// Negotiated server information (from the NATS `INFO` handshake).
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfoDto {
    pub server_id: String,
    pub server_name: String,
    pub version: String,
    pub proto: i32,
    pub host: String,
    pub port: u16,
    pub max_payload: U64,
    pub jetstream: bool,
    pub auth_required: bool,
    pub tls_required: bool,
    pub client_id: Option<U64>,
    pub cluster: Option<String>,
}

/// Per-connection traffic counters.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMetricsDto {
    pub connection_id: String,
    pub in_msgs: U64,
    pub out_msgs: U64,
    pub in_bytes: U64,
    pub out_bytes: U64,
    pub reconnects: U64,
    pub rtt_ms: Option<U64>,
}

/// A live connection's at-a-glance state, returned by `connection_list` / `connection_connect`.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub connection_id: String,
    pub profile_id: String,
    pub name: String,
    pub status: ConnectionStatus,
    pub server_info: Option<ServerInfoDto>,
    pub rtt_ms: Option<U64>,
    pub last_error: Option<String>,
}

// --- request / response DTOs for connection_* commands ---

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProfilesResponse {
    pub profiles: Vec<ConnectionProfile>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetProfileRequest {
    pub id: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProfileRequest {
    pub profile: ConnectionProfileInput,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileRequest {
    pub profile: ConnectionProfile,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProfileRequest {
    pub id: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionRequest {
    pub profile: ConnectionProfileInput,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub profile_id: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRef {
    pub connection_id: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConnectionsResponse {
    pub connections: Vec<ConnectionSummary>,
}
