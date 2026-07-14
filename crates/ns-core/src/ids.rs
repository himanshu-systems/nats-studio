//! Strongly-typed identifiers (spine section 6.2). Each is a UUID newtype that
//! serializes to a string on the wire.

use std::fmt;
use std::str::FromStr;

use uuid::Uuid;

macro_rules! id_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub struct $name(pub Uuid);

        impl $name {
            /// Generate a fresh random (v4) identifier.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            /// Wrap an existing UUID.
            #[must_use]
            pub fn from_uuid(uuid: Uuid) -> Self {
                Self(uuid)
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(Uuid::parse_str(s)?))
            }
        }
    };
}

id_newtype!(
    /// Identifies a live connection in the registry.
    ConnectionId
);
id_newtype!(
    /// Identifies a subscription / request-scoped stream.
    SubscriptionId
);
id_newtype!(
    /// Identifies a tracked background task.
    TaskId
);
id_newtype!(
    /// Identifies a terminal / long-lived session.
    SessionId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_through_string() {
        let id = ConnectionId::new();
        let parsed: ConnectionId = id.to_string().parse().unwrap();
        assert_eq!(id, parsed);
    }

    #[test]
    fn ids_are_unique() {
        assert_ne!(TaskId::new(), TaskId::new());
    }
}
