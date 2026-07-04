# Cross-Cutting Strategy — Security Model

**Strategy key:** `security-model`
**Scope:** whole application (every crate, the Tauri bridge, the WebView, the build/release pipeline)
**Owning role:** Security Model strategist (cross-cutting lead)
**Primary implementing crates:** `ns-security` (L1), `ns-core` (ports + `Redacted<T>`), `ns-ipc` (bridge/redaction surface), `ns-telemetry` (scrubbing), `apps/desktop/src-tauri` (composition root, capabilities, CSP, updater)
**Status:** Strategy v1 (binding)

> Aligns with `docs/architecture/00-conventions-and-workspace.md` (the spine) and `docs/architecture/sub-account-security.md`. Uses spine crate names, layering, error model, IPC/DTO/event conventions, storage rules, and ADRs verbatim; does not contradict them. Every new DTO/port/`ErrorCode`/`EventPayload` variant referenced here is an addition to the frozen crates (`ns-types`, `ns-core`) and requires the normal ADR + `appSchemaVersion` bump before merge. This document sets **mandatory** requirements ("MUST") that every subsystem team is accountable to; §12 is the per-subsystem compliance matrix.

---

## 1. Assets, Trust Boundaries & Threat Model

### 1.1 Assets we protect (ranked)

| # | Asset | Where it lives | Blast radius if leaked |
|---|---|---|---|
| A1 | **NKey seeds** (`S...`, all prefixes) | OS keychain; transiently in RAM (crypto path) | Full impersonation of an operator/account/user; forge JWTs |
| A2 | **`.creds` bodies** (user JWT + user seed) | OS keychain; transiently in RAM | Connect as that user with its permissions |
| A3 | **Passwords / tokens / NKey-auth seeds** for connection profiles | OS keychain | Connect to broker with stored identity |
| A4 | **TLS client private keys** (mTLS) | OS keychain (PEM redacted) | Client-cert impersonation |
| A5 | **Operator/Account signing keys** used for JWT issuance | OS keychain | Mint arbitrary accounts/users under an operator/account |
| A6 | **Message payloads / headers** (may contain secrets, PII) | RAM, message-history SQLite (bounded), export files | Data exfiltration |
| A7 | **The audit log** (integrity) | SQLite `audit_log`, hash-chained | Repudiation; hide malicious actions |
| A8 | **The app itself** (code integrity) | Signed bundle + updater | Supply-chain RCE, malicious auto-update |
| A9 | **App-level encryption master key** (headless-Linux fallback) | OS-protected file / derived | Decrypts A1–A5 fallback vault |

### 1.2 Trust boundaries

```
                          ┌─────────────────────────── UNTRUSTED / SEMI-TRUSTED ──────────────────────────┐
  ┌──────────┐  IPC       │  ┌───────────────┐   NATS (TCP/TLS)   ┌────────────┐   HTTP    ┌───────────┐   │
  │ WebView  │◄──────────►│  │ Tauri bin +   │◄──────────────────►│ nats-server│           │ monitoring│   │
  │ (React)  │  Channels/ │  │ Rust services │                    │  cluster   │◄─────────►│ endpoints │   │
  │  TB-1    │  events    │  │   (trusted)   │                    └────────────┘           └───────────┘   │
  └──────────┘            │  └──────┬────────┘        TB-3 network peer          TB-4 remote data           │
       ▲                  │         │                                                                       │
       │ TB-1 IPC surface │   ┌─────▼──────┐  ┌───────────┐  ┌──────────┐   TB-5 plugins (in-proc now)      │
       │ (validate all)   │   │ OS keychain│  │  SQLite   │  │  nats CLI│◄── TB-6 spawned subprocess (PTY)  │
       └──────────────────┘   │  TB-2 secret│  │  TB-2 disk│  │ + shell  │                                  │
                              └────────────┘  └───────────┘  └──────────┘                                  │
                                                                          └───────────────────────────────┘
```

- **TB-1 — IPC boundary (WebView ⇄ Rust).** The WebView is treated as **partially untrusted**: it renders third-party message payloads, JWTs, cert PEM, and (Phase 2) plugin-provided UI. XSS in the WebView must NOT translate to arbitrary backend capability. Every `#[tauri::command]` validates and authorizes its input; secrets are pulled by `SecretRef`, never passed through JS unless via the single sanctioned `security_reveal_secret` path.
- **TB-2 — Secret & disk boundary.** Keychain and SQLite are on-host but a stolen laptop / malware-with-user-privileges model applies. Secrets never touch SQLite plaintext (ADR-0013); disk-at-rest secrets are envelope-encrypted (§4).
- **TB-3 — NATS network peer.** The broker is authenticated via TLS + creds; a MITM or hostile broker must not be able to trick us into leaking seeds or executing code. Certificate validation is strict by default (§6).
- **TB-4 — Remote monitoring data.** `varz/connz/...` JSON is untrusted input parsed by `ns-monitor`; must be size-bounded and parse-hardened.
- **TB-5 — Plugins.** Phase-1 in-process plugins are trusted-but-capability-gated; Phase-2 WASM is a hard sandbox (ADR-0014). Plugins never see raw secrets.
- **TB-6 — Subprocess (nats CLI / shell).** `ns-terminal` spawns processes; argument injection and env-var secret leakage are in scope.

### 1.3 Threat model (STRIDE, condensed) & mitigations

| Threat | Vector | Mitigation (crate) | Residual |
|---|---|---|---|
| **Spoofing** | Hostile broker / MITM | rustls strict verify, SPKI pinning option, mTLS (`ns-security` TLS builder) | insecure-skip lab flag (§6.4) |
| **Tampering** | Malicious auto-update | Tauri updater Ed25519 signature verify, TLS pinned endpoint (§8) | key custody (Deployment) |
| **Tampering** | Audit-log edits | SHA-256 hash chain + optional HMAC head-signing (§9) | DB-level delete+rechain (open Q) |
| **Repudiation** | "I didn't issue that JWT" | Append-only audited, integrity-verifiable log (§9) | local-user single-actor model |
| **Info disclosure** | Secret in logs / error / crash dump | `Redacted<T>`, `zeroize`, scrubber, single `to_ipc_error` surface (§4, §10) | screenshots by user |
| **Info disclosure** | XSS reads secrets via IPC | CSP, IPC allowlist, `SecretRef` indirection, reveal-gating (§5, §7) | reveal window (open Q §13) |
| **Info disclosure** | Payload/PII in history exports | bounded history + explicit export + redaction hooks (§9.4) | user opts to export |
| **DoS** | Huge JSON / cert bundle / subject flood | size caps, `spawn_blocking` thresholds, bounded ring buffers, backpressure | — |
| **Elevation** | Malicious plugin / dep RCE | capability model, `cargo-deny`/`cargo-audit`, WASM sandbox later (§7.5, §8.4) | in-proc phase-1 trust |
| **Elevation** | Command/arg injection to nats CLI | no shell interpolation; `Command` argv array; gated shell mode (§7.6) | shell mode opt-in |

### 1.4 Explicit non-goals (v1)

- Defending against a **fully compromised OS / root malware** on the user's machine (we rely on OS keychain and process isolation).
- Multi-user / RBAC inside the app (single local user; `actor="local-user"`).
- Pushing accounts to a live `nats-account-resolver` (deferred — sub-account-security §11).

---

## 2. Security Principles (non-negotiable)

1. **Secret confinement to one crate.** `ns-security` is the ONLY crate with `keyring`, `age`/`chacha20poly1305`, `nkeys`, JWT signing, and the rustls `ClientConfig` builder. No other crate imports secret-bearing dependencies. (ADR-0007, ADR-0013.)
2. **Secrets are typed.** All seeds/creds/passwords/tokens/client-keys are `Redacted<T>` (`ns-core`) end-to-end; `Debug`/`Display` print `***`; they are `#[serde(skip)]` or serialized only as `SecretRef`.
3. **`SecretRef` indirection.** IPC and SQLite carry opaque, non-secret `SecretRef { service, account }` pointers, never the secret. Cleartext crosses IPC only through `security_reveal_secret`, which always audits.
4. **Defense in depth on the log path.** `Redacted<T>` (compile-time) + a regex **scrubber** in `ns-telemetry` (runtime) + a single `ns_ipc::to_ipc_error` redaction surface for errors.
5. **Zeroize on drop.** Every in-RAM secret buffer is wrapped so it is zeroized when dropped (`zeroize` / `secrecy`), including intermediate crypto buffers.
6. **Least privilege everywhere.** Tauri capabilities allowlist only the commands a window needs; CSP denies remote fetch; filesystem scope is narrow; plugins are capability-gated.
7. **Fail closed.** On any security-relevant ambiguity (unverifiable cert, unavailable keychain with no fallback, drift in generated types) the app refuses the action with a typed error rather than silently proceeding insecurely.
8. **One serialization surface.** Errors → UI only via `to_ipc_error`; events → UI only via `EventBridge`. No ad-hoc `emit`/`format!` of security state.

---

## 3. Secret Storage Architecture

Confined to `ns-security`; exposed to the rest of the app only through the `ns_core::ports::SecretStore` port and the `SecurityService` facade (see `sub-account-security.md` §2.3). Composition happens in the bin (composition root).

### 3.1 Backends & selection order

```rust
// crates/ns-security/src/secret/mod.rs
pub struct LayeredSecretStore {
    primary:  KeychainSecretStore,      // keyring 3.x -> OS backend
    fallback: EncryptedFileSecretStore, // XChaCha20-Poly1305 / age vault
    policy:   FallbackPolicy,           // AutoFallback (default) | KeychainOnly | FileOnly (dev)
}
```

- **`KeychainSecretStore`** — `keyring` crate (v3.x), backends: **Windows Credential Manager**, **macOS Keychain Services**, **Linux Secret Service (libsecret / GNOME Keyring / KWallet)**. Entry key = `SecretRef { service:"nats-studio", account }` where `account` ∈ `conn:{ConnectionId}:seed`, `nkey:{publicKey}:seed`, `creds:{materialId}`, `tlskey:{ConnectionId}`, etc.
- **`EncryptedFileSecretStore`** — engaged only when the keychain is unavailable (headless/CI Linux, ADR-0013). Envelope-encrypted vault at `{appDataDir}/nats-studio/secrets.vault` (§4).
- **Selection:** try keychain; on `SecretStoreError::Unavailable` (no Secret Service bus, locked wallet) drop to the file vault and emit `SecretStoreStatusChanged` so the UI shows a persistent "encrypted-file fallback" badge. `KeychainOnly` policy makes fallback a hard error (enterprise setting).

### 3.2 What is stored where (invariant)

| Data | Keychain / vault | SQLite (`ns-storage`) |
|---|---|---|
| Seeds, `.creds`, passwords, tokens, client TLS keys | **value** | only the `SecretRef` string + non-secret metadata |
| Connection profile (host, TLS mode, auth *type*) | — | full row (`ConnectionProfileRepo`) |
| Imported JWTs (signed, public claims) | — | `security_material.jwt` (public) |
| Audit entries | — | `audit_log` (no secrets in `detail_json`) |
| App master key (fallback) | OS-protected (§4.3) | never |

**Invariant (CI-enforced by a grep lint in `xtask check-secrets`):** no `INSERT`/`UPDATE` touching a column that could hold a seed/creds/password; `ns-storage` migrations reviewed for secret columns. Secret material must only flow through `SecretStore`.

### 3.3 Failure modes & budgets

| Failure | Behavior | Budget |
|---|---|---|
| Keychain locked / no bus | fall back to file vault (or `SECRET_STORE_UNAVAILABLE` if `KeychainOnly`), badge UI | detect < 200 ms |
| Keychain slow (DBus) | `spawn_blocking` + `Semaphore(1)` serialization; never blocks async worker | UI never freezes |
| Vault key missing/corrupt | `SECRET_STORE_UNAVAILABLE`, refuse to write secrets, offer re-init (destroys old) | fail closed |
| Concurrent access race (Linux SS) | per-store `tokio::sync::Semaphore(1)` | — |

---

## 4. Credential Encryption (Envelope) & In-Memory Handling

### 4.1 Envelope encryption model (file-vault fallback)

Two-tier keys so we can rotate the passphrase/master without re-encrypting every secret:

```
             ┌────────────────────────────────────────────────────────┐
 OS-protected│  Master Key (MK) — 32 bytes, never on disk in cleartext │
   root ────►│                                                         │
             └───────────────┬────────────────────────────────────────┘
                             │ wraps (XChaCha20-Poly1305 AEAD)
                             ▼
             ┌───────────────────────────────┐   each secret AEAD-sealed
             │ Data Encryption Key (DEK)      │──► under DEK; per-secret
             │ per vault, rotatable           │    24-byte random nonce
             └───────────────────────────────┘
```

- **AEAD:** XChaCha20-Poly1305 (`chacha20poly1305` crate) — 24-byte random nonce per record (nonce-misuse margin), 16-byte Poly1305 tag. Alternative packaging: `age` (X25519 + ChaCha20-Poly1305) for interop/export. AAD binds the record to `SecretRef.account` + vault version to prevent record swapping.
- **Record format (versioned):** `{ v:u16, kdf, salt, dek_wrapped, nonce, ct, tag }` serialized with `bincode`/`serde`. `v` allows format migration; unknown `v` → refuse.
- **DEK rotation:** re-wrap DEK under a new MK (cheap); full DEK rotation re-seals records via a background task with progress + audit (`SecretRotated`).

### 4.2 Key derivation (when a passphrase is involved)

- **Argon2id** (`argon2` crate) for any human-passphrase-derived key: params `m=64 MiB, t=3, p=1` (tuned per platform, min OWASP 2024 floor), 16-byte random salt, output 32 bytes. Store params + salt with the vault header (non-secret).
- No passphrase by default: MK is rooted in the OS (§4.3). A passphrase is an optional "extra lock" (setting) that Argon2id-wraps the MK.

### 4.3 Rooting trust without a keychain (headless Linux)

Priority chain, first available wins, recorded in `SecretStoreStatusDto.detail`:
1. **OS keyring even if headless** (some CI has libsecret) — preferred.
2. **File-based MK protected by strict perms** `0600`, in `{appDataDir}`, XORed/derived with a **machine-binding factor** (`/etc/machine-id` or systemd machine-id, hashed) so a copied vault file alone is not portable to another host.
3. **Explicit user passphrase** (Argon2id) — strongest; prompted once per session, MK held only in RAM (zeroized on lock/exit).

> This is a documented **degradation**, not a silver bullet (open Q §13.5). The UI always shows which tier is active; enterprise policy can force tier 3.

### 4.4 In-memory secret handling (zeroize)

```rust
// ns-core: the redaction wrapper — Debug/Display => "***", zeroize on drop.
#[derive(Clone)]
pub struct Redacted<T: Zeroize>(secrecy::Secret<T>);   // built on `secrecy` + `zeroize`

impl<T: Zeroize> fmt::Debug   for Redacted<T> { fn fmt(..) { f.write_str("***REDACTED***") } }
impl<T: Zeroize> fmt::Display for Redacted<T> { fn fmt(..) { f.write_str("***REDACTED***") } }
impl<T: Zeroize> Serialize    for Redacted<T> { /* SKIP or error — never serialized raw */ }
```

Rules (MUST):
- Seeds, creds, passwords, tokens, client-key PEM, MK, DEK are `Redacted<_>` / `Zeroizing<Vec<u8>>` from the moment they exist to drop.
- **Zeroize the whole crypto path**, not just the wrapper: after `nkeys` signing, after JWT signing, after AEAD seal/open, explicitly `zeroize()` the plaintext buffer (`zeroize` crate; audit third-party `nkeys`/`ed25519-dalek`/`chacha20poly1305` for `zeroize`-on-drop — open Q sub-account-security §11.9).
- **Never `to_owned()`/`clone()` a secret into a `String` that outlives the operation.** Reveal-to-UI copies are auto-cleared from Zustand after N seconds and never persisted.
- Prefer `mlock`-style protection is **out of scope v1** (documented residual); we rely on zeroize + short lifetime.

### 4.5 Budgets

| Op | Budget |
|---|---|
| Argon2id derive | 300–800 ms (tuned; deliberately slow) |
| AEAD seal/open one secret | < 1 ms |
| Secret zeroize on drop | O(len), no allocation |
| Vault open (N secrets) | lazy — decrypt per-secret on demand, not whole vault at startup |

---

## 5. IPC Boundary Security (TB-1)

### 5.1 Input validation & authorization

Every `#[tauri::command]` (naming per spine: `connection_*`, `security_*`, …) MUST:
1. Take exactly one `req: XxxRequest` (typeshared DTO) — no free-form strings beyond typed fields.
2. **Validate at the boundary** before touching a service: subject syntax (`ns-subject` validator), UUID/`ConnectionId` well-formedness, size caps (payload ≤ configurable max, default 8 MiB; JWT ≤ 64 KiB; cert input ≤ 512 KiB; batch counts bounded), enum-range, path allowlisting (§5.4). Reject with `INVALID_ARGUMENT`.
3. **Authorize by capability** — the command must be in the calling window's Tauri capability set (§7). There is no ambient authority: a command that operates on a connection takes `connectionId` explicitly and the service verifies the handle exists and belongs to the session (no hidden "current connection" — spine state model).
4. **Never return secrets** except `security_reveal_secret`. All secret inputs are `Redacted<String>` fields that are consumed and dropped.
5. **Catch panics** — the bridge wraps command bodies; a panic → `ErrorCode::INTERNAL` + correlation id, WebView never crashes (spine error model).

### 5.2 The `security_reveal_secret` exception (the only cleartext-out path)

- Requires explicit user action (confirm dialog + optional reason), writes a `SecretRevealed` audit entry, emits a `Notification`, and the FE auto-clears the value from UI state after a timeout and forbids persistence.
- Rate-limited and never available to plugins.

### 5.3 Redaction at the error surface

`ns_ipc::to_ipc_error` is the **single** place errors become wire DTOs. It walks `std::error::Error::source()`, runs the scrubber (§10), attaches the tracing span `correlation_id`, and emits `IpcError { code, message, retriable, correlationId?, causes[], detail? }`. `message`/`causes` are secret-safe by construction. Mid-stream errors are delivered in-band as the terminal `error` variant on the Channel enum (spine IPC conventions).

### 5.4 Safe path handling

- All filesystem locations resolve through the **Tauri path API / `directories` crate** — never hardcoded (spine config conventions). App data: `{appDataDir}/nats-studio/`.
- User-supplied paths (import `.creds`/`.pem`, export audit/history) are **canonicalized** and checked against an allowlist scope (Tauri `fs` capability scope + a runtime `starts_with(appDataDir | user-picked-dir)` check). Reject path traversal (`..`), symlink escapes, UNC/device paths on Windows. Import uses the OS file-picker (user-consented path) rather than arbitrary JS-provided strings where possible.
- Export writes are atomic (temp + rename) and never overwrite outside the chosen dir.

---

## 6. TLS / mTLS Trust Configuration

Owned by `ns-security::TlsConfigBuilder` (`build_client_tls(&TlsProfile) -> Arc<rustls::ClientConfig>`), consumed by `ns-connection`/`ns-nats` (async-nats) and `ns-monitor` (reqwest). rustls preferred; native-tls behind a feature flag (ADR-0004).

### 6.1 Trust modes (per connection profile)

| Mode | rustls config | Use |
|---|---|---|
| **System roots** (default) | `rustls-native-certs` → platform trust store | public/CA-signed brokers |
| **Custom CA pin** | `RootCertStore` seeded ONLY with the user's PEM CA(s) | private PKI |
| **SPKI pin** | custom `ServerCertVerifier` that also checks a pinned SHA-256 SubjectPublicKeyInfo | strongest MITM defense |
| **mTLS** | above + client cert chain + `Redacted` client key (from keychain) | client-cert auth |
| **Insecure skip** | `dangerous().with_custom_certificate_verifier(NoVerify)` | **lab only**, §6.4 |

### 6.2 Defaults & hardening

- TLS 1.2 minimum, **TLS 1.3 preferred**; rustls default cipher suites (no export/NULL). No renegotiation (rustls doesn't support it — good).
- Hostname/SNI verification **on** by default; ALPN set as async-nats requires.
- Client key loaded from keychain as `Redacted`, parsed with `rustls-pemfile`, wrapped in `PrivateKeyDer`, zeroized after `ClientConfig` build.
- Peer chain captured via a `ServerCertVerifier` hook and exposed through `PeerCertProvider` (for `security_inspect_connection_cert`) — DER retained only for the last handshake (bounded).

### 6.3 Certificate inspection

`inspect_certificate` uses `x509-parser` + `rustls-pki-types`: subject/issuer DN, SAN, validity window, key usage/EKU, SHA-256/SHA-1 fingerprints, CA flag, chain validity. Parser is fuzzed (`cargo-fuzz`) and never panics — malformed → `CertParse` → `SERIALIZATION`.

### 6.4 Insecure-skip guardrails (fail-loud)

- Requires a per-connection explicit opt-in toggle; **cannot** be the default; surfaced with a persistent red "INSECURE — certificate not verified" banner on that connection and every panel derived from it.
- Writes a `TlsProfileChanged` audit entry with `outcome=Denied`-style flag noting insecure.
- Disabled entirely under an enterprise "strict TLS" setting (`NS_TLS_STRICT` / setting), which forces one of the verifying modes.

### 6.5 Failure modes

| Failure | `ErrorCode` | UX |
|---|---|---|
| Untrusted/expired/hostname-mismatch cert | `TLS_ERROR` | show cert details + which check failed; offer pin (explicit) |
| Client key/cert mismatch | `TLS_ERROR` | actionable message, never echo key |
| Custom CA parse fail | `TLS_ERROR` | point at bad PEM line count (no content) |

---

## 7. Tauri Hardening

### 7.1 Capabilities / permissions allowlist

Tauri v2 capability files in `apps/desktop/src-tauri/capabilities/`. Principle: **default-deny, enumerate per window**.

```jsonc
// capabilities/main.json  (illustrative)
{
  "identifier": "main-window",
  "windows": ["main"],
  "permissions": [
    "core:event:default",
    "core:window:allow-set-title",
    { "identifier": "core:app:allow-app-info" },
    // Our command groups are explicitly allowlisted, NOT "allow all":
    "ns:connection", "ns:pubsub", "ns:jetstream", "ns:monitor", "ns:subject",
    "ns:inspector", "ns:security", "ns:storage", "ns:settings", "ns:dashboard",
    "ns:terminal", "ns:plugin",
    // Official plugins, scoped:
    "updater:default", "single-instance:default", "deep-link:default",
    { "identifier": "fs:allow-read-file", "allow": [{ "path": "$APPDATA/nats-studio/**" }] },
    { "identifier": "fs:allow-write-file", "allow": [{ "path": "$APPDATA/nats-studio/**" }] }
  ]
}
```

- **No `core:default` blanket**, no wildcard command permission. Each subsystem ships a permission set (`permissions/ns-<subsystem>.toml`) listing only its commands; the bin composes them.
- **`shell` plugin is NOT enabled**; process spawning is done inside `ns-terminal` via `portable-pty` with a fixed program (`nats`), not via `shell:allow-execute`.
- Plugin windows (Phase 2) get a **separate, narrower** capability set — never `ns:security`, never `fs` write.
- `withGlobalTauri: false` (no `window.__TAURI__` global) — the WebView uses the generated typed `invoke` wrappers only.

### 7.2 Content Security Policy

`tauri.conf.json` sets a strict CSP for the WebView:

```jsonc
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
          img-src 'self' data: blob:; font-src 'self' data:; \
          connect-src 'self' ipc: http://ipc.localhost; \
          worker-src 'self' blob:; frame-src 'none'; object-src 'none'; \
          base-uri 'none'; form-action 'none'",
  "dangerousDisableAssetCspModification": false,
  "freezePrototype": true,
  "assetProtocol": { "enable": true, "scope": ["$APPDATA/nats-studio/**"] }
}
```

- **No remote origins** in `connect-src` — the WebView never talks to the network directly; all NATS/HTTP IO is in Rust. This is the single biggest XSS-containment lever: even if a payload/JWT/plugin injects script, it cannot exfiltrate to a remote host.
- `style-src 'unsafe-inline'` is the pragmatic concession for Tailwind/Monaco/ECharts injected styles; **`script-src` stays `'self'`** (no `unsafe-inline`/`unsafe-eval`). Monaco is configured without `eval`-based workers where possible; if a worker needs `blob:`, it is scoped in `worker-src` only.
- `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'` kill iframe/object/base-tag injection.
- Monitoring HTTP endpoints are fetched by `ns-monitor` (reqwest) in Rust, never `fetch()` from the WebView — so they don't appear in `connect-src`.

### 7.3 Untrusted content rendering

- Message payloads, JWT claims, cert fields, subject names, log lines are **untrusted strings**. The React layer renders them as **text nodes** (never `dangerouslySetInnerHTML`); JSON/hex views use Monaco/CodeMirror in read-only, non-executing mode.
- Payload "preview as HTML/markdown" (if ever offered) runs through a sanitizer (`DOMPurify`) — but default is text/hex.

### 7.4 Updater signature verification

- Tauri v2 updater plugin with **Ed25519 signature** verification: bundles are signed by the release key; the app ships the corresponding **public key** in `tauri.conf.json`. An unsigned or wrong-signature update is rejected (fail closed) — this defends A8/TB-3 even if the update host or its TLS is compromised.
- Update manifest served over **HTTPS** from the pinned endpoint; channels `stable`/`beta` (spine versioning). `NS_DISABLE_UPDATER` is a **dev-only** override, never shipped enabled.
- Private signing key custody, rotation, and per-platform code signing (Authenticode / Apple notarization) are owned by the **Deployment strategist**; this strategy mandates that (a) the public key is pinned in-app, (b) CI fails if a release artifact is unsigned, (c) key material never enters the repo or CI logs.

### 7.5 Plugin capability model (ns-plugin)

- Phase 1 (in-process, ADR-0014): plugins declare a **manifest** with `minApi/maxApi` and a **capability list**; the host refuses incompatible plugins (`PLUGIN_INCOMPATIBLE`) and denies un-declared capabilities. Plugins receive **narrowed ports** (e.g. a read-only codec extension point) — **never** `SecretStore`, `AuditRepo`-write, raw `fs`, or `NatsClient` beyond declared subjects.
- Secrets are never handed to a plugin; a plugin that needs a connection uses a scoped handle mediated by `ns-connection`.
- Phase 2: WASM (wasmtime/extism) out-of-process for untrusted third-party plugins — hard memory/host-call sandbox.

### 7.6 Terminal / subprocess safety (ns-terminal, TB-6)

- Spawns a **fixed program** (`nats` CLI) with an **argv array** — no shell string interpolation, so no arg/command injection from UI input.
- Raw shell mode is gated behind an explicit setting (ADR-0017) and clearly marked; disabled under enterprise lockdown.
- **No secrets in argv or env** of spawned processes (process listings/`/proc` are readable) — creds are passed to `nats` via a temp `.creds` file with `0600` perms in `{appDataDir}`, deleted after, or via the connection context, never `--password=` on the command line.
- PTY output is untrusted → rendered by xterm.js (which handles escape sequences safely); output is bounded (FIFO + overflow marker, spine event policy).

---

## 8. Supply-Chain & Build Security

### 8.1 Pinned, reproducible toolchain

- `rust-toolchain.toml` pins **stable** (never the local nightly 1.97; spine ADR-0016). `Cargo.lock` committed. `tools/versions.toml` pins `nats-server`, `nats`, `cargo-tauri`, `typeshare-cli`.
- Single-pinned deps via `[workspace.dependencies]` — one version per crate, reviewed.

### 8.2 `cargo-deny`

`deny.toml` gates CI (`cargo xtask` / CI job). Four checks:
- **advisories** — RustSec DB; deny known-vuln crates; `unmaintained = "warn"→deny` on security-sensitive deps (crypto/tls/keyring).
- **bans** — deny duplicate/backdoor-prone crates; **explicitly ban** `openssl-sys` unless native-tls feature is deliberately on; ban `git`-source deps for crypto.
- **licenses** — allowlist (MIT/Apache-2.0/BSD/ISC/Unicode); deny GPL/AGPL/unknown; produce an SBOM.
- **sources** — only crates.io + vetted registries.

### 8.3 `cargo-audit`

Runs in CI on every PR + a scheduled daily job against `Cargo.lock`; a new advisory on a shipped dep fails the nightly and files an issue. Complements `cargo-deny advisories` for the dedicated audit workflow.

### 8.4 Additional supply-chain controls

- **`cargo-vet`** (or `cargo-crev`) audit records for security-critical crates (`ring`/`rustls`, `chacha20poly1305`, `argon2`, `keyring`, `nkeys`, `ed25519-dalek`) — recommended, tracked as an initiative.
- **`#![forbid(unsafe_code)]`** in every crate except where a documented, reviewed exception exists (FFI in `keyring`/`portable-pty` are upstream; our own crates forbid unsafe). `xtask check-layers` also greps for stray `unsafe`.
- **Dependabot/renovate** for dep bumps, gated by the same CI.
- **SBOM** (CycloneDX via `cargo-cyclonedx` or cargo-deny) attached to each release (Deployment).
- **CSP + generated-type drift**: CI runs `pnpm gen:types` then `git diff --exit-code` so Rust/TS contracts (including `IpcError`, `ErrorCode`) can never silently diverge.
- **Frontend deps**: `pnpm audit` in CI; lockfile committed; no CDN scripts (CSP already blocks them).

---

## 9. Audit Logging & Redaction

### 9.1 What is audited (append-only, hash-chained)

Security-relevant user actions (sub-account-security §2.1, §8): `NKeyGenerated`, `JwtDecoded`, `JwtIssued`, `CredsImported`, `CredsExported`, `SecretStored`, `SecretRevealed`, `SecretRotated`, `SecretDeleted`, `PermissionEdited`, `CertificateInspected`, `TlsProfileChanged`, `ConnectionAuthUsed`, `AuditExported`. Each: `{ seq, ts, action, actor, connectionId?, target?, outcome, detail_json?, prevHash, hash }`.

### 9.2 Tamper-evidence

- **Hash chain:** `hash_i = SHA-256(prev_hash || canonical(entry_i))`; genesis `prev_hash = 64×'0'`. Computed **inside the storage worker's write transaction** (single-writer, ADR-0003) so concurrent `AuditSink::record` appends stay totally ordered and chain-valid.
- **`verify_audit_integrity`** re-walks the chain; a corrupt row → `firstBrokenSeq`.
- **Optional HMAC head-signing (recommended, open Q):** periodically HMAC-SHA-256 the chain head under an OS-protected key (same root as §4.3) so an attacker with DB write access can't silently delete-and-rechain. Decision pending (sub-account-security §11.3).
- **Retention:** bounded by size + TTL (default 90 days / 100k rows, user-configurable). Pruning anchors integrity verification at the earliest retained row, whose `prev_hash` becomes the trusted anchor recorded in `SettingsRepo`. A "never prune security audit" setting is offered.

### 9.3 The `AuditSink` fire-and-forget contract

Other subsystems record via `ns_core::ports::AuditSink` (re-exported from `ns-core`, so they don't depend on `ns-security`): bounded `mpsc` → dedicated drain task → `AuditRepo::append`. Overflow drops-oldest but **emits a synthetic `AuditGap`** entry (never silently lose the drop fact). Callers are never blocked.

### 9.4 Redaction — layered defense in depth

1. **Compile-time:** `Redacted<T>` types make it impossible to accidentally `Debug`/serialize a secret.
2. **Structured logging:** `tracing` fields are never secrets; secret-bearing types print `***`. Log targets are crate module paths; levels per spine.
3. **Runtime scrubber** (`ns-telemetry`, defense in depth): a regex layer on the log write path removes anything matching secret shapes — NKey seeds `S[OAUNXC][A-Z2-7]{56}`, PEM private-key blocks (`-----BEGIN … PRIVATE KEY-----`…), `.creds` bodies, bearer/JWT-in-Authorization, base64 blobs tagged as secret. Runs on both file and in-app ring-buffer layers.
4. **Error surface:** `to_ipc_error` applies the same scrubber to `message`/`causes` — user-visible errors are secret-safe and carry a `correlationId` linking to the (also-scrubbed) log line.
5. **Audit `detail_json`:** validated to contain only non-secret fields (public keys, subjects, `SecretRef.account`, counts) — never seed/creds/password.

### 9.5 Diagnostics bundle

The support-export zips logs + system info + **redacted** settings (secrets and `SecretRef` values elided). The scrubber runs a final pass over the bundle before write.

### 9.6 Budgets

| Metric | Budget |
|---|---|
| `AuditSink::record` caller latency | non-blocking (mpsc push) |
| Audit append (worker) | < 5 ms typical |
| Scrubber overhead per log line | < 50 µs (precompiled regex set) |
| Integrity verify 100k rows | < 2 s |

---

## 10. Redaction & Logging Compliance (all crates)

MUST for every team:
- Never construct a `String`/`format!`/`tracing::field` from a secret. Accept secrets only as `Redacted<T>` and pass by reference into `ns-security`.
- Never log a full JWT compact token at `info`+; the JWT inspector displays it in the WebView only, and it is scrubbed from logs.
- Never put payload bodies in error messages; reference by size/type. Payloads cross IPC as base64 with an explicit `encoding` field (spine DTO rules), never raw byte arrays, and are excluded from logs.
- Errors leave a crate only as the crate's `thiserror` enum implementing `DomainError`; the bin/`ns-ipc` maps to `IpcError`. No `anyhow` in public APIs (spine error model).

---

## 11. Cross-Cutting Interactions with Other Strategies

- **Performance:** crypto uses `spawn_blocking` only above size thresholds; Argon2id is deliberately slow but off the UI path; scrubber regexes precompiled; secret zeroization is O(len). Bounded buffers everywhere prevent memory-DoS.
- **Testing:** `ns-testkit` provides a mock keyring backend, fixture `.creds`/JWT/PEM (generated by `nsc`/`openssl`, committed), and an embedded `nats-server` (TLS + operator/JWT) for E2E. Security tests: redaction/scrubber unit tests, audit-chain concurrency test, fuzz targets for X.509 + subject + base32 nkey parsers, and a CI test asserting no secret pattern appears in captured logs.
- **Deployment:** owns code-signing keys + updater signing key custody, notarization, SBOM publication, and reproducible release builds. This strategy mandates signature-verified updates and pinned public keys.
- **Plugin architecture:** capability model + WASM sandbox roadmap (§7.5).

---

## 12. Per-Subsystem Compliance Matrix (mandatory)

| Subsystem / crate | MUST comply |
|---|---|
| **core-runtime** (`ns-core`, `ns-types`, `ns-event`) | Define `Redacted<T>` (zeroize+secrecy), `SecretStore`/`AuditRepo`/`AuditSink`/`Clock` ports, `ErrorCode`/`IpcError`/`EventPayload` security variants; keep DTOs secret-free (`SecretRef` only); typeshare drift-checked. |
| **account-security** (`ns-security`) | Sole owner of `keyring`, AEAD/`argon2`, `nkeys`, JWT signing, rustls builder; implement `LayeredSecretStore`, envelope encryption, zeroized crypto path, audit chain, cert inspection, TLS modes, reveal-gating. |
| **connection-manager** (`ns-connection`, `ns-nats`) | Resolve creds only via `SecretStore`; build TLS via `ns-security`; expose `PeerCertProvider`; record `ConnectionAuthUsed`; never log creds; async-nats confined to `ns-nats`. |
| **tauri-shell** (`ns-ipc`, bin) | Capabilities allowlist, CSP, updater signature, `to_ipc_error` single surface, panic catch, path canonicalization/scope, `withGlobalTauri:false`; compose `LayeredSecretStore`. |
| **storage** (`ns-storage`) | No secret columns (CI lint); WAL+`foreign_keys=ON`+`busy_timeout`; single-writer audit append computing the hash in-txn; retention/prune; migrations reviewed for secrets. |
| **logging-observability** (`ns-telemetry`) | Scrubber layer on file + ring-buffer; secret-safe fields; redacted diagnostics bundle; OTLP strictly opt-in. |
| **monitoring** (`ns-monitor`) | Size-bound + parse-harden untrusted `varz/connz/...` JSON; reqwest uses `ns-security` TLS; never fetch from WebView; may call pure `decode_jwt`. |
| **jetstream / pubsub / message-inspector** | Payloads/headers untrusted → base64 over IPC, excluded from logs/errors; codecs (`ns-inspector`) fuzzed and panic-free; size caps. |
| **subject-explorer** (`ns-subject`) | Subject validator is the boundary check reused by IPC input validation; sampling rate-limited/bounded. |
| **terminal** (`ns-terminal`) | Fixed-program argv (no shell interpolation); no secrets in argv/env; gated shell mode; bounded output. |
| **message-inspector** (`ns-inspector`) | Codec parsers panic-free/fuzzed; format auto-detect size-bounded; no `eval`. |
| **dashboard** (`ns-dashboard`) | Aggregates only non-secret snapshots; inherits upstream redaction. |
| **frontend-shell** | Render untrusted strings as text (no `dangerouslySetInnerHTML`); reveal-secret auto-clear + no persistence; call only generated `ipc.*` wrappers; no CDN/remote fetch. |
| **plugin-architecture** (`ns-plugin`) | Capability-gated, version-checked, no secret/`fs`/raw-`NatsClient` access; WASM sandbox Phase 2. |
| **testing-strategy** (`ns-testkit`) | Mock keyring, security fixtures, log-leak assertion test, fuzz + chain-concurrency tests. |
| **deployment-strategy** | Code + updater signing key custody/rotation, notarization, SBOM, unsigned-artifact CI gate. |
| **performance-strategy** | Honor `spawn_blocking` thresholds, precompiled scrubber, bounded buffers. |

---

## 13. Risks & Open Questions

1. **Reveal-in-WebView exposure.** Cleartext secret briefly lives in WebView memory/DOM. Mitigations: explicit action, auto-clear timer, no persistence, audit. Residual risk accepted for v1; consider a native "copy to clipboard without display" path (clipboard then cleared).
2. **HMAC-signed audit head.** Whether to key-sign the chain head to defend against DB-level delete+rechain (§9.2). Recommend yes; needs the OS-protected key story finalized.
3. **`zeroize` coverage of third-party crypto buffers.** Audit `nkeys`, `ed25519-dalek`, `chacha20poly1305`, `argon2` for zeroize-on-drop; wrap where they don't.
4. **JWT library vs hand-roll.** Hand-rolled ed25519-nkey JWT confined to `JwtEngine`, golden-file validated (sub-account-security §11.1) — the signing path must be constant-time and zeroized.
5. **Headless-Linux trust root.** Machine-id-derived key vs forced passphrase (§4.3). Needs security-model sign-off; document the guarantee honestly (a copied vault + copied machine-id defeats tier 2 — recommend tier 3 for high-assurance).
6. **CSP `style-src 'unsafe-inline'`.** Required by Tailwind/Monaco/ECharts; script-src stays locked. Revisit if a nonce-based style pipeline becomes feasible.
7. **Insecure-skip TLS.** Kept for lab UX but a foot-gun; enterprise strict-mode disables it. Consider removing from release builds entirely.
8. **Frozen-crate additions.** All ports/DTOs/`EventPayload`/`ErrorCode` variants referenced here are additions to `ns-types`/`ns-core` — bundle into one ADR + `appSchemaVersion` bump before implementation.
```
