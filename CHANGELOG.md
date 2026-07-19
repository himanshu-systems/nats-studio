# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/himanshu-systems/nats-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/himanshu-systems/nats-studio/releases/tag/v0.1.0
