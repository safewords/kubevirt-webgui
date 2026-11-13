//! A small client for the Ceph manager's dashboard REST API — the part of
//! Ceph that can *change* things (mark OSDs out, set `noout`, reweight,
//! scrub) and that knows per-OSD usage and devices, which the prometheus
//! module no longer exports.
//!
//! Configuration (all from the server's environment, never the browser):
//!
//! ```text
//! CEPH_DASHBOARD_URLS        https://10.0.4.3:8443,https://10.0.4.2:8443,…  every manager
//! CEPH_DASHBOARD_USER        a dashboard user, e.g. with role cluster-manager
//! CEPH_DASHBOARD_PASSWORD    its password (from a Secret)
//! CEPH_DASHBOARD_CERT_SHA256 the dashboard certificate's SHA-256 fingerprint
//! ```
//!
//! The dashboard's certificate is normally self-signed (`ceph dashboard
//! create-self-signed-cert`), so it is *pinned*: the connection is accepted
//! when the certificate's fingerprint matches, and the TLS handshake signature
//! is still verified. Without a fingerprint the certificate must chain to a
//! public root.
//!
//! Only the active manager serves the API (with `standby_behaviour error`
//! the others answer 500), so each URL is tried in turn and the one that
//! worked is remembered.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{Method, Request, header};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;

const TIMEOUT: Duration = Duration::from_secs(15);
/// Dashboard tokens last eight hours by default; renew well before.
const TOKEN_TTL: Duration = Duration::from_secs(6 * 3600);
const ACCEPT: &str = "application/vnd.ceph.api.v1.0+json";
const MAX_BODY: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct DashboardConfig {
    pub urls: Vec<String>,
    pub user: String,
    pub password: SecretString,
    pub cert_sha256: Option<[u8; 32]>,
}

impl DashboardConfig {
    /// Parse a fingerprint as printed by `openssl x509 -fingerprint -sha256`
    /// (colon-separated) or as bare hex.
    pub fn parse_fingerprint(text: &str) -> Option<[u8; 32]> {
        // "sha256 Fingerprint=AA:BB:…": only what follows the last '='.
        let value = text.rsplit('=').next().unwrap_or(text);
        let hex: String = value.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        let bytes = hex::decode(hex).ok()?;
        bytes.try_into().ok()
    }
}

#[derive(Debug)]
pub struct ApiError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "HTTP {s}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

fn err(message: impl Into<String>) -> ApiError {
    ApiError { status: None, message: message.into() }
}

struct Session {
    url: String,
    token: String,
    at: Instant,
}

fn session() -> &'static Mutex<Option<Session>> {
    static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

/// One call to the API: tries the last manager that worked first, logs in
/// when there is no token or it was refused, and moves to the next manager
/// when one does not answer as the active one.
pub async fn call(
    config: &DashboardConfig,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ApiError> {
    if config.urls.is_empty() {
        return Err(err("CEPH_DASHBOARD_URLS is not set"));
    }
    let mut order = config.urls.clone();
    let cached = session()
        .lock()
        .unwrap()
        .as_ref()
        .filter(|s| s.at.elapsed() < TOKEN_TTL)
        .map(|s| (s.url.clone(), s.token.clone()));
    if let Some((url, _)) = &cached
        && let Some(i) = order.iter().position(|u| u == url)
    {
        order.swap(0, i);
    }

    let mut errors = Vec::new();
    for url in &order {
        let mut token = cached.as_ref().filter(|(u, _)| u == url).map(|(_, t)| t.clone());
        for attempt in 0..2 {
            if token.is_none() {
                match login(config, url).await {
                    Ok(t) => {
                        *session().lock().unwrap() =
                            Some(Session { url: url.clone(), token: t.clone(), at: Instant::now() });
                        token = Some(t);
                    }
                    Err(e) => {
                        errors.push(format!("{url}: {e}"));
                        break;
                    }
                }
            }
            match request(config, method.clone(), url, path, token.as_deref(), body.clone()).await {
                Ok(v) => return Ok(v),
                // An expired or revoked token: log in again, once.
                Err(e) if e.status == Some(401) && attempt == 0 => token = None,
                // Any other refusal of the request itself: no other manager will think differently.
                Err(e) if e.status.is_some_and(|s| (400..500).contains(&s)) => return Err(e),
                Err(e) => {
                    errors.push(format!("{url}: {e}"));
                    break;
                }
            }
        }
    }
    *session().lock().unwrap() = None;
    Err(err(format!("no Ceph manager answered as the active dashboard: {}", errors.join("; "))))
}

async fn login(config: &DashboardConfig, url: &str) -> Result<String, ApiError> {
    let body = json!({ "username": config.user, "password": config.password.expose_secret() });
    let v = request(config, Method::POST, url, "/api/auth", None, Some(body)).await?;
    v.get("token").and_then(Value::as_str).map(String::from).ok_or_else(|| err("the login answer had no token"))
}

async fn request(
    config: &DashboardConfig,
    method: Method,
    base: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<Value, ApiError> {
    let uri: http::Uri = base.parse().map_err(|e| err(format!("not a URL: {e}")))?;
    if uri.scheme_str() != Some("https") {
        return Err(err("the dashboard URL must be https://"));
    }
    let host = uri.host().ok_or_else(|| err("the URL has no host"))?.to_string();
    let port = uri.port_u16().unwrap_or(8443);
    let tls = tls(config.cert_sha256)?;
    let work = async {
        let tcp =
            TcpStream::connect((host.as_str(), port)).await.map_err(|e| err(format!("could not connect: {e}")))?;
        let name = ServerName::try_from(host.clone()).map_err(|e| err(format!("invalid host {host}: {e}")))?;
        let stream = tokio_rustls::TlsConnector::from(tls)
            .connect(name, tcp)
            .await
            .map_err(|e| err(format!("TLS failed: {e}")))?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake::<_, Full<Bytes>>(TokioIo::new(stream))
            .await
            .map_err(|e| err(format!("HTTP failed: {e}")))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let payload = body.map(|b| serde_json::to_vec(&b).unwrap_or_default()).unwrap_or_default();
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, format!("{host}:{port}"))
            .header(header::ACCEPT, ACCEPT)
            .header(header::USER_AGENT, concat!("kubevirt-webgui/", env!("CARGO_PKG_VERSION")));
        // Always say how long the body is: the dashboard answers 411 to a
        // bodiless POST without it.
        builder = builder.header(header::CONTENT_LENGTH, payload.len());
        if !payload.is_empty() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        if let Some(t) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        let request = builder
            .body(Full::new(Bytes::from(payload)))
            .map_err(|e| err(format!("could not build the request: {e}")))?;
        let response = sender.send_request(request).await.map_err(|e| err(format!("the request failed: {e}")))?;
        let status = response.status().as_u16();
        let mut body = response.into_body();
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|e| err(format!("reading the answer failed: {e}")))?;
            if let Some(data) = frame.data_ref() {
                bytes.extend_from_slice(data);
                if bytes.len() > MAX_BODY {
                    return Err(err("the answer is too large"));
                }
            }
        }
        let value: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        if (200..300).contains(&status) {
            Ok(value)
        } else {
            let message = value.get("detail").and_then(Value::as_str).map(String::from).unwrap_or_else(|| {
                value.as_str().map(|s| s.chars().take(300).collect()).unwrap_or_else(|| value.to_string())
            });
            Err(ApiError { status: Some(status), message })
        }
    };
    tokio::time::timeout(TIMEOUT, work).await.map_err(|_| err("timed out"))?
}

fn tls(pin: Option<[u8; 32]>) -> Result<Arc<rustls::ClientConfig>, ApiError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| err(format!("TLS setup failed: {e}")))?;
    let config = match pin {
        Some(fingerprint) => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pinned { fingerprint, provider }))
            .with_no_client_auth(),
        None => {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            builder.with_root_certificates(roots).with_no_client_auth()
        }
    };
    Ok(Arc::new(config))
}

/// Accepts exactly one certificate, by SHA-256 fingerprint, and still checks
/// that the server holds its key (the handshake signature).
#[derive(Debug)]
struct Pinned {
    fingerprint: [u8; 32],
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if got == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(format!(
                "the dashboard's certificate (sha256 {}) is not the pinned one — CEPH_DASHBOARD_CERT_SHA256",
                hex::encode(got)
            )))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_parse_in_openssl_and_bare_form() {
        let openssl = "sha256 Fingerprint=86:2C:F7:A4:BB:F4:BB:A5:88:76:A6:68:3E:EA:8A:57:31:7D:19:B9:1D:3D:38:6F:AC:49:34:18:18:98:0D:B8";
        let bare = "862cf7a4bbf4bba58876a6683eea8a57317d19b91d3d386fac49341818980db8";
        assert_eq!(DashboardConfig::parse_fingerprint(openssl), DashboardConfig::parse_fingerprint(bare));
        assert!(DashboardConfig::parse_fingerprint("86:2C").is_none());
    }
}
