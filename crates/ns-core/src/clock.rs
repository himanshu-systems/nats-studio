//! A `Clock` port so time-dependent logic is testable (no direct calls to
//! `OffsetDateTime::now_utc()` in services).

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Source of the current time. Injected into services; the real impl is
/// [`SystemClock`], tests can substitute a fixed clock.
pub trait Clock: Send + Sync {
    fn now(&self) -> OffsetDateTime;

    /// The current time as an RFC-3339 string (the wire format for timestamps).
    fn now_rfc3339(&self) -> String {
        self.now().format(&Rfc3339).unwrap_or_default()
    }
}

/// The production clock: the system wall clock in UTC.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_formats_rfc3339() {
        let s = SystemClock.now_rfc3339();
        // e.g. 2026-07-12T18:00:00Z — at minimum contains a date separator and 'T'.
        assert!(s.contains('T'), "unexpected timestamp: {s}");
    }
}
