//! The gateway's vocabulary: methods, topics, and the context they run in.
//!
//! A **method** is a request with one answer — `vm.start`, `resource.get`.
//! A **topic** is a subscription that keeps sending until the browser
//! unsubscribes — `watch`, `tasks`, `metrics.vm`. Extensions register both,
//! so the core and every add-on speak through the same socket in the same way.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use rainier_framework::websocket::Socket;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{Session, UserInfo};
use crate::cluster::{ApiError, Kube};
use crate::state::State;
use crate::tasks::{TaskHandle, TaskTarget};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// An error the browser is shown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    /// `Unauthorized`, `Forbidden`, `NotFound`, `BadRequest`, `Conflict`, …
    pub code: String,
    pub status: u16,
    pub message: String,
}

impl RpcError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { status, code: code.into(), message: message.into() }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "BadRequest", message)
    }

    pub fn unauthorized() -> Self {
        Self::new(401, "Unauthorized", "sign in first")
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "NotFound", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "InternalError", message)
    }
}

impl From<ApiError> for RpcError {
    fn from(e: ApiError) -> Self {
        Self { status: e.status, code: e.reason, message: e.message }
    }
}

impl From<serde_json::Error> for RpcError {
    fn from(e: serde_json::Error) -> Self {
        Self::bad_request(format!("invalid parameters: {e}"))
    }
}

pub type RpcResult<T = Value> = Result<T, RpcError>;

/// Parse a method's parameters.
pub fn params<T: DeserializeOwned>(value: Value) -> RpcResult<T> {
    let value = if value.is_null() { json!({}) } else { value };
    serde_json::from_value(value).map_err(RpcError::from)
}

/// One browser connection to the gateway.
pub struct Conn {
    pub socket: Socket,
    pub session: RwLock<Option<Arc<Session>>>,
    pub subscriptions: std::sync::Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl Conn {
    pub fn new(socket: Socket) -> Self {
        Self { socket, session: RwLock::new(None), subscriptions: Default::default() }
    }

    /// Send a frame; `false` once the browser has gone.
    pub fn send(&self, frame: &Value) -> bool {
        self.socket.send_json(frame).is_ok()
    }

    /// Stop every subscription — on sign-out, and when the socket closes.
    pub fn cancel_all(&self) {
        for (_, handle) in self.subscriptions.lock().unwrap().drain() {
            handle.abort();
        }
    }
}

/// What a method or topic runs with.
#[derive(Clone)]
pub struct Ctx {
    pub state: Arc<State>,
    pub conn: Arc<Conn>,
}

impl Ctx {
    /// The signed-in session, or `Unauthorized`.
    pub fn session(&self) -> RpcResult<Arc<Session>> {
        let session = self.conn.session.read().unwrap().clone().ok_or_else(RpcError::unauthorized)?;
        if session.expired() {
            self.conn.send(&json!({ "op": "session", "state": "expired" }));
            return Err(RpcError::new(401, "Unauthorized", "the session has expired; sign in again"));
        }
        Ok(session)
    }

    /// A client acting as the signed-in user.
    pub fn kube(&self) -> RpcResult<Kube> {
        Ok(self.session()?.kube.clone())
    }

    pub fn user(&self) -> RpcResult<UserInfo> {
        Ok(self.session()?.user.clone())
    }

    /// Start a task as the signed-in user and return `{ "task": id }`.
    pub fn task<F, Fut>(&self, kind: &str, target: TaskTarget, description: impl Into<String>, work: F) -> RpcResult
    where
        F: FnOnce(TaskHandle) -> Fut + Send + 'static,
        Fut: Future<Output = RpcResult<Option<String>>> + Send + 'static,
    {
        let user = self.user()?;
        let id = self.state.tasks.spawn(&user.username, kind, target, description, work);
        Ok(json!({ "task": id }))
    }
}

/// Where a topic sends its events.
#[derive(Clone)]
pub struct Sink {
    id: String,
    conn: Arc<Conn>,
}

impl Sink {
    pub fn new(id: String, conn: Arc<Conn>) -> Self {
        Self { id, conn }
    }

    /// Send one event; `false` once nobody is listening.
    pub fn emit(&self, data: Value) -> bool {
        self.conn.send(&json!({ "op": "event", "id": self.id, "data": data }))
    }
}

type MethodFn = Arc<dyn Fn(Ctx, Value) -> BoxFuture<RpcResult> + Send + Sync>;
type TopicFn = Arc<dyn Fn(Ctx, Value, Sink) -> BoxFuture<RpcResult<()>> + Send + Sync>;

#[derive(Clone)]
struct MethodEntry {
    handler: MethodFn,
    public: bool,
    extension: String,
}

#[derive(Clone)]
struct TopicEntry {
    handler: TopicFn,
    extension: String,
}

/// What an extension says about itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// API resources (`group/version/resource`) the extension needs; the
    /// browser hides its screens when the cluster lacks them.
    pub requires: Vec<String>,
    #[serde(default)]
    pub methods: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
}

/// A bundle of methods and topics. The core is built from these too.
pub trait Extension: Send + Sync + 'static {
    fn manifest(&self) -> ExtensionManifest;
    fn register(&self, registry: &mut Registry);
}

/// Every method and topic the gateway serves.
#[derive(Default)]
pub struct Registry {
    methods: HashMap<String, MethodEntry>,
    topics: HashMap<String, TopicEntry>,
    extensions: BTreeMap<String, ExtensionManifest>,
    current: String,
}

impl Registry {
    /// Register an extension's methods and topics under its id.
    pub fn install(&mut self, extension: &dyn Extension) {
        let manifest = extension.manifest();
        self.current = manifest.id.clone();
        extension.register(self);

        let mut manifest = manifest;
        manifest.methods =
            self.methods.iter().filter(|(_, m)| m.extension == manifest.id).map(|(k, _)| k.clone()).collect();
        manifest.methods.sort();
        manifest.topics =
            self.topics.iter().filter(|(_, t)| t.extension == manifest.id).map(|(k, _)| k.clone()).collect();
        manifest.topics.sort();
        tracing::info!(extension = %manifest.id, methods = manifest.methods.len(), topics = manifest.topics.len(), "extension installed");
        self.extensions.insert(manifest.id.clone(), manifest);
    }

    fn add_method(&mut self, name: &str, handler: MethodFn, public: bool) {
        if self.methods.contains_key(name) {
            tracing::warn!(method = name, extension = %self.current, "method registered twice; the later one wins");
        }
        self.methods.insert(name.to_string(), MethodEntry { handler, public, extension: self.current.clone() });
    }

    /// A method that needs a signed-in user.
    pub fn method<F, Fut>(&mut self, name: &str, handler: F)
    where
        F: Fn(Ctx, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = RpcResult> + Send + 'static,
    {
        let handler: MethodFn = Arc::new(move |ctx, params| Box::pin(handler(ctx, params)));
        self.add_method(name, handler, false);
    }

    /// A method anyone connected may call — sign-in itself.
    pub fn public_method<F, Fut>(&mut self, name: &str, handler: F)
    where
        F: Fn(Ctx, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = RpcResult> + Send + 'static,
    {
        let handler: MethodFn = Arc::new(move |ctx, params| Box::pin(handler(ctx, params)));
        self.add_method(name, handler, true);
    }

    /// A subscription topic. Topics always need a signed-in user.
    pub fn topic<F, Fut>(&mut self, name: &str, handler: F)
    where
        F: Fn(Ctx, Value, Sink) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = RpcResult<()>> + Send + 'static,
    {
        let handler: TopicFn = Arc::new(move |ctx, params, sink| Box::pin(handler(ctx, params, sink)));
        if self.topics.contains_key(name) {
            tracing::warn!(topic = name, "topic registered twice; the later one wins");
        }
        self.topics.insert(name.to_string(), TopicEntry { handler, extension: self.current.clone() });
    }

    pub fn manifests(&self) -> Vec<ExtensionManifest> {
        self.extensions.values().cloned().collect()
    }

    /// Refuse, clearly, a call into an extension whose APIs this cluster does
    /// not serve — atomic-usb without its CRDs, metrics without
    /// metrics-server. Integrations are optional: an absent one is an
    /// explanation, not a 404 from somewhere deep in the API server.
    async fn ensure_available(&self, ctx: &Ctx, extension: &str) -> RpcResult<()> {
        let Some(manifest) = self.extensions.get(extension) else {
            return Ok(());
        };
        if manifest.requires.is_empty() {
            return Ok(());
        }
        let kube = ctx.kube()?;
        let discovery = ctx.state.cluster.discovery.get(&kube, false).await?;
        if manifest.requires.iter().all(|r| discovery.serves(r)) {
            return Ok(());
        }
        // Installed a moment ago? Look again before refusing.
        let discovery =
            ctx.state.cluster.discovery.refresh_unless_recent(&kube, std::time::Duration::from_secs(15)).await?;
        let missing: Vec<&str> =
            manifest.requires.iter().filter(|r| !discovery.serves(r)).map(String::as_str).collect();
        if missing.is_empty() {
            return Ok(());
        }
        Err(RpcError::new(
            404,
            "ExtensionUnavailable",
            format!("{} is not available: this cluster does not serve {}", manifest.name, missing.join(", ")),
        ))
    }

    /// Call a method.
    pub async fn call(&self, ctx: Ctx, method: &str, params: Value) -> RpcResult {
        let entry = self
            .methods
            .get(method)
            .cloned()
            .ok_or_else(|| RpcError::not_found(format!("no such method: {method}")))?;
        if !entry.public {
            ctx.session()?;
            self.ensure_available(&ctx, &entry.extension).await?;
        }
        (entry.handler)(ctx, params).await
    }

    /// Run a topic until it ends.
    pub async fn subscribe(&self, ctx: Ctx, topic: &str, params: Value, sink: Sink) -> RpcResult<()> {
        let entry =
            self.topics.get(topic).cloned().ok_or_else(|| RpcError::not_found(format!("no such topic: {topic}")))?;
        ctx.session()?;
        self.ensure_available(&ctx, &entry.extension).await?;
        (entry.handler)(ctx, params, sink).await
    }
}
