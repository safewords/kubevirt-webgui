//! The Kubernetes side: one [`Cluster`], and a [`Kube`] client per identity.
//!
//! The GUI holds **no privileges of its own**. Every request is made with the
//! credential the signed-in user presented, so the API server's RBAC decides
//! what each person may see and do — exactly as it would for `kubectl`.

pub mod discovery;
pub mod paths;
pub mod watch;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http::{HeaderValue, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use kube::client::Body;
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::Role;

use crate::settings::Settings;

pub use paths::ResourceRef;

/// A failed call against the API server, shaped like a Kubernetes `Status`.
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    /// The HTTP status, or 0 when the server was never reached.
    pub status: u16,
    /// A machine-readable reason: `Forbidden`, `NotFound`, `Conflict`, …
    pub reason: String,
    /// What went wrong, for a person.
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self { status, reason: reason.into(), message: message.into() }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "BadRequest", message)
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self::new(502, "ServiceUnavailable", message)
    }

    pub fn is_not_found(&self) -> bool {
        self.status == 404
    }

    fn from_response(status: StatusCode, body: &[u8]) -> Self {
        let parsed: Option<Value> = serde_json::from_slice(body).ok();
        let reason = parsed
            .as_ref()
            .and_then(|v| v.get("reason"))
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty())
            .map(String::from)
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("Unknown").replace(' ', ""));
        let message = parsed
            .as_ref()
            .and_then(|v| v.get("message"))
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or_else(|| String::from_utf8_lossy(body).trim().chars().take(500).collect());
        Self::new(status.as_u16(), reason, message)
    }
}

/// Who a request is made as.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Credential {
    /// A bearer token: a ServiceAccount token, or an OIDC ID token.
    Token { token: String },
    /// The server's own kubeconfig identity (single-user installs only).
    Server,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Credential::Token { .. } => f.write_str("Credential::Token(<redacted>)"),
            Credential::Server => f.write_str("Credential::Server"),
        }
    }
}

impl Credential {
    fn cache_key(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        match self {
            Credential::Token { token } => {
                hash.update(b"token:");
                hash.update(token.as_bytes());
            }
            Credential::Server => hash.update(b"server"),
        }
        hash.finalize().into()
    }
}

/// The cluster the GUI manages.
pub struct Cluster {
    /// Cluster URL and TLS trust, with the kubeconfig's own identity attached.
    base: kube::Config,
    clients: Mutex<HashMap<[u8; 32], (Kube, Instant)>>,
    pub discovery: discovery::DiscoveryCache,
}

const CLIENT_IDLE: Duration = Duration::from_secs(15 * 60);

impl Cluster {
    /// Load the cluster's address and trust from in-cluster configuration or a
    /// kubeconfig context.
    pub async fn load(settings: &Settings) -> anyhow::Result<Self> {
        let mut base = match settings.kube_context.as_deref() {
            Some(context) => {
                let options =
                    kube::config::KubeConfigOptions { context: Some(context.to_string()), ..Default::default() };
                kube::Config::from_kubeconfig(&options).await?
            }
            None => kube::Config::infer().await?,
        };

        if let Some(server) = settings.kube_api_server.as_deref() {
            base.cluster_url = server.parse()?;
        }
        // Watches are long-lived by design; the per-request timeout that suits
        // a GET would cut them off.
        base.read_timeout = None;

        tracing::info!(cluster = %base.cluster_url, "managing cluster");

        Ok(Self { base, clients: Mutex::new(HashMap::new()), discovery: Default::default() })
    }

    /// The API server's URL.
    pub fn url(&self) -> String {
        self.base.cluster_url.to_string()
    }

    /// A client that acts as `credential`.
    pub fn client_for(&self, credential: &Credential) -> Result<Kube, ApiError> {
        let key = credential.cache_key();
        let now = Instant::now();

        let mut clients = self.clients.lock().expect("client cache poisoned");
        clients.retain(|_, (_, used)| now.duration_since(*used) < CLIENT_IDLE);

        if let Some((client, used)) = clients.get_mut(&key) {
            *used = now;
            return Ok(client.clone());
        }

        let mut config = self.base.clone();
        if let Credential::Token { token } = credential {
            // Only the cluster's address and trust are kept: the user's token
            // replaces whatever identity the kubeconfig carried.
            config.auth_info =
                kube::config::AuthInfo { token: Some(SecretString::from(token.clone())), ..Default::default() };
        }

        let client = kube::Client::try_from(config)
            .map_err(|e| ApiError::transport(format!("could not build a client: {e}")))?;
        let kube = Kube { client };
        clients.insert(key, (kube.clone(), now));
        Ok(kube)
    }
}

/// Which kind of patch a body is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PatchKind {
    #[default]
    Merge,
    Json,
    Strategic,
    Apply,
}

impl PatchKind {
    fn content_type(self) -> &'static str {
        match self {
            PatchKind::Merge => "application/merge-patch+json",
            PatchKind::Json => "application/json-patch+json",
            PatchKind::Strategic => "application/strategic-merge-patch+json",
            PatchKind::Apply => "application/apply-patch+yaml",
        }
    }
}

/// A client acting as one identity. Cheap to clone.
#[derive(Clone)]
pub struct Kube {
    client: kube::Client,
}

impl Kube {
    /// The underlying client, for the typed kube-rs APIs (port-forwarding).
    pub fn client(&self) -> kube::Client {
        self.client.clone()
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        content_type: &str,
    ) -> Result<http::Response<Body>, ApiError> {
        let mut request = Request::builder().method(method).uri(path);
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, content_type);
        }
        request = request.header(header::ACCEPT, "application/json, */*");
        let request = request
            .body(Body::from(body.unwrap_or_default()))
            .map_err(|e| ApiError::bad_request(format!("invalid request: {e}")))?;

        self.client.send(request).await.map_err(|e| match e {
            kube::Error::Api(status) => ApiError::new(status.code, status.reason.clone(), status.message.clone()),
            other => ApiError::transport(format!("the API server could not be reached: {other}")),
        })
    }

    /// A request whose response body is returned as bytes.
    pub async fn raw(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        content_type: &str,
    ) -> Result<(StatusCode, http::HeaderMap, Bytes), ApiError> {
        let response = self.send(method, path, body, content_type).await?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|e| ApiError::transport(format!("reading the response failed: {e}")))?
            .to_bytes();

        if !status.is_success() {
            return Err(ApiError::from_response(status, &bytes));
        }
        Ok((status, headers, bytes))
    }

    /// A JSON request.
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        content_type: &str,
    ) -> Result<Value, ApiError> {
        let body = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|e| ApiError::bad_request(format!("unserialisable body: {e}")))?;
        let (_, _, bytes) = self.raw(method, path, body, content_type).await?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).or_else(|_| Ok(Value::String(String::from_utf8_lossy(&bytes).into())))
    }

    pub async fn get(&self, path: &str) -> Result<Value, ApiError> {
        self.request(Method::GET, path, None, "application/json").await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        self.request(Method::POST, path, Some(body), "application/json").await
    }

    pub async fn put(&self, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        self.request(Method::PUT, path, body, "application/json").await
    }

    pub async fn patch(&self, path: &str, body: &Value, kind: PatchKind) -> Result<Value, ApiError> {
        self.request(Method::PATCH, path, Some(body), kind.content_type()).await
    }

    pub async fn delete(&self, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        self.request(Method::DELETE, path, body, "application/json").await
    }

    /// A newline-delimited JSON stream — what a `watch=true` request answers.
    pub async fn lines(
        &self,
        path: &str,
    ) -> Result<impl Stream<Item = Result<Value, ApiError>> + Send + use<>, ApiError> {
        let response = self.send(Method::GET, path, None, "application/json").await?;
        let status = response.status();
        if !status.is_success() {
            let bytes = response.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
            return Err(ApiError::from_response(status, &bytes));
        }

        let data = response.into_body().into_data_stream();
        let stream = futures_util::stream::unfold(
            (data, Vec::<u8>::new(), false),
            |(mut data, mut buffer, mut done)| async move {
                loop {
                    if let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=end).collect();
                        let trimmed = line.trim_ascii();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let item = serde_json::from_slice::<Value>(trimmed)
                            .map_err(|e| ApiError::transport(format!("malformed watch event: {e}")));
                        return Some((item, (data, buffer, done)));
                    }
                    if done {
                        let rest = std::mem::take(&mut buffer);
                        let trimmed = rest.trim_ascii();
                        if trimmed.is_empty() {
                            return None;
                        }
                        let item = serde_json::from_slice::<Value>(trimmed)
                            .map_err(|e| ApiError::transport(format!("malformed watch event: {e}")));
                        return Some((item, (data, buffer, done)));
                    }
                    match data.next().await {
                        Some(Ok(chunk)) => buffer.extend_from_slice(&chunk),
                        Some(Err(e)) => {
                            done = true;
                            return Some((
                                Err(ApiError::transport(format!("the stream broke: {e}"))),
                                (data, Vec::new(), done),
                            ));
                        }
                        None => done = true,
                    }
                }
            },
        );
        Ok(stream)
    }

    /// Open a WebSocket to a subresource, offering `protocol`.
    ///
    /// Written out rather than delegated to `kube::Client::connect`, which
    /// only negotiates the `vN.channel.k8s.io` protocols used by exec and
    /// attach. KubeVirt's `vnc` and `console` speak `plain.kubevirt.io`.
    pub async fn websocket(
        &self,
        path: &str,
        protocol: &str,
    ) -> Result<WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>, ApiError> {
        let key = tokio_tungstenite::tungstenite::handshake::client::generate_key();
        let request = Request::builder()
            .method(Method::GET)
            .uri(path)
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_VERSION, "13")
            .header(header::SEC_WEBSOCKET_KEY, &key)
            .header(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(protocol).map_err(|_| ApiError::bad_request("bad protocol"))?,
            )
            .body(Body::from(Vec::new()))
            .map_err(|e| ApiError::bad_request(format!("invalid request: {e}")))?;

        let response = self
            .client
            .send(request)
            .await
            .map_err(|e| ApiError::transport(format!("the console could not be reached: {e}")))?;

        if response.status() != StatusCode::SWITCHING_PROTOCOLS {
            let status = response.status();
            let bytes = response.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
            return Err(ApiError::from_response(status, &bytes));
        }

        let upgraded = hyper::upgrade::on(response)
            .await
            .map_err(|e| ApiError::transport(format!("the upgrade did not complete: {e}")))?;

        Ok(WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Client, None).await)
    }
}

/// Remove the fields no screen shows and every event would otherwise repeat.
pub fn slim(mut object: Value) -> Value {
    if let Some(metadata) = object.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.remove("managedFields");
    }
    object
}

pub type Shared<T> = Arc<T>;
