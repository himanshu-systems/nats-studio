<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128.png" width="96" alt="NATS Studio" />

# NATS Studio

**The desktop GUI for [NATS](https://nats.io) — connect, publish, subscribe, and manage JetStream, all in one native app.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-informational)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2%20%2B%20Rust%20%2B%20React-24C8A0)

<!-- Replace with a real 15s demo GIF: connect → Live Tail → Streams -->
<img src="docs/media/demo.gif" width="820" alt="NATS Studio demo" />

</div>

---

## What is it?

NATS Studio is a fast, native desktop application for working with [NATS](https://nats.io) and JetStream — the kind of tool RedisInsight is for Redis or pgAdmin is for Postgres. Instead of stringing together `nats` CLI commands, you get a live, clickable UI to inspect messages, browse streams, debug consumers, and watch your server in real time.

Built with **Rust + Tauri v2** (tiny, secure, no Electron) and **React + TypeScript**. Ships as a single native binary for Windows, macOS, and Linux.

## Features

**Connections**
- Manage multiple connection profiles (user/password, token, and more); credentials stored in the OS keychain.
- Per-connection isolation — every workspace is scoped to the active connection, and state is preserved as you switch tabs.

**Overview**
- Server identity, JetStream status, live round-trip latency, health checks, data stored/processed graphs, streams↔subjects map, and connected-client table — one dashboard.

**Messages**
- **Live Tail** — subscribe to subjects and watch messages stream in live, with per-subscription filtering.
- **Publisher** — templates with `{{uuid}}`/`{{seq}}`/`{{timestamp}}` variables, JSON validate + prettify, hex/base64 bodies, headers, and burst mode.
- **Request–Reply** console.
- **Message Browser** — page through stored JetStream messages and inspect them.
- **Consumer Lab** — pull-fetch a batch and debug ack / nak / term interactively.
- **Dead Letters** — live poison-message advisory monitor.
- **Multi-format payload viewer** — JSON (pretty), Text, Hex dump, **Protobuf** (schema-less field decode), **MessagePack**, and Base64.

**JetStream**
- **Streams** — create / edit / delete / purge (all, by-subject, keep-N, up-to-seq), with inline help on every option.
- **Consumers** — create durable pull consumers and inspect config/pending/ack state.
- **Key-Value** — create buckets, get / put / delete keys.
- **Object Store** — create buckets, list / download / upload / delete objects.

**Monitoring**
- **Metrics** — live throughput dashboard (msgs & bytes / sec) from the server monitoring endpoint.
- **Services** — NATS micro-service discovery via `$SRV.PING`.

**Polish**
- Light **and** dark themes on the NATS brand.
- Searchable dropdowns, tooltips, smooth charts, keyboard-friendly.

## Screenshots

| Overview | Live Tail | JetStream Streams |
| --- | --- | --- |
| ![overview](docs/media/overview.png) | ![live-tail](docs/media/live-tail.png) | ![streams](docs/media/streams.png) |

## Install

### Download (recommended)
Grab the latest installer for your OS from the [**Releases**](https://github.com/himanshu-systems/nats-studio/releases) page.

> Binaries are not yet code-signed, so Windows SmartScreen / macOS Gatekeeper may warn on first launch (More info → Run anyway / right-click → Open). Signing is on the roadmap.

### Build from source
Prerequisites: [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), [pnpm](https://pnpm.io), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (WebView2 on Windows, `webkit2gtk` on Linux).

```bash
git clone https://github.com/himanshu-systems/nats-studio.git nats-studio
cd nats-studio
pnpm install
cd apps/desktop && pnpm tauri build   # or `pnpm tauri dev` to run locally
```

### Need a NATS server to try it?
A ready-to-run broker with JetStream + monitoring is included:

```bash
docker compose -f deploy/nats/docker-compose.yml up -d   # nats://127.0.0.1:4222
```

## Architecture

A layered, dependency-inverted Rust workspace (18 crates): typed wire contract (`ns-types`) → domain ports (`ns-core`) → adapters (`ns-nats`, `ns-storage`, `ns-security`, `ns-monitor`, …) → services (`ns-pubsub`, `ns-jetstream`, `ns-connection`) → the Tauri binary as the single composition root. Each heavyweight dependency is confined to one crate; the frontend talks to the backend over a typed IPC surface generated from Rust via [typeshare](https://github.com/1Password/typeshare).

## Roadmap

- Code-signed installers + auto-update
- Object Store streaming upload/download for large objects
- Dead Letters: redeliver / purge actions
- Services: per-endpoint stats & schema
- TLS / mTLS connection profiles in the UI

## Contributing

Issues and PRs welcome. If you use NATS and something's missing or awkward, tell me — that feedback shapes what gets built next.

## License

[MIT](LICENSE) © Himanshu Chavda

<div align="center">
Not affiliated with Synadia or the NATS project. NATS is a trademark of its respective owner.
</div>
