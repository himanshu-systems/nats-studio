# NATS Studio — Architectural Spine (Conventions & Workspace)

> Document ID: `arch/00-conventions-and-workspace`
> Status: **ACCEPTED — Source of Truth (v1.0)**
> Owner: Principal Architect
> Audience: All 14 subsystem teams + 5 cross-cutting strategists
> Rule: This document is handed to every team **verbatim**. It is binding. Where a team needs to deviate, it must file an ADR that supersedes the relevant section here; it may not silently diverge.

---

## 0. How to read this document

This is the **contract** every crate, command, event, error, and TypeScript type in NATS Studio is built against. It fixes:

1. The **Cargo workspace** — every crate, its path, kind, responsibility, dependencies, and owning subsystem (§3–§5).
2. The **shared types crate** `ns-types` and the Rust→TS type-generation pipeline (§6).
3. The **error model** (§7).
4. The **IPC conventions** (§8).
5. The **event architecture** (§9).
6. The **state model** — Rust `AppState`/registry + frontend Zustand/TanStack split (§10).
7. **Storage, logging, config, versioning** conventions (§11–§14).
8. Security / performance / testing posture stubs that the cross-cutting strategists expand (§15).
9. The **ADR ledger** (§16).
10. Per-team **ownership handoff** (§17).

If two sections appear to conflict, the earlier section wins and the conflict is a bug — report it.

---

## 1. Product summary & quality bar

**NATS Studio** is a production-grade, cross-platform (Windows/macOS/Linux) desktop GUI for [NATS](https://nats.io): the definitive graphical tool for operating, observing, and building on NATS. Quality bar: **RedisInsight, pgAdmin, MongoDB Compass, Conduktor, DBeaver, Lens.**

It covers the full NATS surface:

- **Core NATS** — publish/subscribe, request/reply, queue groups, subjects & wildcards.
- **JetStream** — streams, consumers, message replay/ack, KV store, Object store.
- **Service API (`$SRV` / micro)** — discovery, ping, stats, schema of running services.
- **Monitoring** — server HTTP monitoring endpoints (`/varz`, `/connz`, `/routez`, `/subsz`, `/jsz`, `/healthz`, `/accountz`, `/gatewayz`, `/leafz`) and derived metrics.
- **Security** — NKeys, JWT, `.creds`, TLS, operator/account/user hierarchy, decentralized auth.
- **Topology** — clusters, routes, gateways, leaf nodes, superclusters.
- **Productivity** — embedded terminal (`nats` CLI), message inspector, subject explorer, dashboards, saved workspaces, plugins.

**Shell:** Tauri v2 (Rust backend, WebView frontend). **Backend:** Rust + tokio. **Frontend:** React 18 + TypeScript.

---

## 2. Non-negotiable principles (recap, binding)

1. **Clean architecture + SOLID.** A Cargo workspace of small, single-responsibility crates with stable public trait interfaces. No single-file architecture. Dependencies flow **one way**: `types → domain/ports → services → adapters → bin`. No cycles.
2. **Dependency inversion at every seam.** Domain services depend on **ports** (traits), never on concrete infrastructure. Infrastructure (SQLite, async-nats, reqwest, keychain, PTY) implements those ports. The **binary is the only composition root**.
3. **Async everywhere on IO. Never block the UI thread.** Every Tauri command is `async`. Long/streaming work runs on tokio background tasks with **cancellation**.
4. **Independently testable & extensible.** Every subsystem exposes a clean trait, is mockable (`ns-testkit`), and is a candidate extension point for the plugin API.
5. **Typed errors, gracefully surfaced.** `thiserror` per crate, `anyhow` only at boundaries, one wire error DTO to the UI.
6. **Production-grade by default.** Reconnection, backpressure, caching, cancellation, opt-in telemetry, structured logging, code signing, auto-update.
7. **Low memory, fast startup, high runtime perf.** Bounded buffers, coalescing, lazy subsystem init, zero global mutable statics.

---

## 3. Toolchain, prerequisites & repository layout

### 3.1 Pinned toolchain

`rust-toolchain.toml` at repo root pins a **stable** toolchain (the local nightly 1.97 is **not** permitted for builds):

```toml
# rust-toolchain.toml
[toolchain]
channel = "1.89.0"          # Pin to current stable at repo init; bump via ADR. Never "nightly".
components = ["rustfmt", "clippy", "rust-src"]
targets = [
  "x86_64-pc-windows-msvc",
  "x86_64-apple-darwin", "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
]
profile = "minimal"
```

Frontend: **Node 22.12**, **pnpm 9.9** (pinned via `packageManager` in `package.json` + `.nvmrc`).

### 3.2 Required external tooling (document as prerequisites; CI installs them)

| Tool | Purpose | Notes |
|---|---|---|
| `cargo-tauri` (Tauri v2 CLI) | build/dev/bundle the app | `cargo install tauri-cli --version "^2"` |
| `nats-server` binary | integration & e2e tests | pinned version in `tools/versions.toml`; downloaded by test bootstrap |
| `nats` CLI | embedded terminal + e2e fixtures | pinned version; bundled path resolved at runtime |
| `typeshare-cli` | Rust→TS type generation | `cargo install typeshare-cli`; version pinned |
| platform bundling deps | Linux: `libwebkit2gtk`, `libappindicator`; see Tauri docs | in CI images only |

CI fails fast if any pinned tool version drifts from `tools/versions.toml`.

### 3.3 Repository layout (monorepo)

```
nats-studio/
├─ Cargo.toml                     # [workspace] — members + shared [workspace.dependencies]
├─ rust-toolchain.toml
├─ Cargo.lock                     # committed
├─ deny.toml                      # cargo-deny: licenses, bans, advisories
├─ .config/                       # cargo aliases, nextest config
├─ tools/
│  ├─ versions.toml               # pinned external binary versions
│  └─ xtask/                      # (optional) cargo-xtask helper bin — see §14.5
├─ crates/                        # ── all Rust library crates ──
│  ├─ ns-types/                   # shared DTOs / SoT for Rust<->TS   (L0)
│  ├─ ns-core/                    # kernel: ports, traits, ids, cancellation, config model (L0)
│  ├─ ns-event/                   # internal async event bus          (L1)
│  ├─ ns-nats/                    # async-nats adapter + client traits (L1)
│  ├─ ns-security/                # nkeys/jwt/creds/tls/secrets        (L1)
│  ├─ ns-storage/                 # sqlite (rusqlite) + migrations + repos (L1)
│  ├─ ns-telemetry/               # tracing setup + in-app log stream (L1)
│  ├─ ns-inspector/               # payload codecs + format detection (L1)
│  ├─ ns-connection/              # connection registry + lifecycle   (L2)
│  ├─ ns-pubsub/                  # pub/sub + request/reply + $SRV     (L2)
│  ├─ ns-jetstream/               # streams/consumers/KV/ObjectStore  (L2)
│  ├─ ns-monitor/                 # HTTP monitoring + metrics buffers (L2)
│  ├─ ns-subject/                 # subject tree + sampling + stats    (L2)
│  ├─ ns-terminal/                # PTY sessions running `nats` CLI    (L2)
│  ├─ ns-plugin/                  # plugin host + versioned plugin API (L2)
│  ├─ ns-dashboard/               # overview aggregator (composes L2)  (L3)
│  ├─ ns-ipc/                     # Tauri glue: error map, streams, event bridge (L3)
│  └─ ns-testkit/                 # shared test harness (dev)          (Lx)
├─ apps/
│  └─ desktop/
│     ├─ src-tauri/               # ── the ONLY binary crate: `nats-studio` ── (L4)
│     │  ├─ Cargo.toml
│     │  ├─ tauri.conf.json
│     │  ├─ build.rs
│     │  ├─ capabilities/         # Tauri v2 capability/permission files
│     │  └─ src/
│     │     ├─ main.rs            # composition root: build AppState, register commands
│     │     ├─ commands/          # #[tauri::command] thin handlers, one module per subsystem
│     │     ├─ state.rs           # AppState (service registry)
│     │     └─ bridge.rs          # EventBus -> Tauri event bridge wiring
│     ├─ index.html
│     ├─ package.json
│     ├─ vite.config.ts
│     ├─ tailwind.config.ts
│     └─ src/                     # ── React 18 + TS frontend ──
│        ├─ app/                  # router, shell, dock layout
│        ├─ features/             # one folder per subsystem view slice
│        ├─ ipc/                  # generated bindings + typed invoke wrappers
│        ├─ stores/               # Zustand slices (UI/session)
│        ├─ queries/              # TanStack Query hooks (server-state)
│        └─ components/           # shared UI kit
├─ packages/
│  └─ ns-bindings/                # generated TS: types.ts + command client (from ns-types)
└─ docs/
   └─ architecture/
      ├─ 00-conventions-and-workspace.md   # ← THIS FILE
      └─ adr/                              # one file per ADR
```

**Layering key:** `L0` foundation → `L1` adapters/leaf-domain → `L2` feature services → `L3` composition/glue → `L4` binary. A crate may only depend on **lower or equal-but-acyclic** layers (§5).

---

## 4. Crate catalog (authoritative)

Prefix: **`ns-`** (NATS Studio). All crate names are kebab-case; Rust module paths use the underscore form (`ns_core`). Every crate has its own `thiserror` error enum and a stable public trait surface.

| Crate | Path | Kind | Layer | Owner (subsystem) | Responsibility (one line) | Intra-workspace deps |
|---|---|---|---|---|---|---|
| `ns-types` | `crates/ns-types` | lib | L0 | core-runtime (shared/**frozen**) | Single source of truth for all serde DTOs, IPC request/response types, event payloads, `ErrorCode`, `IpcError`; typeshare-annotated. | — |
| `ns-core` | `crates/ns-core` | lib | L0 | core-runtime | Kernel: `DomainError` trait, `ErrorCode` helpers, IDs (`ConnectionId`, `SubscriptionId`…), `CancellationToken`/`TaskHandle` utils, **port traits** (repositories, `EventPublisher`, `SecretStore`, `Clock`), `Settings` model, redaction (`Redacted<T>`). | `ns-types` |
| `ns-event` | `crates/ns-event` | lib | L1 | core-runtime | Internal async event bus (`tokio::broadcast` fan-out + `mpsc` work queues), `Event` envelope, `Topic`, per-topic coalescing/backpressure policy. | `ns-types`, `ns-core` |
| `ns-nats` | `crates/ns-nats` | lib | L1 | connection-manager | **Adapter** over `async-nats`: `NatsClient`/`JsContext`/`Subscription` traits + real impls; core+JetStream+KV+ObjectStore+Service surfaces; TLS/creds wiring hooks. | `ns-types`, `ns-core` |
| `ns-security` | `crates/ns-security` | lib | L1 | account-security | NKeys/JWT sign+verify, `.creds` parsing, operator/account/user model, TLS `ClientConfig` builder (rustls), `SecretStore` impl (keychain + encrypted fallback). | `ns-types`, `ns-core` |
| `ns-storage` | `crates/ns-storage` | lib | L1 | storage | SQLite via **rusqlite (bundled)** + forward-only migrations; repositories implementing `ns-core` ports (profiles, history, saved queries, settings, layouts, templates). Async via a storage worker. | `ns-types`, `ns-core` |
| `ns-telemetry` | `crates/ns-telemetry` | lib | L1 | logging-observability | `tracing-subscriber` layered setup, file rotation (`tracing-appender`), in-app ring-buffer log layer + log event stream, opt-in metrics/telemetry, diagnostics bundle. | `ns-types`, `ns-core`, `ns-event` |
| `ns-inspector` | `crates/ns-inspector` | lib | L1 | message-inspector | Payload codecs (JSON/MsgPack/Protobuf/Avro/CBOR/text/binary), format auto-detection, header parsing, schema hooks, hex/preview rendering models. | `ns-types`, `ns-core` |
| `ns-connection` | `crates/ns-connection` | lib | L2 | connection-manager | `ConnectionService`: profile resolution, connect/disconnect lifecycle, reconnection with backoff, health/status, per-connection handle registry, event emission. | `ns-types`, `ns-core`, `ns-event`, `ns-nats`, `ns-security` |
| `ns-pubsub` | `crates/ns-pubsub` | lib | L2 | pubsub | `PubSubService`: publish, streaming subscribe (queue groups), request/reply, `$SRV` service requests; server-side decode via inspector. | `ns-types`, `ns-core`, `ns-event`, `ns-nats`, `ns-inspector` |
| `ns-jetstream` | `crates/ns-jetstream` | lib | L2 | jetstream | `JetStreamService`: stream/consumer CRUD & info, message get/replay/purge, ack, **KV** buckets, **Object store** buckets (one crate, four modules). | `ns-types`, `ns-core`, `ns-event`, `ns-nats`, `ns-inspector` |
| `ns-monitor` | `crates/ns-monitor` | lib | L2 | monitoring | `MonitorService`: poll NATS HTTP monitoring endpoints (reqwest), parse varz/connz/jsz/…, maintain bounded metric time-series ring buffers, `$SRV` discovery/stats aggregation. | `ns-types`, `ns-core`, `ns-event` |
| `ns-subject` | `crates/ns-subject` | lib | L2 | subject-explorer | `SubjectService`: subject hierarchy/tree modeling, wildcard analysis/validation, live subject sampling, per-subject rate/count stats. | `ns-types`, `ns-core`, `ns-event`, `ns-nats` |
| `ns-terminal` | `crates/ns-terminal` | lib | L2 | terminal | `TerminalService`: PTY sessions (`portable-pty`) running the `nats` CLI (optional shell mode), stdin/stdout streaming, session registry. | `ns-types`, `ns-core`, `ns-event` |
| `ns-plugin` | `crates/ns-plugin` | lib | L2 | plugin-architecture | Plugin **host** + **SDK**: manifest, capability/permission model, versioned Plugin API traits, extension registry, sandboxed invocation (dyn now → WASM later). | `ns-types`, `ns-core`, `ns-event` |
| `ns-dashboard` | `crates/ns-dashboard` | lib | L3 | dashboard | `DashboardService`: overview aggregator composing connection + monitor + jetstream snapshots into home/dashboard DTOs. | `ns-types`, `ns-core`, `ns-event`, `ns-connection`, `ns-monitor`, `ns-jetstream` |
| `ns-ipc` | `crates/ns-ipc` | lib | L3 | tauri-shell | Tauri glue: `AppError`→`IpcError` mapping, command result/stream envelopes, `Channel`/event streaming helpers, **EventBus→Tauri bridge**, command `Ctx`, cancellation registry. | `ns-types`, `ns-core`, `ns-event`, `tauri` |
| `nats-studio` (`src-tauri`) | `apps/desktop/src-tauri` | **bin** | L4 | tauri-shell | **Composition root**: build `AppState` (service registry), wire ports→adapters, register every `#[tauri::command]`, start runtime + Tauri plugins (updater/single-instance/deep-link), start event bridge. | **all crates** |
| `ns-testkit` | `crates/ns-testkit` | lib (dev) | Lx | testing-strategy | Shared test harness: embedded `nats-server` fixture, mock `NatsClient`/ports, DTO builders, assertions, golden-file helpers. | `ns-types`, `ns-core`, `ns-nats` |

**Frontend (not crates):**

| Package | Path | Owner | Responsibility |
|---|---|---|---|
| `nats-studio-desktop` (React app) | `apps/desktop/src` | frontend-shell (+ every team owns a `features/*` slice) | App shell, dock/router, all subsystem views, Zustand stores, TanStack queries, typed IPC calls. |
| `@nats-studio/bindings` | `packages/ns-bindings` | frontend-shell / core-runtime | Generated `types.ts` (from `ns-types` via typeshare) + typed `invoke` command client + event/channel typings. |

### 4.1 Subsystem → crate coverage matrix (every subsystem maps)

| Subsystem | Owns crate(s) | Frontend slice |
|---|---|---|
| connection-manager | `ns-nats`, `ns-connection` | `features/connections` |
| core-runtime | `ns-types`, `ns-core`, `ns-event` | `packages/ns-bindings` (shared) |
| tauri-shell | `ns-ipc`, `nats-studio` (bin) | `app/*` shell |
| dashboard | `ns-dashboard` | `features/dashboard` |
| monitoring | `ns-monitor` | `features/monitoring` |
| jetstream | `ns-jetstream` | `features/jetstream` (+ kv, object-store views) |
| pubsub | `ns-pubsub` | `features/pubsub` |
| message-inspector | `ns-inspector` | `features/inspector` (reused across views) |
| subject-explorer | `ns-subject` | `features/subjects` |
| account-security | `ns-security` | `features/security` |
| terminal | `ns-terminal` | `features/terminal` |
| logging-observability | `ns-telemetry` | `features/logs` |
| storage | `ns-storage` | (backing; `features/settings`, history) |
| frontend-shell | — | `apps/desktop/src`, `packages/ns-bindings` |
| security-model (strat) | influences `ns-security`, `ns-storage`, capabilities | — |
| performance-strategy (strat) | influences `ns-event`, `ns-ipc`, all services | — |
| testing-strategy (strat) | `ns-testkit` | e2e harness |
| deployment-strategy (strat) | `nats-studio` bundler/updater config | — |
| plugin-architecture (strat) | `ns-plugin` | `features/plugins` |

---

## 5. Dependency graph & layering rules

### 5.1 The acyclic graph (ASCII)

```
                                   ns-types  (L0, no internal deps)
                                       │
                                   ns-core   (L0)  ── ports, traits, ids, Settings, DomainError
             ┌──────────┬─────────────┼───────────────┬───────────────┬─────────────┐
          ns-event    ns-nats     ns-security      ns-storage      ns-inspector   ns-telemetry
            (L1)       (L1)          (L1)             (L1)             (L1)         (L1, +event)
             │          │             │                                  │
   ┌─────────┼──────────┼─────────────┼──────────────┬─────────────┐     │
 ns-connection │      ns-subject     ns-pubsub ───────┼── ns-jetstream ───┘
   (nats+sec)  │       (nats)          (nats+inspector)     (nats+inspector)
             ns-monitor            ns-terminal          ns-plugin
             (event only)          (event only)         (event only)
             (L2 ─────────────────────────────────────────────────)
                    │                      │                 │
                    └─────────► ns-dashboard (L3) ◄──────────┘
                          (composes connection + monitor + jetstream)

                         ns-ipc (L3)  ── tauri glue + event bridge
                              │
                              ▼
                    nats-studio  (L4 bin = composition root, depends on ALL)

   ns-testkit (dev) ── depends on ns-types, ns-core, ns-nats; used by every crate's tests
```

### 5.2 Layering rules (enforced)

1. A crate may depend only on **strictly lower layers**, plus `ns-types`/`ns-core` from anywhere. `ns-dashboard` (L3) may depend on L2 peers because they never depend back — this is verified.
2. **No cycles, ever.** Enforced in CI by `cargo depgraph`/`cargo-deny` + a custom `xtask check-layers` that fails on any back-edge.
3. **Ports live in `ns-core`** (`ns_core::ports`). Adapters (`ns-storage`, `ns-security`, `ns-nats`) implement them. Feature services (L2) consume ports, never concrete adapters. This is why `ns-connection` does **not** depend on `ns-storage`: it takes a `dyn ConnectionProfileRepo` injected by the bin.
4. **`tauri` is only allowed in `ns-ipc` and the bin.** No feature/domain crate may import `tauri`. This keeps domains headless and testable, and lets a future CLI/server reuse them.
5. **`async-nats` is only allowed in `ns-nats`.** Everyone else talks to the `NatsClient` trait. (ADR-0007)
6. **`rusqlite`/SQL only in `ns-storage`.** `reqwest` only in `ns-monitor` (and updater in bin). `portable-pty` only in `ns-terminal`. `keyring` only in `ns-security`.
7. Shared third-party versions are pinned once in root `[workspace.dependencies]`; crates use `foo.workspace = true`.

---

## 6. Shared types crate (`ns-types`) & Rust→TS generation

### 6.1 Purpose

`ns-types` is the **single source of truth** for every value that crosses the IPC boundary: command request/response DTOs, event payloads, `ErrorCode`, `IpcError`, and shared domain value objects (e.g. `StreamConfig`, `ConsumerInfo`, `ServerVarz`). It is a **pure serde crate** — no `tauri`, no business logic, no proc-macro coupling to any binding tool beyond `typeshare` annotations. It is treated as a **frozen public interface**: breaking changes require an ADR + a bump of `app_schema_version` (§14).

### 6.2 Serde conventions (mandatory for all DTOs)

- `#[serde(rename_all = "camelCase")]` on every struct and enum → idiomatic TS.
- Enums that carry data use **adjacently tagged** representation `#[serde(tag = "kind", content = "data")]` so the TS side gets a discriminated union.
- Timestamps: `time::OffsetDateTime` serialized as RFC-3339 strings (`ts: string`). Durations: milliseconds as `u64` (`fooMs`). Bytes/payloads: base64 strings with an explicit `encoding` field; never raw byte arrays over IPC.
- IDs are newtypes (`ConnectionId(Uuid)`) serialized as strings.
- Every field is either required or `Option<T>` (→ `T | null`/optional in TS). No untyped `serde_json::Value` except an explicit `Json` escape hatch type.

### 6.3 Type-generation pipeline — **typeshare** (ADR-0005)

- `ns-types` items are annotated with `#[typeshare]`.
- `pnpm gen:types` (wraps `typeshare ./crates/ns-types --lang typescript --output-file packages/ns-bindings/src/generated/types.ts`) produces the TS types.
- The generated file is **committed**. CI runs `gen:types` then `git diff --exit-code`; drift fails the build. This guarantees Rust and TS never disagree.
- **Generics policy:** prefer concrete response types. Where a paginated envelope is needed, use the shared `Page<T>` only if typeshare emits it cleanly for that instantiation; otherwise **monomorphize** (`StreamPage`, `MessagePage`). Downstream teams must not hand-write types that duplicate `ns-types`.

**Why typeshare over ts-rs:** keeps `ns-types` a plain serde crate (no `#[derive(TS)]` on every type, no test-driven export side effects), one deterministic CLI pass over the whole crate, first-class serde-attribute awareness (rename/tag/content) matching our camelCase + tagged-enum choices, and no forced `ts-rs` dependency on any future non-UI consumer of `ns-types`. Trade-off (weaker generics) is mitigated by the monomorphization rule.

---

## 7. Error model

### 7.1 Layers of error

1. **Per-crate error enums with `thiserror`.** Each crate exposes exactly one public error enum: `ns_connection::ConnectionError`, `ns_jetstream::JetStreamError`, `ns_nats::NatsError`, `ns_storage::StorageError`, etc. External errors (`async_nats::Error`, `rusqlite::Error`, `reqwest::Error`, `std::io::Error`) are wrapped via `#[from]`. **Library crates never expose `anyhow` in their public API.**
2. **`anyhow` only at boundaries.** The bin's `main`, task supervisors, and one-off setup code may use `anyhow` for ergonomics. It never crosses a public crate API.
3. **`AppError`** (in `ns-ipc`) — an aggregate enum wrapping each subsystem error via `#[from]`. It is the internal top type at the command boundary; it is **not** serialized directly.
4. **`IpcError`** (in `ns-types`) — the **wire DTO** sent to TS. Stable, camelCase, typeshared.

### 7.2 The `DomainError` trait (in `ns-core`)

Every crate error implements:

```rust
pub trait DomainError: std::error::Error {
    fn code(&self) -> ErrorCode;      // stable machine code (see 7.3)
    fn retriable(&self) -> bool;      // may the UI auto-retry?
    fn user_message(&self) -> String; // safe, human-facing, no secrets
}
```

`AppError` delegates to the wrapped error. This is the single mapping surface; no crate hand-rolls IPC serialization.

### 7.3 `ErrorCode` (in `ns-types`, shared with TS)

A stable string enum. Non-exhaustive starter set (teams extend via PR + typegen):

```
CONNECTION_TIMEOUT · CONNECTION_CLOSED · AUTH_FAILED · TLS_ERROR · PERMISSION_DENIED
JETSTREAM_NOT_ENABLED · STREAM_NOT_FOUND · CONSUMER_NOT_FOUND · KV_KEY_NOT_FOUND · OBJECT_NOT_FOUND
SUBJECT_INVALID · PAYLOAD_DECODE_FAILED · REQUEST_TIMEOUT · NO_RESPONDERS
MONITOR_UNREACHABLE · MONITOR_PARSE_ERROR
STORAGE · MIGRATION_FAILED · SECRET_STORE_UNAVAILABLE
TERMINAL_SPAWN_FAILED · PLUGIN_ERROR · PLUGIN_INCOMPATIBLE
CANCELLED · TIMEOUT · SERIALIZATION · IO · NOT_FOUND · INVALID_ARGUMENT · INTERNAL
```

### 7.4 The `IpcError` wire DTO (in `ns-types`)

```rust
#[typeshare]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: ErrorCode,            // machine-actionable
    pub message: String,            // user_message(), secret-safe
    pub retriable: bool,
    pub correlation_id: Option<String>, // ties to a tracing span / log entry
    pub causes: Vec<String>,        // std::error::Error::source() chain, redacted
    pub detail: Option<Json>,       // optional structured extra (e.g. field errors)
}
```

### 7.5 Rules

- **Every `#[tauri::command]` returns `Result<T, IpcError>`.** The conversion `AppError → IpcError` happens in exactly one place (`ns_ipc::to_ipc_error`), which walks the `source()` chain, applies redaction (`Redacted<T>` / secret scrubber), and attaches the current span's `correlation_id`.
- **Redaction is mandatory.** Creds, seeds, passwords, tokens, JWTs never appear in `message`, `causes`, or logs. `ns-security` marks these as `Redacted<T>`.
- **Frontend** (`packages/ns-bindings`) rehydrates `IpcError` into a `NatsStudioError` class (`code`, `message`, `retriable`, `causes`). TanStack Query uses `retriable` to drive retry policy; the UI maps `code`→localized copy + action.
- **Panics** in commands are caught at the bridge and converted to `ErrorCode::INTERNAL` with a correlation id (never crash the WebView).

---

## 8. IPC conventions

### 8.1 Command naming

`snake_case`, **namespaced by subsystem prefix**: `connection_*`, `pubsub_*`, `jetstream_*`, `kv_*`, `objectstore_*`, `monitor_*`, `subject_*`, `inspector_*`, `terminal_*`, `security_*`, `storage_*`, `settings_*`, `plugin_*`, `dashboard_*`, `app_*`.

Examples: `connection_connect`, `connection_list`, `connection_disconnect`, `pubsub_publish`, `pubsub_subscribe`, `pubsub_unsubscribe`, `jetstream_list_streams`, `jetstream_get_stream`, `kv_get`, `monitor_get_varz`, `subject_sample_start`, `settings_get`, `app_info`.

### 8.2 Request/response DTO pattern

- Each command takes **one** argument named `req` of type `XxxRequest`, and returns `XxxResponse` (or a domain DTO) wrapped in `Result<_, IpcError>`.

```rust
#[tauri::command]
async fn jetstream_list_streams(
    req: ListStreamsRequest,
    state: tauri::State<'_, AppState>,
) -> Result<ListStreamsResponse, IpcError> { … }
```

- Request/response types live in `ns-types`, camelCase, typeshared. Naming: `<Verb><Noun>Request` / `<Verb><Noun>Response`.
- Commands that operate on a connection carry `connectionId: ConnectionId` in the request. **No hidden global "current connection"** on the backend — the frontend is explicit; "current connection" is UI state (Zustand).
- **Pagination:** cursor-based. Request `{ …, cursor?: string, limit: u32 }` → response `{ items: T[], nextCursor?: string, total?: u64 }` (`Page<T>` or monomorphized per §6.3).
- Frontend calls **only** through generated typed wrappers in `packages/ns-bindings` (`ipc.jetstream.listStreams(req)`), never raw `invoke` with string literals.

### 8.3 Streaming — two mechanisms, one rule each

**(A) Tauri Channels** `tauri::ipc::Channel<T>` — for **request-scoped** streams whose lifetime is bound to a single call: subscriptions, message replay, terminal output, log tail, subject sampling.

```rust
#[tauri::command]
async fn pubsub_subscribe(
    req: SubscribeRequest,
    on_event: tauri::ipc::Channel<SubMessageEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<SubscriptionHandleDto, IpcError> { … } // returns { subscriptionId }
```

- The command spawns a cancellable task that pumps a **bounded** `mpsc` into `on_event`. Returns a `subscriptionId`.
- **Cancellation:** a companion `*_unsubscribe { subscriptionId }` / `*_cancel` command trips the `CancellationToken`. Dropping the Channel (view unmount) is detected by a watchdog and also cancels — no leaked tasks.
- **Backpressure:** the bounded buffer applies the stream's declared policy (§9.4): high-rate subscriptions **sample + count drops** (`droppedSinceLast` field on the event); terminal/log preserve order with a bounded queue and a "buffer overflow, output truncated" marker.

**(B) Tauri events** `app.emit` / `emit_to(window, …)` — for **ambient, app-wide broadcasts** not tied to one call: connection status changes, global metrics ticks, notifications, plugin events. These are **bridged from the internal event bus** (§9), never emitted ad-hoc from feature crates.

**Rule of thumb:** *If the stream belongs to one screen/action → Channel. If it's a global signal many screens observe → bridged event.*

### 8.4 Error propagation

`Result::Err(IpcError)` → Tauri rejects the JS `invoke` promise → `packages/ns-bindings` throws a typed `NatsStudioError` → TanStack Query/`try-catch` handles it → UI renders by `code`. Streaming errors are delivered **in-band** as a terminal `error` variant on the Channel event enum (so partial streams report why they ended), plus the command result reflects setup failures.

### 8.5 Type-generation pipeline (recap)

`ns-types` (typeshare) → `pnpm gen:types` → `packages/ns-bindings/src/generated/types.ts` (committed, drift-checked in CI). Command wrappers are generated/maintained alongside from a `commands.manifest.ts` that pairs each command name with its `Request`/`Response` types, so a renamed command or DTO breaks the TS build immediately.

---

## 9. Event architecture

### 9.1 Internal event bus (`ns-event`)

- Built on **`tokio::sync::broadcast`** for fan-out topics and **`mpsc`** for point-to-point work queues.
- Producers publish via the **`EventPublisher` port** (defined in `ns-core`, implemented in `ns-event`), injected into services. **No service imports `tauri`** — they emit domain events only.

```rust
#[typeshare] #[serde(tag = "topic", content = "data", rename_all = "camelCase")]
pub enum EventPayload {
    ConnectionStatusChanged(ConnectionStatusDto),
    ServerInfoUpdated(ServerInfoDto),
    MetricsTick(MetricsTickDto),
    StreamUpdated(StreamRefDto),
    ConsumerLag(ConsumerLagDto),
    SubjectActivity(SubjectActivityDto),
    LogEmitted(LogRecordDto),
    TaskProgress(TaskProgressDto),
    Notification(NotificationDto),
    PluginEvent(PluginEventDto),
}

pub struct Event {
    pub topic: Topic,
    pub connection_id: Option<ConnectionId>,
    pub seq: u64,               // monotonic per topic → UI gap detection
    pub ts: OffsetDateTime,
    pub payload: EventPayload,
}
```

### 9.2 Tauri event names

Bridged events use a URI-ish namespaced scheme so listeners are unambiguous:
`ns://connection/status`, `ns://server/info`, `ns://monitor/metrics`, `ns://jetstream/stream`, `ns://jetstream/consumer-lag`, `ns://subject/activity`, `ns://log`, `ns://task/progress`, `ns://notification`, `ns://plugin`.

### 9.3 The bridge (`ns-ipc::EventBridge`)

- Subscribes to the bus, filters to UI-relevant topics, applies **coalescing + backpressure**, then forwards to the WebView via `AppHandle::emit`/`emit_to`. It is the **only** component allowed to turn bus events into Tauri events.
- Window scoping: events carry `connectionId`; the bridge emits to the window(s) that have that connection open (multi-window aware).

### 9.4 Backpressure & coalescing policy (per-topic table)

| Topic | Transport | Policy |
|---|---|---|
| `MetricsTick` | bridged event | **Keep-latest** per `(connectionId, metric)` within a 250 ms tick; emit one coalesced frame. |
| `ConnectionStatusChanged` | bridged event | **Dedupe** consecutive identical states; always deliver transitions. |
| `SubjectActivity` | bridged event | **Rate-limit** to N/s per connection; aggregate counts, surface `dropped`. |
| `LogEmitted` | bridged event | Bounded ring; **drop-oldest**; surface `truncated`. |
| `subscribe` messages | Channel | Bounded buffer; **sample + count** at high rate (`droppedSinceLast`). |
| `terminal` output | Channel | Bounded FIFO; preserve order; overflow marker. |
| `TaskProgress` | bridged event | Keep-latest per task id. |
| `Notification` | bridged event | Never drop (small volume). |

- A lagging `broadcast` receiver yields `RecvError::Lagged(n)` → the bridge emits a synthetic "n events dropped" so the UI can show a gap indicator. **Producers are never blocked** by a slow UI.

---

## 10. State model

### 10.1 Rust side — `AppState` service registry (composition root)

- The bin builds one `AppState`, stored in Tauri `State`, consisting of `Arc<dyn Trait>` **service handles (ports)** — a registry, not a god object. Everything is behind a trait for SOLID/DIP + mockability + plugin override.

```rust
// apps/desktop/src-tauri/src/state.rs
pub struct AppState {
    pub connections: Arc<dyn ConnectionService>,
    pub pubsub:      Arc<dyn PubSubService>,
    pub jetstream:   Arc<dyn JetStreamService>,
    pub monitor:     Arc<dyn MonitorService>,
    pub subjects:    Arc<dyn SubjectService>,
    pub inspector:   Arc<dyn InspectorService>,
    pub terminal:    Arc<dyn TerminalService>,
    pub security:    Arc<dyn SecurityService>,
    pub settings:    Arc<dyn SettingsService>,
    pub dashboard:   Arc<dyn DashboardService>,
    pub plugins:     Arc<dyn PluginHost>,
    pub events:      EventBus,             // clone-cheap handle
    pub cancels:     CancellationRegistry, // subscriptionId/sessionId -> token
    pub tasks:       TaskRegistry,         // background task supervision
}
```

- **Composition** (`main.rs`): construct adapters (`SqliteStorage`, `AsyncNatsFactory`, `KeychainSecretStore`) → inject as ports into services → assemble `AppState` → start `EventBridge` → register commands → run.
- **Per-connection runtime state** lives inside `ConnectionService` as a registry of `ConnectionHandle { client, status, tasks, cancel }`, guarded by `tokio::RwLock`/`DashMap`. **No global mutable statics.**
- **Long work** runs on tokio tasks tracked in `TaskRegistry`, each with a `CancellationToken` from `CancellationRegistry` keyed by the id returned to the UI. Every command is `async`; nothing blocks the WebView.
- **Lazy init:** subsystems that aren't touched (e.g. terminal, plugins) initialize on first use → fast startup, low memory.

### 10.2 Frontend — Zustand vs TanStack Query (hard boundary)

**Boundary rule:** *Data that originates in Rust/IPC → TanStack Query. Data that is UI-only/session → Zustand. Never mirror server-state into Zustand.*

- **TanStack Query owns all server-state:** connections list, streams, consumers, KV entries, object listings, monitor snapshots, message history, service list. Query keys are namespaced arrays: `['jetstream','streams', connectionId]`, `['monitor','varz', connectionId]`. Query/mutation fns are the generated `ipc.*` wrappers. Mutations invalidate keys. `retriable` on `IpcError` drives retry. Streaming data (subscriptions/metrics) is folded into the cache via `queryClient.setQueryData` from Channel/event handlers rather than polling.
- **Zustand owns UI/session state:** active connection selection, open tabs, **dock/panel layout**, panel sizes, theme, Monaco editor buffers (unsaved), command palette, per-view filters, feature flags. Persisted slices (layout, prefs) are a **fast local mirror**; the **source of truth is SQLite** via `settings_*`/`layout_*` commands, synced with debounced mutations.
- **Router:** React Router for top-level per-subsystem navigation; workspace composition (which panels are docked where) is Zustand + persisted layout (ADR-0012).
- **Real-time:** a single `useAppEvents()` hook subscribes to bridged Tauri events and routes them to the query cache or the relevant Zustand slice; Channel-based streams are owned by the initiating view's hook and cancelled on unmount.

---

## 11. Storage conventions

- **Engine: `rusqlite` with the `bundled` feature** (ships SQLite; no system dependency), wrapped behind `ns-core` repository ports. Async is provided by a dedicated **storage worker** (a single-writer task + a small read pool via `spawn_blocking`), so the async-everywhere rule holds without a build-time `DATABASE_URL`. (ADR-0003)
- **Migrations:** forward-only, versioned SQL under `crates/ns-storage/migrations/NNNN_*.sql`, applied at startup via `rusqlite_migration`; schema version tracked in `PRAGMA user_version`. Every release notes its schema version.
- **PRAGMAs:** `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.
- **Location:** OS app-data dir via the Tauri path API / `directories`: `{appDataDir}/nats-studio/studio.db` (+ `logs/`). Never hardcode paths.
- **Secrets are NOT stored in SQLite plaintext.** Creds/seeds/passwords/tokens go to the **OS keychain via `keyring`** (`ns-security`); SQLite stores only non-secret profile metadata + a keychain reference. Where no keychain exists (some Linux/headless), fall back to an **app-level encrypted secrets store** (XChaCha20-Poly1305 / `age`) keyed by an OS-protected key. (ADR-0013)
- **Repositories** (one per aggregate, all implementing `ns-core` ports): `ConnectionProfileRepo`, `MessageHistoryRepo`, `SavedQueryRepo`, `PublishTemplateRepo`, `SettingsRepo`, `LayoutRepo`, `PluginStateRepo`.
- **Data hygiene:** message history is bounded (size + TTL, user-configurable) with retention enforced by the storage worker.

---

## 12. Logging & observability conventions

- **`tracing` everywhere.** The bin configures a **layered `tracing-subscriber`** at the very start of `main`, before `AppState`:
  1. **fmt → rolling file** via `tracing-appender` (non-blocking, daily rotation) in `{appDataDir}/logs/`.
  2. **In-app buffer layer** (`ns-telemetry`) → bounded ring buffer + broadcast to the Logs view (`ns://log`).
  3. **`EnvFilter`** from `NS_LOG` env / settings (default `info`, per-target overrides like `ns_connection=debug`).
  4. **Optional OTLP/telemetry layer** — **opt-in only** (§15).
- **Structured fields, never secrets.** Redaction helpers in `ns-core`; secret-bearing types are `Redacted<T>` (Debug/Display print `***`). A scrubber runs on the log path as defense-in-depth.
- **Spans across async:** `#[instrument]` on service methods; `connection_id`, `subscription_id`, `correlation_id` as span fields. The `correlation_id` is attached to `IpcError.correlationId` so a user-visible error links to a log line.
- **Targets** are the crate module paths (`ns_jetstream`, `ns_monitor`, …). Level guidance: `error` = user-visible failure; `warn` = degraded/retrying; `info` = lifecycle; `debug` = protocol detail; `trace` = wire.
- **Frontend diagnostics:** a `log_report` command forwards significant UI errors into the same pipeline; a **"diagnostics bundle"** export zips logs + system info + (redacted) settings for support.

---

## 13. Configuration conventions

Two tiers, strictly separated:

1. **App settings (user-facing, runtime).** Typed `Settings` DTO in `ns-types`, defaults in `ns-core`, persisted in SQLite (`SettingsRepo`), edited via `settings_get` / `settings_update` + the Settings UI. **Hot-reloadable** — a change emits a bridged event so subscribers re-read. Settings **shape is versioned**; migrations handled in the storage layer.
2. **Static/build config.** `tauri.conf.json` (app id, windows, CSP, updater endpoints, signing), workspace `Cargo.toml`, env. **No secrets in any config file.**

- **Env overrides (dev only):** `NS_LOG`, `NS_DATA_DIR`, `NS_DISABLE_UPDATER`, `NS_TELEMETRY=off`. Documented; not required in production.
- **Per-connection configuration** is part of connection **profiles** (stored via `ConnectionProfileRepo`), never global settings.
- All filesystem locations resolve through the Tauri path API / `directories` — no hardcoded paths.

---

## 14. Versioning & compatibility

- **App version: SemVer.** Single source = workspace `version` in root `Cargo.toml`, synced to `tauri.conf.json` + `package.json` by `cargo xtask sync-version` (CI verifies they match). Git tags `vX.Y.Z`.
- **Release channels:** `stable` + `beta`; signed **auto-update via the Tauri v2 updater** (ADR-0002/§15). Code signing per platform (Deployment strategy owns keys).
- **IPC/DTO contract version:** `app_info` returns `appSchemaVersion`. TS bindings are pinned to it; CI fails on generated-type drift (§6.3). Breaking DTO changes bump the schema version + ship a migration note.
- **Plugin API version:** **independent SemVer** (`plugin_api = X.Y.Z`) exposed by `ns-plugin`. The host advertises a supported **range**; plugin manifests declare `minApi`/`maxApi`; incompatible plugins are refused with `PLUGIN_INCOMPATIBLE`. Breaking API changes bump the plugin-API major only. (ADR-0014)
- **Storage schema version:** `PRAGMA user_version` + ordered migration list (§11).
- **MSRV:** pinned via `rust-toolchain.toml` (§3.1); bumps require an ADR.
- `cargo xtask` (in `tools/xtask`) is the canonical place for repo automation: `sync-version`, `check-layers`, `gen-types`, `bundle`, `verify-tools`.

---

## 15. Cross-cutting posture (stubs for the strategists)

These are **binding defaults**; the named strategist expands them in a dedicated doc that supersedes this stub.

- **Security model** — Tauri v2 **capabilities/permissions** scoped per window; strict CSP (no remote origins); IPC is the only trust boundary; secrets in keychain (§11); redaction everywhere (§7.5, §12); `rustls` default TLS with pinned roots + optional custom CA (ADR-0004); no `eval`, no remote code; plugins are capability-gated (§ADR-0014). Supply-chain: `cargo-deny` + `pnpm audit` in CI.
- **Performance strategy** — bounded buffers + coalescing (§9.4); virtualized lists for high-cardinality views (streams/subjects/messages); server-side decode/paginate (don't ship megabytes to JS); TanStack caching + dedupe (§10.2); lazy subsystem init; ECharts with downsampling; startup budget and memory budget tracked in CI perf gates.
- **Testing strategy** — `ns-testkit` provides an embedded `nats-server` fixture + mock ports; unit tests per crate (mock `NatsClient`), integration tests against a real `nats-server`, `cargo nextest`, e2e via Tauri WebDriver / Playwright; golden files for DTO/typegen; property tests for subject/codec logic. `nats-server` + `nats` CLI are prerequisites (§3.2).
- **Deployment strategy** — Tauri bundler per platform (MSI/NSIS, DMG, AppImage/deb), signed; auto-update via updater with signed manifests; reproducible CI matrix; `versions.toml`-pinned toolchain; SBOM from `cargo-deny`.
- **Plugin architecture** — start with **in-process, trait-based, capability-gated** extensions registered through `ns-plugin`'s versioned API; roadmap to **WASM out-of-process** (`wasmtime`/`extism`) for untrusted third-party plugins. Extension points: custom payload codecs (`ns-inspector`), dashboard widgets, connection auth providers, exporters. (ADR-0014)

---

## 16. Architecture Decision Records (ledger)

Each ADR lives in `docs/architecture/adr/NNNN-*.md`. Summary below; teams may not contradict an ACCEPTED ADR without superseding it.

| ID | Title | Decision | Rationale |
|---|---|---|---|
| ADR-0001 | NATS client = `async-nats` (only in `ns-nats`) | Use the official `async-nats` for core + JetStream + KV + Object store + Service, wrapped behind our `NatsClient` trait. | Official, maintained, tokio-native, full feature coverage; the wrapper preserves testability/mocking and confines the dependency. |
| ADR-0002 | Desktop shell = Tauri v2 | Rust backend + system WebView; use official plugins (updater, single-instance, deep-link). | Small binary/memory vs Electron, Rust-native backend, strong security model, first-class signed auto-update, cross-platform. |
| ADR-0003 | Local storage = `rusqlite` (bundled) + `rusqlite_migration` | Reject `sqlx-sqlite`; use rusqlite behind a storage-worker async wrapper. | No build-time `DATABASE_URL`/offline cache friction, smaller footprint, bundles SQLite (no system dep), deterministic, full SQLite control; async boundary is cleanly encapsulated. |
| ADR-0004 | TLS = `rustls` preferred, `native-tls` fallback (feature flag) | Default `rustls` for async-nats + reqwest; `native-tls` behind a feature for platform trust store / enterprise CA / FIPS needs. | Consistent cross-platform TLS with no OpenSSL system dependency; escape hatch for environments that require the OS stack. |
| ADR-0005 | Rust→TS typegen = `typeshare` | Annotate `ns-types` with `#[typeshare]`; generate committed `types.ts`; CI drift-checks. | Keeps `ns-types` a pure serde crate (no per-type `ts-rs` derive), one deterministic CLI pass, serde-attribute aware; generics handled by monomorphization. |
| ADR-0006 | `ns-types` = single source of truth | All IPC DTOs, event payloads, `ErrorCode`, `IpcError` live in one frozen crate. | Coherence: Rust and TS derive from one place; breaking changes are visible and versioned. |
| ADR-0007 | Layered crates + dependency inversion | Ports in `ns-core`; adapters implement them; bin is the only composition root; `tauri`/`async-nats`/`rusqlite`/`reqwest` confined to their crates. | Clean architecture/SOLID, no cycles, headless testable domains, reusable by a future CLI/server. |
| ADR-0008 | Error model | `thiserror` per crate + `DomainError` trait + aggregate `AppError` → `IpcError` wire DTO with `ErrorCode`; `anyhow` only at boundaries; mandatory redaction. | Typed, uniform, secret-safe errors surfaced to the UI with a single mapping surface and correlation to logs. |
| ADR-0009 | IPC streaming = Channels + bridged events | Tauri **Channels** for request-scoped streams (subscribe/replay/terminal/logs); bridged **events** for ambient broadcasts; bounded buffers + per-topic coalescing/drop. | Correct lifecycle binding + cancellation for per-call streams; decoupled global signals; producers never blocked by a slow UI. |
| ADR-0010 | Internal event bus + bridge | `tokio::broadcast`/`mpsc` bus in `ns-event`; `EventPublisher` port; `ns-ipc::EventBridge` is the only bus→Tauri translator. | Decouples producers from Tauri, centralizes backpressure/coalescing/window-scoping, keeps domains headless. |
| ADR-0011 | State model | Rust `AppState` = registry of `Arc<dyn Service>` ports; frontend splits TanStack Query (server-state) vs Zustand (UI/session), hard boundary. | DIP + mockability + plugin override on the backend; correct caching/streaming vs ephemeral UI split on the frontend. |
| ADR-0012 | Dock/panel UI = `dockview` (dockview-react) | Multi-panel workspace via dockview; layout serialized to `LayoutRepo`; floating groups + tabs. | Performant, framework-agnostic core, serializable/restorable layouts matching the Lens/DBeaver workspace bar; avoids bespoke docking engine. |
| ADR-0013 | Secrets in OS keychain | `keyring` primary; encrypted (XChaCha20/`age`) fallback where no keychain; SQLite holds only references/metadata. | Never store creds/seeds in plaintext; use OS-protected storage; degrade safely on headless Linux. |
| ADR-0014 | Plugin architecture (phased) | Phase 1: in-process, trait-based, capability-gated extensions via `ns-plugin` with an independently SemVer-versioned API; Phase 2: WASM (`wasmtime`/`extism`) out-of-process for untrusted plugins. | Ship extensibility pragmatically now with a stable versioned contract; evolve to a hard sandbox for third-party code without breaking the API. |
| ADR-0015 | Monitoring via HTTP endpoints | `ns-monitor` polls `/varz`,`/connz`,`/jsz`,… with `reqwest` on a scheduler, buffers bounded time-series, plus `$SRV` request/reply for services. | Uses NATS' first-class monitoring surface; bounded buffers keep memory flat; no log scraping. |
| ADR-0016 | Pinned stable toolchain + documented prerequisites | `rust-toolchain.toml` pins stable (not nightly 1.97); `cargo-tauri`, `nats`, `nats-server`, `typeshare-cli` pinned in `versions.toml`. | Reproducible builds/tests across teams and CI; integration/e2e need real binaries. |
| ADR-0017 | Terminal = PTY running `nats` CLI | `ns-terminal` spawns the `nats` CLI over `portable-pty`, streamed to xterm.js via a Channel; raw shell mode gated behind a setting. | Purpose-built NATS terminal by default, cross-platform PTY, safe scoping with an opt-in escape hatch. |
| ADR-0018 | Cancellation & task model | Every stream/long op gets a `CancellationToken` in `CancellationRegistry` keyed by the id returned to the UI; drop-detection cancels leaked streams; tasks tracked in `TaskRegistry`. | Async-everywhere with guaranteed cleanup; no orphaned subscriptions/tasks; UI thread never blocks. |
| ADR-0019 | Telemetry opt-in + layered logging | Logging via layered `tracing-subscriber` (file + in-app buffer + EnvFilter); OTLP/analytics strictly opt-in. | Rich diagnostics and an in-app Logs view without compromising privacy by default. |

---

## 17. Handoff — what each team designs against

Every downstream team designs **within** the seams fixed above. Concretely:

- **connection-manager** — own `ns-nats` (`NatsClient`/`JsContext` traits + async-nats impl) and `ns-connection` (`ConnectionService`, handle registry, reconnection). Consume `ConnectionProfileRepo` (port) and `SecurityService`. Emit `ConnectionStatusChanged`/`ServerInfoUpdated`.
- **core-runtime** — own `ns-types` (frozen DTO SoT), `ns-core` (ports, ids, `DomainError`, `Settings`, redaction), `ns-event` (bus). Guard the type-gen pipeline.
- **tauri-shell** — own `ns-ipc` (error map, stream helpers, `EventBridge`, `Ctx`, cancellation) and the `nats-studio` bin (composition root, command registration, Tauri plugins). Own capabilities files.
- **dashboard** — own `ns-dashboard` aggregator + `features/dashboard`. Compose L2 services; do not reach into adapters.
- **monitoring** — own `ns-monitor` (HTTP polling, metric buffers, `$SRV`). Emit `MetricsTick`/`ConsumerLag`.
- **jetstream** — own `ns-jetstream` (streams/consumers/KV/object-store modules). Consume `NatsClient`+`JsContext`+`ns-inspector`.
- **pubsub** — own `ns-pubsub` (publish/subscribe/request-reply/`$SRV`). Stream via Channels; decode via `ns-inspector`.
- **message-inspector** — own `ns-inspector` (codecs, detection, headers). Provide a codec **plugin extension point** for `ns-plugin`.
- **subject-explorer** — own `ns-subject` (tree, wildcard analysis, sampling, stats). Emit `SubjectActivity`.
- **account-security** — own `ns-security` (nkeys/jwt/creds/tls/`SecretStore`). Provide the `SecurityService` used by `ns-connection`; align with the Security Model strategist.
- **terminal** — own `ns-terminal` (PTY + `nats` CLI). Stream output via Channel.
- **logging-observability** — own `ns-telemetry` (subscriber layers, in-app log stream, diagnostics bundle, opt-in telemetry).
- **storage** — own `ns-storage` (rusqlite, migrations, all repos implementing `ns-core` ports).
- **frontend-shell** — own `apps/desktop/src` shell (router, dockview layout, Zustand/TanStack wiring, `useAppEvents`) and `packages/ns-bindings` (generated types + typed command client). Each subsystem owns its `features/*` slice within these conventions.
- **Strategists** (security/performance/testing/deployment/plugin) — expand §15 and the relevant ADRs into dedicated docs that supersede the stubs; they do not redefine the crate graph, IPC/event/error/state contracts without an ADR.

**End of source-of-truth v1.0.**
