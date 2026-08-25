# NATS Studio — the desktop GUI for NATS

A fast, native, cross-platform desktop GUI for [NATS](https://nats.io). Connect, publish and subscribe, and manage JetStream, Key-Value, and Object Store in one open-source app for Windows, macOS, and Linux. No CLI juggling, no browser tab.

- **License:** MIT — free forever, no account, no paid tier
- **Built with:** Rust + Tauri
- **Telemetry:** none
- **Download:** <https://github.com/himanshu-systems/nats-studio/releases/latest>
- **Source:** <https://github.com/himanshu-systems/nats-studio>

## Features

### Live Tail, with real filtering
Subscribe to any subject and watch messages stream in — each subscription filtered on its own tab, with instant search and a multi-format payload viewer (JSON, Protobuf, MessagePack, text, hex, base64). Reply to request messages by hand, including service-style error replies.

### Publish any format
Compose and send in the format your services speak — with reusable templates, `{{variables}}`, and burst mode.

### JetStream, visually
Create streams and consumers (pull or push), browse stored messages by sequence, purge and redeliver, and replay history from a specific sequence number or timestamp — no CLI.

### Key-Value and Object Store
Read and write buckets; stream large objects to and from disk with live progress.

### Secure by default
TLS and mTLS profiles, credentials stored in the OS keychain, and zero telemetry. Your data stays yours.

## Download

Installers for every platform are on the [releases page](https://github.com/himanshu-systems/nats-studio/releases/latest):

| Platform | Formats |
| --- | --- |
| Windows 10 / 11 | `.msi`, NSIS `.exe` setup |
| macOS (Apple Silicon & Intel) | `.dmg` |
| Linux | `.AppImage`, `.deb`, `.rpm` |

Builds aren't code-signed yet, so Windows SmartScreen / macOS Gatekeeper may warn on first launch (one-time). You'll need a NATS server to connect to; `nats-server -js` runs one locally.

## More

- [Documentation](https://nats.studio/docs/)
- [About](https://nats.studio/about/)
- [Contact](https://nats.studio/contact/)
- [Privacy](https://nats.studio/privacy/)
- [Agent guidance (llms.txt)](https://nats.studio/llms.txt)

---

© Himanshu Chavda · Built with Rust + Tauri · Not affiliated with Synadia or the NATS project. NATS is a trademark of its respective owner.
