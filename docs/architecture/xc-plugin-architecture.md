# Cross-Cutting Strategy — `[plugin-architecture]`

**Owner:** Plugin Architecture strategist · **Crate of record:** `ns-plugin` (`crates/ns-plugin`, L2) · **Governing ADR:** ADR-0014 (phased, versioned) · **Status:** normative for the whole app.

This document is subordinate to `docs/architecture/00-conventions-and-workspace.md` (the spine). It never redefines the crate graph, the IPC/event/error/state contracts, or DTO conventions; it *specializes* them for extensibility. Where it introduces new contract surface (new `plugin_*` commands, new `ns-types` DTOs, new extension traits) it does so under the spine's rules (ADR + `appSchemaVersion`/`plugin_api` bump). Any deviation requires a new ADR.

---

## 1. Charter, Goals, Non-Goals

### 1.1 Charter
Own the model for **what a plugin is**, the **manifest**, the **independently-versioned Plugin API**, the **lifecycle** (discover/load/enable/disable/update), **isolation/sandboxing and permission scoping**, the **stable extension points**, **distribution + the Plugin Manager UI**, the **first-party vs third-party** split, and the **safety review of untrusted code** — across both the Rust backend and the React frontend.

### 1.2 Goals / budgets
- **Zero-cost when unused.** Plugins init lazily (spine §state_model). A fresh install with no plugins pays **0 ms** startup and **0 extra MB** beyond the empty `PluginHost` registry (< 32 KB). Budget: host construction < 1 ms; per-enabled-plugin cold load < 50 ms (Phase 1 in-proc), < 150 ms (Phase 2 WASM instantiate).
- **Never destabilize the host.** A misbehaving plugin can be *slow* or *wrong* but MUST NOT crash the WebView, block the UI thread, corrupt storage, leak secrets, or take down a NATS connection. Every plugin entry point is panic-isolated, timeout-bounded, and capability-gated.
- **Stable contract.** The Plugin API is versioned on its **own SemVer line** (`plugin_api = X.Y.Z`), independent of app version and `appSchemaVersion`. A plugin built against `1.2` keeps working on any host advertising a compatible range until a major bump.
- **Extensible everywhere it matters.** First-class extension points at: navigation, dockable panels/views, payload codecs + schema validators, message/table exporters, dashboard widgets, connection auth providers, and (read-only) monitor data sources.

### 1.3 Non-goals
- Not a general scripting console (that risk lives behind the Terminal subsystem's opt-in shell mode, ADR-0017).
- No remote code fetch-and-eval in the WebView (violates CSP, spine §config_conventions). Plugin frontend code is loaded only from disk from an installed, verified package.
- Phase 1 does **not** attempt a hard security boundary for untrusted third-party Rust; that is explicitly Phase 2 (WASM). Phase 1 third-party plugins are **frontend-only + declarative** (see §7.3).

---

## 2. What a Plugin *Is*

A plugin is a **signed, versioned package** that contributes zero or more **extensions** to well-known **extension points**, gated by a declared **capability set**, described by a **manifest**. It has up to three parts; any subset is legal:

1. **Frontend contributions** — React panels/views, nav entries, dashboard widgets, exporters, settings pages. Rendered by the frontend plugin runtime (§8) inside a sandbox (§7.4).
2. **Backend contributions** — Rust extensions registered into host registries at composition time: `dyn Codec` / `dyn SchemaValidator` (into `ns-inspector`), `dyn Exporter`, `dyn DashboardWidgetSource`, `dyn AuthProvider`, `dyn MonitorDataSource`, plus optional **plugin command handlers** invoked via `plugin_invoke`.
3. **Declarative assets** — manifest, capability declarations, JSON-Schema/Protobuf/Avro schema files, default dashboard layouts, icons, i18n bundles.

### 2.1 Plugin *classes* (trust tiers)
| Class | Source | Backend code | Isolation | Ships in |
|---|---|---|---|---|
| **first-party** | built into the app binary | native Rust, statically linked | trusted, in-proc | app bundle |
| **verified** | official registry, reviewed + signed by us | native (Phase 1) / WASM (Phase 2) | in-proc (P1) → sandbox (P2) | registry |
| **third-party (declarative)** | sideloaded / community | **no native**; frontend + declarative only | frontend sandbox + capability gate | user install |
| **third-party (WASM)** | community (Phase 2) | WASM guest via `wasmtime`/`extism` | out-of-proc sandbox | registry / sideload |

The trust class is **not** self-asserted by the manifest; it is derived by the host from **signature provenance** (§13.3) and pinned in `PluginStateRepo`.

### 2.2 On-disk package layout
Installed under `{appDataDir}/nats-studio/plugins/<pluginId>/<version>/` (resolved via the Tauri path API — never hardcoded, spine §storage_conventions):
```
<pluginId>/<version>/
├─ plugin.json          # manifest (§3)  — the ONLY file read before verification
├─ plugin.sig           # detached signature over the package hash (§13.3)
├─ MANIFEST.sha256      # per-file digest list (integrity)
├─ frontend/
│  ├─ index.mjs         # ES module entry, self-contained (no remote imports)
│  └─ assets/…          # icons, css (inlined/local), i18n json
├─ backend/             # Phase 2 only: guest.wasm  (+ wit world)
└─ schemas/             # optional JSON-Schema / .proto / .avsc contributed to inspector
```

---

## 3. Manifest Format (`plugin.json`)

The manifest is the frozen public contract of a package. It is a serde DTO **defined in `ns-types`** (typeshared → TS), so the Plugin Manager UI, the host, and the SDK all read one shape. `#[serde(rename_all="camelCase")]`, tagged enums, RFC-3339 timestamps, `*Ms` durations — same rules as every DTO (spine §shared_types_crate).

```rust
// ns-types::plugin
#[typeshare] #[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema: u32,                     // manifest schema version (=1); host rejects unknown majors
    pub id: PluginId,                    // reverse-DNS, immutable: "io.natsstudio.protobuf-pro"
    pub name: String,
    pub version: SemVerString,           // package SemVer (independent of app & plugin_api)
    pub publisher: PublisherRef,         // { name, url?, keyId }  — keyId ties to §13.3 trust
    pub description: String,
    pub icon: String,                    // relative path within package
    pub license: String,                 // SPDX id; verified against deny.toml allowlist for verified tier
    pub api: ApiRange,                    // { min: SemVerString, max: SemVerString } against plugin_api
    pub appVersion: Option<SemVerRange>, // optional host app constraint
    pub engine: PluginEngine,            // Frontend | Native | Wasm  (tagged kind/data)
    pub capabilities: Vec<Capability>,   // requested permission grants (§7.1) — least privilege
    pub contributes: Contributions,      // extension-point contributions (§4)
    pub configSchema: Option<JsonSchema>,// JSON-Schema for the plugin's own settings page
    pub integrity: IntegrityRef,         // { algo: "sha256", manifestDigest }
}

#[typeshare] #[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum PluginEngine { Frontend, Native, Wasm { world: String } }

#[typeshare] #[serde(rename_all = "camelCase")]
pub struct Contributions {
    pub nav:        Vec<NavContribution>,        // sidebar/route entries
    pub panels:     Vec<PanelContribution>,      // dockview-embeddable views (ADR-0012)
    pub widgets:    Vec<WidgetContribution>,     // dashboard widgets
    pub codecs:     Vec<CodecContribution>,      // ns-inspector Codec/Validator ids + schema refs
    pub exporters:  Vec<ExporterContribution>,   // message/table exporters
    pub authProviders: Vec<AuthProviderContribution>, // connection auth (verified/first-party only)
    pub dataSources:   Vec<DataSourceContribution>,   // read-only monitor sources
    pub commands:   Vec<CommandContribution>,    // backend handlers callable via plugin_invoke
    pub settingsPage: Option<SettingsPageContribution>,
    pub menus:      Vec<MenuContribution>,       // context-menu / command-palette entries
}
```
**Rules.** (1) `id` is reverse-DNS and immutable across versions; changing it is a new plugin. (2) `capabilities` is a *closed allowlist*; any host API touched without a matching grant is denied at the boundary (§7.2) — the manifest cannot escalate at runtime. (3) `api` MUST fall within the host's advertised range or the plugin is refused with `PLUGIN_INCOMPATIBLE` before any code loads. (4) Contributions referencing native engine features are stripped for the `Frontend` engine class. (5) Manifest is parsed with a hard size cap (256 KB) and a schema-validated deserialize; malformed → `PLUGIN_ERROR`, never a panic.

---

## 4. Stable Extension Points

Each extension point is a **narrow trait or declarative contract** owned by the relevant subsystem, registered through `ns-plugin`. Backend registration happens **at composition time in the bin** — feature crates never depend on `ns-plugin` (that would invert layering; the bin bridges them, exactly as the inspector does today, sub-message-inspector §391).

| Point | Contract | Registered into | Owner crate | Class allowed |
|---|---|---|---|---|
| **Navigation** | `NavContribution { id, title, icon, route, order, capability? }` (declarative) | Frontend nav registry | `frontend-shell` | any |
| **Panels / views** | `PanelContribution { id, title, mount, placement, singleton }` → React component in sandbox (§8) | dockview host | `frontend-shell` | any |
| **Dashboard widgets** | `WidgetContribution` + optional `dyn DashboardWidgetSource` (backend feed) | `ns-dashboard` widget registry | `dashboard` | any (FE) / verified (BE) |
| **Payload codecs** | `dyn Codec` / `dyn SchemaValidator` (sub-message-inspector §3.2) | `CodecRegistry`/`ValidatorRegistry` via `InspectorService::register_codec/validator` | `message-inspector` | verified/first-party (native); any (schema-only) |
| **Exporters** | `dyn Exporter { id, formats, export(rows, sink) }` | `ExporterRegistry` (new, in `ns-plugin`) | `plugin-architecture` | any (FE stream) / verified (BE) |
| **Auth providers** | `dyn AuthProvider` producing `AuthArtifacts` for `ns-connection` | connection auth registry | `account-security` | first-party/verified ONLY |
| **Monitor data sources** | `dyn MonitorDataSource` (read-only, produces `MetricsTick`-shaped series) | `ns-monitor` source registry | `monitoring` | verified/first-party |
| **Commands** | `CommandContribution` → handler dispatched by `plugin_invoke` | `PluginHost` command table | `plugin-architecture` | verified/WASM |
| **Menus / palette** | `MenuContribution { id, title, target, commandRef }` (declarative) | command palette + context menus | `frontend-shell` | any |

**Extension point invariants:** every point is (a) a stable trait/DTO carried in `ns-types` or a subsystem's public API, (b) capability-gated, (c) enumerable at runtime (`plugin_list_extensions`), and (d) removable when a plugin is disabled without restart (registries support `unregister(pluginId)`). Auth providers and monitor data sources touch security-/network-sensitive surface and are therefore **hard-restricted to first-party/verified** regardless of manifest requests.

---

## 5. The `ns-plugin` Crate — Host Architecture

`ns-plugin` is an **L2** crate depending only on `ns-types`, `ns-core`, `ns-event` (spine crate table). It imports **no** `tauri`, **no** `async-nats`, **no** SQL, **no** `keyring`. It defines ports and the host; adapters (WASM runtime, file discovery, storage-backed state) are injected by the bin.

### 5.1 Public traits
```rust
// ns-plugin::host
#[async_trait]
pub trait PluginHost: Send + Sync + 'static {
    async fn discover(&self) -> Result<Vec<DiscoveredPlugin>, PluginError>;
    async fn load(&self, id: &PluginId) -> Result<LoadedPlugin, PluginError>;   // parse+verify+instantiate, not enabled
    async fn enable(&self, id: &PluginId) -> Result<(), PluginError>;           // register extensions
    async fn disable(&self, id: &PluginId) -> Result<(), PluginError>;          // unregister, cancel tasks
    async fn install(&self, pkg: PackageSource) -> Result<PluginManifest, PluginError>;
    async fn uninstall(&self, id: &PluginId) -> Result<(), PluginError>;
    async fn update(&self, id: &PluginId, to: SemVerString) -> Result<(), PluginError>;
    fn list(&self) -> Vec<PluginRecord>;                    // manifest + state + trust class
    fn list_extensions(&self) -> Vec<ExtensionRecord>;      // enumerable at runtime (§4)
    async fn invoke(&self, req: PluginInvokeRequest) -> Result<PluginInvokeResponse, PluginError>;
    fn api_range(&self) -> ApiRange;                        // host-advertised plugin_api support
}

// ns-plugin::caps — the capability guard the host applies at every boundary
pub trait CapabilityGuard: Send + Sync {
    fn check(&self, plugin: &PluginId, need: Capability) -> Result<(), PluginError>;
}

// Extension registries the host owns; feature crates expose thin register/unregister that the bin wires.
pub trait ExtensionRegistry<T>: Send + Sync {
    fn register(&self, owner: PluginId, ext: Arc<T>) -> Result<(), PluginError>;
    fn unregister(&self, owner: &PluginId);
    fn snapshot(&self) -> Vec<(PluginId, Arc<T>)>;
}
```

### 5.2 Ports the bin injects (DIP, ADR-0007)
```rust
pub trait PluginStore: Send + Sync {                 // impl in ns-storage (PluginStateRepo)
    async fn get_state(&self, id: &PluginId) -> Result<Option<PluginState>, PluginError>;
    async fn put_state(&self, id: &PluginId, s: &PluginState) -> Result<(), PluginError>;
    async fn kv_get(&self, id: &PluginId, k: &str) -> Result<Option<String>, PluginError>; // sandboxed per-plugin kv
    async fn kv_put(&self, id: &PluginId, k: &str, v: &str) -> Result<(), PluginError>;
}
pub trait PackageVerifier: Send + Sync {             // impl in ns-security (§13.3)
    fn verify(&self, dir: &Path) -> Result<TrustClass, PluginError>;
}
pub trait PluginRuntime: Send + Sync {               // Phase 1: NativeRuntime (no-op guest); Phase 2: WasmRuntime
    async fn instantiate(&self, m: &PluginManifest, dir: &Path) -> Result<GuestHandle, PluginError>;
    async fn call(&self, g: &GuestHandle, method: &str, arg: Json) -> Result<Json, PluginError>;
}
```
The bin's `build_app_state` (sub-tauri-shell §3.1) constructs `SqlitePluginStore`, `KeychainPackageVerifier`, and the runtime, injects them into `PluginHostImpl`, and after building each L2 service **re-enters** the host to register enabled plugins' native extensions into `InspectorService`, `DashboardService`, `MonitorService`, and the connection auth registry.

### 5.3 Error type
`PluginError` (thiserror, one public enum, spine §error_model) with `#[from]` on runtime/verify/store/io errors, implementing `DomainError`:
- `Incompatible { need, have }` → `PLUGIN_INCOMPATIBLE`
- `CapabilityDenied { cap }`, `SignatureInvalid`, `ManifestInvalid`, `GuestTrap`, `Timeout`, `NotFound`, `AlreadyEnabled`, `RuntimeError` → `PLUGIN_ERROR` (or `TIMEOUT`/`NOT_FOUND` where precise).
`user_message` is secret-safe; all guest-provided strings are scrubbed before surfacing.

---

## 6. Versioned Plugin API + SemVer Policy

### 6.1 Two independent version axes
- **`plugin_api = MAJOR.MINOR.PATCH`** — the semantic contract of extension traits + DTOs + the guest ABI. Exposed by `app_info.pluginApiRange` (sub-tauri-shell §4, `AppInfoDto`). This is **not** the app version and **not** `appSchemaVersion` (spine §versioning).
- **Package version** — each plugin's own SemVer in the manifest.

### 6.2 Compatibility rule
Host advertises a **range** `{ min, max }` (e.g. `>=1.0.0, <2.0.0`). A plugin declares `api = { min, max }`. **Compatible iff** the two ranges intersect AND `plugin.min.major == host.current.major`. On mismatch: refuse with `PLUGIN_INCOMPATIBLE` **before loading any code**; the Plugin Manager shows "requires plugin API x.y, host provides a.b" with an upgrade/downgrade hint.

### 6.3 What each bump means
| Change | Bump |
|---|---|
| Remove/rename an extension trait method or DTO field; change enum tag repr; tighten a capability | **major** (ADR required) |
| Add a new extension point, add an optional DTO field, add a capability, add a command | **minor** |
| Bug/behaviour fix within contract | **patch** |
Additive-only within a major (Rust: `#[non_exhaustive]` on all public plugin enums/structs; new trait methods ship with default impls or as a new sub-trait). The guest ABI (Phase 2 WIT world) is versioned in lockstep with `plugin_api.major`.

### 6.4 Deprecation
A method/point deprecated in `1.x` keeps working through the entire `1` line with a `tracing::warn` + a Plugin Manager badge; removal waits for `2.0`. CI guards the contract: a `plugin-api-lock.json` snapshot of the public surface is diffed; any change without a matching version bump fails the build (mirrors the spine's gen-types drift check).

---

## 7. Isolation, Sandboxing & Permission Scoping

### 7.1 Capability model
A closed enum in `ns-types`, requested in the manifest, granted at install with explicit user consent, enforced at every host boundary:
```rust
#[typeshare] #[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum Capability {
    ReadConnections,                    // list profiles (metadata only, never secrets)
    Subscribe   { subjectPattern: String }, // scoped subscribe via pubsub (verified+)
    Publish     { subjectPattern: String }, // scoped publish (verified+, extra consent)
    ReadJetStream,                      // stream/consumer/KV/object metadata (read)
    ReadMonitoring,                     // varz/connz/... snapshots
    RegisterCodec,                      // contribute inspector codecs/validators
    RegisterExporter,
    ContributePanel, ContributeNav, ContributeWidget,
    ProvideAuth,                        // AuthProvider — first-party/verified ONLY
    Network    { hosts: Vec<String> },  // outbound HTTP allowlist (schema fetch etc.) — WASM host-mediated
    Storage,                            // per-plugin sandboxed KV (§5.2), quota-bounded
    ReadSettings, Notify,
}
```
**Never grantable to plugins:** raw filesystem, raw sockets, secret material (creds/seeds/JWTs — always `Redacted<T>`, spine §logging_conventions), arbitrary command execution, the OS keychain, other plugins' storage. Subject-scoped `Subscribe`/`Publish` patterns are validated by `ns-subject` wildcard rules and intersected with the *connection's own* server-side permissions — a plugin can never exceed the user's NATS authz.

### 7.2 Enforcement — the single choke point
Every plugin-originated call (frontend `plugin_invoke`, or a WASM guest host-call) passes through `CapabilityGuard::check` **before** reaching any subsystem service. There is exactly one enforcement surface, analogous to `ns_ipc::to_ipc_error`: the host holds the granted set per plugin (from `PluginStateRepo`), and the `plugin_invoke` command in the bin resolves the calling `pluginId`, checks the capability, then forwards to the target service with a **scoped, connection-bound context**. A denied call returns `PLUGIN_ERROR{CapabilityDenied}` and emits a `PluginEvent` for the audit log. Capabilities are **immutable at runtime**; a plugin that wants more must be re-consented via the Manager (which re-writes `PluginState` and re-enables).

### 7.3 Phase 1 isolation (ship now)
- **Native backend code is trusted** — first-party (compiled in) and **verified** (our signature) only. There is no hard memory boundary for native Rust; safety comes from **provenance + review** (§14), not sandboxing. Third-party unverified plugins in Phase 1 are **`Frontend` engine only + declarative** — they get no native code path at all.
- **Panic isolation:** every native extension invocation is wrapped in `std::panic::catch_unwind` at the host boundary (as the Tauri bridge already does for commands, spine §error_model) → `ErrorCode::INTERNAL`/`PLUGIN_ERROR`, WebView never crashes.
- **Time & resource bounds:** every `PluginHost::invoke` and every native extension call runs under a `CancellationToken` from the `CancellationRegistry` (ADR-0018) with a per-call timeout (default 5 s, configurable) and runs on a `TaskRegistry`-tracked task — never on the UI thread, never blocking.

### 7.4 Frontend sandbox (all classes)
Plugin panels do **not** run in the main WebView origin. The frontend plugin runtime mounts each plugin panel in an **isolated context** with no ambient authority:
- Rendered inside a **sandboxed `<iframe sandbox="allow-scripts">`** (no `allow-same-origin` for third-party; no DOM access to the host app), served from a distinct internal origin. First-party panels may run in-process for perf; verified/third-party are always framed.
- The **only** channel out is a typed `postMessage` bridge exposing the generated `ipc.plugin.*` client — which itself lands on `plugin_invoke` and is re-checked by `CapabilityGuard`. No direct `invoke`, no access to Zustand/TanStack stores, no `window.__TAURI__`.
- Strict CSP (spine §config_conventions): plugin frames get `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'` — **no remote origins, no eval**. All plugin assets are local (embedded/inlined at package build; §2.2). Network egress, if granted, is host-mediated (§7.5), never a raw `fetch` from the frame.

### 7.5 Phase 2 isolation (WASM, roadmap — ADR-0014 Phase 2)
For untrusted third-party **backend** code: compile to WASM, run **out-of-process** via `wasmtime` (component model) or `extism`, exposed through a **WIT world** versioned with `plugin_api.major`. Guests get **no ambient host functions** — only capability-mediated imports (subscribe/publish/read-monitoring/kv/network) that the host implements and gates. Fuel/epoch interruption bounds CPU; linear-memory cap bounds RAM; host-mediated network honours the `Network{hosts}` allowlist. A trapping/OOM/timeout guest is killed and the plugin auto-disabled with a notification — the host process is untouched.

---

## 8. Frontend Plugin Runtime

Owned jointly with `frontend-shell` (`apps/desktop/src/features/plugins/` + `src/plugins/runtime/`). Server-state vs UI-state boundary is unchanged (spine §state_model): plugin data flows through TanStack Query via `ipc.plugin.*`; plugin UI/session state (open panels, plugin settings drafts) is Zustand.

- **Registry hydration.** On startup `useAppEvents()` + a `['plugins','list']` query load enabled plugins. For each, the runtime dynamically imports its local `frontend/index.mjs` (a plain ES module, no remote), which calls a typed **SDK register API** (`packages/ns-plugin-sdk`, TS) to declare its React components for each declared contribution id.
- **Mounting.** Nav entries inject into the sidebar registry; panels become dockview panel factories (ADR-0012) keyed by `pluginId:panelId`; widgets register into the dashboard grid; exporters into the export menu. Everything is removable on disable (registries mirror the backend's `unregister`).
- **The SDK surface** (`@nats-studio/plugin-sdk`, pinned to `pluginApiRange`): `definePlugin({ panels, widgets, exporters, nav })`, a scoped `host` object exposing only the granted `ipc.plugin.*` calls, a `useHostTheme()`/`useHostConnection()` read-only hook set, and typed `ns-types` bindings. The SDK throws `NatsStudioError{PLUGIN_INCOMPATIBLE}` if loaded against an out-of-range host.
- **Events.** Plugins receive host signals via a filtered `ns://plugin` event subset only (never the raw bus). A plugin cannot subscribe to `ns://connection/status` etc. directly; the SDK re-emits a redacted, capability-filtered projection.

---

## 9. Lifecycle

State machine persisted in `PluginStateRepo` (`state ∈ Discovered | Installed | Enabled | Disabled | Incompatible | Quarantined | Errored`):

```
discover ─▶ Installed ─enable─▶ Enabled ─disable─▶ Disabled
   │            │  ▲                │  │
   │       verify│  └───update──────┘  └─trap/timeout/violation─▶ Quarantined
   │            ▼                                                     │
   └─▶ Incompatible (api range)                        (auto-disable + notify)
```

- **Discover.** Scan `{appDataDir}/plugins/*`; parse each `plugin.json` (size-capped, schema-validated) **only**; compute integrity digest; do not execute anything. Emit `PluginEvent::Discovered`.
- **Load/verify.** `PackageVerifier::verify` checks `plugin.sig` + `MANIFEST.sha256` → derives `TrustClass` (§13.3). API-range check → `Incompatible` short-circuits. Capability set resolved from persisted grants.
- **Enable.** Instantiate (native: register extensions into subsystem registries; WASM: `PluginRuntime::instantiate`), register frontend contributions (via a bridged `ns://plugin` event the runtime consumes), flip state `Enabled`. Idempotent; concurrent enable guarded by a per-plugin lock.
- **Disable.** `unregister(pluginId)` across all registries; cancel the plugin's `CancellationToken` group in the `CancellationRegistry`; drop guest handle; frontend unmounts panels/nav. No host restart required for either enable or disable (hot).
- **Update.** Download new version → verify → **stage** under `<pluginId>/<newVersion>/` → disable old → enable new → on success prune old (keep N-1 for rollback); on any failure, keep old enabled and mark update `Errored`. Migration of the plugin's own KV state is the plugin's responsibility, invoked via a `migrate` guest/command hook keyed by prior version.
- **Quarantine.** A capability violation, repeated trap, or failed integrity check on load moves the plugin to `Quarantined`: disabled, flagged red in the Manager, requires explicit user re-consent to re-enable. Emitted as a `Notification` (never dropped, spine §event_architecture).

Startup is **fast**: discovery is cheap (manifest parse only); actual enable/instantiation is lazy per the spine's lazy-init rule — a plugin's backend is only instantiated when its extension is first hit or when eager-enable is user-configured.

---

## 10. IPC & Event Surface

### 10.1 `plugin_*` commands (namespace reserved in spine §ipc_conventions)
Registered by the shell, body delegating to `PluginHost` (sub-tauri-shell §4.2 pattern). Each takes one `req`, returns `Result<_, IpcError>`; DTOs in `ns-types`.

| Command | Kind | Req → Resp | Caps checked | Errors |
|---|---|---|---|---|
| `plugin_list` | request | `{}` → `PluginRecord[]` | — | — |
| `plugin_list_extensions` | request | `{ point? }` → `ExtensionRecord[]` | — | — |
| `plugin_install` | command | `InstallPluginRequest{ source }` → `PluginManifest` | user consent gate | `PLUGIN_ERROR`, `PLUGIN_INCOMPATIBLE` |
| `plugin_uninstall` | command | `{ id }` → `()` | — | `NOT_FOUND` |
| `plugin_enable` / `plugin_disable` | command | `{ id }` → `()` | — | `PLUGIN_ERROR` |
| `plugin_update` | command | `{ id, to }` → `PluginManifest` | — | `PLUGIN_ERROR` |
| `plugin_get_config` / `plugin_set_config` | request/command | `{ id, config? }` → `Json`/`()` | `ReadSettings` | `INVALID_ARGUMENT` |
| `plugin_grant` | command | `{ id, capabilities }` → `()` | user consent gate | `PLUGIN_ERROR` |
| `plugin_invoke` | request/stream | `PluginInvokeRequest{ id, method, arg, connectionId? }` → `PluginInvokeResponse` | **per-method capability** | `PLUGIN_ERROR{CapabilityDenied}`, `TIMEOUT`, `CANCELLED` |
| `plugin_registry_search` / `plugin_registry_install` | request/command | registry browse + fetch (§13) | — | `PLUGIN_ERROR` |

`plugin_invoke` is the **only** backend entry point plugins reach; it is the enforcement choke point (§7.2) and, for streaming plugin outputs (e.g. a live custom monitor widget), returns a `subscriptionId` backed by a Tauri **Channel** with the standard bounded-buffer/drop policy + `*_cancel` companion (ADR-0009/0018). Dropping the Channel (panel unmount) cancels the plugin task — no leaks.

### 10.2 Events — `ns://plugin` (spine §event_architecture, already reserved)
Bridged from the bus by `ns-ipc::EventBridge` only. `EventPayload::PluginEvent(PluginEventDto)` with variants: `Installed`, `Enabled`, `Disabled`, `Updated`, `Quarantined`, `CapabilityDenied`, `RuntimeError`, `Progress` (install/update). Policy: install/update `Progress` = keep-latest per plugin id (like `TaskProgress`); `Quarantined`/`CapabilityDenied` = `Notification`-class, never dropped. Plugins themselves publish domain signals via `plugin_invoke` → the host re-publishes them as capability-filtered `PluginEvent`s; a plugin can never emit onto other topics.

---

## 11. Storage (`PluginStateRepo`, spine §storage_conventions)

Repository already named in the spine (§storage_conventions, sub-core-runtime ports). Owned by `ns-storage` (only crate with SQL), implementing the `PluginStore` port:
```sql
-- crates/ns-storage/migrations/00NN_plugins.sql
CREATE TABLE plugins (
  id            TEXT PRIMARY KEY,
  version       TEXT NOT NULL,
  state         TEXT NOT NULL,          -- lifecycle enum
  trust_class   TEXT NOT NULL,          -- derived, NOT from manifest
  granted_caps  TEXT NOT NULL,          -- JSON array of Capability (consented)
  manifest_json TEXT NOT NULL,          -- cached last-verified manifest
  installed_at  TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE plugin_kv (                 -- sandboxed per-plugin KV (cap: Storage), quota-bounded
  plugin_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
  PRIMARY KEY (plugin_id, k),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
);
```
No secrets in SQLite (spine §storage_conventions): plugins never persist creds; any plugin secret (e.g. a schema-registry token for a `Network` capability) goes through `ns-security` `SecretStore` under a plugin-namespaced key, never plaintext. `plugin_kv` is quota-bounded (default 1 MB/plugin) and TTL-swept by the storage worker like message history.

---

## 12. Distribution & Plugin Manager UI

### 12.1 Channels
1. **Built-in** (first-party) — compiled into the binary; appear pre-enabled, non-removable, version-locked to the app.
2. **Official registry** (verified) — a signed static index (JSON manifest list + package URLs + our detached signatures) served over HTTPS with pinned roots (rustls, ADR-0004). `plugin_registry_search`/`plugin_registry_install` fetch, verify (§13.3), and install. The registry index and every package are signature-checked; TOFU is not accepted for verified tier.
3. **Sideload** — user picks a `.nsplugin` package file (zip of §2.2). Installed as third-party; if unsigned → forced `Frontend`+declarative class with a prominent warning + explicit capability consent.

### 12.2 The Plugin Manager (frontend, `features/plugins`)
A first-class route (`/plugins`) with:
- **Installed** list — cards per plugin: name/publisher/version, trust badge (first-party/verified/third-party), state toggle (enable/disable, hot), update badge, capability summary, "view details/audit".
- **Details** — manifest view, **granted vs requested capabilities** with a per-capability consent UI, contributed extension points, config page (from `configSchema` rendered via Monaco/JSON-Schema form), the plugin's audit log (capability grants/denials, traps, quarantine events pulled from `ns://plugin` + telemetry).
- **Discover/registry** — browse the official registry, search, one-click install with a **consent dialog** enumerating exactly what the plugin will be allowed to do (capabilities in plain language) before any code runs.
- **Safety surfacing** — third-party/unsigned plugins carry a persistent warning banner; quarantined plugins are red and locked pending re-consent; a global "disable all third-party plugins" panic switch (also honoured by a `NS_DISABLE_PLUGINS` dev/support env, mirroring `NS_DISABLE_UPDATER`).

Server-state (registry results, installed list) via TanStack Query keyed `['plugins',...]`; consent/toggle mutations invalidate those keys; UI-only state (open detail tab) via Zustand.

---

## 13. First-Party vs Third-Party & Safety Review

### 13.1 First-party
Built into `nats-studio` (bin) or shipped as verified packages we author. Full native capability set (incl. `ProvideAuth`, `RegisterCodec`). Reviewed as normal app code (CI, `cargo-deny`, security review skill).

### 13.2 Third-party
- **Declarative/frontend (Phase 1)** — no native code; sandboxed frame; capabilities limited to the FE-safe subset (nav/panels/widgets/exporters/read-only data via `plugin_invoke`). This is the *only* untrusted class shippable in Phase 1.
- **WASM (Phase 2)** — untrusted native logic behind the out-of-process sandbox (§7.5).

### 13.3 Signing & verification (`ns-security`, ADR-0013 primitives)
- We publish an **Ed25519** (`nkeys`/`ed25519-dalek`) signing key; the app ships the pinned **public** key(s). Verified packages carry `plugin.sig` = signature over the canonical package hash (Merkle over `MANIFEST.sha256`). `PackageVerifier` recomputes digests, verifies the signature against a pinned key → `TrustClass::Verified`; signature present but unknown key → `Untrusted`; no signature → `Untrusted` (sideload only, with warning). The trust class is **derived and persisted by the host**, never read from the manifest (§2.1).
- Integrity is re-checked on every load (defence against on-disk tampering); a mismatch → `Quarantined`.

### 13.4 Review pipeline for the official (verified) registry
Before a third-party plugin earns our signature: automated scan (bundle static analysis for `eval`/remote URLs/CSP violations in `frontend/`; `cargo-deny` license+advisory + WASM import audit for the guest against the allowed WIT world; capability review — flag `Publish`, `ProvideAuth`, `Network`), then human review (the `security-review` skill on the source), then signing. Publishers register a `keyId`; revocation is a pinned revocation list checked at install (a revoked plugin is refused/quarantined). Least-privilege is enforced editorially: a plugin requesting caps it demonstrably doesn't use is rejected.

---

## 14. Per-Subsystem Compliance Matrix

Every subsystem must comply; the pattern is uniform: **expose a narrow trait/registry; never depend on `ns-plugin`; let the bin bridge; enforce capabilities via `plugin_invoke`.**

| Subsystem / crate | Obligation |
|---|---|
| **core-runtime** (`ns-types`,`ns-core`,`ns-event`) | Own `PluginManifest`, `Capability`, `PluginEventDto`, `PluginRecord`, `Contributions`, `PluginInvokeRequest/Response`, `ApiRange` DTOs (typeshared). `ns-core` adds `PluginStore`/`PackageVerifier`/`PluginRuntime` port traits + `PluginId`/`SemVerString` newtypes. `ns-event` carries `PluginEvent` on the bus. |
| **plugin-architecture** (`ns-plugin`) | The host, registries, `CapabilityGuard`, `ExporterRegistry`, SemVer/compat logic, `plugin-api-lock.json` guard. Only `ns-types`+`ns-core`+`ns-event` deps. |
| **tauri-shell** (`ns-ipc`, bin) | Register `plugin_*` commands; wire `PluginHost` + ports in `build_app_state`; re-enter host to register native extensions into L2 services; bridge `PluginEvent`→`ns://plugin`; give plugin frames a reduced **capability file** + strict CSP (sub-tauri-shell §open-questions #4). `plugin_invoke` is the choke point. |
| **message-inspector** (`ns-inspector`) | Already exposes `register_codec/register_validator` (sub-message-inspector §3.2, §391). Accept plugin `dyn Codec`/`dyn SchemaValidator` (native: verified+; schema-only: any) via bin bridge; enforce IO-free purity — plugin codecs run CPU-bound, timeout-bounded. |
| **dashboard** (`ns-dashboard`) | Expose a `WidgetSourceRegistry` for `dyn DashboardWidgetSource`; render plugin widgets in the grid; compose read-only, never let a widget mutate connection/JS state. |
| **monitoring** (`ns-monitor`) | Expose a `MonitorDataSource` registry (read-only series, `MetricsTick`-shaped); verified/first-party only; honour bounded ring-buffer + coalescing policy for plugin sources. |
| **account-security** (`ns-security`) | Implement `PackageVerifier` (Ed25519, pinned keys, revocation); host the plugin-namespaced `SecretStore`; own the `AuthProvider` registry (first-party/verified ONLY). Redaction of any plugin-surfaced string. |
| **connection-manager** (`ns-connection`) | Consume `AuthProvider` extensions to resolve auth artifacts; enforce that plugin `Subscribe/Publish` scopes are intersected with the connection's server-side permissions; carry `connectionId` explicitly (no hidden current-connection). |
| **pubsub** (`ns-pubsub`) | Serve capability-scoped `Subscribe/Publish` from `plugin_invoke` with subject-pattern validation (`ns-subject`) + existing Channel backpressure. |
| **jetstream** (`ns-jetstream`) | Serve `ReadJetStream` metadata reads to plugins (read-only in P1); no plugin stream/consumer mutation without `Publish`-class consent + verified tier. |
| **subject-explorer** (`ns-subject`) | Provide wildcard/subject-pattern validation used to bound plugin subject capabilities. |
| **storage** (`ns-storage`) | Implement `PluginStateRepo`/`PluginStore` (§11): state, granted caps, cached manifest, quota-bounded per-plugin KV, migrations. No secrets in SQLite. |
| **logging-observability** (`ns-telemetry`) | Route plugin `tracing` spans under target `ns_plugin::<id>`; feed capability grants/denials/traps into the audit log + in-app Logs view; diagnostics bundle includes plugin inventory (redacted). |
| **terminal** (`ns-terminal`) | No obligation to *host* plugins; MUST NOT expose PTY/shell as a plugin capability (that authority is never grantable). |
| **frontend-shell** | Own the plugin runtime (sandboxed frames, SDK, dockview/nav/widget registration), the Plugin Manager UI, consent dialogs, panic switch; enforce the FE CSP + `postMessage` bridge; keep server/UI state split. |
| **security-model (xc)** | Owns the CSP, capability-file scoping, signing-key custody; this doc defers to it on trust primitives. |
| **performance-strategy (xc)** | Owns the per-plugin timeout/CPU/memory budgets and the "0-cost-when-unused" verification. |
| **testing-strategy (xc)** | `ns-testkit` provides a `MockPluginHost`, a fixture signed test package, and capability-denial assertions; e2e enables a sample plugin end-to-end. |
| **deployment-strategy (xc)** | Owns registry hosting, package signing in release CI, and the revocation-list publication. |

---

## 15. Failure Modes & Mitigations

| Failure | Blast radius (mitigated) | Mitigation |
|---|---|---|
| Plugin panics (native) | none | `catch_unwind` at host boundary → `PLUGIN_ERROR`; WebView untouched |
| Plugin hangs / infinite loop | none to UI | per-call timeout + `CancellationToken` + `TaskRegistry`; never on UI thread; Phase 2 fuel/epoch interrupt |
| Plugin memory leak | bounded | Phase 1: native reviewed/trusted; Phase 2: WASM linear-memory cap; per-plugin KV quota |
| Capability escalation attempt | denied + audited | single `CapabilityGuard` choke point; caps immutable at runtime; `CapabilityDenied` event + quarantine on repeat |
| Secret exfiltration | prevented | secrets never grantable; `Redacted<T>`; scrubber on plugin log/error path; no keychain access |
| Malicious frontend (remote fetch/eval) | prevented | CSP `connect-src 'none'`, `script-src 'self'`, no `same-origin`; assets local-only; egress host-mediated |
| Tampered package on disk | quarantined | integrity re-check every load; signature verify; revocation list |
| Incompatible API version | refused pre-load | range check before any code loads → `PLUGIN_INCOMPATIBLE` |
| Update breaks plugin | rollback | staged install, keep N-1, revert on failure |
| Plugin subscribes to firehose | bounded | Channel bounded buffer + sample/drop policy (ADR-0009); subject scope ∩ server authz |
| Registry compromise | limited | packages independently signed by pinned key; index signature; revocation |

**Budgets:** host cold construct < 1 ms; per-plugin enable < 50 ms (native) / < 150 ms (WASM); `plugin_invoke` default timeout 5 s; per-plugin KV 1 MB; plugin frame idle RAM target < 8 MB; a disabled plugin = 0 runtime cost.

---

## 16. Phasing & Proposed ADRs

- **Phase 1 (MVP).** In-proc native (first-party + verified) + declarative/frontend third-party; full capability model + guard; manifest + signing + verifier; lifecycle + Plugin Manager; extension points: nav, panels, codecs/validators, exporters, widgets, read-only data. Ships the stable `plugin_api = 1.0.0`.
- **Phase 1.5.** Official registry + registry UI + revocation list; auth-provider and monitor-data-source points (verified).
- **Phase 2.** WASM out-of-process runtime (`wasmtime` component model / `extism`) behind the *same* capability model + `plugin_invoke` surface — no API break (ADR-0014 Phase 2).

**Sub-ADRs this doc will land** (under `docs/architecture/adr/`): plugin-API SemVer + compat range policy; capability enum + enforcement choke point; package signing (Ed25519, pinned keys, revocation); frontend sandbox (framed + CSP + postMessage bridge); Phase 2 WASM/WIT world. Each is additive to the spine and gated by the normal ADR + version-bump process.

---

## 17. Open Questions
1. WASM runtime pick — `wasmtime` component model vs `extism` — decided at Phase 2 entry against binary-size/perf budgets (perf-strategy owns the call).
2. Cross-plugin extension composition (a codec plugin used by a dashboard-widget plugin) — allow via explicit dependency in the manifest, or forbid for isolation? Default: forbid in Phase 1.
3. Per-window vs per-connection capability scoping for plugin frames (inherits sub-tauri-shell open-question #4) — reduced capability file per plugin window at runtime, not just build time.
4. Monetized/paid plugins & entitlement checks — out of scope until registry maturity; must not add ambient network capability to the host.
