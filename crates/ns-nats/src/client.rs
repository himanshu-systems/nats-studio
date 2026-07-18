//! The `async-nats` adapter: `AsyncNatsFactory` establishes connections from a
//! [`ns_core::ConnectSpec`] and hands back an [`AsyncNatsClient`] implementing the
//! [`ns_core::NatsClient`] port.
//!
//! Reconnection is OWNED BY OUR SUPERVISOR (`ns-connection`), so async-nats's own
//! auto-reconnect is disabled (`max_reconnects(0)`): a dropped connection surfaces
//! as an event and our state machine decides whether/when to redial.
//!
//! TLS uses async-nats's native options (CA file + client cert/key file). The
//! `ring` crypto provider is selected via async-nats's default features (aws-lc-rs
//! is not pulled in). `insecure_skip_verify` is a dev-only escape hatch not yet
//! wired here (it needs a custom rustls config); it returns a clear error rather
//! than silently verifying.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_nats::{ConnectOptions, ServerAddr};
use async_trait::async_trait;
use ns_core::{ConnectSpec, CoreError, NatsClient, NatsClientFactory, ResolvedAuth, ResolvedTls};
use ns_types::ServerInfoDto;

use crate::error::NatsError;

/// A live NATS connection implementing the `ns-core` port.
pub struct AsyncNatsClient {
    client: async_nats::Client,
}

impl AsyncNatsClient {
    /// Access the underlying `async-nats` client (for the pub/sub/JetStream
    /// crates built on top of the connection in later phases).
    #[must_use]
    pub fn raw(&self) -> &async_nats::Client {
        &self.client
    }
}

#[async_trait]
impl NatsClient for AsyncNatsClient {
    async fn server_info(&self) -> Option<ServerInfoDto> {
        Some(map_server_info(&self.client.server_info()))
    }

    async fn rtt(&self) -> Result<Duration, CoreError> {
        // async-nats 0.49 has no direct rtt(); flush() round-trips a PING/PONG,
        // so timing it approximates the server round-trip time.
        let start = std::time::Instant::now();
        self.client
            .flush()
            .await
            .map_err(|e| NatsError::Io(e.to_string()))?;
        Ok(start.elapsed())
    }

    async fn flush(&self) -> Result<(), CoreError> {
        self.client
            .flush()
            .await
            .map_err(|e| NatsError::Io(e.to_string()).into())
    }

    async fn drain(&self) -> Result<(), CoreError> {
        // Best-effort graceful close for Phase 1: flush pending writes; the
        // connection closes when the last handle drops. Full subscription-drain
        // semantics land with the pub/sub crate.
        self.client
            .flush()
            .await
            .map_err(|e| NatsError::Io(e.to_string()).into())
    }
}

/// Establishes `async-nats` connections from a [`ConnectSpec`].
#[derive(Debug, Default, Clone, Copy)]
pub struct AsyncNatsFactory;

#[async_trait]
impl NatsClientFactory for AsyncNatsFactory {
    async fn connect(&self, spec: &ConnectSpec) -> Result<Arc<dyn NatsClient>, CoreError> {
        let options = build_options(spec)?;
        let addrs = parse_servers(&spec.servers)?;
        let client = options
            .connect(addrs)
            .await
            .map_err(|e| NatsError::Connect(e.to_string()))?;
        Ok(Arc::new(AsyncNatsClient { client }))
    }
}

/// Parse the profile's server URLs into `async-nats` addresses.
fn parse_servers(servers: &[String]) -> Result<Vec<ServerAddr>, NatsError> {
    if servers.is_empty() {
        return Err(NatsError::InvalidAddress(
            "no server URLs configured".to_owned(),
        ));
    }
    servers
        .iter()
        .map(|s| {
            s.parse::<ServerAddr>()
                .map_err(|e| NatsError::InvalidAddress(format!("{s}: {e}")))
        })
        .collect()
}

/// Map a [`ConnectSpec`] onto `async-nats` [`ConnectOptions`]. Pure (no IO except
/// reading a `.creds` file), so the auth/TLS wiring is unit-testable.
fn build_options(spec: &ConnectSpec) -> Result<ConnectOptions, CoreError> {
    let mut opts = ConnectOptions::new()
        // Our supervisor owns reconnection.
        .max_reconnects(0)
        .connection_timeout(spec.connect_timeout)
        .ping_interval(spec.ping_interval);

    if let Some(name) = &spec.name {
        opts = opts.name(name);
    }
    if spec.no_echo {
        opts = opts.no_echo();
    }

    opts = apply_auth(opts, &spec.auth)?;

    if let Some(tls) = &spec.tls {
        opts = apply_tls(opts, tls)?;
    }

    Ok(opts)
}

fn apply_auth(opts: ConnectOptions, auth: &ResolvedAuth) -> Result<ConnectOptions, NatsError> {
    let opts = match auth {
        ResolvedAuth::None => opts,
        ResolvedAuth::UserPassword { username, password } => {
            opts.user_and_password(username.clone(), password.expose().to_owned())
        }
        ResolvedAuth::Token(token) => opts.token(token.expose().to_owned()),
        ResolvedAuth::Creds { path } => {
            let content = std::fs::read_to_string(path)
                .map_err(|e| NatsError::Auth(format!("read creds {path}: {e}")))?;
            opts.credentials(&content)
                .map_err(|e| NatsError::Auth(e.to_string()))?
        }
        ResolvedAuth::NKey { seed } => opts.nkey(seed.expose().to_owned()),
        ResolvedAuth::Jwt { jwt, seed } => {
            let key_pair = Arc::new(
                nkeys::KeyPair::from_seed(seed.expose())
                    .map_err(|e| NatsError::Auth(format!("invalid nkey seed: {e}")))?,
            );
            opts.jwt(jwt.clone(), move |nonce| {
                let key_pair = Arc::clone(&key_pair);
                async move { key_pair.sign(&nonce).map_err(async_nats::AuthError::new) }
            })
        }
    };
    Ok(opts)
}

fn apply_tls(opts: ConnectOptions, tls: &ResolvedTls) -> Result<ConnectOptions, NatsError> {
    if tls.insecure_skip_verify {
        return Err(NatsError::Unsupported(
            "insecure_skip_verify is not yet wired in ns-nats; use a CA certificate".to_owned(),
        ));
    }
    let mut opts = opts.require_tls(true);
    if let Some(ca) = &tls.ca_cert_path {
        opts = opts.add_root_certificates(PathBuf::from(ca));
    }
    if let (Some(cert), Some(key)) = (&tls.client_cert_path, &tls.client_key_path) {
        opts = opts.add_client_certificate(PathBuf::from(cert), PathBuf::from(key));
    }
    Ok(opts)
}

/// Map an `async-nats` `ServerInfo` into the wire DTO.
fn map_server_info(info: &async_nats::ServerInfo) -> ServerInfoDto {
    ServerInfoDto {
        server_id: info.server_id.clone(),
        server_name: info.server_name.clone(),
        version: info.version.clone(),
        proto: i32::from(info.proto),
        host: info.host.clone(),
        port: info.port,
        max_payload: info.max_payload as u64,
        jetstream: info.jetstream,
        auth_required: info.auth_required,
        tls_required: info.tls_required,
        client_id: Some(info.client_id),
        cluster: None,
    }
}

#[cfg(test)]
mod tests {
    use ns_core::{DomainError, SecretString};

    use super::*;

    fn spec_with(auth: ResolvedAuth, tls: Option<ResolvedTls>) -> ConnectSpec {
        ConnectSpec {
            servers: vec!["nats://127.0.0.1:4222".to_owned()],
            auth,
            tls,
            name: Some("test".to_owned()),
            connect_timeout: Duration::from_secs(5),
            ping_interval: Duration::from_secs(30),
            no_echo: true,
        }
    }

    #[test]
    fn parses_valid_servers() {
        let addrs = parse_servers(&[
            "nats://127.0.0.1:4222".to_owned(),
            "tls://demo.nats.io:4443".to_owned(),
        ])
        .expect("valid");
        assert_eq!(addrs.len(), 2);
    }

    #[test]
    fn empty_servers_error() {
        assert!(parse_servers(&[]).is_err());
    }

    #[test]
    fn build_options_ok_for_each_auth_kind() {
        // None / user-pass / token / nkey all build without error.
        build_options(&spec_with(ResolvedAuth::None, None)).expect("none");
        build_options(&spec_with(
            ResolvedAuth::UserPassword {
                username: "u".into(),
                password: SecretString::new("p"),
            },
            None,
        ))
        .expect("userpass");
        build_options(&spec_with(
            ResolvedAuth::Token(SecretString::new("tok")),
            None,
        ))
        .expect("token");
    }

    #[test]
    fn jwt_with_bad_seed_errors() {
        let err = build_options(&spec_with(
            ResolvedAuth::Jwt {
                jwt: "ey.fake.jwt".into(),
                seed: SecretString::new("not-a-valid-seed"),
            },
            None,
        ))
        .expect_err("bad seed must error");
        assert_eq!(err.code(), ns_types::ErrorCode::AuthFailed);
    }

    #[test]
    fn insecure_tls_is_rejected_for_now() {
        let tls = ResolvedTls {
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            insecure_skip_verify: true,
            sni: None,
        };
        let err = build_options(&spec_with(ResolvedAuth::None, Some(tls)))
            .expect_err("insecure not yet supported");
        assert_eq!(err.code(), ns_types::ErrorCode::InvalidArgument);
    }

    #[test]
    fn maps_server_info_from_json() {
        let json = r#"{
            "server_id":"NAABC","server_name":"n1","version":"2.10.25","go":"go1.22",
            "host":"0.0.0.0","port":4222,"headers":true,"max_payload":1048576,
            "proto":1,"client_id":7,"auth_required":false,"tls_required":false,
            "jetstream":true,"client_ip":"127.0.0.1"
        }"#;
        let info: async_nats::ServerInfo = serde_json::from_str(json).expect("parse ServerInfo");
        let dto = map_server_info(&info);
        assert_eq!(dto.server_id, "NAABC");
        assert_eq!(dto.port, 4222);
        assert_eq!(dto.max_payload, 1_048_576);
        assert!(dto.jetstream);
        assert_eq!(dto.client_id, Some(7));
    }
}
