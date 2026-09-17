//! `/ws/console/{ticket}` — VNC and serial consoles, proxied.
//!
//! The same two-step Proxmox uses for `vncproxy` → `vncwebsocket`: the browser
//! asks for a console over the authenticated gateway (`console.ticket`), gets
//! a one-time ticket that expires within a minute, and opens a raw byte socket
//! with it. The ticket carries the user's client, so the upstream connection
//! to KubeVirt's `vnc` or `console` subresource is made as that user.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use rainier_framework::http::Request;
use rainier_framework::prelude::{Result as RainierResult, WebSocketHandler};
use rainier_framework::websocket::{Message, Socket, SocketId};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::cluster::paths::segment;
use crate::cluster::{ApiError, Kube};
use crate::state::State;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleKind {
    Vnc,
    Serial,
}

struct Ticket {
    kube: Kube,
    namespace: String,
    name: String,
    kind: ConsoleKind,
    user: String,
    expires: Instant,
}

pub struct ConsoleTickets {
    ttl: Duration,
    tickets: Mutex<HashMap<String, Ticket>>,
}

impl ConsoleTickets {
    pub fn new(ttl: Duration) -> Self {
        Self { ttl, tickets: Mutex::new(HashMap::new()) }
    }

    /// A one-time ticket for a console.
    pub fn issue(&self, kube: Kube, namespace: &str, name: &str, kind: ConsoleKind, user: &str) -> Result<String, ApiError> {
        segment("namespace", namespace)?;
        segment("name", name)?;

        let ticket = {
            use rand::RngCore;
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            hex::encode(bytes)
        };

        let mut tickets = self.tickets.lock().unwrap();
        let now = Instant::now();
        tickets.retain(|_, t| t.expires > now);
        tickets.insert(
            ticket.clone(),
            Ticket {
                kube,
                namespace: namespace.into(),
                name: name.into(),
                kind,
                user: user.into(),
                expires: now + self.ttl,
            },
        );
        Ok(ticket)
    }

    fn redeem(&self, ticket: &str) -> Option<Ticket> {
        let ticket = self.tickets.lock().unwrap().remove(ticket)?;
        (ticket.expires > Instant::now()).then_some(ticket)
    }
}

struct Upstream {
    tx: mpsc::UnboundedSender<WsMessage>,
    tasks: Vec<AbortHandle>,
}

pub struct ConsoleProxy {
    state: Arc<State>,
    upstreams: Mutex<HashMap<SocketId, Upstream>>,
}

impl ConsoleProxy {
    pub fn new(state: Arc<State>) -> Self {
        Self { state, upstreams: Mutex::new(HashMap::new()) }
    }
}

#[async_trait::async_trait]
impl WebSocketHandler for ConsoleProxy {
    fn authorize(&self, request: &Request) -> bool {
        super::origin_allowed(&self.state, request)
    }

    async fn on_connect(&self, socket: &Socket) -> RainierResult<()> {
        let Some(ticket) = socket.param("ticket").and_then(|t| self.state.consoles.redeem(t)) else {
            let _ = socket.close_with("invalid or expired console ticket");
            return Ok(());
        };

        let subresource = match ticket.kind {
            ConsoleKind::Vnc => "vnc",
            ConsoleKind::Serial => "console",
        };
        let path = format!(
            "/apis/subresources.kubevirt.io/v1/namespaces/{}/virtualmachineinstances/{}/{}",
            ticket.namespace, ticket.name, subresource
        );

        tracing::info!(user = %ticket.user, namespace = %ticket.namespace, vm = %ticket.name, kind = subresource, "console opened");

        let upstream = match ticket.kube.websocket(&path, "plain.kubevirt.io").await {
            Ok(upstream) => upstream,
            Err(e) => {
                tracing::warn!(error = %e, "console upstream failed");
                let reason: String = e.message.chars().take(120).collect();
                let _ = socket.close_with(reason);
                return Ok(());
            }
        };

        let (mut writer, mut reader) = upstream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<WsMessage>();

        let write_task = tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                if writer.send(message).await.is_err() {
                    break;
                }
            }
            let _ = writer.close().await;
        });

        let browser = socket.clone();
        let read_task = tokio::spawn(async move {
            while let Some(frame) = reader.next().await {
                let sent = match frame {
                    Ok(WsMessage::Binary(bytes)) => browser.send(Message::Binary(bytes.to_vec())),
                    Ok(WsMessage::Text(text)) => browser.send(Message::Binary(text.as_bytes().to_vec())),
                    Ok(WsMessage::Close(_)) | Err(_) => break,
                    Ok(_) => Ok(()),
                };
                if sent.is_err() {
                    break;
                }
            }
            let _ = browser.close_with("console closed");
        });

        self.upstreams.lock().unwrap().insert(
            socket.id(),
            Upstream { tx, tasks: vec![write_task.abort_handle(), read_task.abort_handle()] },
        );
        Ok(())
    }

    async fn on_message(&self, socket: &Socket, message: Message) -> RainierResult<()> {
        let upstreams = self.upstreams.lock().unwrap();
        let Some(upstream) = upstreams.get(&socket.id()) else { return Ok(()) };
        let frame = match message {
            Message::Binary(bytes) => WsMessage::Binary(bytes.into()),
            Message::Text(text) => WsMessage::Binary(text.into_bytes().into()),
            Message::Close(_) => return Ok(()),
        };
        let _ = upstream.tx.send(frame);
        Ok(())
    }

    async fn on_close(&self, socket: &Socket) {
        if let Some(upstream) = self.upstreams.lock().unwrap().remove(&socket.id()) {
            drop(upstream.tx);
            for task in upstream.tasks {
                // The writer is left to flush its close; the reader stops now.
                task.abort();
            }
        }
    }
}
