# NATS Studio — Master Architecture

> Document ID: `arch/README`
> Status: **ACCEPTED — Master Synthesis (v1.0)**
> Owner: Principal Architect
> Binds to: [`00-conventions-and-workspace.md`](./00-conventions-and-workspace.md) (the Spine / Source of Truth)
> Audience: All subsystem teams, cross-cutting strategists, and any human decision-maker evaluating the plan.

This document is the **single entry point** to the NATS Studio architecture. It reconciles the 14 subsystem designs and 5 cross-cutting strategies into one coherent whole, catalogs every IPC command and event, and links to every detailed design. For build sequencing see the [Implementation Roadmap](./implementation-roadmap.md); for the crate graph see the [Dependency Graph](./dependency-graph.md).

---

## 1. Product overview

**NATS Studio** is a production-grade, cross-platform (Windows / macOS / Linux) desktop GUI for [NATS](https://nats.io), targeting the quality bar of RedisInsight, pgAdmin, MongoDB Compass, Conduktor, DBeaver, and Lens. It is the definitive graphical tool for operating, observing, and building on NATS.

It covers the full NATS surface:

- **Core NATS** — publish/subscribe, request/reply, queue groups, subjects & wildcards.
- **JetStream** — streams, consumers, replay/ack, KV store, Object store, mirrors/sources, backup/restore.
- **Service API (`$SRV` / micro)** — discovery, ping, stats, schema of running services.
- **Monitoring** — server HTTP endpoints (`/varz`, `/connz`, `/routez`, `/subsz`, `/jsz`, `/healthz`, `/accountz`, `/gatewayz`, `/leafz`) plus `$SYS`/`$SRV` fan-in and derived time-series.
- **Security** — NKeys, JWT, `.creds`, TLS, operator/account/user hierarchy, decentralized auth, audit.
- **Topology** — clusters, routes, gateways, leaf nodes, superclusters.
- **Productivity** — embedded `nats`-CLI terminal, message inspector, subject explorer, dashboards, saved workspaces, and a versioned plugin system.

**Shell:** Tauri v2 (Rust backend + system WebView). **Backend:** Rust + tokio + `async-nats`. **Frontend:** React 18 + TypeScript + Vite/pnpm + Tailwind + Zustand + TanStack Query + Monaco + xterm.js + ECharts.

### 1.1 Non-negotiable principles

1. **Clean architecture + SOLID** — a Cargo workspace of small single-responsibility crates behind trait ports; dependencies flow one way; no cycles (CI-enforced).
2. **Dependency inversion at every seam** — services depend on ports (traits) in `ns-core`; infrastructure (async-nats, SQLite, reqwest, keychain, PTY) implements them; the **binary is the only composition root**.
3. **Async everywhere on IO; never block the WebView** — every command is `async`; long/streaming work runs on cancellable tokio tasks.
4. **One shared DTO crate** — `ns-types` is the frozen Rust↔TS source of truth (typeshare).
5. **Typed, secret-safe errors** — `thiserror` per crate, one `IpcError` wire DTO, mandatory redaction + correlation IDs.
6. **Production-grade by default** — reconnection, backpressure, bounded buffers, coalescing, opt-in telemetry, signed auto-update.

---

## 2. Layered architecture

Five layers; dependencies flow strictly downward. The single binary `nats-studio` is the only composition root and the only place that wires ports to adapters.

```
L4  bin ................ nats-studio (apps/desktop/src-tauri)         ← composition root, command registry, EventBridge start
L3  composition/glue ... ns-dashboard, ns-ipc                         ← compose L2 peers / Tauri boundary
L2  feature services ... ns-connection, ns-pubsub, ns-jetstream,      ← one service trait each, headless, mockable
                         ns-monitor, ns-subject, ns-terminal, ns-plugin
L1  adapters/leaf ...... ns-event, ns-nats, ns-security, ns-storage,  ← single-dependency confinement crates
                         ns-telemetry, ns-inspector
L0  foundation ......... ns-types, ns-core                            ← DTOs (frozen) + ports/kernel
dev ................... ns-testkit                                    ← test harness, used by every crate
```

**Single-dependency confinement** (each heavyweight dependency lives in exactly one crate): `async-nats` → `ns-nats`; `rusqlite`/SQL → `ns-storage`; `keyring` → `ns-security`; `reqwest` → `ns-monitor`; `portable-pty` → `ns-terminal`; `tauri` → `ns-ipc` + the bin only.

See [dependency-graph.md](./dependency-graph.md) for the full Mermaid crate graph and the subsystem interaction diagram.

### 2.1 Crate catalog

| Crate | Layer | Owning subsystem | Responsibility |
|---|---|---|---|
| `ns-types` | L0 | core-runtime | Frozen serde DTOs, `ErrorCode`, `IpcError`, event payloads — the Rust↔TS SoT (typeshare). |
| `ns-core` | L0 | core-runtime | Kernel: **all port traits**, `DomainError`, newtype IDs, `CancellationToken`/tasks, `Settings`, `Redacted<T>`. |
| `ns-event` | L1 | core-runtime | Internal async event bus (broadcast + mpsc), `Event` envelope + monotonic seq, coalescing policy. |
| `ns-nats` | L1 | connection-manager | `async-nats` adapter + `NatsClient`/`JsContext`/`Subscription` impls. **Only crate importing async-nats.** |
| `ns-security` | L1 | account-security | NKeys/JWT/`.creds`/rustls + `SecretStore` (keychain + encrypted vault). **Only crate with keyring.** |
| `ns-storage` | L1 | storage | `rusqlite` (bundled) + migrations + **all repositories**. **Only crate with SQL.** |
| `ns-telemetry` | L1 | logging-observability | Layered `tracing`, file rotation, in-app log ring + stream, opt-in telemetry, diagnostics bundle. |
| `ns-inspector` | L1 | message-inspector | Payload codecs (JSON/MsgPack/Protobuf/Avro/CBOR/text/bin), detection, schema validation, hex model. |
| `ns-connection` | L2 | connection-manager | `ConnectionService`: profiles, connect/reconnect lifecycle, health, per-connection handle registry. |
| `ns-pubsub` | L2 | pubsub | `PubSubService`: publish, subscribe (+queue groups), request/reply, `$SRV` ad-hoc, responders. |
| `ns-jetstream` | L2 | jetstream | `JetStreamService`: streams/consumers/messages + KV + Object store + backup/restore (4 modules). |
| `ns-monitor` | L2 | monitoring | `MonitorService`: HTTP endpoint polling, `$SYS`/`$SRV` fan-in, bounded metric ring buffers. |
| `ns-subject` | L2 | subject-explorer | `SubjectService`: subject trie, wildcard analysis, live sampling, per-subject stats, permission overlay. |
| `ns-terminal` | L2 | terminal | `TerminalService`: PTY sessions running the `nats` CLI, scripts/runbooks, Copy-as-CLI. **Only crate with portable-pty.** |
| `ns-plugin` | L2 | plugin-architecture | Plugin host + SDK: manifest, capability model, versioned Plugin API, extension registry, sandboxed invoke. |
| `ns-dashboard` | L3 | dashboard | `DashboardService`: overview aggregator composing connection + monitor + jetstream; alert engine. |
| `ns-ipc` | L3 | tauri-shell | Tauri glue: `to_ipc_error`, `Ctx`/stream helpers, `EventBridge`, cancellation registry. **Only lib with tauri.** |
| `nats-studio` | L4 | tauri-shell | The only binary + composition root: build `AppState`, register commands, start runtime, plugins, bridge. |
| `ns-testkit` | dev | testing-strategy | Embedded `nats-server` fixture, mock ports, DTO builders, assertions. Used by every crate's tests. |

Cross-cutting strategies (Security Model, Performance, Testing, Deployment) do **not** own crates; they set policy that spans many crates. `tools/xtask` (owned by deployment-strategy) is the repo automation binary (`sync-version`, `check-layers`, `gen-types`, `bundle`, `verify-tools`).

---

## 3. IPC command catalog

All commands are `snake_case`, namespaced by subsystem prefix, take one `req: XxxRequest`, and return `Result<XxxResponse, IpcError>`. The frontend calls only generated typed wrappers in `packages/ns-bindings` (`ipc.<subsystem>.<method>`), never raw `invoke`. Kind legend: **R** = request/response, **C** = command (mutation), **S** = stream (returns a `subscriptionId`/`sessionId`/`taskId`; paired with a `*_cancel`/`*_unsubscribe`).

**~271 reconciled commands across 16 namespaces.** (Post-dedup — see [§8 Reconciliation](#8-reconciliation-decisions) for the removed duplicates.)

### 3.1 `app_*` / `settings_*` / `task_*` — core runtime & shell *(ns-core, ns-ipc, bin)*
`app_info` R · `app_health` R · `app_shutdown` C · `app_cancel` C *(trip a CancellationRegistry id)* · `app_perf_stats` R *(dev HUD)* · `settings_get` R · `settings_update` C · `task_list` R · `task_cancel` C
`window_open` C · `window_close` C · `window_list` R · `window_set_title` C · `window_bind_connection` C · `window_unbind_connection` C · `dialog_open_file` R · `dialog_save_file` R · `dialog_message` R · `notify` C · `update_check` R · `update_install` S · `deeplink_current` R

### 3.2 `connection_*` — connection manager *(ns-connection)*
`connection_list_profiles` R · `connection_get_profile` R · `connection_create_profile` C · `connection_update_profile` C · `connection_delete_profile` C · `connection_clone_profile` C · `connection_import_profiles` C · `connection_export_profiles` R · `connection_test` C · `connection_connect` C · `connection_disconnect` C · `connection_reconnect` C · `connection_list` R · `connection_get_status` R · `connection_get_server_info` R · `connection_ping` C · `connection_get_metrics` R · `connection_stream_metrics` S · `connection_stream_metrics_cancel` C · `connection_trust_host_key` C

### 3.3 `pubsub_*` — publish/subscribe/request *(ns-pubsub)*
`pubsub_publish` R · `pubsub_publish_jetstream` R · `pubsub_subscribe` S · `pubsub_set_paused` C · `pubsub_subscription_stats` R · `pubsub_unsubscribe` C · `pubsub_request` R · `pubsub_request_many` S · `pubsub_request_many_cancel` C · `pubsub_service_request` R · `pubsub_start_responder` C · `pubsub_stop_responder` C · `pubsub_list_responders` R · `pubsub_replay` R
*(history/template/saved-request persistence commands consolidated into `storage` — see §8.)*

### 3.4 `jetstream_*` / `kv_*` / `objectstore_*` — JetStream *(ns-jetstream)*
**Streams/messages:** `jetstream_list_streams` R · `jetstream_get_stream` R · `jetstream_create_stream` R · `jetstream_update_stream` R · `jetstream_delete_stream` R · `jetstream_purge_stream` R · `jetstream_stream_subjects` R · `jetstream_get_message` R · `jetstream_delete_message` R · `jetstream_start_replay` S · `jetstream_cancel_replay` C
**Consumers:** `jetstream_list_consumers` R · `jetstream_get_consumer` R · `jetstream_create_consumer` R · `jetstream_update_consumer` R · `jetstream_delete_consumer` R · `jetstream_pause_consumer` R · `jetstream_resume_consumer` R · `jetstream_watch_lag` C · `jetstream_unwatch_lag` C
**Backup/account:** `jetstream_start_backup` S · `jetstream_start_restore` S · `jetstream_cancel_transfer` C · `jetstream_account_limits` R
**KV:** `kv_list_buckets` R · `kv_create_bucket` R · `kv_delete_bucket` R · `kv_status` R · `kv_list_keys` R · `kv_get` R · `kv_put` R · `kv_delete` R · `kv_history` R · `kv_start_watch` S · `kv_cancel_watch` C
**Object store:** `objectstore_list_buckets` R · `objectstore_create_bucket` R · `objectstore_delete_bucket` R · `objectstore_status` R · `objectstore_list_objects` R · `objectstore_object_info` R · `objectstore_delete_object` R · `objectstore_start_put` S · `objectstore_start_get` S · `objectstore_cancel_transfer` C

### 3.5 `monitor_*` — monitoring *(ns-monitor)*
`monitor_get_varz` R · `monitor_get_connz` R · `monitor_get_routez` R · `monitor_get_subsz` R · `monitor_get_gatewayz` R · `monitor_get_leafz` R · `monitor_get_accountz` R · `monitor_get_accstatz` R · `monitor_get_healthz` R · `monitor_get_jsz` R · `monitor_get_topology` R · `monitor_get_series` R · `monitor_get_health` R · `monitor_start_polling` C · `monitor_update_plan` C · `monitor_pause_polling` C · `monitor_resume_polling` C · `monitor_stop_polling` C · `monitor_get_settings` R · `monitor_update_settings` C · `monitor_subscribe_metrics` S · `monitor_unsubscribe_metrics` C

### 3.6 `dashboard_*` — dashboard *(ns-dashboard)*
`dashboard_get_overview` R · `dashboard_get_traffic_series` R · `dashboard_subscribe_overview` S · `dashboard_unsubscribe_overview` C · `dashboard_list_alert_rules` R · `dashboard_create_alert_rule` C · `dashboard_update_alert_rule` C · `dashboard_delete_alert_rule` C · `dashboard_set_alert_rule_enabled` C · `dashboard_test_alert_rule` C · `dashboard_list_alert_events` R · `dashboard_acknowledge_alert` C · `dashboard_get_timeline` R

### 3.7 `subject_*` — subject explorer *(ns-subject)*
`subject_get_tree` R · `subject_get_children` R · `subject_start_sampling` S · `subject_stop_sampling` C · `subject_analyze_pattern` R · `subject_expand_wildcard` R · `subject_get_stats` R · `subject_search` R · `subject_check_permission` R · `subject_refresh_subsz` C · `subject_list_favorites` R · `subject_add_favorite` R · `subject_remove_favorite` R · `subject_rename_favorite` R

### 3.8 `inspector_*` — message inspector *(ns-inspector)*
`inspector_detect` R · `inspector_inspect` R · `inspector_inspect_as` R · `inspector_hexdump` R · `inspector_convert` R · `inspector_validate` R · `inspector_search` R · `inspector_search_cancel` C · `inspector_export` S · `inspector_export_cancel` C · `inspector_list_codecs` R · `inspector_list_validators` R · `inspector_list_schemas` R · `inspector_get_schema` R · `inspector_save_schema` R · `inspector_delete_schema` R · `inspector_import_schema` R

### 3.9 `security_*` — account & security *(ns-security)*
`security_generate_nkey` R · `security_derive_public_key` R · `security_sign` R · `security_verify` R · `security_parse_creds` R · `security_build_creds` R · `security_decode_jwt` R · `security_verify_jwt_chain` R · `security_issue_user_jwt` C · `security_issue_account_jwt` C · `security_build_hierarchy` R · `security_build_authz_graph` R · `security_validate_permissions` R · `security_diff_permissions` R · `security_inspect_certificate` R · `security_inspect_connection_cert` R · `security_secret_store_status` R · `security_store_secret` C · `security_reveal_secret` C · `security_delete_secret` C · `security_audit_query` R · `security_audit_verify` R · `security_audit_export` C

### 3.10 `terminal_*` — terminal *(ns-terminal)*
`terminal_open` S · `terminal_write` C · `terminal_resize` C · `terminal_signal` C · `terminal_close` C · `terminal_list_sessions` R · `terminal_run_command` S · `terminal_run_command_cancel` C · `terminal_generate_cli` R · `terminal_list_history` R · `terminal_clear_history` C · `terminal_save_script` R · `terminal_get_script` R · `terminal_list_scripts` R · `terminal_delete_script` C · `terminal_save_runbook` R · `terminal_list_runbooks` R · `terminal_delete_runbook` C · `terminal_run_runbook` S · `terminal_run_runbook_cancel` C · `terminal_runbook_confirm` C

### 3.11 `log_*` — logging & observability *(ns-telemetry)*
`log_query` R · `log_subscribe` S · `log_unsubscribe` C · `log_get_level` R · `log_set_level` C · `log_export` R · `log_list_sources` R · `log_open_source` R · `log_close_source` C · `log_report` C *(canonical FE-diagnostic sink)* · `log_build_diagnostics_bundle` R *(canonical diagnostics zip)* · `log_stats` R · `log_save_view` C · `log_list_views` R · `log_delete_view` C

### 3.12 `workspace_*` / `layout_*` / `history_*` / `template_*` / `savedrequest_*` / `bookmark_*` / `recent_*` / `storage_*` — persistence *(ns-storage)*
`workspace_list` R · `workspace_create` C · `workspace_update` C · `workspace_delete` C · `workspace_duplicate` C · `workspace_set_active` C · `layout_get` R · `layout_save` C · `layout_reset` C · `history_query` R · `history_get` R · `history_delete` C · `history_clear` C · `savedrequest_list` R · `savedrequest_upsert` C · `savedrequest_delete` C · `template_list` R · `template_upsert` C · `template_delete` C · `bookmark_list` R · `bookmark_toggle` C · `bookmark_reorder` C · `recent_list` R · `recent_pin` C · `recent_clear` C · `storage_stats` R · `storage_backup` C · `storage_restore` C · `storage_export_bundle` C · `storage_import_bundle` C · `storage_vacuum` C · `storage_integrity_check` C

### 3.13 `plugin_*` — plugin architecture *(ns-plugin)*
`plugin_list` R · `plugin_list_extensions` R · `plugin_install` C · `plugin_uninstall` C · `plugin_enable` C · `plugin_disable` C · `plugin_update` C · `plugin_grant` C · `plugin_get_config` R · `plugin_set_config` C · `plugin_invoke` S · `plugin_registry_search` R · `plugin_registry_install` C

---

## 4. Event catalog

Internal producers publish **domain events** through the `EventPublisher` port (`ns-core`) onto the `ns-event` bus. The **`EventBridge` in `ns-ipc` is the only component that translates bus events to Tauri events** — it filters to UI-relevant topics, applies per-topic coalescing/backpressure, and emits to the window(s) bound to the relevant `connectionId`. Feature crates never import `tauri`. Request-scoped streams (subscribe/replay/watch/terminal/log-tail/sampling/export/transfer) travel on **Tauri Channels**, not on these ambient events (ADR-0009).

| Tauri topic | `EventPayload` variant | Producer(s) | Policy |
|---|---|---|---|
| `ns://connection/status` | `ConnectionStatusChanged` | ns-connection | Dedupe identical; always deliver transitions. Never coalesce away. |
| `ns://server/info` | `ServerInfoUpdated` | ns-connection (handshake), ns-monitor (varz delta) | Keep-latest per connection. Payload is a merge of both sources (see §8). |
| `ns://monitor/metrics` | `MetricsTick` | ns-connection (client-side), ns-monitor (server-side) | Keep-latest per `(connectionId, metric[, serverId])` within a 250 ms tick. Carries `source`. |
| `ns://monitor/health` | `HealthChanged` † | ns-monitor | Always deliver transitions. |
| `ns://monitor/topology` | `TopologyChanged` † | ns-monitor | Dedupe identical. |
| `ns://jetstream/stream` | `StreamUpdated` | ns-jetstream | Dedupe consecutive; keep-latest per `(conn, stream)`. |
| `ns://jetstream/consumer-lag` | `ConsumerLag` | ns-jetstream | Keep-latest per `(conn, stream, consumer)`. From ref-counted sampler. |
| `ns://subject/activity` | `SubjectActivity` | ns-pubsub, ns-subject | Rate-limit N/s per connection; aggregate + surface dropped. |
| `ns://dashboard/alert` | `AlertStateChanged` † | ns-dashboard | Dedupe identical; always deliver transitions. |
| `ns://dashboard/timeline` | `TimelineAppended` † | ns-dashboard | Rate-limit 10/s per connection. |
| `ns://inspector/schema` | `SchemaRegistryChanged` † | ns-inspector | Dedupe identical (multi-window schema sync). |
| `ns://security/audit` | `SecurityAuditAppended` † | ns-security | Never drop; order preserved. |
| `ns://security/secret-store` | `SecretStoreStatusChanged` † | ns-security | Dedupe identical. |
| `ns://security/jwt-expiry` | `JwtExpiryWarning` † | ns-security | Keep-latest per subject. |
| `ns://log` | `LogEmitted` | ns-telemetry | Bounded ring, drop-oldest, surface truncated; ambient only `>= ambientMinLevel`. |
| `ns://task/progress` | `TaskProgress` | ns-core (framework) + any long op | Keep-latest per `taskId`; throttled. |
| `ns://notification` | `Notification` | any subsystem | **Never drop.** |
| `ns://plugin` | `PluginEvent` | ns-plugin (host) | Progress keep-latest per id; Quarantined/CapabilityDenied never dropped. |
| `ns://storage/changed` | `DataChanged` † | ns-storage | *(Optional, multi-window cache invalidation — gated, see §8.)* |
| `ns://update/status`, `ns://update/progress` | update DTOs | bin (updater) | Progress keep-latest. |
| `ns://window/lifecycle`, `ns://menu/action`, `ns://tray/action`, `ns://deeplink`, `ns://app/quit-requested` | shell DTOs | bin | Shell OS-surface signals. |

† = **new `EventPayload` variant** added to the frozen `ns-types` enum. All ten new variants ship together in the **Contract-Expansion ADR (ADR-0020)** + one `appSchemaVersion` bump (see §8). A lagging broadcast receiver yields `RecvError::Lagged(n)` → the bridge emits a synthetic gap indicator so the UI shows dropped-event gaps.

---

## 5. Error model

Four layers, one wire surface (ADR-0008):

1. **Per-crate `thiserror` enums** — each crate exposes exactly one public error enum (`ConnectionError`, `JetStreamError`, `NatsError`, `StorageError`, `MonitorError`, `SecurityError`, `PubSubError`, `InspectorError`, `SubjectError`, `TerminalError`, `DashboardError`, `PluginError`, `TelemetryInitError`/`LogError`). External errors wrapped via `#[from]`. Libraries never expose `anyhow`.
2. **`anyhow` at boundaries only** — the bin's `main`, task supervisors, setup.
3. **Aggregate mapping** — every crate error implements the `DomainError` trait (`code() -> ErrorCode`, `retriable() -> bool`, `user_message() -> String`, secret-safe). `ns_ipc::to_ipc_error` is the **single serialization surface**: it walks `Error::source()`, redacts, and attaches the tracing span's `correlationId`.
4. **`IpcError` wire DTO** (`ns-types`): `{ code, message, retriable, correlationId?, causes[], detail? }`.

`ErrorCode` is a stable string enum shared with TS. The **Contract-Expansion ADR** adds the variants requested by teams: `KV_WRONG_LAST_REVISION` (KV CAS conflict, non-retriable), `SCHEMA_INVALID`, `DECOMPRESSION_LIMIT`. Every `#[tauri::command]` returns `Result<T, IpcError>`; panics are caught at the bridge → `INTERNAL` + correlation id (the WebView never crashes); mid-stream failures arrive in-band as a terminal `error` variant on the Channel.

---

## 6. Cross-cutting summaries

| Concern | Summary | Detailed design |
|---|---|---|
| **State model** | Rust: `AppState` is a **registry of `Arc<dyn Service>` ports** built in the bin (DIP + mockability + plugin override); per-connection runtime state lives inside `ConnectionService`; no global mutable statics. Frontend: **hard boundary** — server-state → TanStack Query (namespaced key arrays, folded from Channels/events, never polled), UI/session → Zustand (persisted slices mirror SQLite). | [sub-core-runtime](./sub-core-runtime.md), [sub-frontend-shell](./sub-frontend-shell.md) |
| **Storage** | `rusqlite` (bundled) behind a single-writer storage worker (no build-time `DATABASE_URL`, ADR-0003); forward-only migrations tracked by `PRAGMA user_version`; WAL + `foreign_keys`. **All tables from all teams live physically in `ns-storage`** (§8). Secrets never in SQLite (§security). | [sub-storage](./sub-storage.md) |
| **Security** | Secrets in OS keychain via `keyring`, encrypted `secrets.vault` (XChaCha20-Poly1305) fallback on headless Linux (ADR-0013); `Redacted<T>` zeroizes and never serializes; append-only hash-chained audit log; rustls-first TLS (ADR-0004); one redaction surface; CSP-locked WebView. | [xc-security-model](./xc-security-model.md), [sub-account-security](./sub-account-security.md) |
| **Performance** | Cursor/keyset pagination with server-clamped limits; TanStack Virtual on every long list; delta table patches; 250 ms metric coalescing; sampling with visible drop counts; `spawn_blocking`/rayon for CPU-bound decode/tree-build off the reactor; lazy subsystem init; dynamic-import Monaco/xterm/ECharts. | [xc-performance-strategy](./xc-performance-strategy.md) |
| **Testing** | `ns-testkit` embedded `nats-server` fixture + mock ports + DTO builders; Rust unit/integration + `insta` golden wire snapshots; Vitest + RTL + `mockIpc`; command-manifest & ErrorCode parity contract suites; WebdriverIO E2E across three OSes; criterion perf baselines. | [xc-testing-strategy](./xc-testing-strategy.md) |
| **Deployment** | SemVer single-sourced in root `Cargo.toml`, synced by `cargo xtask sync-version`; signed Tauri v2 auto-update (stable + beta); per-platform signing/notarization; `cargo-deny` bans `openssl-sys`; `panic=abort` + crash handler; opt-in telemetry with egress scrubbing. | [xc-deployment-strategy](./xc-deployment-strategy.md) |
| **Plugins** | Phase 1: in-process, trait-based, capability-gated extensions with an independently SemVer'd Plugin API; frontend plugin panels in sandboxed `<iframe>`; single `CapabilityGuard` choke point; Ed25519-signed packages. Phase 2: WASM out-of-process (ADR-0014). | [xc-plugin-architecture](./xc-plugin-architecture.md) |
| **Logging** | Layered `tracing-subscriber`: rotating file + in-app ring/stream + `EnvFilter` (hot-reloadable) + opt-in OTLP; `#[instrument]` with `connection_id`/`correlation_id`; scrubber on the log path as defense-in-depth. | [sub-logging-observability](./sub-logging-observability.md) |

---

## 7. Subsystem index

### Subsystem designs (`sub-*.md`)

| Subsystem | Crate(s) | Design doc |
|---|---|---|
| Conventions & workspace (Spine / SoT) | — | [00-conventions-and-workspace.md](./00-conventions-and-workspace.md) |
| Core runtime | `ns-types`, `ns-core`, `ns-event` | [sub-core-runtime.md](./sub-core-runtime.md) |
| Tauri shell | `ns-ipc`, `nats-studio` | [sub-tauri-shell.md](./sub-tauri-shell.md) |
| Frontend shell | *(React app, no crate)* | [sub-frontend-shell.md](./sub-frontend-shell.md) |
| Connection manager | `ns-nats`, `ns-connection` | [sub-connection-manager.md](./sub-connection-manager.md) |
| Pub/Sub | `ns-pubsub` | [sub-pubsub.md](./sub-pubsub.md) |
| JetStream | `ns-jetstream` | [sub-jetstream.md](./sub-jetstream.md) |
| Monitoring | `ns-monitor` | [sub-monitoring.md](./sub-monitoring.md) |
| Dashboard | `ns-dashboard` | [sub-dashboard.md](./sub-dashboard.md) |
| Subject explorer | `ns-subject` | [sub-subject-explorer.md](./sub-subject-explorer.md) |
| Message inspector | `ns-inspector` | [sub-message-inspector.md](./sub-message-inspector.md) |
| Account & security | `ns-security` | [sub-account-security.md](./sub-account-security.md) |
| Terminal | `ns-terminal` | [sub-terminal.md](./sub-terminal.md) |
| Logging & observability | `ns-telemetry` | [sub-logging-observability.md](./sub-logging-observability.md) |
| Storage | `ns-storage` | [sub-storage.md](./sub-storage.md) |

### Cross-cutting strategies (`xc-*.md`)

| Strategy | Spans | Design doc |
|---|---|---|
| Security model | ns-security, ns-core, ns-ipc, ns-telemetry, ns-storage, bin | [xc-security-model.md](./xc-security-model.md) |
| Performance strategy | all crates | [xc-performance-strategy.md](./xc-performance-strategy.md) |
| Testing strategy | `ns-testkit` + all | [xc-testing-strategy.md](./xc-testing-strategy.md) |
| Deployment strategy | bin, xtask, ns-telemetry, ns-storage, ns-security | [xc-deployment-strategy.md](./xc-deployment-strategy.md) |
| Plugin architecture | `ns-plugin` + extension points | [xc-plugin-architecture.md](./xc-plugin-architecture.md) |

### Planning docs

- [dependency-graph.md](./dependency-graph.md) — Mermaid crate graph + subsystem interaction diagram.
- [implementation-roadmap.md](./implementation-roadmap.md) — phased, independently-shippable build plan.

---

## 8. Reconciliation decisions

The 19 designs were mutually consistent on the big architectural moves (layering, DIP, the frozen `ns-types`, the single `EventBridge`, the Query/Zustand split). The following inconsistencies were detected and reconciled. Items marked **⚠ needs human decision** require a product/security owner before implementation; the rest are resolved here and codified in ADRs.

### Resolved — crate ownership & layering
- **`ns-jetstream` must not depend on `ns-monitor`/`ns-dashboard`.** The jetstream summary over-listed both. Account limits come from `JsContext` (`$JS.API.INFO`), not `jsz`; dashboard composes JS + monitor at L3 and never depends back. The jetstream doc itself confirms this. **No crate edge.**
- **`ns-pubsub` must not depend on the `ns-jetstream` crate.** JetStream publish (`pubsub_publish_jetstream`) uses the `JsContext` obtained via the `ClientProvider` port, not a crate edge. Stream management stays in jetstream; a plain publish-with-`PubAck` stays in pubsub (de-duplicated ack semantics).
- **`ns-inspector` stays L1**; its summary's `depends_on: [pubsub, jetstream, plugin]` are *consumer/coordination* references, not crate edges. Codec extension points are `register_codec(Arc<dyn Codec>)` ports called by the bin/plugin host — no reverse edge.
- **`ns-plugin` stays L2** (deps `ns-types`/`ns-core`/`ns-event` only); the long cross-cutting crate list is the set of crates that *expose extension points*, wired by the bin — not plugin's dependencies.
- **`ns-subject`/`ns-terminal` use ports, not crate edges,** for subsz (`SubszSource`), permissions (`SubjectPermissionSource`), creds (`CredsMaterializer`), and NATS context — all `ns-core` ports injected by the bin.

### Resolved — the `ns-ipc` dependency contradiction
- The spine lists `ns-ipc` deps as only `ns-types`/`ns-core`/`ns-event`, yet the error model puts an aggregate `AppError` wrapping every subsystem error via `#[from]` in `ns-ipc` — which would force edges to every L2 crate. **Resolution:** `ns_ipc::to_ipc_error` operates on `&dyn DomainError` (walking `Error::source()`), so it needs **no concrete error types**. The concrete aggregate `AppError` lives in the **bin** (which already depends on everything). `ns-ipc` keeps its slim L0-only dependency set. This also resolves the tauri-shell "widened L3 dep graph" risk.

### Resolved — where the NATS client ports live (ADR-0001 vs ADR-0007)
- ADR-0001 says the `NatsClient`/`JsContext` traits live in `ns-nats`; ADR-0007 says "ports live in `ns-core`." `ns-monitor` needs a NATS client (for `$SYS`/`$SRV`) but the spine omits `ns-nats` from its deps (monitoring open-question O1). **Resolution (ADR-0021):** the **port traits** `NatsClient`, `JsContext`, `Subscription`, `NatsClientFactory` and their neutral `Raw*` DTOs are **defined in `ns-core`**; `ns-nats` provides the sole `async-nats` **implementations**. Consumers (`ns-monitor`, `ns-subject`, `ns-pubsub`, `ns-jetstream`) name the trait via `ns-core` and receive clients through resolver ports (`ClientProvider`/`JsContextResolver`/`NatsClientProvider`) implemented by `ns-connection` and injected by the bin. This honors ADR-0001 (async-nats confinement is enforced at the *source-import* level by `check-layers`), satisfies ADR-0007, and removes the need for `ns-monitor → ns-nats`. Mechanical change: `ns_nats::NatsClient` → `ns_core::NatsClient` in four crates.

### Resolved — persistence duplication (pubsub ↔ storage)
- Both teams defined commands and tables for **message history, publish templates, and saved requests**. **Resolution:** `ns-storage` is the sole SQL owner and owns the tables (`message_history`, `publish_template`, `saved_request`) and the generic CRUD commands (`history_*`, `template_*`, `savedrequest_*`). The duplicate `pubsub_list_history`/`pubsub_clear_history`/`pubsub_save_template`/`pubsub_list_templates`/`pubsub_delete_template`/`pubsub_save_request`/`pubsub_list_saved_requests`/`pubsub_delete_saved_request` are **removed**; pubsub writes/reads via the repo ports and keeps only `pubsub_replay` (a NATS-side op). Tables `pubsub_history`/`pubsub_template`/`pubsub_saved_request` are dropped in favor of storage's. (~8 commands + 3 tables de-duplicated.)

### Resolved — all feature-team tables land in `ns-storage`
- `ns-storage` is the only crate with SQL, but its summary listed only its own tables. **Every** feature table — `dashboard_alert_rule`/`dashboard_alert_event`, `monitor_settings`, `inspector_schemas`/`inspector_decode_prefs`/`inspector_saved_filters`, `subject_favorite`, `audit_log`/`security_material`, `terminal_history`/`terminal_script`/`terminal_runbook`, `log_saved_view`, `plugin_kv`, `ssh_known_host`/`connection_session` — must be contributed as migrations in `ns-storage`, with the owning team defining the repo **port** in `ns-core` and the DTO in `ns-types`. Convention codified here.

### Resolved — duplicate & mis-named commands
- **`app_info`** was claimed by core-runtime, tauri-shell, and deployment-strategy. **One** command, registered by the bin, backed by a single **superset `AppInfo` DTO** in `ns-types` (fields: `version`, `appSchemaVersion`, `pluginApiVersion`/range, `storageSchemaVersion`, `os`, `arch`, `buildChannel`). Others consume it.
- **`log_report`** vs tauri-shell's `app_log_report` → canonical **`log_report`** (owner: logging-observability). core-runtime's duplicate listing dropped.
- **`app_export_diagnostics`** (tauri-shell) vs **`log_build_diagnostics_bundle`** (telemetry) → one implementation in `ns-telemetry` (`log_build_diagnostics_bundle`); the shell delegates, no separate command.
- **`task_list`/`task_cancel`** (core-runtime, `TaskRegistry`, keyed by `TaskId`) is canonical; tauri-shell's `app_list_tasks` is dropped as a duplicate. `app_cancel` is retained but scoped to tripping a **`CancellationRegistry`** id (streams/sessions) — a distinct operation from `task_cancel`.

### Resolved — dual-producer event payloads
- **`ServerInfoUpdated`** has two producers (connection handshake + monitor varz). Payload becomes a **merge**: connection populates negotiated/handshake fields, monitor populates varz fields; keep-latest per connection.
- **`MetricsTick`** carries client-side (connection) and server-side (monitor) frames. Payload gains an explicit **`source` (Client|Server)** + per-metric identity so both coexist under one coalescing key.

### Needs finalization before dependent work
- **⚠ `MetricsTick` / `ClusterMonitorSnapshot` contract** (per-server breakdown vs cluster totals) — jointly owned by **monitoring + dashboard**; must be frozen before dashboard live-streaming (Phase 4). Recommendation: per-server dimension in the payload; dashboard aggregates.
- **⚠ `SubjectActivity` field shape** — shared by pubsub (per-subscription rates) and subject-explorer (per-subject tree rates); finalize the one DTO in the Contract-Expansion ADR.
- **⚠ `$SRV` split** — pubsub owns **ad-hoc single-service** requests (`pubsub_service_request`); monitoring owns **fleet discovery + aggregation** (the Services screen). Needs an explicit interface note; no crate gap.
- **⚠ Encrypted-secret fallback location** — storage proposed a `secret_blob` table + `SecretBlobRepo`; the Security Model specifies a standalone `secrets.vault` file. **Resolved in favor of the Security Model** (vault file owned by `ns-security`); the `secret_blob` table/repo is dropped. Flagged for the security owner to confirm before Phase 6.
- **⚠ `ns://storage/changed` (`DataChanged`)** multi-window cache invalidation — include the variant in the Contract-Expansion ADR but gate emission behind a setting; ship-now-vs-defer is a product call.

### Coverage check (no unowned mission features)
Every product surface has exactly one owner: core pub/sub → pubsub; JetStream/KV/Object → jetstream; `$SRV` → pubsub (ad-hoc) + monitoring (fleet); HTTP monitoring/topology → monitoring; security/NKey/JWT/TLS/audit → account-security; terminal → terminal; inspector → message-inspector; subjects → subject-explorer; dashboards/alerts → dashboard; workspaces/history/templates/bookmarks → storage; plugins → plugin-architecture; logs → logging-observability. The only aggregation without a dedicated crate — the **Services (micro) screen** — is composed in the frontend from monitoring (fleet) + pubsub (probe); recommended backend home for fleet aggregation is `ns-monitor`.

### New ADRs required (single coordinated contract freeze)
1. **ADR-0020 — Contract Expansion:** add the 10 new `EventPayload` variants, 3 new `ErrorCode` variants, and all new `ns-core` repo/query ports in one PR + one `appSchemaVersion` bump, executed in Phase 1 before feature teams need them.
2. **ADR-0021 — NATS client ports relocate to `ns-core`** (impls stay in `ns-nats`).
3. **ADR-0022 — Persistence consolidation:** storage owns history/template/saved-request tables + commands; all feature tables land in `ns-storage`.

---

*Master synthesis complete. Detailed rationale for any subsystem lives in its linked design doc; contract changes require an ADR + `appSchemaVersion` bump per ADR-0006.*
