//! [`KeyringSecretStore`]: the [`ns_core::SecretStore`] port implemented over
//! the OS keychain via the `keyring` crate (Windows Credential Manager /
//! macOS Keychain Services / Linux Secret Service — selected at compile time
//! per target, see this crate's `Cargo.toml`).
//!
//! `keyring`'s blocking calls (DBus/Keychain/Credential Manager round trips)
//! never run on the async reactor: every operation is dispatched through
//! [`tokio::task::spawn_blocking`].

use keyring::Entry;
use ns_core::SecretString;

use crate::error::SecurityError;

/// Fixed keyring "service" every entry is stored under; the caller-supplied
/// `key` (e.g. `conn:{ConnectionId}:seed`) is the keyring "account/user".
const SERVICE_NAME: &str = "nats-studio";

/// Key used only by [`KeyringSecretStore::available`]'s round-trip probe.
/// Written, read back, and deleted again on every call — never left behind.
const PROBE_KEY: &str = "__ns_security_probe__";

/// [`ns_core::SecretStore`] backed by the OS keychain.
///
/// A missing entry is `Ok(None)` from [`get`](Self::get) — never an error;
/// only a genuinely broken/unreachable backend surfaces
/// [`SecurityError::SecretStoreUnavailable`] (mapped to
/// [`ns_types::ErrorCode::SecretStoreUnavailable`]).
///
/// # Headless Linux fallback (deferred)
/// `docs/architecture/xc-security-model.md` §4.3 describes an
/// encrypted-file vault fallback for hosts with no reachable keychain
/// backend (e.g. headless Linux with no Secret Service bus). That fallback
/// is deliberately **out of scope for Phase 1** (tracked as ADR-0013,
/// scheduled for Phase 6): this store is keychain-only, and a broken/absent
/// backend is surfaced honestly via [`available`](Self::available) — driving
/// a UI warning — rather than silently degrading to a weaker store.
#[derive(Debug, Clone, Default)]
pub struct KeyringSecretStore {
    service: String,
}

impl KeyringSecretStore {
    /// Build a store using the fixed `"nats-studio"` service name.
    #[must_use]
    pub fn new() -> Self {
        Self {
            service: SERVICE_NAME.to_owned(),
        }
    }

    /// Construct the keyring entry for `key`, rejecting an empty key up
    /// front (every backend would otherwise reject it anyway, with a less
    /// clear error).
    fn entry(&self, key: &str) -> Result<Entry, SecurityError> {
        if key.is_empty() {
            return Err(SecurityError::InvalidArgument(
                "secret store key must not be empty".to_owned(),
            ));
        }
        Entry::new(&self.service, key).map_err(|err| map_keyring_error(&err))
    }
}

#[async_trait::async_trait]
impl ns_core::SecretStore for KeyringSecretStore {
    async fn set(&self, key: &str, secret: SecretString) -> Result<(), ns_core::CoreError> {
        let store = self.clone();
        let key = key.to_owned();
        run_blocking(move || {
            let entry = store.entry(&key)?;
            entry
                .set_password(secret.expose())
                .map_err(|err| map_keyring_error(&err))
        })
        .await
    }

    async fn get(&self, key: &str) -> Result<Option<SecretString>, ns_core::CoreError> {
        let store = self.clone();
        let key = key.to_owned();
        let found = run_blocking(move || {
            let entry = store.entry(&key)?;
            match entry.get_password() {
                Ok(password) => Ok(Some(password)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(err) => Err(map_keyring_error(&err)),
            }
        })
        .await?;
        Ok(found.map(SecretString::new))
    }

    async fn delete(&self, key: &str) -> Result<(), ns_core::CoreError> {
        let store = self.clone();
        let key = key.to_owned();
        run_blocking(move || {
            let entry = store.entry(&key)?;
            match entry.delete_credential() {
                // Deleting an already-absent entry is not a failure —
                // "the secret is gone" is exactly the postcondition either
                // way, so `delete` is idempotent.
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(map_keyring_error(&err)),
            }
        })
        .await
    }

    async fn available(&self) -> bool {
        let store = self.clone();
        run_blocking(move || {
            let entry = store.entry(PROBE_KEY)?;
            let write = entry
                .set_password("ns-security-probe")
                .map_err(|err| map_keyring_error(&err));
            let read =
                write.and_then(|()| entry.get_password().map_err(|err| map_keyring_error(&err)));
            // Always clean up the probe entry, regardless of outcome —
            // never leave it behind in the real keychain.
            let _ = entry.delete_credential();

            match read {
                Ok(value) if value == "ns-security-probe" => Ok(()),
                Ok(_) => Err(SecurityError::SecretStoreUnavailable(
                    "keychain round-trip returned an unexpected value".to_owned(),
                )),
                Err(err) => Err(err),
            }
        })
        .await
        .is_ok()
    }
}

/// Run `f` on the blocking thread pool and flatten a worker-thread panic
/// into [`SecurityError::SecretStoreUnavailable`] (converted to
/// [`ns_core::CoreError`] at the port boundary either way).
async fn run_blocking<F, T>(f: F) -> Result<T, ns_core::CoreError>
where
    F: FnOnce() -> Result<T, SecurityError> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(inner) => inner.map_err(ns_core::CoreError::from),
        Err(_join_err) => Err(SecurityError::SecretStoreUnavailable(
            "secret store worker task panicked".to_owned(),
        )
        .into()),
    }
}

/// Map a `keyring::Error` to our domain error. Callers that need
/// `NoEntry` to mean "absent, not an error" (`get`/`delete`) match on it
/// themselves before falling back to this for everything else.
fn map_keyring_error(err: &keyring::Error) -> SecurityError {
    match err {
        keyring::Error::BadEncoding(_)
        | keyring::Error::TooLong(_, _)
        | keyring::Error::Invalid(_, _) => SecurityError::InvalidArgument(err.to_string()),
        // PlatformFailure, NoStorageAccess, NoEntry (reached only when a
        // caller didn't special-case it), Ambiguous, and any future
        // non-exhaustive variant: treat as the backend being unusable for
        // this operation.
        _ => SecurityError::SecretStoreUnavailable(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use ns_core::SecretStore as _;

    use super::*;

    /// Switch the process-wide default keyring backend to the crate's
    /// built-in in-memory mock (see `keyring::mock`). This is idempotent and
    /// safe to call from multiple tests: it never touches the real OS
    /// keychain, so these tests are deterministic on any machine (including
    /// headless CI with no Secret Service/Credential Manager).
    ///
    /// Note the mock has no persistence *across separately-constructed
    /// `Entry` instances* (each `Entry::new` call gets an independent,
    /// empty-by-default mock credential) — it only persists across calls
    /// made on the *same* `Entry`. That's enough to exercise
    /// `available()` (which builds one entry and round-trips on it) and the
    /// "missing entry" contract of `get`/`delete`, but not a full
    /// set-then-get round trip through the public port (each port method
    /// builds its own `Entry`) — that is instead covered by the `#[ignore]`d
    /// real-backend test below.
    fn use_mock_backend() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    }

    #[tokio::test]
    async fn get_on_missing_entry_is_ok_none() {
        use_mock_backend();
        let store = KeyringSecretStore::new();
        let found = store
            .get("ns-security-test-missing-key")
            .await
            .expect("missing entry must not be an error");
        assert!(found.is_none());
    }

    #[tokio::test]
    async fn delete_on_missing_entry_is_ok() {
        use_mock_backend();
        let store = KeyringSecretStore::new();
        store
            .delete("ns-security-test-missing-key-2")
            .await
            .expect("deleting an absent entry is idempotent, not an error");
    }

    #[tokio::test]
    async fn empty_key_is_invalid_argument() {
        use_mock_backend();
        let store = KeyringSecretStore::new();
        let err = store
            .set("", SecretString::new("x"))
            .await
            .expect_err("empty key must be rejected");
        assert_eq!(
            ns_core::DomainError::code(&err),
            ns_types::ErrorCode::InvalidArgument
        );
    }

    #[tokio::test]
    async fn available_round_trips_on_mock_backend() {
        use_mock_backend();
        let store = KeyringSecretStore::new();
        assert!(store.available().await);
    }

    #[test]
    fn maps_platform_failure_to_unavailable() {
        let err = keyring::Error::NoStorageAccess("locked".into());
        let mapped = map_keyring_error(&err);
        assert!(matches!(mapped, SecurityError::SecretStoreUnavailable(_)));
    }

    #[test]
    fn maps_invalid_attribute_to_invalid_argument() {
        let err = keyring::Error::Invalid("user".to_owned(), "too weird".to_owned());
        let mapped = map_keyring_error(&err);
        assert!(matches!(mapped, SecurityError::InvalidArgument(_)));
    }

    /// Exercises the real OS keychain backend (Windows Credential Manager on
    /// this dev machine): set → get (matches) → delete → get (gone again).
    /// Cleanup (`delete`) always runs before any assertion that could panic,
    /// and uses a process-id-scoped key so concurrent runs don't collide.
    ///
    /// Ignored by default: a headless/CI machine may have no reachable
    /// keychain backend at all, and this test must never break that suite.
    /// Run explicitly with `cargo test -p ns-security --ignored` (in
    /// isolation from the mock-backend tests above, which permanently swap
    /// the process-wide default credential builder).
    #[tokio::test]
    #[ignore = "touches the real OS keychain; run explicitly, see doc comment"]
    async fn real_backend_round_trip_is_self_cleaning() {
        let store = KeyringSecretStore::new();
        let key = format!("ns-security-real-backend-test-{}", std::process::id());

        let set_result = store
            .set(&key, SecretString::new("real-backend-probe"))
            .await;
        let get_result = if set_result.is_ok() {
            store.get(&key).await
        } else {
            Ok(None)
        };
        // Best-effort cleanup runs regardless of what happened above.
        let delete_result = store.delete(&key).await;

        set_result.expect("set against the real keychain backend");
        delete_result.expect("cleanup delete against the real keychain backend");
        assert_eq!(
            get_result
                .expect("get against the real keychain backend")
                .as_ref()
                .map(SecretString::expose),
            Some("real-backend-probe")
        );
    }

    /// Same real-backend caveat as above: `available()` reports whether the
    /// keychain genuinely works on this machine, which is only guaranteed
    /// true here (a real Windows/macOS/Linux desktop), not in headless CI.
    #[tokio::test]
    #[ignore = "touches the real OS keychain; run explicitly, see doc comment"]
    async fn real_backend_reports_available() {
        let store = KeyringSecretStore::new();
        assert!(store.available().await);
    }
}
