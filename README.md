<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128.png" width="96" alt="NATS Studio" />

# NATS Studio

**The desktop GUI for [NATS](https://nats.io). Connect, publish, subscribe, and manage JetStream in one native app.**

[![CI](https://github.com/himanshu-systems/nats-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/himanshu-systems/nats-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-informational)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2%20%2B%20Rust%20%2B%20React-24C8A0)

### [🌐 Website](https://himanshu-systems.github.io/nats-studio/) · [⬇️ Download](https://github.com/himanshu-systems/nats-studio/releases/latest)

<!-- Add a 15s demo GIF (connect → Live Tail → Streams) at docs/media/demo.gif, then uncomment:
<img src="docs/media/demo.gif" width="820" alt="NATS Studio demo" />
-->

</div>

---

## What is it?

NATS Studio is a fast, native desktop app for working with [NATS](https://nats.io) and JetStream. It's similar to what RedisInsight is for Redis or pgAdmin is for Postgres. Instead of connecting a series of `nats` CLI commands, you get a live, clickable interface to check messages, browse streams, debug consumers, and monitor your server in real time.

It’s built with **Rust + Tauri v2** (small, secure, no Electron) and **React + TypeScript**. It comes as a single native binary for Windows, macOS, and Linux.

## Features

**Connections**
- Manage multiple connection profiles, including user/password and token. Credentials are stored in the OS keychain.
- Each connection is isolated. Every workspace is linked to the active connection, and the state is saved as you switch tabs.

**Overview**
- The dashboard features server identity, JetStream status, live round-trip latency, health checks, graphs of stored/processed data, a streams↔subjects map, and a table of connected clients.

**Messages**
- **Live Tail** allows you to subscribe to subjects and watch messages stream in real-time, with filtering for each subscription.
- **Publisher** offers templates with `{{uuid}}`, `{{seq}}`, and `{{timestamp}}` variables, JSON validation and formatting, hex/base64 bodies, headers, and burst mode.
- **Request-Reply** console.
- **Message Browser** lets you page through stored JetStream messages and inspect them.
- **Consumer Lab** enables you to pull-fetch a batch and debug ack/nak/term interactively.
- **Dead Letters** provides a live monitor for poison messages.
- **Multi-format payload viewer** supports JSON (pretty), Text, Hex dump, **Protobuf** (schema-less field decode), **MessagePack**, and Base64.

**JetStream**
- **Streams** lets you create, edit, delete, and purge streams (all, by subject, keep-N, up-to-seq) with inline help for every option.
- **Consumers** allow you to create durable pull consumers and check their config, pending, and ack state.
- **Key-Value** supports creating buckets and getting, putting, or deleting keys.
- **Object Store** enables creating buckets and listing, downloading, uploading, or deleting objects.

**Monitoring**
- **Metrics** gives you a live throughput dashboard (msgs & bytes/sec) from the server monitoring endpoint.
- **Services** include NATS micro-service discovery via `$SRV.PING`.

**Polish**
- Offers light and dark themes that match the NATS brand.
- Features searchable dropdowns, tooltips, smooth charts, and keyboard-friendly controls.

<!-- ## Screenshots — drop real PNGs into docs/media/, then uncomment:

| Overview | Live Tail | JetStream Streams |
| --- | --- | --- |
| ![overview](docs/media/overview.png) | ![live-tail](docs/media/live-tail.png) | ![streams](docs/media/streams.png) |
-->

## Install

### Download (recommended)
Download the latest installer for your OS from the [**Releases**](https://github.com/himanshu-systems/nats-studio/releases) page.

> Binaries are not yet code-signed, so Windows SmartScreen or macOS Gatekeeper might warn you on first launch. (More info → Run anyway or right-click → Open). Signing is planned for the future.

### Build from source
Prerequisites: [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), [pnpm](https://pnpm.io), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (WebView2 for Windows, `webkit2gtk` for Linux).

```bash
git clone https://github.com/himanshu-systems/nats-studio.git nats-studio
cd nats-studio
pnpm install
cd apps/desktop && pnpm tauri build   # or `pnpm tauri dev` to run locally
```

### Need a NATS server to try it?
A ready-to-use broker with JetStream and monitoring is included:

```bash
docker compose -f deploy/nats/docker-compose.yml up -d   # nats://127.0.0.1:4222
```

## Architecture

This is a layered Rust workspace that inverts dependencies (18 crates): typed wire contract (`ns-types`), domain ports (`ns-core`), adapters (`ns-nats`, `ns-storage`, `ns-security`, `ns-monitor`, …), services (`ns-pubsub`, `ns-jetstream`, `ns-connection`), and the Tauri binary as the sole composition root. Each major dependency is limited to one crate, and the front end communicates with the back end over a typed IPC surface generated from Rust via [typeshare](https://github.com/1Password/typeshare).

## Roadmap

Recently shipped:

- ✅ Auto-update with a signed update manifest
- ✅ Object Store streaming upload/download for large objects
- ✅ Dead Letters: redeliver and purge actions
- ✅ Services: per-endpoint stats and schema
- ✅ TLS and mTLS connection profiles in the UI

Planned:

- Code-signed installers (Apple Developer ID + Windows Authenticode)

Have an idea? Open an issue with what you'd like to see next.

## Contributing

Issues and pull requests are welcome. If you use NATS and discover something that's missing or doesn't work well, let me know. Your feedback will help shape future developments.

## Connect

- LinkedIn — [himanshuchavda](https://www.linkedin.com/in/himanshuchavda/)
- Email — himanshu.tech.profile@gmail.com

## License

[MIT](LICENSE) © Himanshu Chavda

<div align="center">
Not affiliated with Synadia or the NATS project. NATS is a trademark of its respective owner.
</div>
