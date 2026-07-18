//! Parser for NATS `.creds` files: two PEM-ish "armored" blocks — a user JWT
//! and the user's NKey seed — as produced by `nsc generate creds` / the NATS
//! account server.
//!
//! A real `.creds` file looks like:
//!
//! ```text
//! -----BEGIN NATS USER JWT-----
//! eyJ0eXAiOiJKV1QiLCJhbGc...
//! ------END NATS USER JWT------
//!
//! ************************* IMPORTANT *************************
//! NKEY Seed printed below can be used to sign and prove identity.
//! NKEYs are sensitive and should be treated as secrets.
//!
//! -----BEGIN USER NKEY SEED-----
//! SUAIO3FHUX5PNV2LQIQ54JBJ5ACZDA5M6ZVCV2FHYPY4Z4M2XX3KGAO2CQ
//! ------END USER NKEY SEED------
//!
//! *************************************************************
//! ```
//!
//! Note the asymmetry that trips up naive parsers: the `BEGIN` line commonly
//! has 5 dashes on each side while the `END` line has 6, and tools in the
//! wild are not consistent about it. This parser therefore never counts
//! dashes — it locates blocks by the literal `BEGIN <label>` / `END <label>`
//! text and ignores everything else (dash run length, CRLF vs LF, blank
//! lines, the "IMPORTANT" banner, trailing text after the last block).

use ns_core::SecretString;

use crate::error::SecurityError;

const JWT_LABEL: &str = "NATS USER JWT";
const SEED_LABEL: &str = "USER NKEY SEED";

/// The two secrets extracted from a `.creds` file: the user JWT (a bearer
/// token — not itself secret, see `docs/architecture/xc-security-model.md`
/// §2.6) and the user NKey seed (always a [`SecretString`]).
#[derive(Debug, Clone)]
pub struct Creds {
    pub jwt: String,
    pub seed: SecretString,
}

impl Creds {
    /// Parse a `.creds` file's contents.
    ///
    /// # Errors
    /// Returns [`SecurityError::CredsParse`] if either the `NATS USER JWT` or
    /// `USER NKEY SEED` armored block is missing or empty.
    pub fn parse(input: &str) -> Result<Self, SecurityError> {
        let jwt = extract_armored(input, JWT_LABEL)?;
        let seed = extract_armored(input, SEED_LABEL)?;
        Ok(Self {
            jwt,
            seed: SecretString::new(seed),
        })
    }
}

/// Extract the whitespace-stripped body of the armored block `BEGIN <label>`
/// .. `END <label>`, tolerating any number of flanking dashes, CRLF line
/// endings, and blank lines within the block.
fn extract_armored(text: &str, label: &str) -> Result<String, SecurityError> {
    let normalized = text.replace("\r\n", "\n");
    let begin_needle = format!("BEGIN {label}");
    let end_needle = format!("END {label}");

    let begin_pos = normalized
        .find(&begin_needle)
        .ok_or_else(|| SecurityError::CredsParse(format!("missing 'BEGIN {label}' block")))?;
    // Body starts on the line after the BEGIN marker.
    let body_start = normalized[begin_pos..]
        .find('\n')
        .map_or(normalized.len(), |i| begin_pos + i + 1);

    let rest = &normalized[body_start..];
    let end_rel = rest
        .find(&end_needle)
        .ok_or_else(|| SecurityError::CredsParse(format!("missing 'END {label}' block")))?;
    // Everything from `body_start` up to the start of the END marker's own
    // line is the body (drops the dash run that precedes "END ...").
    let segment = &rest[..end_rel];
    let body_end = segment.rfind('\n').map_or(0, |i| i + 1);

    let body: String = segment[..body_end]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();

    if body.is_empty() {
        return Err(SecurityError::CredsParse(format!("empty '{label}' block")));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use ns_core::DomainError;

    use super::*;

    /// A realistic fixture matching the format `nsc` actually emits:
    /// asymmetric dash counts, an "IMPORTANT" banner between blocks, and
    /// trailing decoration after the last block.
    const REALISTIC_CREDS: &str = "-----BEGIN NATS USER JWT-----\r\neyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJmYWtlIn0.sig\r\n------END NATS USER JWT------\r\n\r\n************************* IMPORTANT *************************\r\nNKEY Seed printed below can be used to sign and prove identity.\r\nNKEYs are sensitive and should be treated as secrets.\r\n\r\n-----BEGIN USER NKEY SEED-----\r\nSUAIO3FHUX5PNV2LQIQ54JBJ5ACZDA5M6ZVCV2FHYPY4Z4M2XX3KGAO2CQ\r\n------END USER NKEY SEED------\r\n\r\n*************************************************************\r\n";

    #[test]
    fn parses_realistic_inline_sample() {
        let creds = Creds::parse(REALISTIC_CREDS).expect("valid creds");
        assert_eq!(
            creds.jwt,
            "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5In0.eyJqdGkiOiJmYWtlIn0.sig"
        );
        assert_eq!(
            creds.seed.expose(),
            "SUAIO3FHUX5PNV2LQIQ54JBJ5ACZDA5M6ZVCV2FHYPY4Z4M2XX3KGAO2CQ"
        );
    }

    #[test]
    fn tolerates_lf_line_endings_and_varying_dash_counts() {
        let input = "---BEGIN NATS USER JWT-----------\nJWT.BODY.HERE\n----END NATS USER JWT----\n\n----BEGIN USER NKEY SEED----\nSEEDVALUE123\n--END USER NKEY SEED--\n";
        let creds = Creds::parse(input).expect("valid creds");
        assert_eq!(creds.jwt, "JWT.BODY.HERE");
        assert_eq!(creds.seed.expose(), "SEEDVALUE123");
    }

    #[test]
    fn missing_jwt_block_errors() {
        let input =
            "-----BEGIN USER NKEY SEED-----\nSEEDVALUE123\n------END USER NKEY SEED------\n";
        let err = Creds::parse(input).expect_err("missing jwt block must error");
        assert!(matches!(err, SecurityError::CredsParse(_)));
        assert_eq!(err.code(), ns_types::ErrorCode::AuthFailed);
    }

    #[test]
    fn missing_seed_block_errors() {
        let input = "-----BEGIN NATS USER JWT-----\nJWT.BODY.HERE\n------END NATS USER JWT------\n";
        let err = Creds::parse(input).expect_err("missing seed block must error");
        assert!(matches!(err, SecurityError::CredsParse(_)));
    }

    #[test]
    fn empty_block_errors() {
        let input = "-----BEGIN NATS USER JWT-----\n------END NATS USER JWT------\n-----BEGIN USER NKEY SEED-----\nSEEDVALUE123\n------END USER NKEY SEED------\n";
        let err = Creds::parse(input).expect_err("empty jwt block must error");
        assert!(matches!(err, SecurityError::CredsParse(_)));
    }

    #[test]
    fn garbage_input_errors() {
        let err = Creds::parse("not a creds file at all").expect_err("garbage must error");
        assert!(matches!(err, SecurityError::CredsParse(_)));
    }

    #[test]
    fn seed_never_appears_in_debug_output() {
        let creds = Creds::parse(REALISTIC_CREDS).expect("valid creds");
        let debug = format!("{creds:?}");
        assert!(!debug.contains("SUAIO3FHUX5PNV2LQIQ54JBJ5ACZDA5M6ZVCV2FHYPY4Z4M2XX3KGAO2CQ"));
        assert!(debug.contains("***"));
    }
}
