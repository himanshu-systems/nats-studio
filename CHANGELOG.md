# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Every split view is resizable: drag the divider between the panes in Live
  Tail, Sessions, Message Browser, Publisher, Request/Reply, Streams,
  Consumers, Key-Value, Object Store, and Connections. The nav sidebar
  resizes from its right edge. Dividers are keyboard-operable
  (`role="separator"`, arrow keys, Shift for a larger step, Home/End for the
  bounds, Enter or double-click to reset) and each position is remembered per
  view.
- Consumer Lab and the consumer list link straight to Live Tail with a push
  consumer's deliver subject pre-filled.
- Services scans on open instead of waiting for a Discover click, and its
  empty state explains that only micro-framework services register on `$SRV`.

### Fixed
- **Streams, Consumers, Consumer Lab, Message Browser, Key-Value and Object
  Store showed data only intermittently.** Visited views stay mounted, so
  these lists fetched once and never refreshed: a list loaded before
  JetStream was ready, during a reconnect, or after a single transient IPC
  error stayed empty or errored for the rest of the session, and resources
  created elsewhere never appeared. They now poll, which also lets a one-off
  failure recover on its own.
- **The Services page reported "no services responded" while services were
  running.** Opening a subscription returned before the SUB reached the
  server, so the `$SRV.PING` published immediately afterwards could overtake
  it and the replies went nowhere. Subscriptions are now flushed before the
  caller gets a handle, which fixes the race for every subscriber.
- Consumer Lab explains that push consumers deliver to a subject rather than
  being fetched, instead of reading as a broken page.

### Changed
- Website: published `llms.txt` (including when NATS Studio is and isn't the
  right recommendation), JSON-LD identity, `sitemap.xml`, `robots.txt`, a
  markdown twin of every page, plus real `/about`, `/contact`, `/privacy`,
  and `/docs` pages and an agent-friendly 404.

## [0.3.0] - 2026-07-26

### Added
- Push consumers as well as pull, and a deliver policy that can replay from a
  specific stream sequence or timestamp.
- Manual reply panel in Live Tail — answer a request by hand, including
  service-style error replies (`Nats-Service-Error`).
- Saved Requests: reusable publish and request templates with variables,
  usable from the Publisher and Request/Reply forms.
- Save & Replay message sessions — record live traffic to JSON and replay it
  at 1×–5× speed.
- Export message history as JSON or CSV from Live Tail and Message Browser.
- Jump straight to a sequence number in Message Browser.
- Warning when a consumer's filter subject doesn't overlap its stream's
  subjects (it would create fine but never receive anything), and a hard
  block when a push consumer's deliver subject would form a delivery cycle.
- Heads-up when a new connection profile points at a server an existing
  profile already uses.
- First frontend test suite (vitest + Testing Library).

### Fixed
- Session Recorder: captured messages appear while recording rather than only
  after Stop; Save/Load no longer restart the recording (both buttons
  submitted the surrounding form); guards against a double-click on Start.
- Export and Save now confirm what they wrote — a Tauri window has no
  download bar, so a successful save previously gave no feedback at all.
- Consumer Lab messages start collapsed with a preview and expand on click.

## [0.2.1] - 2026-07-25

### Fixed
- App and website icons rendered with transparent backgrounds, and the
  Windows installer shipped without an icon.
- `xtask` parsed TOML manifests through `FromStr`, which broke against
  toml 1.1.
- Release workflow pinned to a Rust toolchain version that does not exist.
- Reverted a frontend dependency bump that broke the build.

## [0.2.0] - 2026-07-25

### Added
- Object Store streaming upload and download with live progress.
- Dead Letter redeliver and purge actions.
- Services page: per-endpoint stats and schema.
- TLS and mTLS configuration in the connection UI, and auto-update.
- Consumers list spanning every stream, optionally grouped by filter subject.
- Monitoring URL moved into the connection profile, so it is set once.
- MessagePack and Protobuf publish formats; published messages carry a
  `Content-Type` header.
- Landing page on GitHub Pages.

### Fixed
- `window.confirm` does not reliably block in a Tauri webview, so every
  destructive action now uses a real modal that names its consequences.
- The app's own polling inflated the Overview throughput charts.
- Feature views did not fill the window width.
- Work Queue stream rejections are explained and prevented up front.
- rustls ring crypto provider is installed at startup.

## [0.1.0] - 2026-07-19

First public release.

### Added
- Connection manager with credentials stored in the OS keychain.
- Live Tail with per-subscription filtering and a multi-format payload viewer
  (JSON, Text, Hex, Protobuf, MessagePack, Base64).
- Publisher with body-format conversion and burst publishing.
- Request/Reply, Subject Browser, and Consumer Lab.
- JetStream: streams, consumers, Key-Value, and Object Store — including
  create/upload from the UI.
- Dead Letter monitor via JetStream advisory subscriptions.
- Monitoring dashboard: server info, health, RTT, and throughput charts.
- State persistence across tabs (visited views stay live).
- Cross-platform installers (Windows `.msi`/`.exe`, macOS `.dmg`, Linux
  `.AppImage`/`.deb`) built per-OS in CI.

[Unreleased]: https://github.com/himanshu-systems/nats-studio/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/himanshu-systems/nats-studio/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/himanshu-systems/nats-studio/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/himanshu-systems/nats-studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/himanshu-systems/nats-studio/releases/tag/v0.1.0
