//! The application composition root: build `AppState` by constructing the
//! concrete adapters and injecting them (as `ns-core` ports) into the services.
//! This is the ONLY place infrastructure is wired to the domain.

use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use ns_connection::ConnectionService;
use ns_core::{
    CancellationRegistry, Clock, ConnectionProfileRepo, NatsClientFactory, NatsClientProvider,
    SecretStore, SystemClock,
};
use ns_event::EventBus;
use ns_jetstream::JetStreamService;
use ns_monitor::MonitorService;
use ns_nats::AsyncNatsFactory;
use ns_pubsub::PubSubService;
use ns_security::KeyringSecretStore;
use ns_storage::{Db, SqliteConnectionProfileRepo, SqliteSettingsRepo};
use ns_telemetry::LogStore;
use tauri::{AppHandle, Manager, Runtime};

/// Shared, thread-safe application state stored in Tauri's managed state.
pub struct AppState {
    pub connections: Arc<ConnectionService>,
    pub pubsub: Arc<PubSubService>,
    pub jetstream: Arc<JetStreamService>,
    pub monitor: Arc<MonitorService>,
    pub settings_repo: Arc<SqliteSettingsRepo>,
    pub events: EventBus,
    pub log_store: LogStore,
    /// Cancellation tokens for active subscription streams, keyed by subscription id.
    pub subscriptions: Arc<CancellationRegistry>,
    pub started_at: Instant,
}

/// Construct every adapter and assemble the service registry.
pub async fn build_state<R: Runtime>(app: &AppHandle<R>, log_store: LogStore) -> Result<AppState> {
    let data_dir = app.path().app_data_dir().context("resolve app data dir")?;
    std::fs::create_dir_all(&data_dir).context("create app data dir")?;

    let db = Db::open(data_dir.join("studio.db"))
        .await
        .context("open storage database")?;

    let profile_repo: Arc<dyn ConnectionProfileRepo> =
        Arc::new(SqliteConnectionProfileRepo::new(db.clone()));
    let settings_repo = Arc::new(SqliteSettingsRepo::new(db));
    let secrets: Arc<dyn SecretStore> = Arc::new(KeyringSecretStore::new());
    let factory: Arc<dyn NatsClientFactory> = Arc::new(AsyncNatsFactory);
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let events = EventBus::new();

    let connections = Arc::new(ConnectionService::new(
        profile_repo,
        secrets,
        factory,
        Arc::new(events.clone()),
        Arc::clone(&clock),
    ));

    // The connection registry is also the NatsClientProvider for feature services.
    let provider: Arc<dyn NatsClientProvider> =
        Arc::clone(&connections) as Arc<dyn NatsClientProvider>;
    let jetstream = Arc::new(JetStreamService::new(
        Arc::clone(&connections) as Arc<dyn NatsClientProvider>
    ));
    let pubsub = Arc::new(PubSubService::new(provider, clock));
    let monitor = Arc::new(MonitorService::new());

    Ok(AppState {
        connections,
        pubsub,
        jetstream,
        monitor,
        settings_repo,
        events,
        log_store,
        subscriptions: Arc::new(CancellationRegistry::new()),
        started_at: Instant::now(),
    })
}
