# Contributing to NATS Studio

Thanks for your interest! Bug reports, feature requests, and pull requests are all welcome.

## Ways to help

- **Report a bug** or **request a feature** — open an [issue](https://github.com/himanshu-systems/nats-studio/issues).
- **Discuss ideas** in [Discussions](https://github.com/himanshu-systems/nats-studio/discussions).
- **Send a pull request** — see below.

## Development setup

Prerequisites: [Rust](https://rustup.rs) (stable), [Node 22+](https://nodejs.org), [pnpm 9+](https://pnpm.io), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (WebView2 on Windows, `webkit2gtk` + friends on Linux — see the `libwebkit2gtk-4.1-dev …` list in `.github/workflows/ci.yml`).

```bash
git clone https://github.com/himanshu-systems/nats-studio.git
cd nats-studio
pnpm install

# Run the app in dev mode (hot reload):
cd apps/desktop && pnpm tauri dev

# Need a NATS server? A JetStream broker is included:
docker compose -f deploy/nats/docker-compose.yml up -d   # nats://127.0.0.1:4222
```

## Project layout

Layered, dependency-inverted Rust workspace + a React/TS frontend:

- `crates/ns-types` — the typed wire contract (source of truth; additive-only).
- `crates/ns-core` — domain ports (traits) and models.
- `crates/ns-*` — adapters (`ns-nats`, `ns-storage`, `ns-security`, `ns-monitor`) and services (`ns-pubsub`, `ns-jetstream`, `ns-connection`).
- `apps/desktop/src-tauri` — the Tauri binary (the only composition root).
- `apps/desktop/src` — the React frontend; `packages/ns-bindings` — the generated TS bindings.

**Rules the CI enforces** (`tools/xtask`): the crate graph is layered and acyclic, and each heavyweight dependency is confined to one crate (`async-nats` only in `ns-nats`, `reqwest` only in `ns-monitor`, etc.). If you change a DTO in `ns-types`, regenerate the TS bindings with `cargo xtask gen-types`.

## Before you open a PR

Please make sure these pass (the same checks CI runs):

```bash
cargo fmt --all
cargo xtask check-layers
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask gen-types && git diff --exit-code -- packages/ns-bindings/src/generated/types.ts
cd apps/desktop && pnpm build     # tsc + vite build
```

## Pull request guidelines

- Keep PRs focused; one feature/fix per PR.
- Match the surrounding code style; no new dependencies without discussion.
- Update docs/README if you change user-facing behavior.
- Describe what and why in the PR description; link the issue it closes.

## Commit messages

Conventional-style prefixes are appreciated (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), but clarity matters more than format.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
