//! Secret handling: `SecretString` (zeroized, never printed) and a generic
//! `Redacted<T>` wrapper that hides a value in `Debug`/`Display` output.
//!
//! Nothing here ever renders the underlying secret except via the explicit
//! `expose()` accessor — defense-in-depth against leaking creds into logs/errors.

use std::fmt;

use zeroize::Zeroize;

/// A UTF-8 secret (password, token, NKey seed, JWT). Its bytes are zeroized on
/// drop and it never appears in `Debug`/`Display`. Access with [`expose`](Self::expose).
#[derive(Clone, Default)]
pub struct SecretString(String);

impl SecretString {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Reveal the secret. Call sites should keep the borrow as short as possible.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(***)")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Wraps any value so it is hidden in `Debug`/`Display` output. Unlike
/// [`SecretString`] it does not zeroize; use it for sensitive-but-not-key data
/// (e.g. a struct that should never be logged verbatim).
#[derive(Clone)]
pub struct Redacted<T>(T);

impl<T> Redacted<T> {
    pub fn new(value: T) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &T {
        &self.0
    }

    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> fmt::Debug for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Redacted(***)")
    }
}

impl<T> fmt::Display for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_string_never_prints() {
        let s = SecretString::new("hunter2");
        assert_eq!(format!("{s:?}"), "SecretString(***)");
        assert_eq!(format!("{s}"), "***");
        assert_eq!(s.expose(), "hunter2");
    }

    #[test]
    fn redacted_hides_debug() {
        let r = Redacted::new(vec![1, 2, 3]);
        assert_eq!(format!("{r:?}"), "Redacted(***)");
        assert_eq!(r.expose(), &vec![1, 2, 3]);
    }
}
