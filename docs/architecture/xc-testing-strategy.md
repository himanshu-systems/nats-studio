# Cross-Cutting Strategy — [testing-strategy] Testing Strategy

**Owner:** Testing Strategy (cross-cutting)
**Crate owned:** `ns-testkit` (`crates/ns-testkit`, dev-only lib, layer Lx) — depends on `ns-types`, `ns-core`, `ns-nats`; used by *every* crate's tests.
**Automation owned (co-owned with [tauri-shell] / [deployment-strategy]):** `cargo xtask` test targets, the CI test matrix, coverage gates, and the nats-binary provisioning contract in `tools/versions.toml`.

> Testing is a horizontal contract, not a team. This document defines *how every subsystem proves it works* — the harness they build on (`ns-testkit`), the layers they must fill (unit → integration → contract → component → E2E → load/bench), the budgets they must hit, and the CI that enforces it on Windows/macOS/Linux. It never contradicts the spine (§00): it *tests* the ports, DTOs, error model, streaming, and event bus exactly as the spine defines them. Where a rule says "every subsystem MUST", CI enforces it — a subsystem that does not comply does not merge.

---

## (a) Scope & the Testing Pyramid

We test the **whole application** across six layers. Each layer has an owner, a runner, a speed budget, and a gate.

| Layer | What it proves | Runner | Where | Needs real `nats-server`? | Speed budget |
|---|---|---|---|---|---|
| **L1 Rust unit** | Pure logic per crate against mocked ports | `cargo nextest` | `#[cfg(test)]` in each crate | No (mocks from `ns-testkit`) | < 60 s whole workspace |
| **L2 Rust integration** | A service against a real ephemeral `nats-server` (core / JS / TLS / auth) | `cargo nextest` (`--test '*'`) | `crates/<c>/tests/` | **Yes** — `NatsServerFixture` | < 5 min per OS |
| **L3 IPC contract** | Rust DTOs ↔ generated TS never drift; command manifest is complete | `xtask gen-types` + `git diff`, `vitest` contract suite | `packages/ns-bindings`, `xtask` | No | < 30 s |
| **L4 FE unit/component** | React components, hooks, stores, query wiring | `vitest` + React Testing Library | `apps/desktop/src/**/__tests__` | No (mocked IPC) | < 90 s |
| **L5 E2E** | Real bundled app: IPC round-trips, streaming, cancellation, layout | `tauri-driver` + WebdriverIO (primary); Playwright (dev-server fallback) | `apps/desktop/e2e/` | **Yes** | < 15 min (smoke < 3 min) |
| **L6 Load / bench / perf** | Throughput, backpressure, memory, latency budgets, regression | `criterion` (Rust micro), custom `xtask loadtest`, `tinybench` (FE) | `benches/`, `xtask` | **Yes** (load) | Nightly, not on PR |

**Distribution target (rough count, not dogma):** ~70% L1, ~15% L2, ~5% L3, ~7% L4, ~2% L5, plus a standing L6 nightly. The pyramid is inverted-cost: push assertions to the lowest layer that can prove them. A bug reproducible with a mocked `NatsClient` MUST get an L1 test; only behavior that genuinely needs the wire (JS ack semantics, TLS handshake, reconnection) earns an L2 test.

---

## (b) Tooling & Pinned Versions

All test tooling is pinned. Rust tool versions live in `tools/versions.toml` and are installed by `cargo xtask verify-tools`; JS versions live in `package.json` / `pnpm-lock.yaml`.

| Concern | Tool | Version (pin) | Notes |
|---|---|---|---|
| Rust test runner | `cargo-nextest` | 0.9.x | Parallel, per-test process isolation, JUnit + retries, `--partition` for CI sharding |
| Rust coverage | `cargo-llvm-cov` | 0.6.x | Source-based coverage, LCOV + Cobertura; merges nextest runs |
| Rust micro-bench | `criterion` | 0.5.x | Statistical benches, `--save-baseline` for regression gates |
| Property testing | `proptest` | 1.x | Subject parsing, codecs, DTO round-trips |
| Snapshot / golden | `insta` | 1.x | DTO JSON goldens, error-mapping goldens, review workflow |
| Fake NATS server | `nats-server` binary | pinned in `versions.toml` (e.g. 2.10.x) | Real server, spawned by fixture; NOT a mock |
| NATS CLI | `nats` binary | pinned (e.g. 0.1.x) | For terminal tests + fixture seeding |
| Async test macros | `tokio` `#[tokio::test]` | workspace tokio | `flavor = "multi_thread"` where needed |
| Time control | `tokio::time::pause` + `Clock` port | — | Deterministic timers; no real sleeps in unit tests |
| HTTP mock (monitor) | `wiremock` | 0.6.x | Serve canned `varz`/`connz`/`jsz` JSON for `ns-monitor` unit tests |
| FE unit/component | `vitest` | 2.x | jsdom env, `@testing-library/react` 16.x, `@testing-library/user-event` 14.x |
| FE mocking | `vi.mock` + MSW-style IPC stub | vitest built-in | Mock `@tauri-apps/api` `invoke` + `Channel` |
| FE coverage | `@vitest/coverage-v8` | matches vitest | LCOV, merged with Rust in report |
| E2E driver | `tauri-driver` | matches Tauri v2 | WebDriver bridge to the bundled app |
| E2E client | `webdriverio` | 9.x | Primary E2E; runs the real signed-dev bundle |
| E2E fallback | `playwright` | 1.4x.x | Against `tauri dev` WebView for fast local iteration only |
| FE micro-bench | `tinybench` | 2.x | Render/serialize hot paths |
| CI | GitHub Actions | — | 3-OS matrix, see §(k) |

Toolchain is pinned stable via `rust-toolchain.toml` (`1.89.0`, never the local nightly 1.97 — ADR-0016). CI and local dev install the same tool versions or `xtask verify-tools` fails fast.

---

## (c) `ns-testkit` — the shared harness (our crate)

`ns-testkit` is the single dev-only dependency every crate's tests import. It exists so that no team hand-rolls a NATS fixture, a mock client, or DTO builders. It has three pillars.

### 1. `NatsServerFixture` — ephemeral real server

Spawns a **real** pinned `nats-server` on an ephemeral port, waits for readiness via `/healthz`, and tears it down (kill + port release) on `Drop`. Configurable matrix so integration tests can request exactly the server shape they need.

```rust
pub struct NatsServerFixture { /* child process, ports, tmpdir, creds */ }

pub struct NatsServerBuilder {
    jetstream: bool,               // -js, with tmp store_dir
    tls: Option<TlsFixture>,       // rustls test CA -> server cert + client trust
    auth: AuthMode,                // None | Token | UserPass | NKey | Creds(operator/account/user)
    accounts: Vec<AccountSpec>,    // multi-account / permissions for security tests
    http_monitor: bool,            // -m <port>, exposes varz/connz/jsz/... for ns-monitor
    cluster: Option<ClusterSpec>,  // N-node route mesh for routez/cluster tests
    leaf: Option<LeafSpec>,        // leaf node for leafz tests
    max_payload: Option<usize>,
    log_capture: bool,             // pipe server stderr into tracing for triage
}

impl NatsServerBuilder {
    pub fn new() -> Self;
    pub fn jetstream(self) -> Self;
    pub fn with_tls(self) -> Self;
    pub fn with_creds_auth(self) -> Self;
    pub async fn start(self) -> Result<NatsServerFixture, FixtureError>;
}

impl NatsServerFixture {
    pub fn client_url(&self) -> String;          // nats://127.0.0.1:<port>
    pub fn monitor_url(&self) -> String;         // http://127.0.0.1:<mport>
    pub fn creds_path(&self) -> Option<&Path>;   // generated .creds for auth tests
    pub fn tls_client_config(&self) -> Option<rustls::ClientConfig>;
    pub async fn connect(&self) -> Result<Box<dyn NatsClient>, NatsError>; // via ns-nats real adapter
    pub fn nats_cli(&self) -> NatsCliInvoker;    // pre-wired `nats` CLI pointed at this server
}
```

Provisioning: the fixture resolves the `nats-server` path from (1) `NS_TEST_NATS_SERVER` env, (2) `tools/versions.toml` cache dir populated by `xtask verify-tools`, (3) `PATH`. If none found, tests marked `#[integration]` **skip with a loud warning** locally and **hard-fail in CI** (CI guarantees the binary — see §k). This keeps `cargo test` runnable on a laptop without NATS while making CI authoritative.

TLS fixture generates an in-memory test CA (`rcgen`) → server leaf cert + a `rustls::ClientConfig` trusting it, so TLS tests need no on-disk PKI and no OpenSSL.

### 2. Mock ports — headless unit testing

Every `ns-core` port has a canonical mock so services test without any I/O. Mocks are behavior-configurable (scripted responses, injected errors, latency, cancellation).

```rust
pub struct MockNatsClient { /* scripted req/reply, pub/sub channels, fault injection */ }
pub struct MockJsContext  { /* in-memory streams/consumers/KV/object maps */ }
pub struct MockSecretStore { /* in-mem keychain, toggle "unavailable" */ }
pub struct MockClock       { /* manual advance; drives Clock port deterministically */ }
pub struct RecordingEventPublisher { /* captures every Event for assertions */ }
pub struct InMemoryRepos   { /* ConnectionProfileRepo/MessageHistoryRepo/... in a HashMap */ }

impl MockNatsClient {
    pub fn expect_request(&self, subject: &str, reply_with: Bytes);
    pub fn inject_error(&self, on: Op, err: NatsError);       // e.g. NO_RESPONDERS, TIMEOUT
    pub fn inject_disconnect_after(&self, n: usize);          // drive reconnection tests
    pub fn feed_subscription(&self, subject: &str, msgs: impl IntoIterator<Item = Message>);
}
```

`RecordingEventPublisher` is how subsystems assert their event contract (topic, `seq` monotonicity, coalescing) without the bridge. `InMemoryRepos` lets services test persistence-dependent flows without SQLite.

### 3. Builders, assertions, golden helpers

```rust
pub mod builders {                    // typed DTO builders, sane defaults, override any field
    pub fn stream_config() -> StreamConfigBuilder;
    pub fn consumer_info() -> ConsumerInfoBuilder;
    pub fn server_varz() -> ServerVarzBuilder;
    pub fn connection_profile() -> ConnectionProfileBuilder;
    pub fn ipc_error(code: ErrorCode) -> IpcErrorBuilder;
}
pub mod assert {
    pub fn assert_ipc_error(err: &IpcError, code: ErrorCode);        // code + retriable + secret-free
    pub fn assert_no_secrets(text: &str);                            // scans for seed/jwt/pass patterns
    pub fn assert_seq_monotonic(events: &[Event]);                   // per-topic seq gap check
    pub fn assert_camel_case_json(value: &serde_json::Value);        // DTO wire convention
}
pub mod golden {
    pub fn assert_json_golden(name: &str, value: &impl Serialize);   // insta-backed, redacted
}
```

**Every crate MUST use these; hand-rolled fixtures/mocks are rejected in review.** This is the mechanism that keeps testing uniform across 18 crates.

---

## (d) Layer L1 — Rust unit tests (per crate)

Rule: every public function/branch of business logic has a unit test that runs with **no network, no filesystem, no clock, no WebView**. Ports are injected as `ns-testkit` mocks. Async tests use `#[tokio::test]` with `tokio::time::pause()` and `MockClock` — **no real `sleep`**.

Mandatory per-crate coverage of the spine's cross-cutting contracts:

- **Error model (ADR-0008):** every `thiserror` variant maps to the correct `ErrorCode`, `retriable()`, and a secret-safe `user_message()`. `#[from]` wrapping of external errors (async_nats/rusqlite/reqwest/io) preserves the source chain. Assert with `ns-testkit::assert`.
- **Redaction:** any type holding a secret is `Redacted<T>`; `Debug`/`Display` print `***`; `assert_no_secrets` on all error/log output.
- **Cancellation (ADR-0018):** long ops observe their `CancellationToken` and stop promptly; dropping the consumer cancels.
- **Event contract:** services emit the documented `EventPayload` variants with monotonic `seq` — assert via `RecordingEventPublisher`.

Determinism: seed all randomness; `proptest` cases use a fixed RNG in CI (`PROPTEST_CASES` pinned). No test may depend on wall-clock or ordering of a `HashMap` iteration.

Subsystem-specific L1 focus (non-exhaustive):

| Crate | L1 must cover |
|---|---|
| `ns-types` | serde round-trips, camelCase, adjacently-tagged enum repr, base64 payload encoding, RFC-3339 ts, newtype-id string form — property tests |
| `ns-core` | `DomainError` default impls, `Redacted<T>`, cancellation registry, `Page<T>` cursor math, Settings defaults/migration |
| `ns-event` | broadcast fan-out, per-topic `seq` monotonicity, coalescing (MetricsTick keep-latest/250ms), `Lagged(n)` surfacing |
| `ns-nats` | trait shape + error mapping via `MockNatsClient`; real-wire behavior deferred to L2 |
| `ns-security` | NKey sign/verify, `.creds` parse (valid/malformed), JWT claim checks, `SecretStore` fallback path, redaction |
| `ns-storage` | migration application on a `:memory:` db, each repo CRUD, retention/TTL enforcement, WAL pragmas — uses real rusqlite in-memory (fast, deterministic) |
| `ns-inspector` | codec encode/decode round-trips + format auto-detection (JSON/MsgPack/Protobuf/Avro/CBOR/text/bin), hex preview, header parsing — property + golden |
| `ns-connection` | reconnection backoff state machine, health transitions, status-event dedupe — `MockNatsClient` disconnect injection |
| `ns-pubsub` | publish/subscribe/req-reply flows, queue-group fan, `NO_RESPONDERS` mapping, decode via inspector |
| `ns-jetstream` | stream/consumer/KV/object CRUD DTO mapping, ack/replay logic against `MockJsContext` |
| `ns-monitor` | parse each endpoint (varz/connz/routez/subsz/jsz/healthz/accountz/gatewayz/leafz) from `wiremock` canned JSON; ring-buffer bounds; `$SRV` aggregation |
| `ns-subject` | tree build, wildcard validation (`*`/`>`), sampling stats — property tests on subject grammar |
| `ns-terminal` | session registry, backpressure/overflow marker logic (PTY spawn deferred to L2/L5) |
| `ns-plugin` | manifest parse, capability gating, API version range check → `PLUGIN_INCOMPATIBLE` |
| `ns-dashboard` | aggregation of mocked connection+monitor+jetstream snapshots into overview DTO |
| `ns-ipc` | `AppError→IpcError` mapping, source-chain walk, redaction, correlation-id attach, panic→`INTERNAL` catch |

---

## (e) Layer L2 — Rust integration tests (ephemeral `nats-server`)

Live in `crates/<crate>/tests/*.rs`, tagged so they can be filtered (`cargo nextest run -E 'test(integration_)'`). Each acquires a `NatsServerFixture` matching its needs. These prove real-wire behavior that mocks cannot.

**Server-shape matrix (each subsystem picks the rows it needs):**

| Shape | Builder | Exercised by |
|---|---|---|
| Core plain | `NatsServerBuilder::new()` | `ns-connection`, `ns-pubsub`, `ns-subject` |
| JetStream on | `.jetstream()` | `ns-jetstream` (streams/consumers/KV/object), `ns-dashboard` |
| TLS (rustls) | `.with_tls()` | `ns-connection`, `ns-security` (handshake, cert trust, `TLS_ERROR`) |
| Auth: token / user-pass / nkey / creds | `.with_creds_auth()` etc. | `ns-security`, `ns-connection` (`AUTH_FAILED`, permission denied) |
| HTTP monitor | `.http_monitor()` | `ns-monitor` (real varz/connz/jsz against live server) |
| Cluster (N routes) | `.cluster(3)` | `ns-monitor` routez/cluster, `ns-connection` failover |
| Leaf node | `.leaf(..)` | `ns-monitor` leafz |

**Mandatory integration scenarios (per subsystem compliance in §j):**

- **Connection:** connect success; wrong port → `CONNECTION_TIMEOUT`; bad auth → `AUTH_FAILED`; TLS mismatch → `TLS_ERROR`; **kill server mid-session → reconnect with backoff → status events fire in order** (drive by killing/restarting the fixture child).
- **PubSub:** publish→subscribe delivery; queue-group load balancing across N subs; request/reply; **no responders → `NO_RESPONDERS`**; request timeout.
- **JetStream:** create stream, publish, create durable consumer, ack/nak/term, replay by seq/time, purge, delete; KV put/get/watch/delete; Object put/get/list; stream-not-found / consumer-not-found error codes.
- **Monitor:** poll every endpoint from the live server, assert parsed DTO shape and that ring buffers stay bounded under repeated polls.
- **Security:** `.creds` end-to-end connect; nkey challenge; per-account permission boundary → `PERMISSION_DENIED`.
- **Terminal:** spawn the real `nats` CLI via the fixture's `NatsCliInvoker`, run `nats pub`/`nats sub`, assert streamed stdout, cancellation kills the PTY child.

These tests are **serialized per fixture** but **parallel across fixtures** (nextest process isolation + unique ephemeral ports). Timeouts are explicit (`tokio::time::timeout`) so a hung server fails fast rather than blocking the suite.

---

## (f) Layer L3 — IPC contract & type-drift tests

The spine's single-source-of-truth (ADR-0005/0006) is only real if CI enforces it. Three gates:

1. **Type-gen drift.** `pnpm gen:types` runs `typeshare ./crates/ns-types --lang typescript --output-file packages/ns-bindings/src/generated/types.ts`; CI then `git diff --exit-code`. Any Rust DTO change not regenerated fails the build. Owned here, run in the FE + Rust jobs.
2. **Command manifest completeness.** A `vitest` contract suite loads `commands.manifest.ts` and asserts (a) every `#[tauri::command]` in the Rust `commands/*` (extracted by `xtask gen-command-list` into a JSON) has a manifest entry pairing it with `Request`/`Response` types, and (b) every manifest type exists in generated `types.ts`. A renamed command or DTO breaks the TS build immediately — exactly as the spine requires.
3. **Error-code parity.** `xtask` emits the Rust `ErrorCode` enum variants to JSON; a vitest test asserts the TS `ErrorCode` union and the FE's `code → localized copy` map cover every variant (no orphan codes, no missing copy).

Golden IPC snapshots: representative `Request`/`Response`/`IpcError`/`EventPayload` values are serialized and checked with `insta` goldens (redacted), so wire-format changes are visible in review even when types still compile.

---

## (g) Layer L4 — Frontend unit & component tests

Runner: **Vitest** (jsdom) + **React Testing Library** + `@testing-library/user-event`. IPC is fully mocked — no real Tauri.

**IPC mocking:** a `ns-testkit`-equivalent for TS (`packages/ns-bindings/testing`) provides `mockIpc()` that stubs the generated `ipc.*` wrappers and `Channel`/event emitters. Tests script command responses and push `Channel` frames / bridged events to drive streaming UI. Because the FE calls **only** typed wrappers (never raw `invoke("string")`), the mock surface is finite and typed.

What every feature slice MUST test:

- **Components:** render states (loading/empty/error/data), accessibility roles, keyboard interaction (user-event, not fireEvent), Monaco/xterm/ECharts wrappers behind mocks.
- **Query wiring (TanStack Query):** query keys are the namespaced arrays from the spine (`['jetstream','streams',connectionId]`); mutations invalidate the right keys; `IpcError.retriable` drives retry; **server-state is never mirrored into Zustand** (a lint + a test assert this boundary).
- **Zustand stores:** UI/session reducers (active connection, tabs, dockview layout, filters, Monaco buffers) with pure-state assertions; persisted slices sync via debounced `settings_*`/`layout_*` mutations (mocked).
- **`useAppEvents()`:** given a bridged event, it routes to the correct query-cache `setQueryData` or Zustand slice; gap indicator shown on synthetic "n events dropped".
- **Error rehydration:** `IpcError` → typed `NatsStudioError`; UI renders by `code`; secret-free.
- **Channel streams:** a view hook subscribes, folds frames into cache, and **cancels/unsubscribes on unmount** (assert the `*_unsubscribe` wrapper is called) — proves no leaked subscriptions at the UI layer.

Component tests must not snapshot entire DOM trees blindly; prefer role/text assertions. Visual snapshots (if any) are isolated and reviewed, never auto-updated in CI.

---

## (h) Layer L5 — End-to-end (real bundled app)

**Primary: `tauri-driver` + WebdriverIO** against the actual built app (dev-signed bundle). This is the only layer that exercises the true Rust↔WebView boundary, the real event bridge, and OS integration (keychain, path API, PTY). **Fallback: Playwright** against `tauri dev` for fast local authoring only — never the CI gate of record.

E2E needs a **real `nats-server`** (provisioned per §k). A `docker`/process fixture starts a JS-enabled, monitored server; deep-linked test profiles are seeded via the `nats` CLI.

**Smoke suite (< 3 min, runs on every PR that touches app/shell):**
1. App launches, no WebView crash, main window + dockview shell render.
2. Add a connection profile → connect → status pill goes green (real connection status event through the bridge).
3. Publish a message → subscribe in another panel → message appears (real Channel stream).
4. Open JetStream view → list streams → create a stream → it appears.
5. Open terminal → `nats pub`/`nats sub` round-trips.
6. Disconnect → status pill red; app stays alive.

**Full E2E (nightly / pre-release):** reconnection UX (kill server, watch reconnect banner), TLS + creds connection, KV/Object browsing, monitor dashboard renders live varz charts, message inspector decodes each payload format, subject explorer live sampling, workspace layout save/restore across restart (dockview → LayoutRepo → SQLite), settings hot-reload, cancellation (start a big replay, cancel, assert task stops), and the crash-safety guarantee (force a command panic → UI shows `INTERNAL` toast, WebView survives).

E2E stability rules: every step waits on an explicit condition (element/text/event), never a fixed sleep; each test provisions its own connection profile and tears it down; the SQLite `NS_DATA_DIR` is a throwaway temp dir per run so tests never share state.

---

## (i) Layer L6 — Load, throughput, perf benchmarks & regression

Owned jointly with [performance-strategy]; this section is the *testing* mechanism for their budgets.

**Rust micro-benchmarks (`criterion`, `crates/*/benches/`):** codec encode/decode throughput (`ns-inspector`), subject tree build & wildcard match (`ns-subject`), event-bus fan-out & coalescing (`ns-event`), monitor JSON parse (`ns-monitor`), DTO serialize (`ns-types`). Each bench `--save-baseline main`; the nightly job compares against the committed baseline and **fails on > X% regression** (default 10%, per-bench overridable).

**Throughput / load (`cargo xtask loadtest` against a real server):**
- **Subscribe firehose:** publish 100k+ msgs/s to a subject, subscribe through `ns-pubsub`, assert the backpressure policy holds — bounded buffer, `droppedSinceLast` counted and surfaced, **producer never blocked**, memory stays flat (RSS ceiling assertion).
- **Metrics coalescing:** flood `MetricsTick`, assert the bridge coalesces to ≤ 1 frame per (connection,metric) per 250 ms and the UI-facing rate is bounded.
- **JetStream replay:** replay a large stream, measure sustained rate + steady memory (ring/stream, not full buffering).
- **Terminal/log ordering:** high-rate output preserves order with overflow marker, no unbounded growth.

**Budgets (targets; performance-strategy owns exact numbers, testing enforces them):** cold startup < 2 s to interactive; idle RSS < ~150 MB; no UI-thread block > 16 ms during streaming; subscribe firehose sustained ≥ 100k msg/s decode with bounded memory; reconnect detection < 1 s. Each budget is a nightly assertion with a hard fail + a tracked trend.

**FE perf (`tinybench`):** hot render/serialize paths (message list virtualization, ECharts data mapping) measured; regression tracked, not PR-gating.

**Regression suite:** every fixed bug ships with a test at the lowest layer that reproduces it (labeled `regression_<issue>`); goldens (`insta`) lock DTO/error/type-gen output so accidental wire changes are caught in review.

---

## (j) Per-subsystem compliance (what every team MUST deliver)

Every subsystem MUST, as a merge gate, provide: L1 unit tests using `ns-testkit` mocks covering its error/redaction/cancellation/event contracts; the L2 integration rows marked below; L4 tests for its FE slice; and register its E2E smoke step if it has one. "N/A wire" = no direct NATS wire, so no L2.

| Subsystem / crate | L2 server shapes required | Signature scenarios that MUST pass |
|---|---|---|
| [connection-manager] `ns-nats`,`ns-connection` | core, TLS, all auth, cluster | connect/timeout/auth/TLS errors; **kill→reconnect→ordered status events** |
| [core-runtime] `ns-types`,`ns-core`,`ns-event` | N/A wire | serde/enum/base64/ts round-trips; seq monotonicity; coalescing; cancellation |
| [tauri-shell] `ns-ipc`, bin | via E2E | AppError→IpcError mapping; panic→INTERNAL; EventBridge window-scoping; command registration |
| [dashboard] `ns-dashboard` | JS-on | aggregate connection+monitor+jetstream snapshot; partial-source degradation |
| [monitoring] `ns-monitor` | http monitor, cluster, leaf | parse every endpoint from live server; bounded ring buffers; `MONITOR_UNREACHABLE`/`MONITOR_PARSE_ERROR` |
| [jetstream] `ns-jetstream` | JS-on | stream/consumer/KV/object CRUD; ack/replay/purge; not-found codes |
| [pubsub] `ns-pubsub` | core | pub/sub/queue-group/req-reply; `NO_RESPONDERS`; `REQUEST_TIMEOUT`; decode via inspector |
| [message-inspector] `ns-inspector` | N/A wire | codec round-trips + auto-detect (property + golden); `PAYLOAD_DECODE_FAILED` |
| [subject-explorer] `ns-subject` | core | tree/wildcard (property); live sampling stats; `SUBJECT_INVALID` |
| [account-security] `ns-security` | TLS, all auth | nkey/jwt/creds sign+verify+parse; SecretStore fallback; redaction; `PERMISSION_DENIED` |
| [terminal] `ns-terminal` | core (+ real `nats` CLI) | PTY spawn/stream/cancel; ordering + overflow; `TERMINAL_SPAWN_FAILED` |
| [logging-observability] `ns-telemetry` | N/A wire | ring-buffer bounds; redaction scrubber; EnvFilter; correlation-id propagation |
| [storage] `ns-storage` | N/A wire | migrations on fresh + upgraded db; per-repo CRUD; retention/TTL; WAL pragmas |
| [frontend-shell] React app | via L3/L4/L5 | query/Zustand boundary; useAppEvents routing; typed IPC wrappers; layout save/restore |
| [security-model] (xc) | reuses security/connection L2 | redaction audit across all crates (`assert_no_secrets` sweep); CSP/capability checks in E2E |
| [performance-strategy] (xc) | reuses L6 | benches + loadtests + budget assertions |
| [deployment-strategy] (xc) | E2E on bundle | bundle launches + updater-config sanity per OS |
| [plugin-architecture] `ns-plugin` | N/A wire | manifest/capability/API-range; `PLUGIN_INCOMPATIBLE`; sandboxed invoke |

---

## (k) CI matrix, coverage, and nats-binary provisioning

**Matrix:** GitHub Actions across `windows-latest`, `macos-latest`, `ubuntu-latest`, on the pinned stable toolchain. Jobs:

1. **`lint`** (ubuntu): `cargo fmt --check`, `cargo clippy -D warnings`, `xtask check-layers` (no dependency cycles / layer violations), `cargo-deny` (licenses/bans/advisories/SBOM), `pnpm lint` + `tsc --noEmit`.
2. **`typegen-drift`** (ubuntu): `pnpm gen:types` → `git diff --exit-code`; command-manifest + error-code parity vitest suites.
3. **`rust-test`** (3 OS): install pinned `nats-server` + `nats` (see below) → `cargo nextest run` (unit + integration) with `--partition` sharding → JUnit + `cargo-llvm-cov` LCOV.
4. **`fe-test`** (ubuntu): `vitest run --coverage`.
5. **`e2e-smoke`** (3 OS, on shell/app changes): build dev bundle → start server fixture → `tauri-driver` + WebdriverIO smoke suite.
6. **`nightly`** (3 OS, scheduled): full E2E, `criterion` regression vs baseline, `xtask loadtest`, perf-budget assertions, longer property-test case counts.

**Provisioning `nats-server` / `nats` (the missing local prerequisites):**
- Versions pinned in `tools/versions.toml`. `cargo xtask verify-tools` downloads the exact release for the runner OS/arch into a cached dir and verifies checksums; CI caches by version key so it downloads once.
- CI installs before `rust-test`/`e2e`; the `NatsServerFixture` resolves the cached path via `NS_TEST_NATS_SERVER`.
- **Locally**, `cargo xtask verify-tools` does the same, so a developer runs `xtask verify-tools && cargo nextest run` and gets full integration coverage with zero manual install. If a dev skips it, `#[integration]` tests skip locally (warn) but CI still runs them — CI is authoritative.
- The `nats` CLI is provisioned the same way and is what `ns-terminal` tests and E2E seeding use.

**Coverage:** `cargo-llvm-cov` (Rust) + `@vitest/coverage-v8` (FE) LCOV are merged and uploaded. Gates: **workspace Rust line coverage ≥ 80%**, **per-L2-service branch coverage on error paths ≥ 90%** (error mapping is safety-critical), **FE lib (`ns-bindings`, stores, hooks) ≥ 80%**. Coverage cannot drop more than 1% vs `main` without an override label. Coverage is a floor, not a target — a covered-but-unasserted line is a review reject.

**Flakiness policy:** nextest retries = 2 with per-test JUnit; a test that needs retry is reported. A flaky test is either fixed within one sprint or moved to a `#[ignore = "quarantine: <issue>"]` quarantine lane (tracked, non-gating, auto-expiring). Nightly runs the quarantine lane so it can't rot silently. Root causes of flakiness (real sleeps, port races, shared temp dirs, unseeded RNG) are banned by convention and caught in review.

---

## (l) Failure modes this strategy defends against

| Failure mode | Defense |
|---|---|
| Rust/TS types silently disagree | L3 type-gen drift + command-manifest + error-code parity gates |
| Secret leaks into error/log/UI | `Redacted<T>` + `assert_no_secrets` sweep in L1 + security-model audit + scrubber test |
| Reconnection regressions | L2 kill→reconnect with ordered status-event assertions |
| Backpressure/memory blowup under load | L6 firehose loadtest with RSS ceiling + `droppedSinceLast` assertions |
| Leaked subscriptions/tasks | L1 cancellation tests + L4 unmount-cancels + L5 cancel-a-replay E2E |
| WebView crash on backend panic | L1 `ns-ipc` panic→INTERNAL + L5 forced-panic-survives E2E |
| Flaky CI eroding trust | Explicit-wait rules, no real sleeps, deterministic clock/RNG, quarantine lane, per-OS matrix |
| "Works on my machine" (missing nats binaries) | `xtask verify-tools` pins/downloads; CI authoritative; local skip-with-warn |
| Layer/architecture erosion | `xtask check-layers` + `cargo-deny` in `lint` job |
| Bugs recurring | Mandatory `regression_<issue>` test + `insta` goldens at lowest reproducing layer |

---

## (m) Definition of Done (testing contract per PR)

A change merges only if: (1) new logic has L1 tests via `ns-testkit`; (2) new wire behavior has an L2 test on the right server shape; (3) new/changed DTOs pass type-gen drift + goldens; (4) new FE has L4 tests respecting the query/Zustand boundary; (5) a new user-visible flow has an E2E smoke step; (6) coverage floors hold; (7) `lint`/`check-layers`/`cargo-deny` are green; (8) any fixed bug has a `regression_` test. CI enforces all eight across Windows/macOS/Linux.
