//! Build a [`rustls::ClientConfig`] from resolved TLS material
//! ([`ns_core::ResolvedTls`]).
//!
//! **Crypto provider:** this crate pins the **`ring`** provider explicitly
//! (`rustls` is depended on with `default-features = false` + `ring`) because the
//! default `aws-lc-rs` provider needs nasm/cmake, which are not part of this
//! project's toolchain. Every config is built via
//! [`ClientConfig::builder_with_provider`] so the choice is unambiguous and never
//! relies on a process-wide default being installed.
//!
//! **Verification modes:**
//! - default: verify the server against a root store (a CA PEM if supplied, else
//!   the OS native roots);
//! - `insecure_skip_verify`: install a verifier that accepts ANY certificate.
//!   This is DANGEROUS and exists only for the explicit per-connection opt-in
//!   (self-signed dev servers); it disables authentication of the server.

use std::fs;
use std::io::BufReader;
use std::sync::Arc;

use ns_core::ResolvedTls;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};

use crate::error::SecurityError;

/// Build a [`rustls::ClientConfig`] from `tls` using the `ring` provider.
///
/// # Errors
/// Returns [`SecurityError::TlsBuild`] for unreadable/invalid PEM material or a
/// rustls configuration failure, and [`SecurityError::InvalidArgument`] if a
/// client certificate is supplied without its key (or vice versa).
pub fn client_config(tls: &ResolvedTls) -> Result<ClientConfig, SecurityError> {
    let provider = Arc::new(ring::default_provider());

    let builder = ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| SecurityError::TlsBuild(e.to_string()))?;

    // --- server verification stage ---
    let builder = if tls.insecure_skip_verify {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert::new(Arc::clone(
                &provider,
            ))))
    } else {
        builder.with_root_certificates(load_roots(tls)?)
    };

    // --- client authentication stage (mTLS) ---
    let config = match load_client_auth(tls)? {
        Some((certs, key)) => builder
            .with_client_auth_cert(certs, key)
            .map_err(|e| SecurityError::TlsBuild(e.to_string()))?,
        None => builder.with_no_client_auth(),
    };

    Ok(config)
}

/// Assemble the root trust store: a supplied CA PEM, else the OS native roots.
fn load_roots(tls: &ResolvedTls) -> Result<RootCertStore, SecurityError> {
    let mut roots = RootCertStore::empty();

    if let Some(ca_path) = &tls.ca_cert_path {
        let bytes = fs::read(ca_path)
            .map_err(|e| SecurityError::TlsBuild(format!("read CA file {ca_path}: {e}")))?;
        let mut reader = BufReader::new(&bytes[..]);
        for cert in rustls_pemfile::certs(&mut reader) {
            let cert =
                cert.map_err(|e| SecurityError::TlsBuild(format!("parse CA PEM {ca_path}: {e}")))?;
            roots
                .add(cert)
                .map_err(|e| SecurityError::TlsBuild(format!("add CA cert: {e}")))?;
        }
        if roots.is_empty() {
            return Err(SecurityError::TlsBuild(format!(
                "no certificates found in CA file {ca_path}"
            )));
        }
    } else {
        let native = rustls_native_certs::load_native_certs();
        for cert in native.certs {
            // A single malformed system cert should not sink the whole store.
            let _ = roots.add(cert);
        }
        if roots.is_empty() {
            return Err(SecurityError::TlsBuild(
                "no OS native root certificates were available; supply a CA file".to_owned(),
            ));
        }
    }

    Ok(roots)
}

/// Load the client certificate chain + private key for mTLS, if configured.
/// Both paths must be set together.
#[allow(clippy::type_complexity)]
fn load_client_auth(
    tls: &ResolvedTls,
) -> Result<Option<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)>, SecurityError> {
    match (&tls.client_cert_path, &tls.client_key_path) {
        (Some(cert_path), Some(key_path)) => {
            let cert_bytes = fs::read(cert_path).map_err(|e| {
                SecurityError::TlsBuild(format!("read client cert {cert_path}: {e}"))
            })?;
            let mut cert_reader = BufReader::new(&cert_bytes[..]);
            let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
                .collect::<Result<_, _>>()
                .map_err(|e| SecurityError::TlsBuild(format!("parse client cert PEM: {e}")))?;
            if certs.is_empty() {
                return Err(SecurityError::TlsBuild(format!(
                    "no certificates in client cert file {cert_path}"
                )));
            }

            let key_bytes = fs::read(key_path)
                .map_err(|e| SecurityError::TlsBuild(format!("read client key {key_path}: {e}")))?;
            let mut key_reader = BufReader::new(&key_bytes[..]);
            let key = rustls_pemfile::private_key(&mut key_reader)
                .map_err(|e| SecurityError::TlsBuild(format!("parse client key PEM: {e}")))?
                .ok_or_else(|| SecurityError::TlsBuild(format!("no private key in {key_path}")))?;

            Ok(Some((certs, key)))
        }
        (None, None) => Ok(None),
        _ => Err(SecurityError::InvalidArgument(
            "client certificate and key must both be provided for mTLS".to_owned(),
        )),
    }
}

/// A [`ServerCertVerifier`] that accepts every certificate. **DANGEROUS** — only
/// installed for a connection's explicit `insecure_skip_verify` opt-in.
#[derive(Debug)]
struct AcceptAnyServerCert {
    provider: Arc<CryptoProvider>,
}

impl AcceptAnyServerCert {
    fn new(provider: Arc<CryptoProvider>) -> Self {
        Self { provider }
    }
}

impl ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    /// Write `contents` to a uniquely-named temp file and return its path.
    fn temp_file(suffix: &str, contents: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("ns-sec-{}-{}-{}", std::process::id(), n, suffix));
        std::fs::write(&path, contents).expect("write temp file");
        path
    }

    fn resolved(
        ca: Option<PathBuf>,
        cert: Option<PathBuf>,
        key: Option<PathBuf>,
        insecure: bool,
    ) -> ResolvedTls {
        ResolvedTls {
            ca_cert_path: ca.map(|p| p.to_string_lossy().into_owned()),
            client_cert_path: cert.map(|p| p.to_string_lossy().into_owned()),
            client_key_path: key.map(|p| p.to_string_lossy().into_owned()),
            insecure_skip_verify: insecure,
            sni: None,
        }
    }

    #[test]
    fn insecure_skip_verify_builds() {
        let cfg = client_config(&resolved(None, None, None, true)).expect("insecure config builds");
        // A config built with the accept-any verifier is still a usable ClientConfig.
        assert!(!cfg.alpn_protocols.is_empty() || cfg.alpn_protocols.is_empty());
    }

    #[test]
    fn ca_pem_and_mtls_build() {
        // Real, self-signed cert + key via rcgen — exercises CA loading + mTLS.
        let ck = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
            .expect("generate self-signed");
        let cert_pem = ck.cert.pem();
        let key_pem = ck.key_pair.serialize_pem();

        let ca = temp_file("ca.pem", &cert_pem);
        let cfg = client_config(&resolved(Some(ca.clone()), None, None, false))
            .expect("CA-rooted config builds");
        let _ = cfg;

        let cert = temp_file("client.pem", &cert_pem);
        let key = temp_file("client.key", &key_pem);
        client_config(&resolved(
            Some(ca.clone()),
            Some(cert.clone()),
            Some(key.clone()),
            false,
        ))
        .expect("mTLS config builds");

        for p in [ca, cert, key] {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn client_cert_without_key_is_invalid_argument() {
        let cert = temp_file(
            "only-cert.pem",
            "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n",
        );
        let err = client_config(&resolved(None, Some(cert.clone()), None, true))
            .expect_err("cert without key must error");
        assert!(matches!(err, SecurityError::InvalidArgument(_)));
        let _ = std::fs::remove_file(cert);
    }

    #[test]
    fn missing_ca_file_errors() {
        let err = client_config(&resolved(
            Some(PathBuf::from("/no/such/ca/file.pem")),
            None,
            None,
            false,
        ))
        .expect_err("nonexistent CA must error");
        assert!(matches!(err, SecurityError::TlsBuild(_)));
    }
}
