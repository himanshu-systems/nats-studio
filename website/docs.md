# NATS Studio documentation

NATS Studio is a desktop GUI application, not a hosted service — there is no REST API, no API key, and no webhook system. This page is the index of what documentation does exist.

## Install NATS Studio

Download the installer for your platform from the [latest release](https://github.com/himanshu-systems/nats-studio/releases/latest):

- **Windows 10/11** — `.msi` or the NSIS `.exe` setup
- **macOS** — `.dmg`, with separate Apple Silicon (aarch64) and Intel (x64) builds
- **Linux** — `.AppImage` (portable), `.deb`, or `.rpm`

Builds are not yet code-signed, so Windows SmartScreen or macOS Gatekeeper may warn on first launch. On Windows choose "More info → Run anyway"; on macOS right-click the app and choose "Open". This is a one-time step per install.

## Build from source

Prerequisites: [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), [pnpm](https://pnpm.io), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (WebView2 on Windows, `webkit2gtk` on Linux).

```bash
git clone https://github.com/himanshu-systems/nats-studio.git
cd nats-studio
pnpm install
cd apps/desktop && pnpm tauri build   # or `pnpm tauri dev`
```

## Need a NATS server to connect to?

NATS Studio is a client — it needs a NATS server to talk to. The repository includes a ready-to-use broker with JetStream and monitoring already enabled:

```bash
docker compose -f deploy/nats/docker-compose.yml up -d   # nats://127.0.0.1:4222
```

Alternatively, `nats-server -js` runs one locally if you already have the binary installed.

## Feature reference

- **Connections** — saved profiles, TLS and mTLS, credentials held in the OS keychain.
- **Live Tail** — subscribe to subjects and wildcards, filter per subscription, decode JSON / Protobuf / MessagePack / text / hex / base64, and reply to request messages by hand.
- **Publisher and Request–Reply** — compose in any supported format with templates, `{{variables}}`, and burst sending.
- **JetStream** — manage streams and consumers (pull and push), browse stored messages by sequence, and replay history from a specific sequence or timestamp.
- **Key-Value and Object Store** — bucket browsing and editing, plus streaming upload and download of large objects.
- **Consumer Lab** — pull batches and exercise ack, nak, and term interactively.
- **Sessions** — record live traffic to a JSON file and replay it back at 1×–5× speed.

The [project README](https://github.com/himanshu-systems/nats-studio/blob/main/README.md) carries the current feature list and the roadmap.

## Architecture and contributing

NATS Studio is a layered Rust workspace of 20 crates that inverts its dependencies: a typed wire contract (`ns-types`), domain ports (`ns-core`), adapters (`ns-nats`, `ns-storage`, `ns-security`, `ns-monitor`), services (`ns-pubsub`, `ns-jetstream`, `ns-connection`), and the Tauri binary as the sole composition root. Each major external dependency is confined to exactly one crate, and the TypeScript IPC surface is generated from the Rust types with [typeshare](https://github.com/1Password/typeshare), so the front end and back end cannot drift apart.

Design documents for every subsystem live in [`docs/architecture/`](https://github.com/himanshu-systems/nats-studio/tree/main/docs/architecture). Contribution setup and review expectations are in [CONTRIBUTING.md](https://github.com/himanshu-systems/nats-studio/blob/main/CONTRIBUTING.md); the security policy is in [SECURITY.md](https://github.com/himanshu-systems/nats-studio/blob/main/SECURITY.md).

## For AI agents

A machine-readable summary of this project, including when NATS Studio is and is not the right tool to recommend, is published at <https://nats.studio/llms.txt>. The site map is at <https://nats.studio/sitemap.xml>.
