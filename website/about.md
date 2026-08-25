# About NATS Studio

A free, open-source desktop client for NATS — built because working with a message broker shouldn't mean living in a terminal.

## What NATS Studio is

NATS Studio is a cross-platform desktop application for [NATS](https://nats.io), the open-source messaging system. It gives you a real graphical interface for the things developers do with NATS every day: opening connections, publishing and subscribing to subjects, inspecting message payloads, and managing JetStream streams, consumers, Key-Value buckets, and the Object Store.

It runs natively on Windows, macOS, and Linux. The backend is written in Rust and the interface is rendered through [Tauri](https://tauri.app), so the whole application ships as a single native binary — there is no Electron runtime, no local web server, and no browser tab.

The project exists because the alternative — juggling `nats` CLI invocations across several terminal windows while trying to reason about stream state — makes routine work harder than it needs to be. NATS Studio puts connection state, live message flow, and JetStream management in one window you can actually look at.

## What it does

- **Connections** — saved profiles with TLS and mTLS support; credentials are stored in the operating system keychain, never in plaintext configuration files.
- **Live Tail** — subscribe to any subject or wildcard and watch messages arrive in real time, each subscription filtered on its own tab, with a payload viewer that decodes JSON, Protobuf, MessagePack, text, hex, and base64.
- **Publisher and Request–Reply** — compose messages in any of those formats, with reusable templates, variable substitution, and burst sending.
- **JetStream** — create, edit, purge, and delete streams and consumers; browse stored messages by sequence; replay history from a specific sequence number or timestamp.
- **Key-Value and Object Store** — read and write buckets, and stream large objects to and from disk with live progress reporting.
- **Monitoring** — server health, throughput, and round-trip latency, read from the NATS monitoring endpoint.

## Who maintains it

NATS Studio is built and maintained by **Himanshu Chavda**, an independent software developer. It is a personal open-source project, not a commercial product, and it is not affiliated with Synadia or the official NATS project. NATS is a trademark of its respective owner.

Development happens in the open on GitHub. Issues and pull requests are welcome — if you use NATS and something is missing or does not work well, that feedback directly shapes what gets built next. You can reach the maintainer at <himanshu.tech.profile@gmail.com> or on [LinkedIn](https://www.linkedin.com/in/himanshuchavda/).

## License and cost

NATS Studio is released under the [MIT License](https://github.com/himanshu-systems/nats-studio/blob/main/LICENSE). It is free to download and free to use, for personal and commercial work alike, with no account, no license key, and no paid tier. The complete source code is published at <https://github.com/himanshu-systems/nats-studio>.

The application collects no telemetry and sends no analytics. It talks to the NATS servers you point it at, and to GitHub when checking for updates — nothing else.
