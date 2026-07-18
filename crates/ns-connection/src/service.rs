//! [`ConnectionService`] — the connection manager (spine sub-connection-manager).
//!
//! Built entirely against `ns-core` ports so it is headless and unit-testable:
//! the binary injects a [`ConnectionProfileRepo`] (ns-storage), a [`SecretStore`]
//! (ns-security), a [`NatsClientFactory`] (ns-nats), an [`EventPublisher`]
//! (ns-event), and a [`Clock`]. The service owns the live-connection registry and
//! the status state machine, emitting `ConnectionStatusChanged` / `ServerInfoUpdated`
//! events as connections come and go (the UI never polls).
//!
//! Secret handling: on create/update, secret fields (password/token/seed) are
//! moved into the [`SecretStore`] keyed by `<profileId>::<field>` and the stored
//! profile is left with `None` in those fields — SQLite never holds a secret. On
//! connect, secrets are materialized back into a [`ConnectSpec`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ns_core::{
    Clock, ConnectSpec, ConnectionId, ConnectionProfileRepo, DomainError, Event, EventPublisher,
    NatsClient, NatsClientFactory, ResolvedAuth, ResolvedTls, SecretStore, SecretString,
};
use ns_types::{
    ConnectionAuth, ConnectionProfile, ConnectionProfileInput, ConnectionStatus,
    ConnectionStatusDto, ConnectionSummary, CredsAuth, EventPayload, JwtAuth, NKeyAuth,
    ServerInfoDto, ServerInfoUpdatedDto, TlsConfig, TokenAuth, UserPasswordAuth,
};
use tokio::sync::RwLock;

use crate::error::ConnectionError;

/// Live state of one connection in the registry.
struct ConnectionHandle {
    id: ConnectionId,
    profile_id: String,
    name: String,
    status: ConnectionStatus,
    client: Option<Arc<dyn NatsClient>>,
    server_info: Option<ServerInfoDto>,
    last_error: Option<String>,
    rtt_ms: Option<u64>,
}

impl ConnectionHandle {
    fn summary(&self) -> ConnectionSummary {
        ConnectionSummary {
            connection_id: self.id.to_string(),
            profile_id: self.profile_id.clone(),
            name: self.name.clone(),
            status: self.status,
            server_info: self.server_info.clone(),
            rtt_ms: self.rtt_ms,
            last_error: self.last_error.clone(),
        }
    }
}

/// The connection manager service.
pub struct ConnectionService {
    repo: Arc<dyn ConnectionProfileRepo>,
    secrets: Arc<dyn SecretStore>,
    factory: Arc<dyn NatsClientFactory>,
    events: Arc<dyn EventPublisher>,
    clock: Arc<dyn Clock>,
    connections: Arc<RwLock<HashMap<ConnectionId, ConnectionHandle>>>,
}

fn secret_key(profile_id: &str, field: &str) -> String {
    format!("{profile_id}::{field}")
}

/// Secret field names stored per profile.
const SECRET_FIELDS: [&str; 4] = ["password", "token", "nkey_seed", "jwt_seed"];

impl ConnectionService {
    #[must_use]
    pub fn new(
        repo: Arc<dyn ConnectionProfileRepo>,
        secrets: Arc<dyn SecretStore>,
        factory: Arc<dyn NatsClientFactory>,
        events: Arc<dyn EventPublisher>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            repo,
            secrets,
            factory,
            events,
            clock,
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    // --- profile CRUD -----------------------------------------------------

    pub async fn list_profiles(&self) -> Result<Vec<ConnectionProfile>, ConnectionError> {
        Ok(self.repo.list().await?)
    }

    pub async fn get_profile(
        &self,
        id: &str,
    ) -> Result<Option<ConnectionProfile>, ConnectionError> {
        Ok(self.repo.get(id).await?)
    }

    pub async fn create_profile(
        &self,
        input: ConnectionProfileInput,
    ) -> Result<ConnectionProfile, ConnectionError> {
        let id = ConnectionId::new().to_string();
        let auth = self.stash_secrets(&id, &input.auth).await?;
        let profile = ConnectionProfile {
            id,
            name: input.name,
            servers: input.servers,
            auth,
            tls: input.tls,
            options: input.options,
        };
        self.repo.upsert(&profile).await?;
        Ok(profile)
    }

    pub async fn update_profile(
        &self,
        profile: ConnectionProfile,
    ) -> Result<ConnectionProfile, ConnectionError> {
        if self.repo.get(&profile.id).await?.is_none() {
            return Err(ConnectionError::ProfileNotFound(profile.id));
        }
        let auth = self.stash_secrets(&profile.id, &profile.auth).await?;
        let updated = ConnectionProfile { auth, ..profile };
        self.repo.upsert(&updated).await?;
        Ok(updated)
    }

    pub async fn delete_profile(&self, id: &str) -> Result<(), ConnectionError> {
        for field in SECRET_FIELDS {
            // Best-effort: a profile need not have every secret.
            let _ = self.secrets.delete(&secret_key(id, field)).await;
        }
        self.repo.delete(id).await?;
        Ok(())
    }

    // --- connection lifecycle --------------------------------------------

    pub async fn connect(&self, profile_id: &str) -> Result<ConnectionSummary, ConnectionError> {
        let profile = self
            .repo
            .get(profile_id)
            .await?
            .ok_or_else(|| ConnectionError::ProfileNotFound(profile_id.to_owned()))?;

        // Materialize secrets first — a missing credential is a config error, not
        // a connection attempt, so we fail before creating a handle/emitting.
        let auth = self.materialize_auth(profile_id, &profile.auth).await?;
        let tls = profile.tls.as_ref().filter(|t| t.enabled).map(map_tls);
        let spec = ConnectSpec {
            servers: profile.servers.clone(),
            auth,
            tls,
            name: Some(profile.name.clone()),
            connect_timeout: Duration::from_millis(profile.options.connect_timeout_ms),
            ping_interval: Duration::from_millis(profile.options.ping_interval_ms),
            no_echo: profile.options.no_echo,
        };

        let conn_id = ConnectionId::new();
        self.connections.write().await.insert(
            conn_id.clone(),
            ConnectionHandle {
                id: conn_id.clone(),
                profile_id: profile_id.to_owned(),
                name: profile.name.clone(),
                status: ConnectionStatus::Connecting,
                client: None,
                server_info: None,
                last_error: None,
                rtt_ms: None,
            },
        );
        self.emit_status(&conn_id, ConnectionStatus::Connecting, None, None);

        match self.factory.connect(&spec).await {
            Ok(client) => {
                let info = client.server_info().await;
                let summary = {
                    let mut map = self.connections.write().await;
                    let handle = map
                        .get_mut(&conn_id)
                        .expect("handle inserted above still present");
                    handle.status = ConnectionStatus::Connected;
                    handle.client = Some(client);
                    handle.server_info = info.clone();
                    handle.summary()
                };
                if let Some(si) = info {
                    self.emit_server_info(&conn_id, si);
                }
                self.emit_status(&conn_id, ConnectionStatus::Connected, None, None);
                Ok(summary)
            }
            Err(err) => {
                let message = err.user_message();
                if let Some(handle) = self.connections.write().await.get_mut(&conn_id) {
                    handle.status = ConnectionStatus::Failed;
                    handle.last_error = Some(message.clone());
                }
                self.emit_status(&conn_id, ConnectionStatus::Failed, Some(message), None);
                Err(ConnectionError::Core(err))
            }
        }
    }

    pub async fn disconnect(&self, connection_id: &str) -> Result<(), ConnectionError> {
        let conn_id = parse_conn_id(connection_id)?;
        let handle = self
            .connections
            .write()
            .await
            .remove(&conn_id)
            .ok_or_else(|| ConnectionError::ConnectionNotFound(connection_id.to_owned()))?;
        if let Some(client) = handle.client {
            let _ = client.drain().await; // best-effort graceful close
        }
        self.emit_status(&conn_id, ConnectionStatus::Disconnected, None, None);
        Ok(())
    }

    pub async fn list_connections(&self) -> Vec<ConnectionSummary> {
        self.connections
            .read()
            .await
            .values()
            .map(ConnectionHandle::summary)
            .collect()
    }

    pub async fn get_status(&self, connection_id: &str) -> Option<ConnectionStatusDto> {
        let conn_id = parse_conn_id(connection_id).ok()?;
        let map = self.connections.read().await;
        map.get(&conn_id).map(|h| ConnectionStatusDto {
            connection_id: h.id.to_string(),
            status: h.status,
            last_error: h.last_error.clone(),
            rtt_ms: h.rtt_ms,
        })
    }

    /// Measure and record the round-trip time of a live connection.
    pub async fn ping(&self, connection_id: &str) -> Result<u64, ConnectionError> {
        let conn_id = parse_conn_id(connection_id)?;
        let client = {
            let map = self.connections.read().await;
            map.get(&conn_id)
                .and_then(|h| h.client.clone())
                .ok_or_else(|| ConnectionError::ConnectionNotFound(connection_id.to_owned()))?
        };
        let rtt = client.rtt().await?;
        let ms = u64::try_from(rtt.as_millis()).unwrap_or(u64::MAX);
        if let Some(handle) = self.connections.write().await.get_mut(&conn_id) {
            handle.rtt_ms = Some(ms);
        }
        Ok(ms)
    }

    // --- helpers ----------------------------------------------------------

    /// Move any provided secrets into the [`SecretStore`] and return the auth
    /// with secret fields cleared (safe to persist). Absent secrets are left
    /// untouched in the store (so an update that doesn't re-enter a password
    /// keeps the existing one).
    async fn stash_secrets(
        &self,
        profile_id: &str,
        auth: &ConnectionAuth,
    ) -> Result<ConnectionAuth, ConnectionError> {
        Ok(match auth {
            ConnectionAuth::None => ConnectionAuth::None,
            ConnectionAuth::UserPassword(UserPasswordAuth { username, password }) => {
                self.store_if_some(profile_id, "password", password.as_deref())
                    .await?;
                ConnectionAuth::UserPassword(UserPasswordAuth {
                    username: username.clone(),
                    password: None,
                })
            }
            ConnectionAuth::Token(TokenAuth { token }) => {
                self.store_if_some(profile_id, "token", token.as_deref())
                    .await?;
                ConnectionAuth::Token(TokenAuth { token: None })
            }
            ConnectionAuth::NKey(NKeyAuth { seed }) => {
                self.store_if_some(profile_id, "nkey_seed", seed.as_deref())
                    .await?;
                ConnectionAuth::NKey(NKeyAuth { seed: None })
            }
            ConnectionAuth::Jwt(JwtAuth { jwt, seed }) => {
                self.store_if_some(profile_id, "jwt_seed", seed.as_deref())
                    .await?;
                ConnectionAuth::Jwt(JwtAuth {
                    jwt: jwt.clone(),
                    seed: None,
                })
            }
            // `.creds` is referenced by path (not a stored secret).
            ConnectionAuth::Creds(creds) => ConnectionAuth::Creds(creds.clone()),
        })
    }

    async fn store_if_some(
        &self,
        profile_id: &str,
        field: &str,
        value: Option<&str>,
    ) -> Result<(), ConnectionError> {
        if let Some(v) = value {
            self.secrets
                .set(&secret_key(profile_id, field), SecretString::new(v))
                .await?;
        }
        Ok(())
    }

    async fn materialize_auth(
        &self,
        profile_id: &str,
        auth: &ConnectionAuth,
    ) -> Result<ResolvedAuth, ConnectionError> {
        Ok(match auth {
            ConnectionAuth::None => ResolvedAuth::None,
            ConnectionAuth::UserPassword(UserPasswordAuth { username, .. }) => {
                ResolvedAuth::UserPassword {
                    username: username.clone(),
                    password: self.get_secret(profile_id, "password").await?,
                }
            }
            ConnectionAuth::Token(_) => {
                ResolvedAuth::Token(self.get_secret(profile_id, "token").await?)
            }
            ConnectionAuth::NKey(_) => ResolvedAuth::NKey {
                seed: self.get_secret(profile_id, "nkey_seed").await?,
            },
            ConnectionAuth::Jwt(JwtAuth { jwt, .. }) => ResolvedAuth::Jwt {
                jwt: jwt.clone(),
                seed: self.get_secret(profile_id, "jwt_seed").await?,
            },
            ConnectionAuth::Creds(CredsAuth { creds_path }) => ResolvedAuth::Creds {
                path: creds_path.clone(),
            },
        })
    }

    async fn get_secret(
        &self,
        profile_id: &str,
        field: &str,
    ) -> Result<SecretString, ConnectionError> {
        self.secrets
            .get(&secret_key(profile_id, field))
            .await?
            .ok_or_else(|| ConnectionError::MissingSecret(field.to_owned()))
    }

    fn emit_status(
        &self,
        conn_id: &ConnectionId,
        status: ConnectionStatus,
        last_error: Option<String>,
        rtt_ms: Option<u64>,
    ) {
        let payload = EventPayload::ConnectionStatusChanged(ConnectionStatusDto {
            connection_id: conn_id.to_string(),
            status,
            last_error,
            rtt_ms,
        });
        self.events.publish(Event::new(
            payload,
            Some(conn_id.to_string()),
            self.clock.now(),
        ));
    }

    fn emit_server_info(&self, conn_id: &ConnectionId, server_info: ServerInfoDto) {
        let payload = EventPayload::ServerInfoUpdated(ServerInfoUpdatedDto {
            connection_id: conn_id.to_string(),
            server_info,
        });
        self.events.publish(Event::new(
            payload,
            Some(conn_id.to_string()),
            self.clock.now(),
        ));
    }
}

fn parse_conn_id(s: &str) -> Result<ConnectionId, ConnectionError> {
    s.parse::<ConnectionId>()
        .map_err(|_| ConnectionError::ConnectionNotFound(s.to_owned()))
}

fn map_tls(tls: &TlsConfig) -> ResolvedTls {
    ResolvedTls {
        ca_cert_path: tls.ca_cert_path.clone(),
        client_cert_path: tls.client_cert_path.clone(),
        client_key_path: tls.client_key_path.clone(),
        insecure_skip_verify: tls.insecure_skip_verify,
        sni: tls.sni.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use ns_core::{CoreError, DomainError, ErrorCode};
    use ns_types::ConnectionOptions;
    use time::OffsetDateTime;

    use super::*;

    // ---- mock ports ----

    #[derive(Default)]
    struct MockRepo {
        profiles: RwLock<HashMap<String, ConnectionProfile>>,
    }
    #[async_trait]
    impl ConnectionProfileRepo for MockRepo {
        async fn list(&self) -> Result<Vec<ConnectionProfile>, CoreError> {
            Ok(self.profiles.read().await.values().cloned().collect())
        }
        async fn get(&self, id: &str) -> Result<Option<ConnectionProfile>, CoreError> {
            Ok(self.profiles.read().await.get(id).cloned())
        }
        async fn upsert(&self, profile: &ConnectionProfile) -> Result<(), CoreError> {
            self.profiles
                .write()
                .await
                .insert(profile.id.clone(), profile.clone());
            Ok(())
        }
        async fn delete(&self, id: &str) -> Result<(), CoreError> {
            self.profiles.write().await.remove(id);
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockSecrets {
        map: RwLock<HashMap<String, String>>,
    }
    #[async_trait]
    impl SecretStore for MockSecrets {
        async fn set(&self, key: &str, secret: SecretString) -> Result<(), CoreError> {
            self.map
                .write()
                .await
                .insert(key.to_owned(), secret.expose().to_owned());
            Ok(())
        }
        async fn get(&self, key: &str) -> Result<Option<SecretString>, CoreError> {
            Ok(self.map.read().await.get(key).map(SecretString::new))
        }
        async fn delete(&self, key: &str) -> Result<(), CoreError> {
            self.map.write().await.remove(key);
            Ok(())
        }
        async fn available(&self) -> bool {
            true
        }
    }

    struct MockClient;
    #[async_trait]
    impl NatsClient for MockClient {
        async fn server_info(&self) -> Option<ServerInfoDto> {
            Some(ServerInfoDto {
                server_id: "NATEST".into(),
                server_name: "test-server".into(),
                version: "2.10.25".into(),
                proto: 1,
                host: "127.0.0.1".into(),
                port: 4222,
                max_payload: 1_048_576,
                jetstream: true,
                auth_required: false,
                tls_required: false,
                client_id: Some(1),
                cluster: None,
            })
        }
        async fn rtt(&self) -> Result<Duration, CoreError> {
            Ok(Duration::from_millis(3))
        }
        async fn flush(&self) -> Result<(), CoreError> {
            Ok(())
        }
        async fn drain(&self) -> Result<(), CoreError> {
            Ok(())
        }
    }

    struct MockFactory {
        fail: bool,
    }
    #[async_trait]
    impl NatsClientFactory for MockFactory {
        async fn connect(&self, _spec: &ConnectSpec) -> Result<Arc<dyn NatsClient>, CoreError> {
            if self.fail {
                Err(CoreError::coded(
                    ErrorCode::ConnectionTimeout,
                    "no route to host",
                    true,
                ))
            } else {
                Ok(Arc::new(MockClient))
            }
        }
    }

    #[derive(Default)]
    struct CapturingPublisher {
        events: Mutex<Vec<Event>>,
    }
    impl EventPublisher for CapturingPublisher {
        fn publish(&self, event: Event) {
            self.events.lock().unwrap().push(event);
        }
    }
    impl CapturingPublisher {
        fn statuses(&self) -> Vec<ConnectionStatus> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match &e.payload {
                    EventPayload::ConnectionStatusChanged(dto) => Some(dto.status),
                    _ => None,
                })
                .collect()
        }
        fn server_info_count(&self) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e.payload, EventPayload::ServerInfoUpdated(_)))
                .count()
        }
    }

    #[derive(Default)]
    struct FixedClock;
    impl Clock for FixedClock {
        fn now(&self) -> OffsetDateTime {
            OffsetDateTime::UNIX_EPOCH
        }
    }

    fn service(
        fail: bool,
    ) -> (
        ConnectionService,
        Arc<MockSecrets>,
        Arc<MockRepo>,
        Arc<CapturingPublisher>,
    ) {
        let repo = Arc::new(MockRepo::default());
        let secrets = Arc::new(MockSecrets::default());
        let events = Arc::new(CapturingPublisher::default());
        let svc = ConnectionService::new(
            repo.clone(),
            secrets.clone(),
            Arc::new(MockFactory { fail }),
            events.clone(),
            Arc::new(FixedClock),
        );
        (svc, secrets, repo, events)
    }

    fn user_pass_input() -> ConnectionProfileInput {
        ConnectionProfileInput {
            name: "local".into(),
            servers: vec!["nats://127.0.0.1:4222".into()],
            auth: ConnectionAuth::UserPassword(UserPasswordAuth {
                username: "admin".into(),
                password: Some("s3cret".into()),
            }),
            tls: None,
            options: ConnectionOptions {
                max_reconnects: None,
                reconnect_delay_ms: 2000,
                connect_timeout_ms: 5000,
                ping_interval_ms: 30000,
                no_echo: false,
            },
        }
    }

    #[tokio::test]
    async fn create_profile_stashes_secret_and_redacts() {
        let (svc, secrets, repo, _) = service(false);
        let profile = svc.create_profile(user_pass_input()).await.unwrap();

        // returned + persisted profile carry no password
        match &profile.auth {
            ConnectionAuth::UserPassword(u) => assert!(u.password.is_none()),
            _ => panic!("wrong auth kind"),
        }
        let stored = repo.get(&profile.id).await.unwrap().unwrap();
        match &stored.auth {
            ConnectionAuth::UserPassword(u) => assert!(u.password.is_none()),
            _ => panic!("wrong auth kind"),
        }
        // secret landed in the store under the derived key
        let key = secret_key(&profile.id, "password");
        assert_eq!(secrets.get(&key).await.unwrap().unwrap().expose(), "s3cret");
    }

    #[tokio::test]
    async fn connect_success_drives_connected_and_emits_events() {
        let (svc, _, _, events) = service(false);
        let profile = svc.create_profile(user_pass_input()).await.unwrap();

        let summary = svc.connect(&profile.id).await.unwrap();
        assert_eq!(summary.status, ConnectionStatus::Connected);
        assert!(summary.server_info.is_some());

        assert_eq!(
            events.statuses(),
            vec![ConnectionStatus::Connecting, ConnectionStatus::Connected]
        );
        assert_eq!(events.server_info_count(), 1);
        assert_eq!(svc.list_connections().await.len(), 1);
    }

    #[tokio::test]
    async fn connect_failure_drives_failed_and_errors() {
        let (svc, _, _, events) = service(true);
        let profile = svc.create_profile(user_pass_input()).await.unwrap();

        let err = svc.connect(&profile.id).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::ConnectionTimeout);
        assert_eq!(
            events.statuses(),
            vec![ConnectionStatus::Connecting, ConnectionStatus::Failed]
        );
        // the failed connection is retained with its error
        let conns = svc.list_connections().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].status, ConnectionStatus::Failed);
        assert!(conns[0].last_error.is_some());
    }

    #[tokio::test]
    async fn connect_with_missing_secret_errors_before_dialing() {
        let (svc, secrets, repo, events) = service(false);
        let profile = svc.create_profile(user_pass_input()).await.unwrap();
        // wipe the stored secret to simulate a keychain miss
        secrets
            .map
            .write()
            .await
            .remove(&secret_key(&profile.id, "password"));
        let _ = repo;

        let err = svc.connect(&profile.id).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::AuthFailed);
        // no handle created, no events emitted
        assert!(events.statuses().is_empty());
        assert!(svc.list_connections().await.is_empty());
    }

    #[tokio::test]
    async fn disconnect_removes_and_emits() {
        let (svc, _, _, events) = service(false);
        let profile = svc.create_profile(user_pass_input()).await.unwrap();
        let summary = svc.connect(&profile.id).await.unwrap();

        svc.disconnect(&summary.connection_id).await.unwrap();
        assert!(svc.list_connections().await.is_empty());
        assert_eq!(
            *events.statuses().last().unwrap(),
            ConnectionStatus::Disconnected
        );

        // disconnecting an unknown id errors
        assert!(svc.disconnect(&summary.connection_id).await.is_err());
    }

    #[tokio::test]
    async fn delete_profile_removes_profile_and_secret() {
        let (svc, secrets, repo, _) = service(false);
        let profile = svc.create_profile(user_pass_input()).await.unwrap();

        svc.delete_profile(&profile.id).await.unwrap();
        assert!(repo.get(&profile.id).await.unwrap().is_none());
        assert!(secrets
            .get(&secret_key(&profile.id, "password"))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn ping_records_rtt() {
        let (svc, _, _, _) = service(false);
        let profile = svc.create_profile(user_pass_input()).await.unwrap();
        let summary = svc.connect(&profile.id).await.unwrap();
        let ms = svc.ping(&summary.connection_id).await.unwrap();
        assert_eq!(ms, 3);
        let status = svc.get_status(&summary.connection_id).await.unwrap();
        assert_eq!(status.rtt_ms, Some(3));
    }
}
