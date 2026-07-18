//! Infrastructure **ports** — the trait seams the domain depends on. Adapter
//! crates (`ns-storage`, `ns-security`, `ns-nats`) implement them; the binary is
//! the only place that constructs the adapters and injects them as `Arc<dyn Port>`.
//! This is what keeps the crate graph acyclic and every service headless-testable
//! (spine ADR-0007 / ADR-0021).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ns_types::{ConnectionProfile, ServerInfoDto, Settings};

use crate::{CoreError, IncomingMessage, OutgoingMessage, SecretString};

/// Secure storage for credentials, backed by the OS keychain with an encrypted
/// fallback (implemented in `ns-security`).
#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn set(&self, key: &str, secret: SecretString) -> Result<(), CoreError>;
    async fn get(&self, key: &str) -> Result<Option<SecretString>, CoreError>;
    async fn delete(&self, key: &str) -> Result<(), CoreError>;
    /// Whether a real secure backend is available (vs. the app being unable to
    /// store secrets at all). Drives a UI warning.
    async fn available(&self) -> bool;
}

/// Persistence for connection profiles (implemented in `ns-storage`). The stored
/// profile carries no secrets — those live in the [`SecretStore`], keyed by id.
#[async_trait]
pub trait ConnectionProfileRepo: Send + Sync {
    async fn list(&self) -> Result<Vec<ConnectionProfile>, CoreError>;
    async fn get(&self, id: &str) -> Result<Option<ConnectionProfile>, CoreError>;
    async fn upsert(&self, profile: &ConnectionProfile) -> Result<(), CoreError>;
    async fn delete(&self, id: &str) -> Result<(), CoreError>;
}

/// Persistence for the singleton [`Settings`] record (implemented in `ns-storage`).
#[async_trait]
pub trait SettingsRepo: Send + Sync {
    async fn load(&self) -> Result<Option<Settings>, CoreError>;
    async fn save(&self, settings: &Settings) -> Result<(), CoreError>;
}

/// A fully-resolved dial spec: profile + materialized secrets + TLS, ready to hand
/// to a [`NatsClientFactory`]. Built by `ns-connection` from a profile and the
/// `SecretStore`; carries live secrets, so it is never serialized or logged.
#[derive(Clone)]
pub struct ConnectSpec {
    pub servers: Vec<String>,
    pub auth: ResolvedAuth,
    pub tls: Option<ResolvedTls>,
    pub name: Option<String>,
    pub connect_timeout: Duration,
    pub ping_interval: Duration,
    pub no_echo: bool,
}

/// Authentication material with secrets materialized from the [`SecretStore`].
#[derive(Clone)]
pub enum ResolvedAuth {
    None,
    UserPassword {
        username: String,
        password: SecretString,
    },
    Token(SecretString),
    Creds {
        path: String,
    },
    NKey {
        seed: SecretString,
    },
    Jwt {
        jwt: String,
        seed: SecretString,
    },
}

/// Resolved TLS material (paths + verification mode).
#[derive(Clone)]
pub struct ResolvedTls {
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
    pub insecure_skip_verify: bool,
    pub sni: Option<String>,
}

/// A live NATS client handle (implemented in `ns-nats` over `async-nats`). The
/// pub/sub/request surface is added in Phase 2; Phase 1 needs only lifecycle +
/// health.
#[async_trait]
pub trait NatsClient: Send + Sync {
    /// The negotiated server info from the `INFO` handshake, if connected.
    async fn server_info(&self) -> Option<ServerInfoDto>;
    /// Round-trip time to the server (a `PING`/`PONG`).
    async fn rtt(&self) -> Result<Duration, CoreError>;
    /// Flush pending writes to the server.
    async fn flush(&self) -> Result<(), CoreError>;
    /// Drain and close the connection gracefully.
    async fn drain(&self) -> Result<(), CoreError>;

    /// Publish a message (core NATS).
    async fn publish(&self, message: OutgoingMessage) -> Result<(), CoreError>;

    /// Subscribe to a subject (optionally in a queue group), returning a stream
    /// of messages.
    async fn subscribe(
        &self,
        subject: &str,
        queue_group: Option<String>,
    ) -> Result<Box<dyn Subscription>, CoreError>;

    /// Send a request and await a single reply, or time out.
    async fn request(
        &self,
        message: OutgoingMessage,
        timeout: Duration,
    ) -> Result<IncomingMessage, CoreError>;
}

/// A live subscription: a message stream that can be cancelled (implemented in
/// `ns-nats`). `next` yields `None` when the subscription ends.
#[async_trait]
pub trait Subscription: Send {
    async fn next(&mut self) -> Option<IncomingMessage>;
    async fn unsubscribe(&mut self) -> Result<(), CoreError>;
}

/// Establishes NATS connections from a [`ConnectSpec`] (implemented in `ns-nats`).
#[async_trait]
pub trait NatsClientFactory: Send + Sync {
    async fn connect(&self, spec: &ConnectSpec) -> Result<Arc<dyn NatsClient>, CoreError>;
}
