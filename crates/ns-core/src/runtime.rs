//! Cancellation and background-task bookkeeping (spine ADR-0018).
//!
//! - [`CancellationRegistry`] maps a UI-facing id (subscription/session) to a
//!   `CancellationToken` so a `*_cancel` command can trip the right stream.
//! - [`TaskRegistry`] tracks spawned tokio tasks so they can be aborted on
//!   shutdown or when their owning connection goes away.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

/// Registry of cancellation tokens keyed by the id returned to the UI.
#[derive(Default)]
pub struct CancellationRegistry {
    inner: Mutex<HashMap<String, CancellationToken>>,
}

impl CancellationRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a fresh token under `id` and return a clone for the worker to poll.
    pub fn register(&self, id: impl Into<String>) -> CancellationToken {
        let token = CancellationToken::new();
        self.inner
            .lock()
            .expect("cancellation registry poisoned")
            .insert(id.into(), token.clone());
        token
    }

    /// Cancel and drop the token for `id`. Returns `true` if one was present.
    pub fn cancel(&self, id: &str) -> bool {
        let removed = self
            .inner
            .lock()
            .expect("cancellation registry poisoned")
            .remove(id);
        if let Some(token) = removed {
            token.cancel();
            true
        } else {
            false
        }
    }

    /// Drop the token for `id` without cancelling (the worker finished cleanly).
    pub fn remove(&self, id: &str) {
        self.inner
            .lock()
            .expect("cancellation registry poisoned")
            .remove(id);
    }

    /// Cancel every outstanding token (shutdown).
    pub fn cancel_all(&self) {
        let drained: Vec<_> = self
            .inner
            .lock()
            .expect("cancellation registry poisoned")
            .drain()
            .map(|(_, token)| token)
            .collect();
        for token in drained {
            token.cancel();
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("cancellation registry poisoned")
            .len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Registry of abort handles for tracked background tasks.
#[derive(Default)]
pub struct TaskRegistry {
    inner: Mutex<HashMap<String, AbortHandle>>,
}

impl TaskRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Track a task's abort handle under `id`.
    pub fn track(&self, id: impl Into<String>, handle: AbortHandle) {
        self.inner
            .lock()
            .expect("task registry poisoned")
            .insert(id.into(), handle);
    }

    /// Abort and forget the task registered under `id`.
    pub fn abort(&self, id: &str) {
        if let Some(handle) = self
            .inner
            .lock()
            .expect("task registry poisoned")
            .remove(id)
        {
            handle.abort();
        }
    }

    /// Abort every tracked task (shutdown).
    pub fn abort_all(&self) {
        let drained: Vec<_> = self
            .inner
            .lock()
            .expect("task registry poisoned")
            .drain()
            .map(|(_, handle)| handle)
            .collect();
        for handle in drained {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_registry_cancels_by_id() {
        let reg = CancellationRegistry::new();
        let token = reg.register("sub-1");
        assert_eq!(reg.len(), 1);
        assert!(!token.is_cancelled());
        assert!(reg.cancel("sub-1"));
        assert!(token.is_cancelled());
        assert!(reg.is_empty());
        assert!(!reg.cancel("sub-1")); // already gone
    }

    #[tokio::test]
    async fn task_registry_aborts() {
        let reg = TaskRegistry::new();
        let handle = tokio::spawn(async {
            std::future::pending::<()>().await;
        });
        reg.track("job-1", handle.abort_handle());
        reg.abort("job-1");
        // The joined task should report cancellation.
        assert!(handle.await.unwrap_err().is_cancelled());
    }
}
