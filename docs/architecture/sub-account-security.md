# Subsystem Design — Account & Security

**Subsystem key:** `account-security`
**Owning crate(s):** `ns-security` (L1, `crates/ns-security`)
**Frontend slice:** `apps/desktop/src/features/security`
**Author:** Lead Engineer, Account & Security Team
**Status:** Design v1 (implementable)

> Aligns with `docs/architecture/00-conventions-and-workspace.md` (the spine). Where this doc references crate names, layering, error model, IPC/DTO/event conventions, storage, and ADRs, it uses the spine verbatim and does not contradict it. New DTOs proposed here are additions to `ns-types` (the frozen SoT) and require the normal ADR + `appSchemaVersion` bump before merge.

---

## 1. Responsibilities & Boundaries

### 1.1 In scope (this team owns)

The decentralized-security domain of NATS, plus the app's own audit trail:

1. **Credential material & key management**
   - NKey generation for **all prefixes**: Operator (`O`), Account (`A`), User (`U`), Server (`N`), Cluster (`C`), Curve/xkey (`X`) — seed (`S...`) + public key derivation.
   - Sign / verify with an NKey (nonce challenge, arbitrary payload).
   - `.creds` file parsing (JWT + seed extraction) and generation (compose a `.creds` from a user JWT + user seed).
2. **JWT (decentralized auth) decode + display + generation**
   - Decode & structurally validate Operator / Account / User JWTs (`nats/jwt` v2 claims: `nats` block, `iss`, `sub`, `aud`, `exp`, `iat`, `jti`, `type`, tagged claims).
   - Verify the issuer signature chain (User signed by Account, Account signed by Operator, Operator self-signed / signing keys).
   - Generate / re-sign JWTs (issue a User under an Account signing key, issue an Account under an Operator signing key) — **generation is an explicit, gated action**.
3. **Operator / Account / User model** — a strongly-typed in-memory hierarchy assembled from imported JWTs/creds, with limits, signing keys, imports/exports, and expiry surfaced for display.
4. **Permission editor domain** — publish/subscribe `allow`/`deny` sets, `allow_responses` (response permissions: `max` + `expires`), subject-token validation, and diffing before re-issue.
5. **Certificate inspection** — parse & display X.509 leaf/chain from a `.pem`/`.crt`/`.der` (or pulled from a live TLS handshake via the connection subsystem): subject, issuer, SAN, validity window, key usage, fingerprints, chain validity.
6. **TLS `ClientConfig` builder (rustls)** — construct `rustls::ClientConfig` for `async-nats`/`reqwest` from a connection profile's trust settings (system roots, pinned custom CA, client cert/key, optional insecure-skip for lab use). *(This is consumed by `ns-connection` / `ns-nats`; we own the builder.)*
7. **`SecretStore`** — the OS keychain adapter (`keyring`) + encrypted fallback (XChaCha20-Poly1305 / `age`) per ADR-0013. **`ns-security` is the ONLY crate with `keyring`.**
8. **Authentication/authorization visualization model** — a computed graph/tree DTO (operator → accounts → users, signing-key edges, import/export links, effective-permission summary) for the FE to render.
9. **In-app audit log** — an append-only local record of security-relevant user actions (key generated, JWT issued, secret stored/rotated/deleted, creds imported/exported, permission edited, connection auth used). Exposed as a queryable, exportable, tamper-evident (hash-chained) log.

### 1.2 Explicitly out of scope (boundaries)

- **Actual connection / handshake** → `ns-connection` + `ns-nats`. We hand them a `rustls::ClientConfig` and resolved credential material; we never open sockets.
- **SQL** → all persistence goes through **ports** (`ns-core::ports`) implemented by `ns-storage`. `ns-security` has no `rusqlite`.
- **Event bus impl** → we emit through the `EventPublisher` port; the `EventBridge` (`ns-ipc`) forwards to the WebView.
- **Server-side NSC / account-server administration** — we do not push accounts to a running `nats-account-resolver` in v1 (open question §11). We decode/generate locally.
- **HTTP `/accountz`/`/authz`** monitoring parsing → `ns-monitor` owns those endpoints; we provide the JWT/claims decoders it may call via a pure function API.

### 1.3 Architectural placement

`ns-security` is **L1** (leaf-domain + adapter). It depends only on `ns-types` and `ns-core` (ports). It implements ports (`SecretStore`) and consumes ports (`AuditRepo`, `EventPublisher`, `Clock`) that the **bin** injects. It exposes a `SecurityService` facade trait (behind `Arc<dyn SecurityService>` in `AppState`) plus pure adapter types. `ns-connection` depends on `ns-security` for the TLS builder + credential resolution (spine §row `ns-connection`).

```
        ns-types ──► ns-core (ports: SecretStore, AuditRepo, EventPublisher, Clock, Redacted<T>)
            │            ▲
            └────────────┤
                     ns-security (L1)  ── implements SecretStore; consumes AuditRepo/EventPublisher/Clock
                         ▲
                         │ (TLS builder + cred resolution)
                     ns-connection (L2)
```

---

## 2. Rust Public Interface (`ns-security`)

Crate error enum (one per crate, `thiserror`, implements `ns_core::DomainError`):

```rust
// crates/ns-security/src/error.rs
#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    #[error("invalid nkey: {0}")]
    InvalidNKey(String),
    #[error("nkey prefix mismatch: expected {expected:?}, got {got:?}")]
    PrefixMismatch { expected: KeyPrefix, got: KeyPrefix },
    #[error("signature verification failed")]
    SignatureInvalid,
    #[error("jwt decode failed: {0}")]
    JwtDecode(String),
    #[error("jwt signature chain invalid: {0}")]
    JwtChainInvalid(String),
    #[error("jwt expired at {expires}")]
    JwtExpired { expires: OffsetDateTime },
    #[error("creds parse failed: {0}")]
    CredsParse(String),
    #[error("certificate parse failed: {0}")]
    CertParse(String),
    #[error("tls config build failed: {0}")]
    TlsBuild(String),
    #[error("secret store unavailable: {0}")]
    SecretStoreUnavailable(String),
    #[error("secret not found for reference {0}")]
    SecretNotFound(String),
    #[error("audit store error")]
    Audit(#[from] Box<dyn std::error::Error + Send + Sync>), // wraps AuditRepo port error
    #[error("invalid subject permission: {0}")]
    InvalidPermission(String),
    #[error("operation cancelled")]
    Cancelled,
}

impl ns_core::DomainError for SecurityError {
    fn code(&self) -> ns_types::ErrorCode { /* map each variant, see §2.7 */ }
    fn retriable(&self) -> bool { matches!(self, SecurityError::SecretStoreUnavailable(_)) }
    fn user_message(&self) -> String { /* secret-safe copy */ }
}
```

### 2.1 The facade — `SecurityService`

Everything the bin registers as `security_*` commands delegates to this port. All methods are `async` (audit writes + secret-store IO are async via the ports); pure crypto is sync internally but wrapped.

```rust
// crates/ns-security/src/service.rs
#[async_trait::async_trait]
pub trait SecurityService: Send + Sync + 'static {
    // ---- NKeys ----
    fn generate_nkey(&self, prefix: KeyPrefix) -> Result<GeneratedKey, SecurityError>;
    fn derive_public_key(&self, seed: &Redacted<String>) -> Result<PublicKeyInfo, SecurityError>;
    fn sign(&self, seed: &Redacted<String>, payload: &[u8]) -> Result<Vec<u8>, SecurityError>;
    fn verify(&self, public_key: &str, payload: &[u8], sig: &[u8]) -> Result<(), SecurityError>;

    // ---- Creds ----
    fn parse_creds(&self, contents: &Redacted<String>) -> Result<ParsedCreds, SecurityError>;
    fn build_creds(&self, user_jwt: &str, user_seed: &Redacted<String>)
        -> Result<Redacted<String>, SecurityError>;

    // ---- JWT decode / verify / generate ----
    fn decode_jwt(&self, token: &str) -> Result<DecodedJwt, SecurityError>;
    fn verify_jwt_chain(&self, req: VerifyChainRequest) -> Result<ChainVerification, SecurityError>;
    fn issue_user_jwt(&self, req: IssueUserJwtRequest)   // signs with an Account (signing) key
        -> Result<IssuedJwt, SecurityError>;
    fn issue_account_jwt(&self, req: IssueAccountJwtRequest) // signs with an Operator key
        -> Result<IssuedJwt, SecurityError>;

    // ---- Hierarchy / visualization ----
    fn build_hierarchy(&self, req: BuildHierarchyRequest) -> Result<SecurityHierarchy, SecurityError>;
    fn build_authz_graph(&self, req: BuildHierarchyRequest) -> Result<AuthzGraph, SecurityError>;

    // ---- Permissions ----
    fn validate_permissions(&self, perms: &PermissionSet) -> Result<PermissionValidation, SecurityError>;
    fn diff_permissions(&self, before: &PermissionSet, after: &PermissionSet) -> PermissionDiff;

    // ---- Certificates ----
    fn inspect_certificate(&self, pem_or_der: &CertInput) -> Result<CertificateChain, SecurityError>;

    // ---- TLS builder (consumed by ns-connection) ----
    fn build_client_tls(&self, req: &TlsProfile) -> Result<std::sync::Arc<rustls::ClientConfig>, SecurityError>;

    // ---- Secret store (delegates to SecretStore port) ----
    async fn store_secret(&self, ref_: SecretRef, value: Redacted<String>, ctx: AuditCtx)
        -> Result<(), SecurityError>;
    async fn get_secret(&self, ref_: &SecretRef) -> Result<Redacted<String>, SecurityError>;
    async fn delete_secret(&self, ref_: &SecretRef, ctx: AuditCtx) -> Result<(), SecurityError>;
    async fn secret_store_status(&self) -> SecretStoreStatus;

    // ---- Audit ----
    async fn record_audit(&self, entry: NewAuditEntry) -> Result<(), SecurityError>;
    async fn query_audit(&self, q: AuditQuery) -> Result<AuditPage, SecurityError>;
    async fn verify_audit_integrity(&self) -> Result<AuditIntegrity, SecurityError>;
    async fn export_audit(&self, q: AuditQuery, fmt: AuditExportFormat) -> Result<Vec<u8>, SecurityError>;
}
```

### 2.2 Default implementation & construction

```rust
pub struct DefaultSecurityService {
    secrets: Arc<dyn SecretStore>,          // ns-core port; impl below (KeychainSecretStore)
    audit:   Arc<dyn AuditRepo>,            // ns-core port; impl in ns-storage
    events:  Arc<dyn EventPublisher>,       // ns-core port; impl in ns-event
    clock:   Arc<dyn Clock>,                // ns-core port
    nkeys:   NKeyEngine,                    // wraps `nkeys` crate
    jwt:     JwtEngine,                     // wraps `nats-jwt`/`jsonwebtoken`-style decode + ed25519 verify
    x509:    X509Inspector,                 // wraps `x509-parser` + `rustls-pki-types`
    tls:     TlsConfigBuilder,              // wraps rustls + rustls-native-certs (feature-gated)
}

impl DefaultSecurityService {
    pub fn new(
        secrets: Arc<dyn SecretStore>,
        audit: Arc<dyn AuditRepo>,
        events: Arc<dyn EventPublisher>,
        clock: Arc<dyn Clock>,
    ) -> Self { /* ... */ }
}
```

### 2.3 Ports we implement (in `ns-security`)

```rust
// SecretStore is DEFINED in ns-core::ports, IMPLEMENTED here.
#[async_trait::async_trait]
pub trait SecretStore: Send + Sync {            // (ns_core::ports::SecretStore)
    async fn set(&self, r: &SecretRef, v: &Redacted<String>) -> Result<(), SecretStoreError>;
    async fn get(&self, r: &SecretRef) -> Result<Redacted<String>, SecretStoreError>;
    async fn delete(&self, r: &SecretRef) -> Result<(), SecretStoreError>;
    async fn status(&self) -> SecretStoreStatus;
}

pub struct KeychainSecretStore { /* keyring::Entry factory + backend selection */ }
pub struct EncryptedFileSecretStore { /* age/XChaCha20-Poly1305, OS-protected key */ }
// Composite tries keychain first, falls back to encrypted file on headless Linux (ADR-0013).
pub struct LayeredSecretStore { primary: KeychainSecretStore, fallback: EncryptedFileSecretStore }
```

`SecretRef` is an opaque, non-secret pointer stored in SQLite by `ns-connection`/profiles: `SecretRef { service: String /* "nats-studio" */, account: String /* e.g. "conn:{ConnectionId}:seed" */ }`.

### 2.4 Ports we consume (defined in `ns-core`, injected by bin)

```rust
// ns-core::ports — AuditRepo (NEW — this team specifies it; ns-storage implements it)
#[async_trait::async_trait]
pub trait AuditRepo: Send + Sync {
    async fn append(&self, entry: AuditRecord) -> Result<AuditSeq, StoragePortError>;
    async fn last(&self) -> Result<Option<AuditRecord>, StoragePortError>;   // for hash chaining
    async fn query(&self, q: AuditQuery) -> Result<Vec<AuditRecord>, StoragePortError>;
    async fn count(&self, q: &AuditQuery) -> Result<u64, StoragePortError>;
    async fn prune(&self, retain: RetentionPolicy) -> Result<u64, StoragePortError>;
}
```

Other subsystems record audit entries through a lightweight **sink** re-exported from `ns-core` so they do not depend on `ns-security`:

```rust
// ns-core::ports — an object-safe fire-and-forget sink; DefaultSecurityService implements it.
#[async_trait::async_trait]
pub trait AuditSink: Send + Sync {
    async fn record(&self, entry: NewAuditEntry);   // never returns error to caller; logs+drops on failure
}
```

### 2.5 Key value objects (owned domain types, non-DTO)

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyPrefix { Operator, Account, User, Server, Cluster, Curve /* xkey */ }

pub struct GeneratedKey { pub prefix: KeyPrefix, pub public_key: String, pub seed: Redacted<String> }
pub struct PublicKeyInfo { pub prefix: KeyPrefix, pub public_key: String }

pub struct ParsedCreds {
    pub jwt: String,                    // user JWT (safe to display, but issuer subjects shown)
    pub seed: Redacted<String>,         // U-seed
    pub decoded: DecodedJwt,
}
```

### 2.6 Redaction contract

- Seeds, `.creds` bodies, private keys, client-key PEM, keychain values are always `Redacted<String>`/`Redacted<Vec<u8>>` (`Debug`/`Display` → `***`).
- JWTs are **not** secrets per se (they are bearer tokens but signed, public-claim), yet a **user JWT paired with its seed forms a credential** — so the *combination* in `.creds` is redacted; a standalone decoded JWT for display is allowed but the raw compact token is shown only in the JWT inspector, never logged.
- The single serialization surface `ns_ipc::to_ipc_error` + the tracing scrubber guarantee no secret escapes. We add a `secret scrubber` regex set for `S[OAUNXC][A-Z2-7]{56}` (seeds) and PEM private-key blocks as defense-in-depth.

### 2.7 `ErrorCode` mapping

| Variant | `ErrorCode` |
|---|---|
| `InvalidNKey`, `PrefixMismatch` | `INVALID_ARGUMENT` |
| `SignatureInvalid`, `JwtChainInvalid` | `AUTH_FAILED` |
| `JwtExpired` | `AUTH_FAILED` |
| `JwtDecode`, `CredsParse`, `CertParse` | `SERIALIZATION` |
| `TlsBuild` | `TLS_ERROR` |
| `SecretStoreUnavailable` | `SECRET_STORE_UNAVAILABLE` |
| `SecretNotFound` | `NOT_FOUND` |
| `InvalidPermission` | `SUBJECT_INVALID` |
| `Cancelled` | `CANCELLED` |
| `Audit` | `STORAGE` |

*(No new `ErrorCode`s required; all exist in the spine enum.)*

---

## 3. DTOs added to `ns-types` (typeshared, camelCase, tagged enums)

All are `#[serde(rename_all="camelCase")]`; enums that carry data use `#[serde(tag="kind", content="data")]`; timestamps are RFC-3339 strings; durations are `u64` ms; bytes are base64 with an `encoding` field. IDs are string newtypes.

```rust
// ns-types/src/security.rs  (excerpt — signatures only)

pub struct GeneratedKeyDto { pub prefix: KeyPrefixDto, pub publicKey: String,
                             pub seedRef: SecretRefDto /* seed lands in keychain, not returned raw by default */,
                             pub seedRevealed: Option<String> /* only when reveal=true & audited */ }

pub enum KeyPrefixDto { Operator, Account, User, Server, Cluster, Curve }

pub struct DecodedJwtDto {
    pub raw: String,                         // compact token (inspector only)
    pub header: JwtHeaderDto,                // alg (ed25519-nkey), typ (JWT)
    pub jwtType: NatsJwtType,                // Operator | Account | User | Generic
    pub subject: String, pub issuer: String, pub name: Option<String>,
    pub issuedAt: Option<String>, pub expires: Option<String>, pub jti: Option<String>,
    pub nats: NatsClaimsDto,                 // tagged union by jwtType
    pub signatureValid: Option<bool>,        // when a verifying key was supplied
    pub warnings: Vec<JwtWarningDto>,        // expired, notYetValid, weakAlg, missingExp, etc.
}
pub enum NatsJwtType { Operator, Account, User, Generic }
pub enum NatsClaimsDto {                      // tag=kind, content=data
    Operator(OperatorClaimsDto),              // signingKeys, accountServerUrl, operatorServiceUrls, strictSigning
    Account(AccountClaimsDto),                // limits, signingKeys, imports, exports, defaultPermissions, revocations
    User(UserClaimsDto),                      // pub/sub permissions, resp, src (allowed CIDRs), times, limits, issuerAccount, bearerToken
    Generic(serde_json::Value),               // the one allowed Json escape
}

pub struct PermissionSetDto {
    pub publish: PermissionRulesDto,          // allow: Vec<String>, deny: Vec<String>
    pub subscribe: PermissionRulesDto,
    pub responses: Option<ResponsePermissionDto>, // max: u32, expiresMs: u64
}
pub struct PermissionValidationDto { pub ok: bool, pub issues: Vec<PermissionIssueDto> }
pub struct PermissionDiffDto { pub added: PermissionSetDto, pub removed: PermissionSetDto, pub changed: bool }

pub struct CertificateChainDto { pub leaf: CertificateDto, pub intermediates: Vec<CertificateDto>,
                                 pub root: Option<CertificateDto>, pub chainValid: Option<bool>,
                                 pub validationError: Option<String> }
pub struct CertificateDto {
    pub subject: DistinguishedNameDto, pub issuer: DistinguishedNameDto,
    pub serialHex: String, pub notBefore: String, pub notAfter: String, pub expired: bool,
    pub sans: Vec<String>, pub keyUsage: Vec<String>, pub extKeyUsage: Vec<String>,
    pub sigAlg: String, pub publicKeyAlg: String, pub isCa: bool,
    pub fingerprintSha256: String, pub fingerprintSha1: String, pub pemLength: u32,
}

pub struct SecurityHierarchyDto { pub operators: Vec<OperatorNodeDto> } // operator→accounts→users tree
pub struct AuthzGraphDto { pub nodes: Vec<AuthzNodeDto>, pub edges: Vec<AuthzEdgeDto> } // for graph view
pub struct AuthzNodeDto { pub id: String, pub kind: AuthzNodeKind /* Operator|Account|User|SigningKey */,
                          pub label: String, pub expires: Option<String>, pub revoked: bool }
pub struct AuthzEdgeDto { pub from: String, pub to: String, pub kind: AuthzEdgeKind /* Signs|Imports|Exports|SigningKeyOf */ }

pub struct SecretStoreStatusDto { pub backend: SecretBackendDto /* Keychain|EncryptedFile|Unavailable */,
                                  pub writable: bool, pub detail: Option<String> }

// Audit
pub struct AuditEntryDto {
    pub seq: u64, pub ts: String, pub action: AuditActionDto, pub actor: String /* "local-user" */,
    pub connectionId: Option<String>, pub target: Option<String>,
    pub outcome: AuditOutcomeDto /* Success | Failure | Denied */,
    pub detail: Option<serde_json::Value>, pub prevHash: String, pub hash: String,
}
pub enum AuditActionDto {
    NKeyGenerated, JwtDecoded, JwtIssued, CredsImported, CredsExported,
    SecretStored, SecretRevealed, SecretRotated, SecretDeleted,
    PermissionEdited, CertificateInspected, TlsProfileChanged, ConnectionAuthUsed, AuditExported,
}
pub struct AuditPageDto { pub items: Vec<AuditEntryDto>, pub nextCursor: Option<String>, pub total: Option<u64> }
pub struct AuditIntegrityDto { pub ok: bool, pub checkedCount: u64, pub firstBrokenSeq: Option<u64> }

// Requests/Responses follow <Verb><Noun>Request/Response naming — omitted for brevity, one per command in §4.
```

**Generics policy:** paginated audit uses a **monomorphized** `AuditPageDto` (not `Page<T>`) per the spine's typeshare guidance.

---

## 4. Tauri IPC Commands (namespace `security_*`)

All commands: `#[tauri::command] async fn ...(req: XxxRequest, state: State<AppState>, ctx: CommandCtx) -> Result<XxxResponse, IpcError>`. Registered in `apps/desktop/src-tauri/src/commands/security.rs`. One `req` arg, typed via `packages/ns-bindings` wrappers (`ipc.security.*`). "Kind" = request (unary), stream (Channel), or command (fire-and-forget-ish unary).

| Command | Kind | Params (`req`) | Returns | Primary errors |
|---|---|---|---|---|
| `security_generate_nkey` | request | `{ prefix, persist?: SecretRef, reveal?: bool }` | `GeneratedKeyDto` | `INVALID_ARGUMENT`, `SECRET_STORE_UNAVAILABLE` |
| `security_derive_public_key` | request | `{ seed }` (seed via secretRef **or** inline redacted) | `PublicKeyInfoDto` | `INVALID_ARGUMENT` |
| `security_sign` | request | `{ seedRef, payloadB64 }` | `{ signatureB64 }` | `INVALID_ARGUMENT`, `NOT_FOUND` |
| `security_verify` | request | `{ publicKey, payloadB64, signatureB64 }` | `{ valid: bool }` | `AUTH_FAILED` |
| `security_parse_creds` | request | `{ contents /* redacted */, persist?: SecretRef }` | `ParsedCredsDto` (seed redacted/stored) | `SERIALIZATION`, `SECRET_STORE_UNAVAILABLE` |
| `security_build_creds` | request | `{ userJwt, userSeedRef }` | `{ credsRef: SecretRef }` (written to keychain; optional file export separate) | `SERIALIZATION`, `NOT_FOUND` |
| `security_decode_jwt` | request | `{ token, verifyWith?: string[] /* issuer pubkeys */ }` | `DecodedJwtDto` | `SERIALIZATION`, `AUTH_FAILED` |
| `security_verify_jwt_chain` | request | `{ userJwt?, accountJwt?, operatorJwt? }` | `ChainVerificationDto` | `AUTH_FAILED` |
| `security_issue_user_jwt` | command | `{ accountSigningKeyRef, claims: UserClaimsInputDto }` | `IssuedJwtDto` | `INVALID_ARGUMENT`, `NOT_FOUND`, `SUBJECT_INVALID` |
| `security_issue_account_jwt` | command | `{ operatorSigningKeyRef, claims: AccountClaimsInputDto }` | `IssuedJwtDto` | same as above |
| `security_build_hierarchy` | request | `{ jwts: string[], credsRefs?: SecretRef[] }` | `SecurityHierarchyDto` | `SERIALIZATION` |
| `security_build_authz_graph` | request | `{ jwts: string[] }` | `AuthzGraphDto` | `SERIALIZATION` |
| `security_validate_permissions` | request | `{ permissions: PermissionSetDto }` | `PermissionValidationDto` | `SUBJECT_INVALID` |
| `security_diff_permissions` | request | `{ before, after }` | `PermissionDiffDto` | — |
| `security_inspect_certificate` | request | `{ input: CertInputDto /* {kind: Pem\|Der\|File, data} */ }` | `CertificateChainDto` | `SERIALIZATION`, `IO` |
| `security_inspect_connection_cert` | request | `{ connectionId }` (pulls peer cert via ns-connection port) | `CertificateChainDto` | `CONNECTION_CLOSED`, `TLS_ERROR` |
| `security_secret_store_status` | request | `{}` | `SecretStoreStatusDto` | — |
| `security_store_secret` | command | `{ ref, value /* redacted */ }` | `{ ok: true }` | `SECRET_STORE_UNAVAILABLE` |
| `security_reveal_secret` | command | `{ ref, reason?: string }` | `{ value /* redacted-in-transit? no: explicit reveal */ }` | `NOT_FOUND`, `SECRET_STORE_UNAVAILABLE` |
| `security_delete_secret` | command | `{ ref }` | `{ ok: true }` | `NOT_FOUND` |
| `security_audit_query` | request | `{ cursor?, limit, filter?: AuditFilterDto }` | `AuditPageDto` | `STORAGE` |
| `security_audit_verify` | request | `{}` | `AuditIntegrityDto` | `STORAGE` |
| `security_audit_export` | command | `{ filter?, format: Csv\|Json\|Jsonl }` | `{ bytesB64, filename }` | `STORAGE` |

Notes:
- **`security_reveal_secret`** is the single sanctioned path that returns a secret in cleartext to the WebView; it always writes a `SecretRevealed` audit entry and is gated by a confirm dialog + optional reason. All other commands keep secrets in the backend and return only `SecretRef`s.
- **`security_inspect_connection_cert`** depends on a small `PeerCertProvider` port exposed by `ns-connection` (returns the DER chain captured during the last handshake). We consume it via `AppState.connections`.
- Generation commands (`issue_*`) are the mutating, sensitive surface — each audits and emits a `Notification` event.

---

## 5. Events Emitted

Emitted via `EventPublisher` (domain) → `EventBridge` (`ns-ipc`) → Tauri events. All are **ambient broadcasts** (not request-scoped), so they use bridged events, not Channels. Payloads are variants of `ns_types::EventPayload` (we add the ones below via ADR).

| Bus payload variant | Tauri event name | When | Coalescing |
|---|---|---|---|
| `SecurityAuditAppended(AuditEntryDto)` | `ns://security/audit` | every audit append | none (never drop; audit matters) — bounded queue, order preserved |
| `SecretStoreStatusChanged(SecretStoreStatusDto)` | `ns://security/secret-store` | backend becomes unavailable / recovers | dedupe consecutive identical states |
| `Notification(NotificationDto)` | `ns://notification` | key generated / JWT issued / secret revealed / creds imported | never drop |
| `JwtExpiryWarning(JwtExpiryDto)` | `ns://security/jwt-expiry` | a tracked operator/account/user JWT is < 7d from expiry (scheduler tick) | keep-latest per subject |

We **do not** own a metrics tick. `JwtExpiryWarning` is produced by an optional lightweight background task (see §7) that re-checks imported JWTs on an interval.

---

## 6. Frontend Surface (`apps/desktop/src/features/security`)

### 6.1 Routes (React Router)

- `/security` → Security overview (hierarchy + secret-store status + audit summary)
- `/security/keys` → NKey generator & signer/verifier
- `/security/jwt` → JWT inspector / decoder (paste or pick from creds)
- `/security/jwt/issue` → JWT issuer (User/Account) — gated wizard
- `/security/permissions` → Permission editor (standalone or embedded in issue wizard)
- `/security/certificates` → Certificate inspector
- `/security/audit` → Audit log viewer/export
- Embeddable panels (dockview) surfaced into other views: `SecurityHierarchyPanel`, `AuthzGraphPanel`, `ConnectionCertPanel` (opened from Connection Manager's TLS tab).

### 6.2 Components / panels

- `NKeyGeneratorPanel` (prefix picker, generate, copy-public, reveal-seed w/ confirm, store-to-keychain)
- `SignVerifyPanel`
- `JwtInspector` (Monaco read-only JSON of decoded claims + a claims tree + signature/expiry badges + warnings list)
- `JwtIssueWizard` (pick signing key → identity → `PermissionEditor` → limits → review diff → issue → export/store)
- `PermissionEditor` (two allow/deny lists for pub & sub with subject-token validation, response-permission fields, live validation via `security_validate_permissions`, diff view)
- `CertificateInspector` (drop `.pem`/`.crt`/`.der` or "inspect current connection", chain accordion, fingerprint copy, validity timeline)
- `AuthzGraphPanel` (ECharts graph: operator→account→user, signing-key + import/export edges, expiry coloring)
- `SecurityHierarchyTree`
- `AuditLogTable` (virtualized, filterable by action/outcome/date/connection, integrity badge, export button)
- `SecretStoreStatusBadge` (global; reads status, warns on encrypted-fallback/unavailable)

### 6.3 Zustand store (UI/session only — never mirrors server-state)

`useSecurityUiStore`:
- `activeTab`, editor buffers for pasted JWT/PEM (Monaco unsaved text), permission-editor draft (`PermissionSetDto` being edited before submit), `revealConfirmOpen`, `auditFilterDraft`, selected node in hierarchy/graph, wizard step state. Persisted slices: none beyond last-used prefix + audit filter preset (mirrored to SettingsRepo via `settings_*`).

### 6.4 TanStack Query keys (all server-state)

```
['security','secretStoreStatus']
['security','decodeJwt', tokenHash]
['security','hierarchy', jwtsHash]
['security','authzGraph', jwtsHash]
['security','cert', inputHash]
['security','connectionCert', connectionId]
['security','audit', filter, cursor]
['security','auditIntegrity']
['security','validatePermissions', permsHash]   // or run as mutation for editor live-check
```

Mutations (invalidate the relevant keys + `['security','audit',...]`): `generateNKey`, `parseCreds`, `issueUserJwt`, `issueAccountJwt`, `storeSecret`, `revealSecret`, `deleteSecret`, `buildCreds`, `auditExport`.

### 6.5 IPC client calls (`packages/ns-bindings`, `ipc.security.*`)

`generateNKey`, `derivePublicKey`, `sign`, `verify`, `parseCreds`, `buildCreds`, `decodeJwt`, `verifyJwtChain`, `issueUserJwt`, `issueAccountJwt`, `buildHierarchy`, `buildAuthzGraph`, `validatePermissions`, `diffPermissions`, `inspectCertificate`, `inspectConnectionCert`, `secretStoreStatus`, `storeSecret`, `revealSecret`, `deleteSecret`, `auditQuery`, `auditVerify`, `auditExport` — each paired in `commands.manifest.ts` with its Request/Response type so a rename breaks the TS build.

The global `useAppEvents()` hook routes `ns://security/audit` → `queryClient.setQueryData(['security','audit',...])` (prepend), `ns://security/secret-store` → `['security','secretStoreStatus']`, `ns://security/jwt-expiry` → notification toast + hierarchy badge.

---

## 7. Concurrency / Async & Backpressure

- **Pure crypto** (nkey gen/sign/verify, JWT decode/verify, X.509 parse, permission validation) is CPU-cheap and synchronous; the `async` facade methods run them inline. Only bulk/large inputs (a big cert bundle, verifying a big JWT set) are wrapped in `spawn_blocking` with a size threshold to avoid stalling the tokio worker.
- **Secret-store IO** (`keyring`) can block (DBus/Keychain/Credential Manager). All `SecretStore` calls go through `spawn_blocking` inside the adapter so we never block an async worker; a per-store `tokio::sync::Semaphore(1)` serializes keychain access to avoid backend races on Linux Secret Service.
- **Audit writes** go through the storage worker (single-writer task, ADR-0003), so ordering + the hash chain are naturally serialized. `record_audit` acquires `last()` and computes `hash = H(prevHash || canonical(entry))`; to avoid a read-modify-write race, the **AuditRepo `append` is the atomic point**: it computes the chain inside the storage worker's write transaction (we pass the entry sans hash; the repo assigns `seq`, reads prev inside the txn, sets `prevHash`/`hash`). This keeps the chain correct under concurrent appenders.
- **`AuditSink::record`** is fire-and-forget: it pushes onto a bounded `mpsc` drained by a dedicated task that calls `AuditRepo::append`. On overflow it drops-oldest **but emits a synthetic `AuditGap` entry** (never silently lose the fact that we dropped) and logs a `warn`. Callers (other subsystems) are never blocked.
- **Event emission**: `SecurityAuditAppended` and `Notification` are marked never-drop in the bridge's policy; the bounded queue preserves order. `JwtExpiryWarning` uses keep-latest-per-subject.
- **Cancellation**: only long/bulk ops (bulk hierarchy build over many creds, audit export of a huge range) accept a `CancellationToken` from the `CancellationRegistry`; they check it between items. Short crypto ops are not cancellable (sub-ms).
- **JWT-expiry scheduler**: one background task in `TaskRegistry`, interval (default 1h, setting-driven), iterates the set of currently-imported JWTs (held in `SecurityService`'s in-memory registry, `Arc<RwLock<...>>`), emits warnings. Cancelled on shutdown.
- **No global mutable statics.** In-memory JWT/hierarchy registry is `DashMap`/`RwLock` inside the service.

---

## 8. Data Model (SQLite — owned tables via `ns-storage`, ports here)

We own **no SQL** but specify the tables `ns-storage` must create (migration `NNNN_audit_and_security.sql`). Secrets never land here (ADR-0013).

```sql
-- audit_log: append-only, hash-chained
CREATE TABLE audit_log (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,                 -- RFC-3339
  action        TEXT NOT NULL,                 -- AuditActionDto discriminant
  actor         TEXT NOT NULL DEFAULT 'local-user',
  connection_id TEXT,                          -- nullable FK-ish (no hard FK; connections may be deleted)
  target        TEXT,                          -- e.g. subject, public key, secretRef.account (non-secret)
  outcome       TEXT NOT NULL,                 -- Success|Failure|Denied
  detail_json   TEXT,                          -- non-secret structured detail
  prev_hash     TEXT NOT NULL,                 -- hex sha256; genesis = 64 zeros
  hash          TEXT NOT NULL                  -- sha256(prev_hash || canonical_entry)
);
CREATE INDEX idx_audit_ts     ON audit_log(ts);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_conn   ON audit_log(connection_id);

-- security_material: NON-SECRET references + display metadata for imported operators/accounts/users.
-- Raw JWTs stored here are signed, public claims (safe); seeds/creds live ONLY in the keychain.
CREATE TABLE security_material (
  id            TEXT PRIMARY KEY,              -- uuid
  kind          TEXT NOT NULL,                 -- Operator|Account|User
  subject       TEXT NOT NULL,                 -- nkey public (the JWT 'sub')
  issuer        TEXT NOT NULL,                 -- 'iss'
  name          TEXT,
  jwt           TEXT,                          -- compact token (public); nullable
  seed_secret_ref TEXT,                        -- keychain reference string (NOT the seed)
  expires       TEXT,                          -- RFC-3339 nullable
  created_at    TEXT NOT NULL,
  UNIQUE(subject, kind)
);
CREATE INDEX idx_secmat_issuer ON security_material(issuer);
```

- **Retention:** `audit_log` bounded by size + TTL (user-configurable, default keep 90 days / 100k rows), enforced by the storage worker's `prune`. Pruning the oldest rows breaks the chain prefix by design; `verify_audit_integrity` verifies from the earliest retained row (its `prev_hash` becomes the trusted anchor recorded in `SettingsRepo`).
- **Repositories (ports, this team specifies; `ns-storage` implements):** `AuditRepo` (§2.4) and `SecurityMaterialRepo` (CRUD over `security_material`).
- Keychain entries (the actual secrets) are keyed by `SecretRef { service:"nats-studio", account }` — e.g. `conn:{ConnectionId}:seed`, `nkey:{publicKey}:seed`, `creds:{materialId}`.

---

## 9. Dependencies

**We depend on (crates):** `ns-types`, `ns-core` (ports + `Redacted<T>`), and third-party: `nkeys`, `nats-jwt` (or hand-rolled ed25519 via `ed25519-dalek` + base32 nkey codec — see open Q), `data-encoding` (base32/base64), `rustls`, `rustls-native-certs` (feature `native-roots`), `rustls-pemfile`, `x509-parser`, `keyring`, `age`/`chacha20poly1305`, `sha2`, `time`, `async-trait`, `thiserror`, `tracing`, `zeroize`.

**We depend on (ports, injected by bin):** `AuditRepo`, `SecurityMaterialRepo`, `EventPublisher`, `Clock`, and `PeerCertProvider` (from `ns-connection`, for `security_inspect_connection_cert`).

**Who depends on us:**
- `ns-connection` — `SecurityService::build_client_tls` + credential resolution (seed/creds → `async-nats` auth) during connect; records `ConnectionAuthUsed` audit via `AuditSink`.
- `apps/desktop/src-tauri` (bin) — constructs `LayeredSecretStore` + `DefaultSecurityService`, registers `security_*` commands, injects our `AuditSink` into other services so they can record actions.
- `ns-monitor` — may call our pure `decode_jwt` to render `/accountz` claims (pure fn, no service dep).

**Cross-cutting alignment:** Security Model strategist (capabilities/CSP, redaction), Storage team (migration + repo impls), Connection team (`PeerCertProvider`, cred resolution), core-runtime (new `EventPayload`/`ErrorCode`/DTO additions land in `ns-types`/`ns-core` via ADR).

---

## 10. Test Plan

### 10.1 Unit (in `ns-security`, using `ns-testkit` builders + mock ports)
- **NKeys:** round-trip generate→derive→sign→verify for every `KeyPrefix`; seed prefix byte correctness; reject wrong-prefix seed; tamper-detect (flip a byte → `SignatureInvalid`).
- **JWT decode:** golden-file decode of known Operator/Account/User JWTs (fixtures generated with `nsc` and committed); assert claim mapping (limits, signing keys, imports/exports, permissions, `resp`). Expired/not-yet-valid/missing-`exp` → correct `warnings`. Signature verify against issuer pubkey; chain verify (user↔account↔operator) positive + negative (wrong issuer, revoked).
- **JWT issue:** issue a user under an account signing key → re-decode → claims match input; verify chain of the issued token against the account/operator; re-signing changes `iat`/`jti`.
- **Creds:** parse a real `.creds` (fixture) → jwt+seed; rebuild `.creds` from parts → byte-equivalent to canonical format; malformed creds → `CredsParse`.
- **Permissions:** subject-token validation (`>`, `*`, empty tokens, spaces) → `InvalidPermission`; diff add/remove/change; response-permission bounds.
- **Certificates:** parse PEM & DER fixtures (leaf+chain, self-signed, expired, wildcard SAN); fingerprints match `openssl` output; chain-valid vs broken chain.
- **Redaction:** `Debug`/`Display` of `Redacted<Seed>`/`ParsedCreds` prints `***`; scrubber removes seeds/PEM-private-key from a sample log line; `to_ipc_error` on a `SecurityError` carrying a seed in context never leaks it.
- **Audit chaining:** append N entries → `hash[i] == H(hash[i-1] || entry_i)`; `verify_audit_integrity` ok; corrupt one row → `firstBrokenSeq` correct; concurrent appends (spawn many `AuditSink::record`) → chain stays valid & totally ordered (mock repo runs on single worker).

### 10.2 Integration (`ns-security` + real `ns-storage` sqlite temp DB + real keychain-mock)
- `SecretStore`: `KeychainSecretStore` against a mock keyring backend; `EncryptedFileSecretStore` round-trip (set/get/delete, wrong-key → fail, tamper → auth fail); `LayeredSecretStore` falls back when primary reports unavailable; `SecretStoreStatusChanged` emitted on transition (mock `EventPublisher` records it).
- `AuditRepo` against real sqlite: append/query/count/prune; prune preserves chain-verify from new anchor; pagination cursor stability.
- End-to-end command layer: drive each `security_*` command through `ns-ipc` mapping and assert the returned DTO + that the corresponding `AuditEntryDto` was appended and `ns://security/audit` emitted.

### 10.3 E2E (Tauri app + WebView, using `ns-testkit` embedded `nats-server` where auth applies)
- Boot `nats-server` with an **operator/account/user (JWT+resolver) config** and a committed `.creds`; in the app: import creds → hierarchy renders → connect via Connection Manager using our resolved creds → `ConnectionAuthUsed` appears in the audit log.
- TLS: boot `nats-server` with a self-signed cert; "inspect current connection" shows the leaf cert matching the fixture fingerprint; connecting with pinned custom CA succeeds, with wrong CA → `TLS_ERROR` surfaced.
- JWT issue wizard: generate account nkey → issue a user with edited permissions → export `.creds` → use it to connect to the running server (proves the issued token is server-valid). Requires `nats-server` supporting the operator; guarded behind the `has-nats-binaries` test gate (ADR-0016).
- Audit viewer: filter, export CSV/JSON, integrity badge; reveal-secret flow requires confirm and writes `SecretRevealed`.

### 10.4 Property / fuzz
- `proptest` on subject-permission parser and JWT/base32 nkey decoder (never panic on arbitrary input; malformed → typed error).
- Fuzz X.509 parser inputs (`cargo-fuzz` target) — parse must never panic, only return `CertParse`.

---

## 11. Risks & Open Questions

1. **JWT library choice.** `nats-jwt` (rust) maturity vs hand-rolling ed25519-nkey JWT encode/decode on `ed25519-dalek` + `data-encoding`. Hand-roll gives control over the exact NATS claim schema and generation (issuing), but is more surface to test. **Leaning: hand-rolled decode/encode confined to `JwtEngine`, validated against `nsc`-generated golden files.** Needs an ADR.
2. **Issuing JWTs / server administration.** v1 generates tokens locally; it does **not** push accounts to a running `nats-account-resolver` or memory-resolver. Do we add `nsc`-style resolver upload / `$SYS` account operations later? (Big security surface — deferred, open.)
3. **Audit tamper-evidence strength.** Hash-chaining detects post-hoc edits but not deletion+re-chain by someone with DB access and the app's hashing logic. Optional HMAC keyed by an OS-protected key (like the encrypted-secrets key) would raise the bar. Decide whether to sign the chain head periodically.
4. **Retention vs auditability conflict.** Pruning old entries breaks the chain prefix; we anchor on the earliest retained row. Some users may want "never prune security audit" — expose as a setting; document the size implications.
5. **Secret-store portability.** Linux Secret Service (GNOME Keyring/KWallet) availability varies; headless/CI has none. Fallback encrypted store's master key must be OS-protected without a keychain — where do we root trust on headless Linux (file perms + machine-id-derived key)? Needs security-model sign-off.
6. **`PeerCertProvider` coupling.** Requires `ns-connection` to capture and retain the peer DER chain from the rustls handshake (a `ServerCertVerifier` hook). Contract + lifetime (only last handshake?) to be agreed with the Connection team.
7. **Reveal-secret in WebView.** Returning cleartext to JS puts a secret in WebView memory/DOM briefly. Mitigate: reveal only on explicit user action, auto-clear from UI state after N seconds, never store in Zustand-persisted slices, always audit. Confirm CSP/clipboard policy with security-model.
8. **DTO additions freeze.** All §3 DTOs + §5 `EventPayload` variants + the `AuditRepo`/`SecurityMaterialRepo`/`AuditSink`/`PeerCertProvider` ports are additions to frozen crates (`ns-types`, `ns-core`) — bundle them into a single ADR + `appSchemaVersion` bump before implementation starts.
9. **`zeroize` coverage.** Ensure seeds/keys are zeroized on drop through the crypto path (nkeys/dalek buffers), not just the `Redacted<T>` wrapper. Audit the third-party crates for zeroization guarantees.
```
