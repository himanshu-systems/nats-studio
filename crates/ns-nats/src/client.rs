//! The `async-nats` adapter: `AsyncNatsFactory` establishes connections from a
//! [`ns_core::ConnectSpec`] and hands back an [`AsyncNatsClient`] implementing the
//! [`ns_core::NatsClient`] port.
//!
//! Reconnection is OWNED BY OUR SUPERVISOR (`ns-connection`), so async-nats's own
//! auto-reconnect is disabled (`max_reconnects(0)`): a dropped connection surfaces
//! as an event and our state machine decides whether/when to redial.
//!
//! TLS is applied via a `rustls::ClientConfig` produced by a builder INJECTED at
//! the composition root (`tls_client_config`). Keeping the builder out of this
//! crate preserves the layering rule — `ns-nats` must not depend on `ns-security`,
//! which owns the `ring`-based rustls config (CA roots, mTLS client cert/key, and
//! the `insecure_skip_verify` opt-in). All three modes flow through the one seam.

use std::sync::Arc;
use std::time::Duration;

use async_nats::{ConnectOptions, HeaderMap, Request, ServerAddr};
use async_trait::async_trait;
use ns_core::{
    ConnectSpec, CoreError, IncomingMessage, JetStreamManager, NatsClient, NatsClientFactory,
    OutgoingMessage, ResolvedAuth, ResolvedTls, Subscription,
};
use ns_types::ServerInfoDto;

use crate::error::NatsError;
use crate::jetstream::AsyncJetStream;

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
        // Best-effort graceful close: flush pending writes; the connection closes
        // when the last handle drops.
        self.client
            .flush()
            .await
            .map_err(|e| NatsError::Io(e.to_string()).into())
    }

    async fn publish(&self, message: OutgoingMessage) -> Result<(), CoreError> {
        let OutgoingMessage {
            subject,
            payload,
            reply,
            headers,
        } = message;
        let result = match (reply, to_header_map(&headers)) {
            (Some(reply), Some(h)) => {
                self.client
                    .publish_with_reply_and_headers(subject, reply, h, payload.into())
                    .await
            }
            (Some(reply), None) => {
                self.client
                    .publish_with_reply(subject, reply, payload.into())
                    .await
            }
            (None, Some(h)) => {
                self.client
                    .publish_with_headers(subject, h, payload.into())
                    .await
            }
            (None, None) => self.client.publish(subject, payload.into()).await,
        };
        result.map_err(|e| NatsError::Io(e.to_string()).into())
    }

    async fn subscribe(
        &self,
        subject: &str,
        queue_group: Option<String>,
    ) -> Result<Box<dyn Subscription>, CoreError> {
        let subscriber = match queue_group {
            Some(group) => self.client.queue_subscribe(subject.to_owned(), group).await,
            None => self.client.subscribe(subject.to_owned()).await,
        }
        .map_err(|e| NatsError::Io(e.to_string()))?;
        Ok(Box::new(AsyncNatsSubscription { inner: subscriber }))
    }

    async fn request(
        &self,
        message: OutgoingMessage,
        timeout: Duration,
    ) -> Result<IncomingMessage, CoreError> {
        let OutgoingMessage {
            subject,
            payload,
            headers,
            ..
        } = message;
        let mut request = Request::new()
            .payload(payload.into())
            .timeout(Some(timeout));
        if let Some(h) = to_header_map(&headers) {
            request = request.headers(h);
        }
        let reply = self
            .client
            .send_request(subject, request)
            .await
            .map_err(map_request_error)?;
        Ok(map_message(reply))
    }

    async fn jetstream(&self) -> Result<Arc<dyn JetStreamManager>, CoreError> {
        Ok(Arc::new(AsyncJetStream::new(self.client.clone())))
    }
}

/// A live subscription wrapping an `async-nats` `Subscriber` (a message stream).
struct AsyncNatsSubscription {
    inner: async_nats::Subscriber,
}

#[async_trait]
impl Subscription for AsyncNatsSubscription {
    async fn next(&mut self) -> Option<IncomingMessage> {
        use futures::StreamExt;
        self.inner.next().await.map(map_message)
    }

    async fn unsubscribe(&mut self) -> Result<(), CoreError> {
        self.inner
            .unsubscribe()
            .await
            .map_err(|e| NatsError::Io(e.to_string()).into())
    }
}

fn to_header_map(headers: &[(String, String)]) -> Option<HeaderMap> {
    if headers.is_empty() {
        return None;
    }
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        map.insert(name.as_str(), value.as_str());
    }
    Some(map)
}

fn map_message(message: async_nats::Message) -> IncomingMessage {
    let headers = message
        .headers
        .map(|h| {
            h.iter()
                .flat_map(|(name, values)| {
                    values
                        .iter()
                        .map(move |v| (name.to_string(), v.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    IncomingMessage {
        subject: message.subject.to_string(),
        payload: message.payload.to_vec(),
        reply: message.reply.map(|r| r.to_string()),
        headers,
    }
}

fn map_request_error(err: async_nats::client::RequestError) -> CoreError {
    use async_nats::client::RequestErrorKind;
    match err.kind() {
        RequestErrorKind::NoResponders => NatsError::NoResponders.into(),
        RequestErrorKind::TimedOut => NatsError::Timeout("request timed out".to_owned()).into(),
        _ => NatsError::Io(err.to_string()).into(),
    }
}

/// Builds a [`rustls::ClientConfig`] from resolved TLS material. Injected from the
/// composition root so `ns-nats` needn't depend on `ns-security` (the layering
/// rule) — the concrete builder is `ns_security::client_config`.
pub type TlsConfigBuilder =
    Arc<dyn Fn(&ResolvedTls) -> Result<rustls::ClientConfig, CoreError> + Send + Sync>;

/// Establishes `async-nats` connections from a [`ConnectSpec`].
#[derive(Clone)]
pub struct AsyncNatsFactory {
    tls_config_builder: TlsConfigBuilder,
}

impl AsyncNatsFactory {
    /// Create a factory with the injected TLS `ClientConfig` builder.
    #[must_use]
    pub fn new(tls_config_builder: TlsConfigBuilder) -> Self {
        Self { tls_config_builder }
    }
}

#[async_trait]
impl NatsClientFactory for AsyncNatsFactory {
    async fn connect(&self, spec: &ConnectSpec) -> Result<Arc<dyn NatsClient>, CoreError> {
        let options = build_options(spec, &self.tls_config_builder)?;
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
fn build_options(
    spec: &ConnectSpec,
    tls_builder: &TlsConfigBuilder,
) -> Result<ConnectOptions, CoreError> {
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
        opts = apply_tls(opts, tls, tls_builder)?;
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

/// Apply TLS via the injected builder. The builder's `rustls::ClientConfig` is the
/// single path that covers CA roots, mTLS client cert/key, AND `insecure_skip_verify`
/// (a per-connection dev opt-in resolved inside the builder, not rejected here).
fn apply_tls(
    opts: ConnectOptions,
    tls: &ResolvedTls,
    tls_builder: &TlsConfigBuilder,
) -> Result<ConnectOptions, CoreError> {
    let config = tls_builder(tls)?;
    Ok(opts.require_tls(true).tls_client_config(config))
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
    use std::sync::atomic::{AtomicBool, Ordering};

    use ns_core::{DomainError, SecretString};

    use super::*;

    /// A builder that must never be invoked (used when a spec carries no TLS).
    fn unused_tls_builder() -> TlsConfigBuilder {
        Arc::new(|_| unreachable!("TLS builder must not be called when tls is None"))
    }

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
        let b = unused_tls_builder();
        build_options(&spec_with(ResolvedAuth::None, None), &b).expect("none");
        build_options(
            &spec_with(
                ResolvedAuth::UserPassword {
                    username: "u".into(),
                    password: SecretString::new("p"),
                },
                None,
            ),
            &b,
        )
        .expect("userpass");
        build_options(
            &spec_with(ResolvedAuth::Token(SecretString::new("tok")), None),
            &b,
        )
        .expect("token");
    }

    #[test]
    fn jwt_with_bad_seed_errors() {
        let err = build_options(
            &spec_with(
                ResolvedAuth::Jwt {
                    jwt: "ey.fake.jwt".into(),
                    seed: SecretString::new("not-a-valid-seed"),
                },
                None,
            ),
            &unused_tls_builder(),
        )
        .expect_err("bad seed must error");
        assert_eq!(err.code(), ns_types::ErrorCode::AuthFailed);
    }

    /// insecure_skip_verify is no longer rejected here: a present `ResolvedTls`
    /// (even the insecure one) is routed to the injected builder, which owns the
    /// verification decision. Proven by observing the builder gets called.
    #[test]
    fn tls_present_invokes_injected_builder() {
        let called = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&called);
        let builder: TlsConfigBuilder = Arc::new(move |_tls| {
            flag.store(true, Ordering::SeqCst);
            Err(NatsError::Unsupported("stub builder".to_owned()).into())
        });
        let tls = ResolvedTls {
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            insecure_skip_verify: true,
            sni: None,
        };
        build_options(&spec_with(ResolvedAuth::None, Some(tls)), &builder)
            .expect_err("stub builder returns an error");
        assert!(
            called.load(Ordering::SeqCst),
            "the injected TLS builder must be invoked (insecure is not short-circuited)"
        );
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

    /// End-to-end: dial a real server. Ignored by default; run with a local
    /// `nats-server` on 127.0.0.1:4222 via `cargo test -p ns-nats -- --ignored`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires a local nats-server on 127.0.0.1:4222"]
    async fn live_connect_to_local_server() {
        let client = AsyncNatsFactory::new(unused_tls_builder())
            .connect(&spec_with(ResolvedAuth::None, None))
            .await
            .expect("connect to local nats-server");
        let info = client.server_info().await.expect("server info");
        assert!(!info.version.is_empty(), "server reported a version");
        let rtt = client.rtt().await.expect("rtt");
        assert!(rtt.as_millis() < 5_000, "rtt is sane");
        client.drain().await.expect("drain");
    }

    /// End-to-end publish -> subscribe roundtrip against a live server.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires a local nats-server on 127.0.0.1:4222"]
    async fn live_pub_sub_roundtrip() {
        // no_echo must be false so a same-connection publish echoes back to the sub.
        let spec = ConnectSpec {
            servers: vec!["nats://127.0.0.1:4222".to_owned()],
            auth: ResolvedAuth::None,
            tls: None,
            name: Some("pubsub-test".to_owned()),
            connect_timeout: Duration::from_secs(5),
            ping_interval: Duration::from_secs(30),
            no_echo: false,
        };
        let client = AsyncNatsFactory::new(unused_tls_builder())
            .connect(&spec)
            .await
            .expect("connect");
        let mut sub = client
            .subscribe("ns.studio.test", None)
            .await
            .expect("subscribe");
        client.flush().await.expect("flush sub"); // ensure SUB reaches the server
        tokio::time::sleep(Duration::from_millis(100)).await;

        client
            .publish(OutgoingMessage::new(
                "ns.studio.test",
                b"hello nats".to_vec(),
            ))
            .await
            .expect("publish");
        client.flush().await.expect("flush");

        let msg = tokio::time::timeout(Duration::from_secs(2), sub.next())
            .await
            .expect("no timeout")
            .expect("a message");
        assert_eq!(msg.subject, "ns.studio.test");
        assert_eq!(msg.payload, b"hello nats");
        sub.unsubscribe().await.expect("unsubscribe");
    }
}
