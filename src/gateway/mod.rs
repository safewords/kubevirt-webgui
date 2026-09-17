//! `/ws` — the one socket every action travels over.
//!
//! ```text
//! browser → { "id": "7", "op": "call", "method": "vm.start", "params": { … } }
//! server  → { "id": "7", "op": "result", "result": { "task": "UPID:…" } }
//!
//! browser → { "id": "8", "op": "subscribe", "topic": "watch", "params": { … } }
//! server  → { "id": "8", "op": "event", "data": { "type": "SYNC", "items": [ … ] } }
//! server  → { "id": "8", "op": "event", "data": { "type": "MODIFIED", "object": { … } } }
//! browser → { "id": "8", "op": "unsubscribe" }
//! server  → { "id": "8", "op": "end" }
//! ```
//!
//! Frames are handled concurrently: a slow `vm.migrate` never holds up the
//! `resource.get` sent after it, because each call runs as its own task.

pub mod console;
pub mod upload;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rainier_framework::http::Request;
use rainier_framework::prelude::{Result as RainierResult, WebSocketHandler};
use rainier_framework::websocket::{Message, Socket, SocketId};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::rpc::{Conn, Ctx, RpcError, Sink};
use crate::state::State;

pub struct Gateway {
    state: Arc<State>,
    conns: Mutex<HashMap<SocketId, Arc<Conn>>>,
}

impl Gateway {
    pub fn new(state: Arc<State>) -> Self {
        Self { state, conns: Mutex::new(HashMap::new()) }
    }
}

#[derive(Deserialize)]
struct Inbound {
    #[serde(default)]
    id: Option<String>,
    op: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    topic: Option<String>,
    #[serde(default)]
    params: Value,
}

/// Browsers attach `Origin` to every socket; a page on another site must not
/// be able to drive this one with a visitor's open session.
pub fn origin_allowed(state: &State, request: &Request) -> bool {
    let Some(origin) = request.header("origin") else {
        // Not a browser; nothing to forge.
        return true;
    };
    if state.settings.allowed_origins.iter().any(|allowed| allowed == origin) {
        return true;
    }
    let origin_host = origin.split("://").nth(1).unwrap_or(origin).trim_end_matches('/');
    let host = request.header("x-forwarded-host").or_else(|| request.header("host")).unwrap_or_default();
    let allowed = !host.is_empty() && origin_host.eq_ignore_ascii_case(host);
    if !allowed {
        tracing::warn!(origin, host, "refused a socket from a foreign origin");
    }
    allowed
}

fn error_frame(id: &Option<String>, error: &RpcError) -> Value {
    json!({ "id": id, "op": "error", "error": error })
}

#[async_trait::async_trait]
impl WebSocketHandler for Gateway {
    fn authorize(&self, request: &Request) -> bool {
        origin_allowed(&self.state, request)
    }

    async fn on_connect(&self, socket: &Socket) -> RainierResult<()> {
        let conn = Arc::new(Conn::new(socket.clone()));
        self.conns.lock().unwrap().insert(socket.id(), conn.clone());

        conn.send(&json!({
            "op": "hello",
            "server": {
                "name": env!("CARGO_PKG_NAME"),
                "version": env!("CARGO_PKG_VERSION"),
                "product": self.state.settings.product_name,
                "cluster": self.state.cluster.url(),
            },
            "auth": {
                "methods": if self.state.auth.allows_server_identity() { vec!["token", "server"] } else { vec!["token"] },
            },
            "extensions": self.state.registry.manifests(),
            "pluginUrls": self.state.settings.plugin_urls.iter().cloned().chain(crate::spa::discovered_plugins()).collect::<Vec<_>>(),
        }));
        Ok(())
    }

    async fn on_message(&self, socket: &Socket, message: Message) -> RainierResult<()> {
        let Message::Text(text) = message else { return Ok(()) };
        let Some(conn) = self.conns.lock().unwrap().get(&socket.id()).cloned() else { return Ok(()) };

        if text.len() > self.state.settings.max_frame_bytes {
            conn.send(&error_frame(&None, &RpcError::bad_request("frame too large")));
            return Ok(());
        }

        let frame: Inbound = match serde_json::from_str(&text) {
            Ok(frame) => frame,
            Err(e) => {
                conn.send(&error_frame(&None, &RpcError::bad_request(format!("malformed frame: {e}"))));
                return Ok(());
            }
        };

        let ctx = Ctx { state: self.state.clone(), conn: conn.clone() };

        match frame.op.as_str() {
            "ping" => {
                conn.send(&json!({ "id": frame.id, "op": "pong", "ts": chrono::Utc::now().timestamp_millis() }));
            }
            "call" => {
                let Some(method) = frame.method else {
                    conn.send(&error_frame(&frame.id, &RpcError::bad_request("`method` is required")));
                    return Ok(());
                };
                let id = frame.id;
                tokio::spawn(async move {
                    let state = ctx.state.clone();
                    let conn = ctx.conn.clone();
                    let started = std::time::Instant::now();
                    let outcome = state.registry.call(ctx, &method, frame.params).await;
                    tracing::debug!(method, elapsed_ms = started.elapsed().as_millis() as u64, ok = outcome.is_ok(), "call");
                    match outcome {
                        Ok(result) => conn.send(&json!({ "id": id, "op": "result", "result": result })),
                        Err(error) => conn.send(&error_frame(&id, &error)),
                    };
                });
            }
            "subscribe" => {
                let (Some(id), Some(topic)) = (frame.id.clone(), frame.topic) else {
                    conn.send(&error_frame(&frame.id, &RpcError::bad_request("`id` and `topic` are required")));
                    return Ok(());
                };
                let sink = Sink::new(id.clone(), conn.clone());
                let task_conn = conn.clone();
                let task_id = id.clone();
                let handle = tokio::spawn(async move {
                    let state = ctx.state.clone();
                    let outcome = state.registry.subscribe(ctx, &topic, frame.params, sink).await;
                    task_conn.subscriptions.lock().unwrap().remove(&task_id);
                    match outcome {
                        Ok(()) => task_conn.send(&json!({ "id": task_id, "op": "end" })),
                        Err(error) => task_conn.send(&json!({ "id": task_id, "op": "end", "error": error })),
                    };
                });
                if let Some(previous) = conn.subscriptions.lock().unwrap().insert(id, handle.abort_handle()) {
                    previous.abort();
                }
            }
            "unsubscribe" => {
                if let Some(id) = &frame.id {
                    if let Some(handle) = conn.subscriptions.lock().unwrap().remove(id) {
                        handle.abort();
                    }
                    conn.send(&json!({ "id": id, "op": "end" }));
                }
            }
            other => {
                conn.send(&error_frame(&frame.id, &RpcError::bad_request(format!("unknown op: {other}"))));
            }
        }
        Ok(())
    }

    async fn on_close(&self, socket: &Socket) {
        if let Some(conn) = self.conns.lock().unwrap().remove(&socket.id()) {
            conn.cancel_all();
        }
    }
}
