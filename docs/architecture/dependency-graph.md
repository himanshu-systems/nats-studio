# NATS Studio — Dependency & Interaction Graphs

> Document ID: `arch/dependency-graph`
> Status: **ACCEPTED (v1.0)**
> Owner: Principal Architect
> Binds to: [`README.md`](./README.md), [`00-conventions-and-workspace.md`](./00-conventions-and-workspace.md)

This document is the authoritative visual model of how the crates depend on each other (layered and **acyclic**) and how the subsystems interact at runtime. The edges here reflect the [reconciliation decisions](./README.md#8-reconciliation-decisions) — notably that the `NatsClient`/`JsContext` **ports live in `ns-core`** (ADR-0021), that `ns-ipc` keeps an L0-only dependency set (the aggregate `AppError` lives in the bin), and that no L2 feature crate depends on another L2 or on L3 `ns-dashboard`.

`cargo xtask check-layers` enforces this graph in CI: any edge that points "upward" or forms a cycle fails the build.

---

## 1. Crate dependency graph (layered, acyclic)

Edges point from a crate to the crate it depends on. Every arrow flows **downward** across layers (L4 → L3 → L2 → L1 → L0). There are no upward or lateral edges except the explicitly-allowed L3 `ns-dashboard` → L2 composition.

```mermaid
flowchart TB
    classDef l0 fill:#1e3a5f,stroke:#4a90d9,color:#fff
    classDef l1 fill:#234d34,stroke:#4caf7d,color:#fff
    classDef l2 fill:#4a3a1e,stroke:#d9a94a,color:#fff
    classDef l3 fill:#4a1e3a,stroke:#d94a90,color:#fff
    classDef l4 fill:#5f1e1e,stroke:#d94a4a,color:#fff
    classDef dev fill:#333,stroke:#888,color:#fff

    subgraph L4["L4 — binary / composition root"]
        BIN["nats-studio"]:::l4
    end

    subgraph L3["L3 — composition & glue"]
        DASH["ns-dashboard"]:::l3
        IPC["ns-ipc"]:::l3
    end

    subgraph L2["L2 — feature services"]
        CONN["ns-connection"]:::l2
        PUB["ns-pubsub"]:::l2
        JS["ns-jetstream"]:::l2
        MON["ns-monitor"]:::l2
        SUBJ["ns-subject"]:::l2
        TERM["ns-terminal"]:::l2
        PLUG["ns-plugin"]:::l2
    end

    subgraph L1["L1 — adapters & leaf domain"]
        EVT["ns-event"]:::l1
        NATS["ns-nats"]:::l1
        SEC["ns-security"]:::l1
        STOR["ns-storage"]:::l1
        TEL["ns-telemetry"]:::l1
        INSP["ns-inspector"]:::l1
    end

    subgraph L0["L0 — foundation"]
        TYPES["ns-types"]:::l0
        CORE["ns-core"]:::l0
    end

    %% L0 internal
    CORE --> TYPES

    %% L1 -> L0
    EVT --> TYPES
    EVT --> CORE
    NATS --> TYPES
    NATS --> CORE
    SEC --> TYPES
    SEC --> CORE
    STOR --> TYPES
    STOR --> CORE
    TEL --> TYPES
    TEL --> CORE
    TEL --> EVT
    INSP --> TYPES
    INSP --> CORE

    %% L2 -> L1/L0
    CONN --> CORE
    CONN --> EVT
    CONN --> NATS
    CONN --> SEC
    CONN --> STOR
    PUB --> CORE
    PUB --> EVT
    PUB --> INSP
    JS --> CORE
    JS --> EVT
    JS --> INSP
    MON --> CORE
    MON --> EVT
    SUBJ --> CORE
    SUBJ --> EVT
    TERM --> CORE
    TERM --> EVT
    PLUG --> CORE
    PLUG --> EVT

    %% L3 -> L2/L1/L0
    DASH --> CORE
    DASH --> EVT
    DASH --> CONN
    DASH --> MON
    DASH --> JS
    IPC --> TYPES
    IPC --> CORE
    IPC --> EVT

    %% L4 -> everything (composition root)
    BIN --> DASH
    BIN --> IPC
    BIN --> CONN
    BIN --> PUB
    BIN --> JS
    BIN --> MON
    BIN --> SUBJ
    BIN --> TERM
    BIN --> PLUG
    BIN --> NATS
    BIN --> SEC
    BIN --> STOR
    BIN --> TEL
    BIN --> INSP
```

> `ns-types` and `ns-core` carry all `EventPayload`/`ErrorCode`/DTO edges implicitly — every crate depends on them. `ns-testkit` (dev) depends on `ns-types`, `ns-core`, `ns-nats` and is a `dev-dependency` of every crate; it is omitted above to keep the production graph clean.

### 1.1 Why the "surprising" edges are absent

| Edge you might expect | Why it does **not** exist | Where the coupling actually lives |
|---|---|---|
| `ns-jetstream → ns-monitor` | JS account limits come from `$JS.API.INFO` via `JsContext`. | `JetStreamQuery` port; dashboard composes at L3. |
| `ns-jetstream/ns-monitor → ns-dashboard` | Composition is one-way; L2 never depends on L3. | `ns-dashboard` pulls via `MonitorQuery`/`JetStreamQuery`/`ConnectionQuery` ports. |
| `ns-pubsub → ns-jetstream` | JS publish uses `JsContext` from a resolver port. | `ClientProvider::js()` port in `ns-core`. |
| `ns-monitor → ns-nats` | `NatsClient` is a **port in `ns-core`** (ADR-0021). | `NatsClientProvider` port; `ns-nats` impl injected by the bin. |
| `ns-ipc → ns-connection/...` (L2 errors) | `to_ipc_error` takes `&dyn DomainError`. | Aggregate `AppError` lives in the **bin**. |
| `ns-inspector → ns-pubsub/ns-plugin` | Inspector is L1; plugins register codecs via a port. | `register_codec(Arc<dyn Codec>)` called by bin/host. |
| any crate (except `ns-nats`) importing `async-nats` | Source-import confinement (ADR-0001). | Only `ns-nats` `use async_nats`. |

---

## 2. The port-injection pattern

Feature services never construct infrastructure. The bin builds adapters and injects them as `Arc<dyn Port>`. This is what keeps the graph acyclic and every service headless-testable.

```mermaid
flowchart LR
    classDef port fill:#1e3a5f,stroke:#4a90d9,color:#fff
    classDef adapter fill:#234d34,stroke:#4caf7d,color:#fff
    classDef svc fill:#4a3a1e,stroke:#d9a94a,color:#fff
    classDef root fill:#5f1e1e,stroke:#d94a4a,color:#fff

    BIN["nats-studio (composition root)<br/>builds adapters → injects ports → assembles AppState"]:::root

    subgraph Ports["Ports (traits) — defined in ns-core"]
        P1["NatsClient / JsContext / Subscription"]:::port
        P2["ClientProvider / JsContextResolver / NatsClientProvider"]:::port
        P3["SecretStore / AuditRepo / AuditSink"]:::port
        P4["*Repo ports (Profile, History, Layout, Settings, AlertRule,<br/>Schema, Favorite, TerminalHistory, LogView, PluginState, …)"]:::port
        P5["EventPublisher / Clock / SubszSource / SubjectPermissionSource /<br/>MonitorQuery / ConnectionQuery / JetStreamQuery / PeerCertProvider"]:::port
    end

    subgraph Adapters["Adapters (impls) — one heavyweight dep each"]
        A1["ns-nats (async-nats)"]:::adapter
        A2["ns-connection (registry)"]:::adapter
        A3["ns-security (keyring + vault)"]:::adapter
        A4["ns-storage (rusqlite)"]:::adapter
        A5["ns-event / ns-monitor / ns-telemetry"]:::adapter
    end

    subgraph Services["Services (consume ports)"]
        S["ns-pubsub · ns-jetstream · ns-monitor ·<br/>ns-subject · ns-terminal · ns-dashboard"]:::svc
    end

    A1 -. implements .-> P1
    A2 -. implements .-> P2
    A3 -. implements .-> P3
    A4 -. implements .-> P4
    A5 -. implements .-> P5

    BIN --> A1 & A2 & A3 & A4 & A5
    BIN -->|"inject Arc&lt;dyn Port&gt;"| S
    S -->|"call"| Ports
```

---

## 3. Runtime subsystem interaction

How a live connection's data flows from NATS to the WebView and back. The **`EventBridge` is the only bus→Tauri translator**; request-scoped streams use Tauri **Channels**; all commands cross the `ns-ipc` boundary.

```mermaid
flowchart TB
    classDef fe fill:#1e3a5f,stroke:#4a90d9,color:#fff
    classDef boundary fill:#4a1e3a,stroke:#d94a90,color:#fff
    classDef svc fill:#4a3a1e,stroke:#d9a94a,color:#fff
    classDef infra fill:#234d34,stroke:#4caf7d,color:#fff
    classDef ext fill:#333,stroke:#888,color:#fff

    subgraph FE["Frontend (React 18 WebView)"]
        RQ["TanStack Query cache<br/>(all server-state)"]:::fe
        ZU["Zustand<br/>(UI/session)"]:::fe
        HK["useAppEvents() / useStreamChannel()"]:::fe
        IPCC["ipc.* typed wrappers<br/>(packages/ns-bindings)"]:::fe
    end

    subgraph B["IPC boundary — ns-ipc + bin"]
        CMD["#[tauri::command] registry<br/>Result&lt;T, IpcError&gt;"]:::boundary
        CH["Tauri Channels<br/>(subscribe/replay/watch/tail/pty/export)"]:::boundary
        BR["EventBridge<br/>(coalesce · window-scope · gap-mark)"]:::boundary
    end

    subgraph SVC["Services (AppState registry of Arc&lt;dyn Service&gt;)"]
        CONN["ConnectionService"]:::svc
        FEAT["PubSub · JetStream · Monitor ·<br/>Subject · Terminal · Dashboard · Plugin"]:::svc
    end

    subgraph INF["Adapters & bus"]
        BUS["ns-event bus<br/>(broadcast + mpsc, monotonic seq)"]:::infra
        NAT["ns-nats (async-nats)"]:::infra
        STO["ns-storage / ns-security / ns-telemetry / ns-inspector"]:::infra
    end

    SERVER["NATS server(s)<br/>core · JetStream · HTTP monitor · $SYS/$SRV"]:::ext

    %% command path
    IPCC -->|invoke| CMD
    CMD --> CONN
    CMD --> FEAT
    CONN -->|resolve client| NAT
    FEAT -->|ports| NAT
    FEAT --> STO
    NAT <-->|TCP/TLS/WS| SERVER

    %% streaming path
    FEAT -->|bounded mpsc| CH
    CH -->|StreamEvent&lt;T&gt;| HK

    %% event path
    CONN -->|EventPublisher| BUS
    FEAT -->|EventPublisher| BUS
    BUS --> BR
    BR -->|ns:// emit_to window| HK

    %% fold into stores
    HK -->|setQueryData| RQ
    HK -->|slice update| ZU
    RQ --> IPCC
```

### 3.1 The two streaming mechanisms (ADR-0009)

| Mechanism | Used for | Lifecycle | Backpressure |
|---|---|---|---|
| **Tauri Channel** (`Channel<StreamEvent<T>>`) | Request-scoped streams tied to one call: subscribe, replay, KV/object watch, backup/restore/transfer, terminal PTY, log tail, subject sampling, export. | Bound to the initiating view; `*_cancel`/`*_unsubscribe` trips the token; Channel-drop watchdog cancels leaks. | Bounded buffer + per-stream policy (sample+count / preserve-order+overflow marker). |
| **Bridged Tauri event** (`ns://…`) | Ambient app-wide broadcasts many screens observe: connection status, metrics ticks, stream/consumer updates, notifications, plugin/security/dashboard signals. | App-lifetime; multiplexed through the single `EventBridge`. | Per-topic coalescing (keep-latest / dedupe / rate-limit / never-drop) in the bridge; `Lagged(n)` → synthetic gap event. |

---

## 4. Acyclicity invariants (CI-enforced)

1. **No upward edges.** A crate may depend only on strictly lower layers (plus `ns-types`/`ns-core`). The single allowed intra-tier composition is L3 `ns-dashboard` → L2 services.
2. **No L2 ↔ L2 edges.** Feature services communicate only through `ns-core` ports and `ns-types` DTOs, never by depending on each other.
3. **Single-import confinement.** `async-nats` only in `ns-nats`; SQL only in `ns-storage`; `keyring` only in `ns-security`; `reqwest` only in `ns-monitor`; `portable-pty` only in `ns-terminal`; `tauri` only in `ns-ipc` + the bin.
4. **Ports down, adapters up, wiring in the bin.** Trait definitions live in `ns-core`; implementations live in the adapter crates; the only `new_*()`/injection site is `nats-studio`.
5. **`ns-types` is frozen.** Additive-only; breaking changes require an ADR + `appSchemaVersion` bump (ADR-0006).
