# Cross-Cutting Strategy — `[deployment-strategy]`

> Document ID: `arch/xc-deployment-strategy`
> Status: **ACCEPTED — Cross-Cutting Contract (v1.0)**
> Owner: Deployment Strategist (release engineering lead; holder of signing key custody).
> Audience: All 14 subsystem teams + 4 peer strategists.
> Rule: This document is subordinate to `docs/architecture/00-conventions-and-workspace.md` (the spine) and must never contradict it. Where the spine fixes a name (`nats-studio`, `ns-types`, `cargo xtask`, `tools/versions.toml`, `appSchemaVersion`, `ns-telemetry`, `NS_DISABLE_UPDATER`), this document reuses it verbatim. Deviations require an ADR.

---

## 0. Scope & non-negotiables

This strategy owns everything between a green `main` commit and a signed, notarized, auto-updatable artifact on a user's machine, plus the opt-in diagnostics that flow back. Concretely:

1. **Bundling** the single `nats-studio` binary + WebView assets into per-OS installers (Windows MSI/NSIS, macOS `.app`/`.dmg`, Linux AppImage/deb/rpm) via Tauri v2's bundler.
2. **Code signing & notarization** on all three platforms with hardware-backed key custody.
3. **Auto-update** through the Tauri v2 updater with signed `latest.json` manifests, across **stable / beta / nightly** channels.
4. **Versioning & changelog** — one SemVer source of truth, synced by `cargo xtask sync-version`, tied to `appSchemaVersion` and the plugin-API version.
5. **CI/CD** — a reproducible GitHub Actions build → sign → notarize → publish pipeline with SBOM and provenance.
6. **Opt-in telemetry & crash reporting** design, wired to `ns-telemetry`, privacy-preserving by default (ADR-0019).

**Non-negotiables inherited from the spine:**
- Toolchain is **pinned stable** (`rust-toolchain.toml`, `channel = "1.89.0"`, never nightly 1.97 — ADR-0016). All external tool versions live in `tools/versions.toml`.
- **No secrets in any config file or artifact** (config_conventions). Signing keys never touch the repo or a developer laptop; they live only in CI secret stores / HSM.
- **Telemetry is opt-in only** (ADR-0019); default build ships with analytics off.
- `cargo xtask` is the canonical automation entry point; the CI pipeline calls xtask subcommands, never bespoke shell.

---

## 1. Target matrix, budgets & prerequisites

### 1.1 Platform / artifact matrix

| OS | Arch | Bundle formats | Signing | Update artifact |
|----|------|----------------|---------|-----------------|
| Windows 10/11 | x86_64, aarch64 | NSIS (`.exe`, primary), MSI (`.msi`, enterprise/GPO) | Authenticode (EV cert, HSM) | NSIS `-setup.exe` + `.sig` |
| macOS 12+ | x86_64, aarch64 (universal `.app`) | `.app` inside `.dmg`, plus `.app.tar.gz` for updater | Developer ID Application + notarization + stapling, hardened runtime | `.app.tar.gz` + `.sig` |
| Linux | x86_64, aarch64 | AppImage (primary, self-updating), `.deb`, `.rpm` | GPG detached sig on repo metadata; AppImage embedded sig | AppImage + `.sig` |

Rationale for choices per platform:
- **Windows: NSIS primary, MSI secondary.** NSIS gives per-user install (no admin), smaller footprint, and clean updater integration; MSI is shipped in parallel for enterprises that deploy via Intune/SCCM/GPO. Both are Tauri v2 first-class targets.
- **macOS: universal binary** (`lipo` of x86_64 + aarch64) inside a `.dmg`; the updater consumes the `.app.tar.gz`. Notarization + stapling is mandatory or Gatekeeper blocks first launch.
- **Linux: AppImage primary** because it is the only format the Tauri updater can self-replace; `.deb`/`.rpm` are provided for package-manager users but auto-update is delegated to the distro repo (see §4.6).

### 1.2 Size, startup & build budgets

| Budget | Target | Hard ceiling | Enforced by |
|--------|--------|--------------|-------------|
| Installer size (compressed) | ≤ 12 MB | 20 MB | CI size-gate step (fails PR) |
| Installed on-disk | ≤ 40 MB | 60 MB | CI size-gate |
| Cold startup to interactive | ≤ 800 ms | 1500 ms | perf-strategy smoke (shared budget) |
| Updater manifest fetch + verify | ≤ 500 ms | 2 s | integration test |
| CI full release build (per OS) | ≤ 25 min | 45 min | pipeline timeout |
| SBOM + advisory scan | ≤ 3 min | 8 min | `cargo-deny` + `cargo-cyclonedx` |

Size is a real Tauri advantage over Electron (ADR-0002) and we protect it: `opt-level = "z"` is rejected in favor of `"s"` + LTO (§3.3) to keep startup fast; the WebView bundle is Vite-tree-shaken and Brotli-precompressed; `strip = true` on release.

### 1.3 Prerequisites (documented, pinned in `tools/versions.toml`)

The spine flags these as MISSING on dev machines; this strategy owns pinning and CI provisioning:

```toml
# tools/versions.toml  (single source for tool versions; xtask verify-tools checks these)
[tools]
cargo-tauri      = "2.x"     # tauri-cli, drives bundling
nats-server      = "2.10.x"  # integration/e2e fixtures (ns-testkit)
nats             = "0.1.x"   # nats CLI (ns-terminal + e2e)
typeshare-cli    = "1.x"     # Rust->TS gen (ADR-0005)
cargo-deny       = "0.16.x"  # licenses/bans/advisories/SBOM (deny.toml)
cargo-cyclonedx  = "0.5.x"   # CycloneDX SBOM emit
cargo-about      = "0.6.x"   # third-party license bundle for installers
cargo-llvm-cov   = "0.6.x"   # coverage (shared w/ testing-strategy)
```

`cargo xtask verify-tools` reads this file, checks each tool's `--version`, and fails fast with an actionable message. CI runs it as the first job step so a drifted runner never produces an unreproducible build.

---

## 2. Versioning, changelog & schema contracts

### 2.1 Single version source of truth

App version is **SemVer**, defined **once** in the workspace `version` under root `Cargo.toml`. `cargo xtask sync-version` propagates it to:

- `apps/desktop/src-tauri/tauri.conf.json` → `version`
- `apps/desktop/src/package.json` and root `package.json` → `version`
- `packages/ns-bindings/package.json` → `version`

CI runs `cargo xtask sync-version --check` (dry-run) and fails if any file drifts. Git tags are `vX.Y.Z`; the tag is the release trigger.

```rust
// tools/xtask/src/commands/sync_version.rs  (signature)
pub fn sync_version(check_only: bool) -> anyhow::Result<()>;
//  - reads workspace.package.version from root Cargo.toml
//  - rewrites tauri.conf.json / package.json version fields
//  - --check => compares only, non-zero exit on drift (CI gate)
```

### 2.2 Three independent version axes (do not conflate)

| Axis | Source | Bump rule | Gate |
|------|--------|-----------|------|
| **App version** | root `Cargo.toml` `version` | product SemVer; tag `vX.Y.Z` | sync-version --check |
| **IPC/DTO schema** (`appSchemaVersion`) | constant in `ns-types` | bump on any breaking DTO change (ADR-0006) | `pnpm gen:types` + `git diff --exit-code` |
| **Plugin API** (`plugin_api`) | `ns-plugin` const | independent SemVer; major bump = breaking (ADR-0014) | manifest min/maxApi compat test |

`app_info` returns all three so a running client and its plugins can negotiate compatibility. A **release cannot ship** if `appSchemaVersion` changed without an ADR referenced in the changelog.

### 2.3 Changelog & release notes

- **`CHANGELOG.md`** follows Keep-a-Changelog; entries are grouped Added/Changed/Fixed/Security.
- Enforced by **Conventional Commits** on PR titles (CI lint) → `git-cliff` generates the release-notes body from the commit range between the previous tag and the new tag.
- The generated notes are attached to the GitHub Release **and** embedded into the updater manifest `notes` field so the in-app "Update available" dialog shows them.
- Any commit touching `ns-types` DTOs, migrations (`crates/ns-storage/migrations/`), or `plugin_api` must include a `BREAKING CHANGE:` footer, which git-cliff surfaces under a **Migration** heading.

### 2.4 Release channels

Three channels, each a distinct updater endpoint and cosign identity scope:

| Channel | Trigger | Audience | Cadence | Updater endpoint |
|---------|---------|----------|---------|------------------|
| **stable** | tag `vX.Y.Z` (no prerelease) | all users (default) | ~monthly | `/stable/{target}/latest.json` |
| **beta** | tag `vX.Y.Z-beta.N` | opt-in testers | ~weekly | `/beta/{target}/latest.json` |
| **nightly** | scheduled `main` build | internal / power users | nightly cron | `/nightly/{target}/latest.json` |

The active channel is an **app setting** (`settings.update.channel`, persisted via `SettingsRepo`), read by the updater at check time to pick the endpoint. Downgrade across channels is blocked unless the user explicitly opts to switch and reinstall.

---

## 3. Bundling (Tauri v2) per OS

### 3.1 Composition root & bundle inputs

The bundled binary is the single `nats-studio` (L4 bin, `apps/desktop/src-tauri`). The build has two halves stitched by `cargo tauri build`:

1. **Frontend**: `pnpm --filter desktop build` → Vite emits `dist/` (tree-shaken, code-split, Brotli-precompressed). `beforeBuildCommand` in `tauri.conf.json` runs `pnpm gen:types` first so bindings can never be stale in a shipped build.
2. **Backend**: `cargo build --release` of the bin, which statically links every `ns-*` crate. `rustls` is the default TLS (ADR-0004) so there is **no OpenSSL system dependency** — critical for reproducible, portable Linux artifacts.

```jsonc
// apps/desktop/src-tauri/tauri.conf.json  (bundle-relevant excerpt)
{
  "productName": "NATS Studio",
  "version": "0.0.0",                    // overwritten by xtask sync-version
  "identifier": "ai.usevelo.nats-studio",
  "build": {
    "beforeBuildCommand": "pnpm gen:types && pnpm --filter desktop build",
    "frontendDist": "../src/dist"
  },
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi", "app", "dmg", "appimage", "deb", "rpm"],
    "resources": ["licenses/THIRD_PARTY.html"],   // cargo-about output
    "windows": { "nsis": { "installMode": "perUser" }, "webviewInstallMode": { "type": "downloadBootstrapper" } },
    "macOS": { "minimumSystemVersion": "12.0", "hardenedRuntime": true, "entitlements": "entitlements.plist" },
    "linux": { "appimage": { "bundleMediaFramework": false } }
  }
}
```

### 3.2 Windows

- **Formats**: NSIS (`installMode: perUser`, no admin) as primary; MSI via WiX for enterprise GPO/Intune. Both emit from one `cargo tauri build --bundles nsis,msi`.
- **WebView2**: `downloadBootstrapper` mode — the tiny installer pulls the Evergreen WebView2 runtime if absent (present on all supported Win11 and patched Win10). Avoids embedding ~150 MB.
- **Signing**: Authenticode with an **EV code-signing certificate** stored in an HSM / cloud KMS (Azure Trusted Signing or DigiCert KeyLocker). Signing is invoked by Tauri's `signCommand` hook so both the `.exe` payload and the installer are signed. EV cert gives immediate SmartScreen reputation.
- **Failure mode**: unsigned or standard-cert builds trigger SmartScreen "unknown publisher" → treated as a **release blocker**; CI verifies signature (`signtool verify /pa`) before publish.

### 3.3 macOS

- **Universal binary**: build both `aarch64-apple-darwin` and `x86_64-apple-darwin`, `lipo` into one `.app`; wrap in a `.dmg`.
- **Hardened runtime + entitlements**: `hardenedRuntime: true`; entitlements limited to what the app needs (network client, JIT off). Keychain access (ns-security, ADR-0013) requires `keychain-access-groups`.
- **Signing → notarization → stapling** (mandatory, in order):
  1. `codesign --deep --options runtime` with **Developer ID Application** cert (from CI keychain, imported from a base64 secret).
  2. `xcrun notarytool submit --wait` to Apple.
  3. `xcrun stapler staple` the `.dmg` and the `.app` so first launch works offline.
- **Failure mode**: skipping notarization → Gatekeeper hard-blocks with no override on modern macOS. CI runs `spctl -a -vvv` assessment as a gate.

### 3.4 Linux

- **AppImage primary** (updater-capable), plus `.deb` and `.rpm`.
- **Reproducibility risks**: build inside a pinned old-glibc container (e.g. Ubuntu 22.04 base) so the AppImage runs on a wide range of distros; forbid dynamic linking to system OpenSSL by using `rustls`. GTK/WebKitGTK versions are pinned in the build image.
- **Signing**: GPG-sign the release repo metadata and detached-sign each artifact; the AppImage carries the Tauri updater signature (`.sig`) for self-update.
- **Failure mode**: glibc-too-new is the classic AppImage break — mitigated by the old-base build container and a smoke launch on a minimal distro image in CI.

### 3.5 Every subsystem's bundling obligations

Deployment is cross-cutting; each crate/team must comply:

- **`ns-terminal`, `ns-testkit`**: the `nats`/`nats-server` binaries are **runtime/test prerequisites, never bundled**. `ns-terminal` must resolve the `nats` CLI via PATH/setting and surface `TERMINAL_SPAWN_FAILED` gracefully when absent (ADR-0017) — the installer does not ship it.
- **`ns-storage`**: uses `rusqlite` **bundled** feature (ADR-0003) → SQLite is statically linked, zero system dep, reproducible. No migration file may be omitted from the binary (`include_dir!`/embedded migrations).
- **`ns-security`**: `keyring` links platform keychains dynamically — CI must confirm the linked frameworks (Security.framework, libsecret, wincred) are present on the target base images; the encrypted-fallback path (ADR-0013) must compile with no system crypto lib.
- **All L1/L2 crates**: no crate may add a dependency that pulls `openssl-sys` unless behind the `native-tls` feature (ADR-0004); `cargo-deny` bans it by default (§6.4).
- **`ns-bindings` / frontend**: all assets inlined or bundled; the strict CSP in `tauri.conf.json` forbids remote asset loads, so no team may reference a CDN. Vite build must produce a self-contained `dist/`.
- **`ns-plugin`**: Phase-1 plugins are compiled-in; they inherit the app's signature. Phase-2 WASM plugins (ADR-0014) are **not** bundled and are covered by a separate plugin-distribution ADR.

### 3.6 Release profile (root `Cargo.toml`)

```toml
[profile.release]
opt-level = "s"       # size-leaning but keeps startup fast (not "z")
lto = "thin"          # cross-crate inlining, faster than "fat" builds, near-same size
codegen-units = 1     # better optimization; CI build time budget absorbs it
strip = true          # strip symbols from shipped binary
panic = "abort"       # smaller, no unwind tables; panics in commands are caught at bridge first
```

`panic = "abort"` is safe because `ns-ipc` catches command panics at the bridge and converts to `ErrorCode::INTERNAL` before they can unwind past the boundary (error_model); the crash-reporter (§7) still captures the abort.

---

## 4. Auto-update (Tauri v2 updater)

### 4.1 Mechanism

The bin registers `tauri-plugin-updater` (v2). The updater periodically (and on-demand from the About screen) fetches the channel-scoped `latest.json`, verifies its **minisign/ed25519 signature** against the public key baked into `tauri.conf.json`, compares versions, downloads the platform artifact, verifies the artifact signature, then installs and relaunches.

```jsonc
// tauri.conf.json  (updater plugin config)
"plugins": {
  "updater": {
    "active": true,
    "dangerousInsecureTransportProtocol": false,
    "pubkey": "<minisign-ed25519-public-key>",       // private key only in CI HSM
    "endpoints": [
      "https://updates.usevelo.ai/nats-studio/{{channel}}/{{target}}/{{arch}}/latest.json"
    ],
    "windows": { "installMode": "passive" }
  }
}
```

`{{channel}}` is templated by the app from `settings.update.channel`.

### 4.2 Signed manifest (`latest.json`)

```jsonc
{
  "version": "1.4.0",
  "notes": "…git-cliff generated release notes…",
  "pub_date": "2026-07-04T10:00:00Z",
  "platforms": {
    "darwin-universal": { "signature": "<minisign sig of .app.tar.gz>", "url": "https://…/NATS-Studio_1.4.0_universal.app.tar.gz" },
    "windows-x86_64":   { "signature": "<sig>", "url": "https://…/NATS-Studio_1.4.0_x64-setup.exe" },
    "linux-x86_64":     { "signature": "<sig>", "url": "https://…/nats-studio_1.4.0_amd64.AppImage" }
  }
}
```

The signing **private key** (minisign/ed25519) is a CI secret, never on a laptop; `TAURI_SIGNING_PRIVATE_KEY` + password are injected at publish time only. The public key in `tauri.conf.json` is the trust anchor — rotating it is a breaking release requiring a manual bridge build.

### 4.3 Update flow, backpressure & UX

- The **check** is a background task in the `TaskRegistry` with a `CancellationToken` — it never blocks the UI thread (state_model / ADR-0018). Progress (download %) is surfaced via the internal event bus → bridged `ns://task/progress` (TaskProgress, keep-latest per task id) → `ns://notification` when ready.
- The user is **never force-updated**: "Restart to update" is an explicit action. Nightly/beta may auto-download but still require user consent to relaunch.
- **Delta/differential updates** are out of scope for v1 (full-artifact replace); tracked as a future ADR.

### 4.4 Rollback & staged rollout

- **Staged rollout**: `latest.json` can carry a `rollout` fraction; the client hashes its install-id and only self-selects if under the fraction. Lets us canary a release to 5% → 100%.
- **Rollback**: publishing is atomic per channel by swapping the `latest.json` pointer; a bad release is reverted by re-pointing `latest.json` to the prior version (the prior artifacts are never deleted). Clients that already updated are covered by the next hotfix, not downgrade (downgrades are refused to protect the SQLite schema — forward-only migrations, ADR-0003).

### 4.5 Failure modes

| Failure | Detection | Handling |
|---------|-----------|----------|
| Manifest signature invalid | updater verify | abort, no download, `PLUGIN`/updater error surfaced as notification, log at warn |
| Artifact hash/sig mismatch | post-download verify | discard, retry once, then surface actionable error |
| Endpoint unreachable | reqwest timeout | silent retry with backoff; never nags; `MONITOR_UNREACHABLE`-style typed error only in logs |
| Partial download / disk full | IO error | clean temp, keep current install intact |
| Schema-incompatible downgrade attempt | version compare | refused |
| `NS_DISABLE_UPDATER=1` (dev/enterprise) | env at startup | updater not registered at all |

### 4.6 Linux package-manager path

`.deb`/`.rpm` users do **not** use the Tauri updater. We publish an APT and a YUM/DNF repo (GPG-signed metadata); update is `apt upgrade` / `dnf upgrade`. The in-app updater detects it is running from a distro package (not AppImage) and disables self-update, showing "managed by your package manager".

---

## 5. CI/CD pipeline (GitHub Actions)

### 5.1 Pipeline topology

```
 PR / push ──► ci.yml         (lint, layer-check, gen-types drift, tests, size-gate, deny)
 tag vX.Y.Z ─► release.yml    (matrix build ─► sign ─► notarize ─► SBOM ─► publish ─► manifest)
 nightly cron ► nightly.yml   (build main on nightly channel, no notarization gate blocking)
```

### 5.2 `ci.yml` (every PR — must be green to merge)

Jobs (fail-fast, cached):
1. `verify-tools` — `cargo xtask verify-tools` (versions.toml).
2. `fmt` — `cargo fmt --check`.
3. `clippy` — `cargo clippy --all-targets --all-features -D warnings`.
4. `check-layers` — `cargo xtask check-layers` (enforces the L0→L4 DAG, no cycles — ADR-0007).
5. `gen-types-drift` — `pnpm gen:types && git diff --exit-code` (ADR-0005/0006).
6. `sync-version-check` — `cargo xtask sync-version --check`.
7. `test` — unit + integration (`ns-testkit` embedded `nats-server`), coverage via `cargo-llvm-cov` (owned by testing-strategy; deployment consumes the gate).
8. `deny` — `cargo deny check` (licenses/bans/advisories — §6.4).
9. `size-gate` — dry bundle on Linux, assert installer ≤ budget (§1.2).

### 5.3 `release.yml` (tag-triggered)

Matrix over `{windows-latest, macos-14 (arm), ubuntu-22.04}`; macOS builds the universal binary. Steps per runner:

```yaml
# .github/workflows/release.yml  (essential shape)
permissions:
  contents: write        # create release
  id-token: write        # OIDC for keyless cosign / KMS
jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: macos-14,     target: universal-apple-darwin }
          - { os: windows-2022, target: x86_64-pc-windows-msvc }
          - { os: ubuntu-22.04, target: x86_64-unknown-linux-gnu }
    steps:
      - uses: actions/checkout@… (pinned by SHA)
      - run: rustup show                       # honors rust-toolchain.toml (1.89.0)
      - uses: swatinem/rust-cache@…            # sccache/registry cache, keyed by lockfile
      - run: cargo xtask verify-tools
      - run: pnpm install --frozen-lockfile
      - run: cargo xtask sync-version
      - uses: tauri-apps/tauri-action@…        # runs beforeBuildCommand + bundles + updater sign
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_UPDATER_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_UPDATER_KEY_PW }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERT_P12_B64 }}
          APPLE_ID / APPLE_TEAM_ID / APPLE_PASSWORD: ${{ secrets.* }}   # notarization
          WINDOWS_SIGN: azure-trusted-signing  # signCommand hook -> HSM
      - run: cargo cyclonedx --format json      # SBOM per artifact
      - run: <upload artifacts + SBOM to release>
  publish-manifest:
    needs: build
    steps:
      - run: cargo xtask build-manifest --channel ${{ needs.channel }}   # assemble latest.json from artifacts + sigs
      - run: <atomic swap latest.json on updates.usevelo.ai per channel>
```

### 5.4 Reproducibility

- **Toolchain pinned** via `rust-toolchain.toml` (rustup honors it on every runner) — ADR-0016.
- **`Cargo.lock` committed** and CI uses `--locked`; `pnpm install --frozen-lockfile`.
- **Action pinning by commit SHA** (not floating tags) to prevent supply-chain drift.
- **Deterministic-ish builds**: `SOURCE_DATE_EPOCH` set from the tag's commit date; `--remap-path-prefix` strips absolute paths from the binary; Linux built in a pinned container.
- **`cargo xtask verify-tools`** guarantees the same external tool versions everywhere.

### 5.5 Key custody & least privilege

- Secrets live in **GitHub Environments** (`release` env) with required-reviewer protection; only `release.yml` on a tag can access them.
- Windows/macOS signing prefer **remote HSM/KMS** (Azure Trusted Signing, Apple notary API) so the private key material is never materialized on a runner.
- Cosign uses **keyless OIDC** (`id-token: write`) to sign artifacts + SBOM with the workflow identity, recorded in the public Rekor transparency log.
- The updater minisign key rotation procedure and the Apple/Windows cert renewal calendar are owned by this strategist and documented in an ops runbook (referenced ADR).

---

## 6. Supply chain, SBOM & compliance

### 6.1 SBOM

- **CycloneDX** SBOM (`cargo-cyclonedx`) generated per release, attached to the GitHub Release and to each artifact; a matching JS SBOM from `pnpm` (CycloneDX npm) covers the frontend.
- SBOMs are **cosign-attested** (in-toto attestation) so downstream can verify provenance.

### 6.2 Provenance / SLSA

- GitHub Actions **OIDC + cosign keyless** yields SLSA-style provenance; the build is non-falsifiable-tied to the tagged commit and workflow.

### 6.3 Third-party licenses in the installer

- `cargo-about` generates `THIRD_PARTY.html`, bundled as a Tauri `resource` and shown in About → Licenses. `cargo-deny` fails the build on any license outside the allowlist.

### 6.4 `deny.toml` (advisories, bans, licenses)

```toml
[advisories]  # RUSTSEC advisory DB; fail on vulnerabilities
vulnerability = "deny"
unmaintained  = "warn"
[bans]
deny = [ { name = "openssl-sys" } ]   # rustls-only (ADR-0004); native-tls feature exempts explicitly
multiple-versions = "warn"
[licenses]
allow = ["MIT","Apache-2.0","BSD-3-Clause","ISC","Unicode-DFS-2016","MPL-2.0","Zlib"]
```

### 6.5 Every subsystem's supply-chain obligation

Any new dependency in any `ns-*` crate must pass `cargo deny` (license + advisory + ban). Adding a crate that pulls `openssl-sys`, a copyleft license, or an unmaintained package **fails the PR** — the owning team fixes or files an exception ADR.

---

## 7. Opt-in telemetry & crash reporting

### 7.1 Principle (ADR-0019)

Telemetry and crash reporting are **strictly opt-in**. Default builds send nothing. The first-run dialog and Settings expose independent toggles (`settings.telemetry.usage`, `settings.telemetry.crash`), persisted via `SettingsRepo`. `NS_TELEMETRY=off` env force-disables regardless of setting (config_conventions).

### 7.2 Architecture — anchored in `ns-telemetry`

`ns-telemetry` (L1, logging-observability) owns the layered `tracing-subscriber`. Telemetry is an **additional opt-in layer** on the same pipeline:

- **Usage telemetry**: an OTLP layer (behind the opt-in flag) exports anonymized, aggregated events (feature used, connection count buckets, error-code frequencies). **Never** payloads, subjects, creds, or PII. Uses a random install-id (rotatable, not tied to identity).
- **Crash reporting**: a panic/abort hook (compatible with `panic = "abort"`, §3.6) captures a **redacted** minidump/backtrace + the current `correlation_id`, queued locally, uploaded only if the crash toggle is on. The scrubber that already runs on the log path (logging_conventions) also scrubs crash payloads — `Redacted<T>` fields print `***`.

```rust
// ns-telemetry (signatures)
pub struct TelemetryConfig { pub usage: bool, pub crash: bool, pub endpoint: Option<Url>, pub install_id: InstallId }
pub fn install_telemetry_layers(cfg: &TelemetryConfig) -> Vec<BoxedLayer>; // empty unless opted in
pub fn install_crash_handler(cfg: &TelemetryConfig, scrubber: Scrubber);   // no-op unless cfg.crash
```

### 7.3 Redaction guarantees (defense in depth)

1. Secret-bearing types are `Redacted<T>` (ns-core) — Debug/Display print `***`.
2. A **scrubber** runs on both the log and telemetry/crash egress paths as a second line.
3. **No subject names, message payloads, or connection URLs** leave the machine; only structural/aggregate signals.
4. Every subsystem that emits a telemetry event does so through an `ns-telemetry` API that enforces an allowlist of field types — no free-form strings from user data.

### 7.4 Every subsystem's telemetry obligation

- Teams instrument with `tracing` spans/fields (already required by logging_conventions); telemetry is derived from those, so **no team calls an analytics SDK directly**.
- Any new telemetry event requires a schema entry reviewed by this strategist + security-model for PII (cross-cutting sign-off).
- The **diagnostics-bundle** export (ns-telemetry) zips logs + system info + redacted settings for support; it is user-initiated and stays local unless the user attaches it.

---

## 8. Compliance matrix — what every subsystem must do

| Subsystem / crate | Deployment obligation |
|---|---|
| `[core-runtime]` ns-types | Bump `appSchemaVersion` on breaking DTO change; keep typeshare annotations gen-clean (CI drift gate). |
| `[core-runtime]` ns-core/ns-event | Provide `Redacted<T>` + scrubber used by telemetry egress; TaskRegistry hosts the updater/telemetry tasks. |
| `[connection-manager]` ns-nats/ns-connection | rustls-only (no openssl-sys); reconnection unaffected by update relaunch (state rebuilt on restart). |
| `[account-security]` ns-security | Keychain frameworks present on all base images; encrypted fallback compiles with no system crypto; signing keys never in this crate. |
| `[storage]` ns-storage | Bundled SQLite (reproducible); embed all migrations in binary; forward-only (blocks downgrade). |
| `[logging-observability]` ns-telemetry | Own opt-in telemetry + crash layers; enforce redaction allowlist; diagnostics bundle. |
| `[monitoring]` ns-monitor | reqwest on rustls; no extra system TLS dep. |
| `[terminal]` ns-terminal | `nats` CLI is a prerequisite, not bundled; graceful `TERMINAL_SPAWN_FAILED`. |
| `[jetstream]/[pubsub]/[subject]/[inspector]/[dashboard]` | No CDN/remote assets (CSP); no banned deps; instrument via tracing only. |
| `[tauri-shell]` ns-ipc/nats-studio | Owns updater wiring, capabilities/CSP, `beforeBuildCommand`; catch command panics before `panic=abort`. |
| `[plugin-architecture]` ns-plugin | Phase-1 plugins inherit app signature; Phase-2 WASM distribution is a separate ADR. |
| `[testing-strategy]` ns-testkit | Provides the `nats-server` fixture; coverage gate consumed by CI. |
| `[performance-strategy]` | Owns startup/size budgets this pipeline enforces. |
| `[security-model]` | Co-signs telemetry schema + signing/custody policy. |

---

## 9. Open questions & future ADRs

1. **Delta updates** (bsdiff/courgette) to shrink update downloads — deferred; needs its own ADR.
2. **Windows MSIX / Store** distribution alongside NSIS/MSI — evaluate for enterprise reach.
3. **macOS Mac App Store** build variant (sandboxed, no updater) — conflicts with keychain-access-groups + updater; likely out of scope.
4. **Phase-2 WASM plugin distribution & signing** — separate marketplace/registry ADR (ADR-0014 successor).
5. **Reproducible-build attestation** to bit-for-bit — currently "reproducible-ish"; full determinism (esp. macOS `.app`) is a stretch goal.
6. **Flatpak/Snap** Linux formats — demand-driven; would replace AppImage self-update with portal-managed update.
7. **Updater CDN + rollout service** — `latest.json` hosting hardening, geo-CDN, and the rollout-fraction service backend.

---

## 10. Definition of Done (release gate checklist)

A tag `vX.Y.Z` may publish only when: `ci.yml` green on the commit · `sync-version --check` clean · gen-types no drift · `cargo deny` clean · all three OS artifacts signed (+ macOS notarized & stapled) · SBOM attached & attested · `latest.json` signed and validated by a staging client on each platform · CHANGELOG + git-cliff notes generated · `appSchemaVersion`/plugin-API bumps (if any) have referenced ADRs · rollback pointer (prior `latest.json`) preserved.
