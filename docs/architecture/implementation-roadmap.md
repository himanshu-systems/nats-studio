# NATS Studio — Implementation Roadmap

> Document ID: `arch/implementation-roadmap`
> Status: **ACCEPTED (v1.0)**
> Owner: Principal Architect
> Binds to: [`README.md`](./README.md), [`dependency-graph.md`](./dependency-graph.md), [`00-conventions-and-workspace.md`](./00-conventions-and-workspace.md)

A phased build plan ordered so that **every phase is independently shippable and testable, builds strictly on the previous one, and never regresses prior functionality**. Phase 0 stands up a workspace that compiles and gates CI; Phase 1 delivers a "walking skeleton" (one real connection, end-to-end, event-driven); Phases 2–7 add one vertical slice at a time along the true dependency order; Phase 8 hardens and ships.

Sequencing rationale: the foundation everything imports (`ns-types`/`ns-core`/`ns-event`/`ns-storage`/`ns-connection`) comes first; then the most-used surface (messaging + inspector); then JetStream; then read-only observability (monitor + dashboard, purely additive); then productivity (subject + terminal); then security/logging depth; then extensibility (plugins); then release engineering. `ns-security` and `ns-storage` land in a **minimal** form in Phase 1 (connection needs TLS/`.creds` + profile persistence) and reach full depth in their own later phases.

---

## Phase 0 — Workspace scaffold that compiles + CI

**Goal:** a real, empty-but-wired Cargo workspace where all 19 crates exist, compile, pass the layer lint, and the Rust→TS type pipeline + CI are green on all three OSes. No features yet — just the rails.

**Ordered deliverables**
1. Root `Cargo.toml` `[workspace]` with all 19 members + `[workspace.dependencies]` (single-pinned); `rust-toolchain.toml` pinned to stable `1.89.0`; committed `Cargo.lock`.
2. `tools/xtask` with `sync-version`, `check-layers` (enforces the [dependency graph](./dependency-graph.md) + single-import confinement), `gen-types`, `verify-tools`; `tools/versions.toml` (pinned `nats-server`/`nats`/`cargo-tauri`/`typeshare-cli`).
3. `deny.toml` — `cargo-deny` licenses/advisories/bans (ban `openssl-sys`, ADR-0004) + SBOM.
4. All 19 crate skeletons (`lib.rs`/`main.rs` placeholders) so the graph type-checks; `ns-testkit` fixture stub.
5. `ns-types` minimal (`IpcError`, `ErrorCode`, `AppInfo`) + `pnpm gen:types` → committed `packages/ns-bindings/src/generated/types.ts`; CI runs `gen:types` then `git diff --exit-code`.
6. `apps/desktop` React 18 + Vite + pnpm + Tailwind skeleton; Tauri v2 window opens to a placeholder.
7. CI: `fmt` + `clippy -D warnings` + `xtask check-layers` + gen-types drift + `cargo build --workspace` + `pnpm build` on Windows/macOS/Linux.

**Exit criteria:** `cargo build --workspace` and `pnpm build` green on all three OSes; `xtask check-layers` passes; gen-types diff clean; the app launches to an empty shell; CI blocks a deliberately-introduced upward edge.

**Crates/teams:** core-runtime, tauri-shell, frontend-shell, deployment-strategy (CI/xtask), testing-strategy (testkit skeleton).

---

## Phase 1 — Core spine + IPC + first connection vertical slice (walking skeleton)

**Goal:** the kernel is real and **one connection opens end-to-end**, driven by the event bridge with zero polling. This phase also performs the **one-time contract freeze** so every later team builds against a stable `ns-types`/`ns-core` surface.

**Ordered deliverables**
1. **Merge ADR-0020 (Contract Expansion), ADR-0021 (NATS client ports → `ns-core`), ADR-0022 (persistence consolidation).** Finalize `ns-types`: all 10 new `EventPayload` variants, 3 new `ErrorCode` variants, unified superset `AppInfo` DTO; one `appSchemaVersion` bump; regenerate types.
2. `ns-core`: `DomainError`, `ErrorCode` helpers, newtype IDs, `Redacted<T>` (zeroize), `Clock`, `CancellationRegistry`, `TaskRegistry`, `Settings`+defaults, and **all port traits** (`NatsClient`/`JsContext`/`Subscription`/resolvers, `EventPublisher`, `SecretStore`, repo ports, `MonitorQuery`/`ConnectionQuery`/`JetStreamQuery`, `PeerCertProvider`, `SubszSource`, `SubjectPermissionSource`).
3. `ns-event`: broadcast+mpsc bus, `Event` envelope + monotonic per-topic seq, coalescing/backpressure policy engine.
4. `ns-storage` (minimal): `Db` worker (single-writer + read pool over WAL), `rusqlite_migration` runner + `PRAGMA user_version`, PRAGMAs; `SettingsRepo` + `ConnectionProfileRepo` + `schema_meta`.
5. `ns-security` (minimal): `LayeredSecretStore` (keychain + encrypted `secrets.vault` fallback), `.creds` parse, rustls `ClientConfig` builder, `Redacted` zeroize coverage.
6. `ns-nats`: `async-nats` impls of `NatsClient`/`JsContext`/`Subscription`/`Factory` (core connect, `server_info`, ping/rtt/stats/flush/drain; JS context resolvable). Inner reconnect disabled (`max_reconnects(0)`).
7. `ns-connection`: `ConnectionService` — profile CRUD, connect/disconnect/reconnect state machine (our supervisor authoritative), health, per-connection handle registry, status/serverInfo/metrics event emission.
8. `ns-ipc`: `to_ipc_error(&dyn DomainError)`, `Ctx`/`run_command`, `spawn_stream`+`StreamEvent<T>`, cancellation glue, and the **`EventBridge`** (bus→Tauri, coalescing, window-scoping, `Lagged(n)` gap-marking).
9. `ns-telemetry` (minimal): `init_telemetry` layered subscriber (rotating file + in-app ring + `EnvFilter`), `log_query`/`log_subscribe`/`log_set_level`/`log_report`.
10. `nats-studio` bin: `AppState` registry, wire adapters→ports, register `app_*`/`settings_*`/`task_*`/`connection_*`, start tokio + `EventBridge` + single-instance/deep-link/updater plugins; aggregate `AppError`.
11. Frontend shell: Providers tree, dockview host, router, `AppBootGate` (blocks on `app_info`+`settings_get`), `useAppEvents`, `ConnectionSwitcher`/`ConnectionList`/`ConnectionEditor`/status pill; `packages/ns-bindings` typed client + `commands.manifest.ts`.

**Exit criteria:** create a profile → connect to a real `nats-server` (testkit) → **Connected** status + `ServerInfo` appear via events (no polling); `app_info`/`app_health`/`settings_*` round-trip; disconnect + supervised reconnect work; a typed `IpcError` renders by code; an E2E test drives the connect flow. Layer-lint, gen-types, clippy green.

**Crates/teams:** core-runtime, connection-manager, storage (min), account-security (min), logging (min), tauri-shell, frontend-shell, testing.

---

## Phase 2 — Messaging vertical: Pub/Sub + Inspector + persistence

**Goal:** publish, streaming subscribe (queue groups), request/reply, with decoded payloads and persisted history — the daily-driver surface.

**Ordered deliverables**
1. `ns-inspector`: codecs (text/binary/hex/JSON first; MsgPack/CBOR; Protobuf/Avro best-effort), format+compression detection, `hexdump`, `convert`, JSON-Schema `validate`, `search`, `export` (Channel), `register_codec` port; decompression-bomb caps.
2. `ns-storage`: `MessageHistoryRepo`/`PublishTemplateRepo`/`SavedRequestRepo`/`BookmarkRepo`/`RecentConnectionRepo`/`WorkspaceRepo`/`LayoutRepo` + tables + the consolidated `history_*`/`template_*`/`savedrequest_*`/`bookmark_*`/`recent_*`/`workspace_*`/`layout_*` commands (ADR-0022).
3. `ns-pubsub`: `publish`/`publish_jetstream`, `subscribe` (Channel + queue groups + pause + stats + non-blocking `try_send` drop accounting), `request`/`request_many`/`service_request`, responder simulators, `replay`; history written via repo; `SubjectActivity` events.
4. Frontend: Publisher (Monaco payload + headers), Subscriber (virtualized list + rate badge + pause), Request, Responder, History+Replay panels; embeddable `MessageInspectorPanel` (Raw/JSON/Tree/Hex/Binary tabs); workspace save/restore.

**Exit criteria:** pub/sub roundtrip on a real server with visible backpressure + drop counts; request/reply distinguishes `REQUEST_TIMEOUT` vs `NO_RESPONDERS`; payload decode + hexdump + schema validation; history persists and replays; workspaces + dockview layout persist and restore across restart. E2E covers pub/sub + inspect.

**Crates/teams:** pubsub, message-inspector, storage, frontend-shell, testing.

---

## Phase 3 — JetStream vertical: streams/consumers/messages + KV + Object store

**Goal:** the full JetStream management surface.

**Ordered deliverables**
1. **Co-design the neutral `Raw*` DTOs + `JsContext` trait surface** with connection-manager (critical-path dependency; must precede service code).
2. `ns-jetstream`: streams CRUD/info/state/purge/subjects; messages get/delete/`start_replay` (Channel, ephemeral pull consumer + Drop guard); consumers CRUD/pause/resume + ref-counted lag sampler; **KV** buckets/keys/get/put(CAS)/history/`start_watch` (Channel); **Object store** buckets/objects/chunked `start_put`/`start_get` (Channel, stream-to-disk); backup/restore (Channel); `account_limits` (`$JS.API.INFO`); config validation; `StreamUpdated`/`ConsumerLag` events; **connection-generation keying** to invalidate handles on reconnect.
3. `ns-storage`: `StreamTemplateRepo`/`ConsumerTemplateRepo`/`KvBookmarkRepo`/`JsBackupHistoryRepo`.
4. Frontend: Stream list/wizard/config (Monaco+form live-validate), Consumer list/config/lag charts (ECharts), Message browser (replay), KV browser, Object browser, Backup/Restore dialog.

**Exit criteria:** create stream → create consumer → publish → replay/browse; KV put/get/watch with CAS conflict surfaced as non-retriable `KV_WRONG_LAST_REVISION`; object put/get stream to disk without buffering whole payloads; backup + restore; handles survive a reconnect. E2E on a JetStream-enabled fixture.

**Crates/teams:** jetstream, connection-manager (`Raw*` co-design), storage, message-inspector (reuse), frontend-shell, testing.

---

## Phase 4 — Observability vertical: Monitoring + Dashboard

**Goal:** server HTTP monitoring, metric time-series, cluster/gateway/leaf topology, and the overview dashboard with alerts. Purely additive — cannot regress messaging/JetStream.

**Ordered deliverables**
1. **Finalize the `MetricsTick`/`ClusterMonitorSnapshot` contract** (monitoring + dashboard) — per-server dimension + `source`, before any live streaming.
2. `ns-monitor`: `reqwest` `HttpFetcher`; version-tolerant parsers for varz/connz/subsz/routez/gatewayz/leafz/accountz/accstatz/healthz/jsz (+ per-version golden tests); bounded ring buffers; polling scheduler + plan (start/update/pause/resume/stop); `$SYS`/`$SRV` topology fan-in via `NatsClientProvider`; `get_series`/`get_health`; `subscribe_metrics` (Channel); settings repo; `MetricsTick`/`HealthChanged`/`TopologyChanged` events; counter-reset baseline guard.
3. `ns-dashboard`: `get_overview`/`get_traffic_series`; `subscribe_overview` (Channel, delta frames); alert rules CRUD + evaluation engine + events + timeline; `AlertRuleRepo`/`AlertEventRepo`; `MonitorQuery`/`ConnectionQuery`/`JetStreamQuery` ports; `AlertStateChanged`/`TimelineAppended` events.
4. Frontend: virtualized connz/subsz tables, ECharts metric charts (streaming `appendData`), topology graph, dashboard panels/KPIs/sparklines, alert-rule editor.

**Exit criteria:** live varz/connz on a real server; charts stream via 250 ms-coalesced ticks; topology renders on a cluster fixture; dashboard overview + a firing alert → notification + timeline entry; counters survive a server restart without negative spikes. E2E on a cluster fixture.

**Crates/teams:** monitoring, dashboard, connection-manager (client port), storage, frontend-shell, testing.

---

## Phase 5 — Productivity vertical: Subject Explorer + Terminal

**Goal:** subject hierarchy/analysis/sampling and the embedded `nats`-CLI terminal with Copy-as-CLI, scripts, and runbooks.

**Ordered deliverables**
1. `ns-subject`: trie build merging live traffic ∪ subsz (via `SubszSource` port); `get_tree`/`get_children`; `start_sampling` (Channel, scoped-root default + `>` guardrail); wildcard `analyze`/`expand`; `get_stats` (EWMA); `search`; permission overlay (`SubjectPermissionSource` port); favorites repo; high-cardinality cap/eviction; `SubjectActivity` events.
2. `ns-terminal`: `PtyBackend` (portable-pty) + session registry; `terminal_open` (Channel, per-chunk seq); write/resize/signal (control-byte interrupt)/close; `run_command`; `generate_cli` (redacted + runnable Copy-as-CLI); scripts + runbooks + repos; `CredsMaterializer` temp-creds guard (0600, erase-on-Drop, startup sweep); bundle pinned per-platform `nats` CLI.
3. Shared `CopyAsCliButton` + `CliGeneratorExt` registrations mounted across feature panels.
4. Frontend: Subject Explorer (virtualized/lazy tree, analyzer, sampling controls, favorites, permission toggle); Terminal (xterm.js + addons), command bar, history, script library, runbook runner.

**Exit criteria:** subject tree from live traffic + subsz with wildcard analysis and guard-railed sampling; terminal runs `nats` against the active connection with creds materialized then erased on close; Copy-as-CLI is byte-identical to Run-in-terminal. E2E across the OS PTY matrix (ConPTY/WebKitGTK).

**Crates/teams:** subject-explorer, terminal, connection-manager, account-security (creds), storage, frontend-shell, testing.

---

## Phase 6 — Security & observability depth: full Account-Security + Logging views

**Goal:** the full decentralized-security workbench (keys/JWT/authz/certs/audit) and server-log sources + diagnostics.

**Ordered deliverables**
1. `ns-security` (full): NKey gen/derive/sign/verify; JWT decode/verify-chain/issue (gated); build hierarchy + authz graph; validate/diff permissions; certificate inspect (PEM/DER + live peer via `PeerCertProvider`); `store`/`reveal`/`delete` secret (confirm-gated, rate-limited, always audited); hash-chained `audit_log` query/verify/export; `SecurityAuditAppended`/`SecretStoreStatusChanged`/`JwtExpiryWarning` events. Validate JWT/NKey against `nsc` golden files.
2. `ns-connection`: `PeerCertProvider` hook capturing the rustls peer DER chain.
3. `ns-telemetry` (full): server log sources (file tail / spawned-stdout ingest), `log_export`, saved views, `log_build_diagnostics_bundle` (scrubbed), OTLP opt-in gate.
4. Frontend: security routes (keys/jwt/issue/permissions/certificates/audit + authz graph, hierarchy tree, secret-store badge); logs viewer + level control + sources + diagnostics button + gap indicator.

**Exit criteria:** generate NKey + issue a user JWT that verifies against `nsc` goldens; authz graph renders; reveal-secret is confirm-gated + audited + auto-cleared and never persisted; audit chain verifies and detects tampering; logs view tails/filters/exports; diagnostics bundle is scrubbed. **Security-review sign-off.**

**Crates/teams:** account-security, logging-observability, connection-manager, storage, security-model (xc), frontend-shell, testing.

---

## Phase 7 — Extensibility: Plugin system (Phase 1, in-process)

**Goal:** in-process, capability-gated, independently-versioned plugins with sandboxed frontend panels.

**Ordered deliverables**
1. `ns-plugin`: `PluginHost` (discover/load/enable/disable/install/uninstall/update); single `CapabilityGuard` choke point; `ExtensionRegistry<T>`; `PackageVerifier` (Ed25519 pinned-key + signed index); `NativeRuntime`; `plugin_invoke` (Channel) + all `plugin_*` commands; `PluginStateRepo` + quota-bounded `plugin_kv`; `PluginEvent` bridging; `catch_unwind` + per-call timeout + `CancellationToken`.
2. Wire the extension points registered via ports and removable on disable: inspector codecs, dashboard widgets, dockview panels, sidebar nav, export menu, terminal CLI generators.
3. Frontend: Plugin Manager (list/details/registry browse/consent/audit/trust badges/disable-all panic switch); sandboxed `<iframe sandbox=allow-scripts>` runtime + typed `postMessage` bridge to `ipc.plugin.*`; `@nats-studio/plugin-sdk` (`definePlugin`).

**Exit criteria:** install a signed sample plugin contributing a panel + a codec + a dashboard widget; a capability denial quarantines the plugin; disable cleanly unregisters all contributions and cancels tasks; an out-of-range API version is refused with `PLUGIN_INCOMPATIBLE`. E2E covers install→enable→invoke→disable.

**Crates/teams:** plugin-architecture, message-inspector, dashboard, frontend-shell, security-model, testing.

---

## Phase 8 — Hardening, performance gating, packaging & release

**Goal:** ship-ready v1.0 — perf budgets enforced, signed/notarized installers, auto-update, opt-in telemetry, full cross-OS E2E, a11y and polish.

**Ordered deliverables**
1. **Performance:** committed `criterion` baselines per crate; regression gate (10% PR-soft, nightly-hard for startup/RSS on a dedicated runner); verify frontend virtualization + lazy-load (Monaco/xterm/ECharts) + `manualChunks`; confirm memory budgets; ship the `app_perf_stats` dev HUD.
2. **Deployment:** `sync-version` CI check; signed bundles (EV Authenticode / Apple Developer ID + notarization / AppImage on a pinned old base); minisign updater key + signed `latest.json` (stable + beta) + staged rollout; `THIRD_PARTY.html`; first-run telemetry/crash opt-in.
3. **Testing:** full WebdriverIO E2E on Windows/macOS/Linux; macOS-keychain E2E; coverage floors; `insta` golden wire snapshots frozen.
4. **Polish:** WCAG 2.1 AA pass; light/dark/high-contrast themes; i18n plumbing; command palette + scoped shortcuts; empty/error/skeleton states across every view.

**Exit criteria:** signed + notarized installers for all three platforms that launch clean from a cold machine; stable→beta auto-update verified end-to-end; perf gates green; E2E matrix green; **security + a11y sign-off → v1.0 release.**

**Crates/teams:** performance-strategy, deployment-strategy, testing-strategy, frontend-shell, and every owner for polish.

---

## Dependency-order at a glance

```
Phase 0  scaffold + CI ............................ (all crates as skeletons)
Phase 1  ns-types/core/event + storage(min) +      ← everything depends on this
         security(min) + nats + connection +
         ipc + telemetry(min) + bin + FE shell
Phase 2  inspector + storage(persistence) + pubsub  ← messaging
Phase 3  jetstream (+ KV/Object)                    ← builds on nats/inspector/connection
Phase 4  monitor + dashboard                        ← additive read-only observability
Phase 5  subject + terminal                         ← productivity, reuse ports
Phase 6  security(full) + telemetry(full)           ← depth on Phase-1 minimal crates
Phase 7  plugin                                     ← extension points from all prior
Phase 8  perf + packaging + E2E + polish            ← release engineering
```

Each phase leaves the app **runnable and shippable**: Phase 1 ships "connect + observe status," Phase 2 adds "message," Phase 3 "JetStream," and so on. No phase removes or breaks a capability delivered by an earlier one — later phases only add crates/commands/events against the frozen Phase-1 contract.
