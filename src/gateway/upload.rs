//! `/ws/upload/{ticket}` — disk images uploaded from the browser, over a socket.
//!
//! The browser never talks to CDI. It asks the gateway to begin an upload
//! (`upload.begin`), which creates a DataVolume with an upload source and
//! returns a one-time ticket; it then streams the file over this socket, and
//! the server streams it on to CDI's upload proxy as a single request body.
//!
//! ```text
//! browser → upload.begin { namespace, name, size, … }   (gateway /ws)
//! server  ← { task, ticket, path: "/ws/upload/<ticket>" }
//! browser → opens /ws/upload/<ticket>
//! server  → {"status":"preparing"}         while CDI starts its upload server
//! server  → {"ready":true,"chunkSize":N}   once the upstream request is open
//! browser → <binary chunk>                  then waits for…
//! server  → {"ack":<bytes so far>}          …before sending the next chunk
//! server  → {"done":true}                   after the last byte is accepted
//! server  → {"error":"…"}                   on any failure, then closes
//! ```
//!
//! The ack after every chunk is the backpressure: a browser can read a file
//! far faster than a storage backend can write it.
//!
//! CDI's upload proxy only reads its token from the `Authorization` header,
//! which the API server strips when proxying a service, so the proxy is
//! reached directly — at `CDI_UPLOAD_PROXY_URL`, or its in-cluster service
//! address when this server runs in the cluster — or, from outside the
//! cluster, through a port-forward to the proxy pod made as the user.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{Request, header};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use hyper_util::rt::TokioIo;
use rainier_framework::http::Request as HttpRequest;
use rainier_framework::prelude::{Result as RainierResult, WebSocketHandler};
use rainier_framework::websocket::{Message, Socket, SocketId};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, ServerName};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::cluster::Kube;
use crate::cluster::paths::{ResourceRef, with_query};
use crate::state::State;

/// Suggested chunk size: large enough to be quick, small enough that an ack
/// arrives often.
pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;

const TICKET_TTL: Duration = Duration::from_secs(120);
const READY_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Where and how to reach CDI's upload proxy.
#[derive(Debug, Clone)]
pub struct UploadConfig {
    /// `https://host[:port]` of the upload proxy, when reachable directly.
    pub proxy_url: Option<String>,
    /// The namespace CDI runs in.
    pub cdi_namespace: String,
    /// A PEM bundle to trust for the proxy's certificate.
    pub ca_file: Option<String>,
    /// Refuse to upload when the proxy's certificate cannot be verified.
    pub strict_tls: bool,
}

impl UploadConfig {
    pub fn from_env() -> Self {
        let env = rainier_framework::config::Env::load_or_default(".env");
        let read = |key: &str| {
            std::env::var(key).ok().or_else(|| env.get(key)).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
        };
        let cdi_namespace = read("CDI_NAMESPACE").unwrap_or_else(|| "cdi".into());
        let in_cluster = std::env::var("KUBERNETES_SERVICE_HOST").is_ok();
        let proxy_url = read("CDI_UPLOAD_PROXY_URL")
            .or_else(|| in_cluster.then(|| format!("https://cdi-uploadproxy.{cdi_namespace}.svc:443")));
        Self {
            proxy_url,
            cdi_namespace,
            ca_file: read("CDI_UPLOAD_PROXY_CA_FILE"),
            strict_tls: read("CDI_UPLOAD_PROXY_VERIFY").is_some_and(|v| v.eq_ignore_ascii_case("strict")),
        }
    }
}

/// Where an upload is.
#[derive(Debug, Clone, PartialEq)]
pub enum UploadState {
    /// CDI is starting its upload server.
    Preparing,
    /// The upload token is issued; the browser may send.
    Ready {
        token: String,
    },
    /// Bytes are flowing.
    Uploading {
        sent: u64,
    },
    /// Every byte was accepted by the upload proxy.
    Finished,
    Failed(String),
}

/// One upload: the DataVolume being filled and who is filling it.
pub struct UploadSession {
    pub namespace: String,
    pub name: String,
    pub size: u64,
    pub user: String,
    pub kube: Kube,
    state: watch::Sender<UploadState>,
}

impl UploadSession {
    pub fn new(namespace: &str, name: &str, size: u64, user: &str, kube: Kube) -> Arc<Self> {
        Arc::new(Self {
            namespace: namespace.into(),
            name: name.into(),
            size,
            user: user.into(),
            kube,
            state: watch::channel(UploadState::Preparing).0,
        })
    }

    pub fn set(&self, state: UploadState) {
        self.state.send_replace(state);
    }

    pub fn state(&self) -> UploadState {
        self.state.borrow().clone()
    }

    pub fn watch(&self) -> watch::Receiver<UploadState> {
        self.state.subscribe()
    }

    /// Mark failed, unless already finished.
    pub fn fail(&self, reason: impl Into<String>) {
        let reason = reason.into();
        self.state.send_if_modified(|state| match state {
            UploadState::Finished | UploadState::Failed(_) => false,
            _ => {
                *state = UploadState::Failed(reason.clone());
                true
            }
        });
    }
}

/// Upload tickets, and the configuration every upload shares.
pub struct Uploads {
    pub config: UploadConfig,
    tickets: Mutex<HashMap<String, (Arc<UploadSession>, Instant)>>,
}

/// The process's uploads.
pub fn uploads() -> &'static Uploads {
    static UPLOADS: OnceLock<Uploads> = OnceLock::new();
    UPLOADS.get_or_init(|| Uploads { config: UploadConfig::from_env(), tickets: Mutex::new(HashMap::new()) })
}

impl Uploads {
    /// A one-time ticket for a session.
    pub fn issue(&self, session: Arc<UploadSession>) -> String {
        let ticket = {
            use rand::RngCore;
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            hex::encode(bytes)
        };
        let mut tickets = self.tickets.lock().unwrap();
        let now = Instant::now();
        tickets.retain(|_, (_, expires)| *expires > now);
        tickets.insert(ticket.clone(), (session, now + TICKET_TTL));
        ticket
    }

    fn redeem(&self, ticket: &str) -> Option<Arc<UploadSession>> {
        let (session, expires) = self.tickets.lock().unwrap().remove(ticket)?;
        (expires > Instant::now()).then_some(session)
    }
}

// --- the transport ----------------------------------------------------------------

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

type UploadBody =
    StreamBody<std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<Frame<Bytes>, std::io::Error>> + Send>>>;

/// An open upload request: chunks go in `body`, the proxy's answer comes out
/// of `response`. Dropping `body` ends the request; sending an `Err` aborts it
/// mid-body, so CDI sees a broken upload rather than a short image.
pub struct Upstream {
    pub body: mpsc::Sender<Result<Bytes, std::io::Error>>,
    pub response: JoinHandle<Result<(u16, String), String>>,
    /// A note for the task log about how the proxy was reached.
    pub route: String,
}

impl Upstream {
    /// End the body and wait for the proxy's verdict.
    pub async fn finish(self, timeout: Duration) -> Result<(), String> {
        drop(self.body);
        match tokio::time::timeout(timeout, self.response).await {
            Ok(Ok(Ok((status, _)))) if (200..300).contains(&status) => Ok(()),
            Ok(Ok(Ok((status, body)))) => Err(format!("the upload proxy answered {status}: {body}")),
            Ok(Ok(Err(e))) => Err(e),
            Ok(Err(e)) => Err(format!("the upload was interrupted: {e}")),
            Err(_) => Err("the upload proxy did not answer".into()),
        }
    }

    /// Break the request off, so the partial data is not taken as an image.
    pub async fn abort(self) {
        let _ = self.body.send(Err(std::io::Error::other("upload aborted"))).await;
        self.response.abort();
    }
}

/// The CA that signs the upload proxy's certificate: from a file, or CDI's
/// signer bundle (readable by cluster admins).
async fn trust_anchors(config: &UploadConfig, kube: &Kube) -> Vec<CertificateDer<'static>> {
    let pem = match &config.ca_file {
        Some(file) => std::fs::read(file).ok(),
        None => {
            let path = ResourceRef::new("v1", "configmaps")
                .ns(&config.cdi_namespace)
                .named("cdi-uploadproxy-signer-bundle")
                .path();
            match path {
                Ok(path) => kube.get(&path).await.ok().and_then(|cm| {
                    cm.pointer("/data/ca-bundle.crt").and_then(Value::as_str).map(|s| s.as_bytes().to_vec())
                }),
                Err(_) => None,
            }
        }
    };
    pem.map(|pem| CertificateDer::pem_slice_iter(&pem).filter_map(Result::ok).collect()).unwrap_or_default()
}

mod insecure {
    use rustls::DigitallySignedStruct;
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls_pki_types::{CertificateDer, ServerName, UnixTime};

    /// Accepts any certificate. Used only when the proxy's CA cannot be read;
    /// the upload token is scoped to one claim and expires within minutes.
    #[derive(Debug)]
    pub struct AnyCertificate(pub rustls::crypto::WebPkiSupportedAlgorithms);

    impl ServerCertVerifier for AnyCertificate {
        fn verify_server_cert(
            &self,
            _: &CertificateDer<'_>,
            _: &[CertificateDer<'_>],
            _: &ServerName<'_>,
            _: &[u8],
            _: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0)
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.0.supported_schemes()
        }
    }
}

fn tls_config(anchors: &[CertificateDer<'static>], strict: bool) -> Result<(rustls::ClientConfig, bool), String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup failed: {e}"))?;

    let mut roots = rustls::RootCertStore::empty();
    for anchor in anchors {
        let _ = roots.add(anchor.clone());
    }
    if !roots.is_empty() {
        return Ok((builder.with_root_certificates(roots).with_no_client_auth(), true));
    }
    if strict {
        return Err("the upload proxy's CA could not be read (set CDI_UPLOAD_PROXY_CA_FILE)".into());
    }
    let config = builder
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(insecure::AnyCertificate(
            provider.signature_verification_algorithms,
        )))
        .with_no_client_auth();
    Ok((config, false))
}

/// Open the upload request for `token`, streaming its body from the returned
/// sender. Without a `content_length` the body is sent chunked.
pub async fn open_upstream(
    config: &UploadConfig,
    kube: &Kube,
    token: &str,
    content_length: Option<u64>,
) -> Result<Upstream, String> {
    let (io, host, route): (Box<dyn Io>, String, String) = match &config.proxy_url {
        Some(url) => {
            let uri: http::Uri = url.parse().map_err(|e| format!("CDI_UPLOAD_PROXY_URL is not a URL: {e}"))?;
            let host = uri.host().ok_or("CDI_UPLOAD_PROXY_URL has no host")?.to_string();
            let port = uri.port_u16().unwrap_or(443);
            let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
                .await
                .map_err(|e| format!("could not reach the upload proxy at {host}:{port}: {e}"))?;
            let route = format!("directly at {host}:{port}");
            (Box::new(tcp), host, route)
        }
        None => {
            let namespace = &config.cdi_namespace;
            let pods = kube
                .get(&with_query(
                    &ResourceRef::new("v1", "pods").ns(namespace).path().map_err(|e| e.message)?,
                    &[("labelSelector", Some("cdi.kubevirt.io=cdi-uploadproxy".into()))],
                ))
                .await
                .map_err(|e| format!("could not find CDI's upload proxy in `{namespace}`: {} — run the GUI in the cluster or set CDI_UPLOAD_PROXY_URL", e.message))?;
            let pod = pods
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|p| p.pointer("/status/phase").and_then(Value::as_str) == Some("Running"))
                .and_then(|p| p.pointer("/metadata/name").and_then(Value::as_str))
                .ok_or_else(|| format!("no running cdi-uploadproxy pod in `{namespace}`"))?
                .to_string();

            let api: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(kube.client(), namespace);
            let mut forwarder = api
                .portforward(&pod, &[8443])
                .await
                .map_err(|e| format!("could not port-forward to {namespace}/{pod}: {e} — set CDI_UPLOAD_PROXY_URL if you may not port-forward in `{namespace}`"))?;
            let stream = forwarder.take_stream(8443).ok_or("the port-forward produced no stream")?;
            // The forwarder's own task must outlive the stream.
            tokio::spawn(async move {
                let _ = forwarder.join().await;
            });
            (
                Box::new(stream),
                format!("cdi-uploadproxy.{namespace}.svc"),
                format!("via a port-forward to {namespace}/{pod}"),
            )
        }
    };

    let anchors = trust_anchors(config, kube).await;
    let (tls, verified) = tls_config(&anchors, config.strict_tls)?;
    let server_name = ServerName::try_from(host.clone()).map_err(|e| format!("invalid proxy host {host}: {e}"))?;
    let tls_stream = tokio_rustls::TlsConnector::from(Arc::new(tls))
        .connect(server_name, io)
        .await
        .map_err(|e| format!("TLS with the upload proxy failed: {e}"))?;

    let (mut sender, connection) = hyper::client::conn::http1::handshake::<_, UploadBody>(TokioIo::new(tls_stream))
        .await
        .map_err(|e| format!("HTTP with the upload proxy failed: {e}"))?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            tracing::debug!(error = %e, "upload proxy connection ended");
        }
    });

    let (body, chunks) = mpsc::channel::<Result<Bytes, std::io::Error>>(2);
    let stream = futures_util::stream::unfold(chunks, |mut chunks| async move {
        chunks.recv().await.map(|item| (item.map(Frame::data), chunks))
    });
    let mut request = Request::post("/v1beta1/upload-async")
        .header(header::HOST, host.as_str())
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/octet-stream");
    if let Some(length) = content_length {
        request = request.header(header::CONTENT_LENGTH, length);
    }
    let request = request
        .body(StreamBody::new(Box::pin(stream) as std::pin::Pin<Box<dyn futures_util::Stream<Item = _> + Send>>))
        .map_err(|e| format!("could not build the upload request: {e}"))?;

    let response = tokio::spawn(async move {
        let response = sender.send_request(request).await.map_err(|e| format!("the upload request failed: {e}"))?;
        let status = response.status().as_u16();
        let body = response.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
        Ok((status, String::from_utf8_lossy(&body).chars().take(500).collect()))
    });

    let route = if verified { route } else { format!("{route} (certificate not verified: CDI's CA was not readable)") };
    Ok(Upstream { body, response, route })
}

// --- the socket -------------------------------------------------------------------

struct Active {
    session: Arc<UploadSession>,
    upstream: Option<Upstream>,
    received: u64,
    finished: bool,
    prepare: Option<JoinHandle<()>>,
}

pub struct UploadProxy {
    state: Arc<State>,
    active: Mutex<HashMap<SocketId, Arc<tokio::sync::Mutex<Active>>>>,
}

impl UploadProxy {
    pub fn new(state: Arc<State>) -> Self {
        Self { state, active: Mutex::new(HashMap::new()) }
    }
}

fn fail(socket: &Socket, session: &UploadSession, message: &str) {
    session.fail(message);
    let _ = socket.send_json(&json!({ "error": message }));
    let _ = socket.close_with(message.chars().take(120).collect::<String>());
}

/// Close the request body and read the proxy's answer.
async fn finish(socket: &Socket, active: &mut Active) {
    let Some(upstream) = active.upstream.take() else { return };
    active.finished = true;
    match upstream.finish(Duration::from_secs(600)).await {
        Ok(()) => {
            active.session.set(UploadState::Finished);
            let _ = socket.send_json(&json!({ "done": true, "bytes": active.received }));
            let _ = socket.close();
        }
        Err(message) => fail(socket, &active.session, &message),
    }
}

#[async_trait::async_trait]
impl WebSocketHandler for UploadProxy {
    fn authorize(&self, request: &HttpRequest) -> bool {
        super::origin_allowed(&self.state, request)
    }

    async fn on_connect(&self, socket: &Socket) -> RainierResult<()> {
        let Some(session) = socket.param("ticket").and_then(|t| uploads().redeem(t)) else {
            let _ = socket.send_json(&json!({ "error": "invalid or expired upload ticket" }));
            let _ = socket.close_with("invalid or expired upload ticket");
            return Ok(());
        };
        tracing::info!(user = %session.user, namespace = %session.namespace, disk = %session.name, bytes = session.size, "upload opened");

        let active = Arc::new(tokio::sync::Mutex::new(Active {
            session: session.clone(),
            upstream: None,
            received: 0,
            finished: false,
            prepare: None,
        }));
        self.active.lock().unwrap().insert(socket.id(), active.clone());

        // Waiting for CDI can take minutes; it happens off the socket's read
        // loop so the connection stays responsive.
        let browser = socket.clone();
        let task_active = active.clone();
        let prepare = tokio::spawn(async move {
            let _ = browser.send_json(&json!({ "status": "preparing" }));
            let mut states = session.watch();
            let ready = tokio::time::timeout(
                READY_TIMEOUT,
                states.wait_for(|s| matches!(s, UploadState::Ready { .. } | UploadState::Failed(_))),
            )
            .await
            .ok()
            .and_then(|r| r.ok().map(|state| state.clone()));
            let token = match ready {
                Some(UploadState::Ready { token }) => token,
                Some(UploadState::Failed(reason)) => return fail(&browser, &session, &reason),
                _ => return fail(&browser, &session, "CDI did not become ready for the upload"),
            };
            match open_upstream(&uploads().config, &session.kube, &token, Some(session.size)).await {
                Ok(upstream) => {
                    tracing::info!(route = %upstream.route, "upload proxy connected");
                    let route = upstream.route.clone();
                    task_active.lock().await.upstream = Some(upstream);
                    session.set(UploadState::Uploading { sent: 0 });
                    let _ = browser.send_json(&json!({ "ready": true, "chunkSize": CHUNK_SIZE, "route": route }));
                }
                Err(message) => fail(&browser, &session, &message),
            }
        });
        active.lock().await.prepare = Some(prepare);
        Ok(())
    }

    async fn on_message(&self, socket: &Socket, message: Message) -> RainierResult<()> {
        let Some(active) = self.active.lock().unwrap().get(&socket.id()).cloned() else {
            return Ok(());
        };
        let mut active = active.lock().await;
        if active.finished {
            return Ok(());
        }

        match message {
            Message::Binary(chunk) => {
                let Some(upstream) = active.upstream.as_ref() else {
                    let session = active.session.clone();
                    fail(socket, &session, "data arrived before the upload was ready");
                    return Ok(());
                };
                let length = chunk.len() as u64;
                if active.received + length > active.session.size {
                    let session = active.session.clone();
                    fail(socket, &session, "more data than the declared size");
                    return Ok(());
                }
                if upstream.body.send(Ok(Bytes::from(chunk))).await.is_err() {
                    // The proxy stopped reading: its answer says why.
                    finish(socket, &mut active).await;
                    return Ok(());
                }
                active.received += length;
                let sent = active.received;
                active.session.set(UploadState::Uploading { sent });
                let _ = socket.send_json(&json!({ "ack": sent }));
                if sent == active.session.size {
                    finish(socket, &mut active).await;
                }
            }
            Message::Text(text) => {
                let done = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.get("done").and_then(Value::as_bool))
                    .unwrap_or(false);
                if done {
                    if active.received != active.session.size {
                        let (received, size, session) = (active.received, active.session.size, active.session.clone());
                        fail(socket, &session, &format!("the upload ended after {received} of {size} bytes"));
                    } else {
                        finish(socket, &mut active).await;
                    }
                }
            }
            Message::Close(_) => {}
        }
        Ok(())
    }

    async fn on_close(&self, socket: &Socket) {
        let Some(active) = self.active.lock().unwrap().remove(&socket.id()) else {
            return;
        };
        let mut active = active.lock().await;
        if let Some(prepare) = active.prepare.take() {
            prepare.abort();
        }
        if !active.finished {
            active.session.fail("the browser closed the upload before it finished");
            if let Some(upstream) = active.upstream.take() {
                upstream.response.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failing_keeps_the_first_reason_and_never_overwrites_success() {
        let (tx, _) = watch::channel(UploadState::Preparing);
        let session = UploadSessionForTest { state: tx };
        session.fail("first");
        session.fail("second");
        assert_eq!(*session.state.borrow(), UploadState::Failed("first".into()));

        let (tx, _) = watch::channel(UploadState::Finished);
        let finished = UploadSessionForTest { state: tx };
        finished.fail("late");
        assert_eq!(*finished.state.borrow(), UploadState::Finished);
    }

    /// `UploadSession::fail` without a client, which tests cannot build.
    struct UploadSessionForTest {
        state: watch::Sender<UploadState>,
    }

    impl UploadSessionForTest {
        fn fail(&self, reason: &str) {
            self.state.send_if_modified(|state| match state {
                UploadState::Finished | UploadState::Failed(_) => false,
                _ => {
                    *state = UploadState::Failed(reason.into());
                    true
                }
            });
        }
    }

    #[test]
    fn a_tls_config_without_anchors_is_refused_when_strict() {
        assert!(tls_config(&[], true).is_err());
        let (_, verified) = tls_config(&[], false).unwrap();
        assert!(!verified);
    }
}
