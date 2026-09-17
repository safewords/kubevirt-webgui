//! Signing in with the cluster's own authentication.
//!
//! There is no user database. A person proves who they are with a credential
//! the API server already accepts — a ServiceAccount token or an OIDC ID token
//! — and the API server tells us who that is (`SelfSubjectReview`). From then
//! on every request is made with that credential, so Kubernetes RBAC is the
//! only authorisation there is.
//!
//! The browser holds a **ticket** rather than the token: the credential and
//! identity sealed with the application key (Proxmox's `PVEAuthCookie`, in
//! spirit). A ticket survives a reconnect and a restart (given a stable
//! `APP_KEY`) and expires on its own.

use std::sync::{Arc, OnceLock};

use base64::Engine;
use rainier_framework::crypt::Encryption;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cluster::{ApiError, Cluster, Credential, Kube};
use crate::settings::Settings;

/// Who the API server says a credential belongs to.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub username: String,
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub groups: Vec<String>,
    /// The namespace a ServiceAccount token belongs to, when it is one — the
    /// natural place to start for a user who cannot list namespaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_namespace: Option<String>,
}

/// What a ticket seals.
#[derive(Clone, Serialize, Deserialize)]
struct Claims {
    credential: Credential,
    user: UserInfo,
    issued: i64,
    expires: i64,
}

/// A signed-in identity, resolved to a client.
pub struct Session {
    pub user: UserInfo,
    pub credential: Credential,
    pub kube: Kube,
    pub expires: i64,
}

impl Session {
    pub fn expired(&self) -> bool {
        chrono::Utc::now().timestamp() >= self.expires
    }
}

/// Sign-ins and tickets.
pub struct Auth {
    settings: Settings,
    cluster: Arc<Cluster>,
    crypt: OnceLock<Arc<Encryption>>,
}

impl Auth {
    pub fn new(settings: Settings, cluster: Arc<Cluster>) -> Self {
        Self { settings, cluster, crypt: OnceLock::new() }
    }

    /// Hand over the application's encryption once the framework has booted.
    pub fn set_encryption(&self, crypt: Arc<Encryption>) {
        let _ = self.crypt.set(crypt);
    }

    fn crypt(&self) -> Result<&Encryption, ApiError> {
        self.crypt
            .get()
            .map(|c| c.as_ref())
            .ok_or_else(|| ApiError::new(503, "ServiceUnavailable", "the server is still starting"))
    }

    /// Whether signing in as the server's own identity is offered.
    pub fn allows_server_identity(&self) -> bool {
        self.settings.allow_server_identity
    }

    /// Sign in with a credential, returning the ticket and the session.
    pub async fn login(&self, credential: Credential) -> Result<(String, Arc<Session>), ApiError> {
        if matches!(credential, Credential::Server) && !self.settings.allow_server_identity {
            return Err(ApiError::new(403, "Forbidden", "signing in with the server's identity is disabled"));
        }
        if let Credential::Token { token } = &credential
            && (token.trim().is_empty() || token.len() > 16 * 1024)
        {
            return Err(ApiError::new(401, "Unauthorized", "a token is required"));
        }

        let kube = self.cluster.client_for(&credential)?;
        let user = whoami(&kube, &credential).await?;

        let now = chrono::Utc::now().timestamp();
        let claims =
            Claims { credential, user, issued: now, expires: now + self.settings.session_ttl.as_secs() as i64 };
        let ticket = self
            .crypt()?
            .encrypt_json(&claims)
            .map_err(|e| ApiError::new(500, "InternalError", format!("could not issue a ticket: {}", e.message())))?;

        Ok((
            ticket,
            Arc::new(Session { user: claims.user, credential: claims.credential, kube, expires: claims.expires }),
        ))
    }

    /// Resume from a ticket, without asking the API server again.
    pub fn resume(&self, ticket: &str) -> Result<Arc<Session>, ApiError> {
        let claims: Claims = self
            .crypt()?
            .decrypt_json(ticket)
            .map_err(|_| ApiError::new(401, "Unauthorized", "the ticket is invalid; sign in again"))?;

        if chrono::Utc::now().timestamp() >= claims.expires {
            return Err(ApiError::new(401, "Unauthorized", "the session has expired; sign in again"));
        }
        if matches!(claims.credential, Credential::Server) && !self.settings.allow_server_identity {
            return Err(ApiError::new(401, "Unauthorized", "server identity sign-in has been disabled"));
        }

        let kube = self.cluster.client_for(&claims.credential)?;
        Ok(Arc::new(Session { user: claims.user, credential: claims.credential, kube, expires: claims.expires }))
    }

    /// A fresh ticket for a live session — after checking with the API server
    /// that the credential is still accepted.
    pub async fn renew(&self, session: &Session) -> Result<(String, Arc<Session>), ApiError> {
        self.login(session.credential.clone()).await
    }
}

/// Ask the API server who a credential is.
async fn whoami(kube: &Kube, credential: &Credential) -> Result<UserInfo, ApiError> {
    let review = json!({
        "apiVersion": "authentication.k8s.io/v1",
        "kind": "SelfSubjectReview",
    });

    let mut user = match kube.post("/apis/authentication.k8s.io/v1/selfsubjectreviews", &review).await {
        Ok(response) => {
            let info = response.pointer("/status/userInfo").cloned().unwrap_or(Value::Null);
            UserInfo {
                username: info.get("username").and_then(Value::as_str).unwrap_or_default().to_string(),
                uid: info.get("uid").and_then(Value::as_str).unwrap_or_default().to_string(),
                groups: info
                    .get("groups")
                    .and_then(Value::as_array)
                    .map(|g| g.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default(),
                home_namespace: None,
            }
        }
        Err(e) if e.status == 401 => {
            return Err(ApiError::new(401, "Unauthorized", "the cluster did not accept that token"));
        }
        // Older API servers lack SelfSubjectReview. Any authenticated request
        // proves the token; the name then comes from the token itself.
        Err(e) if e.status == 404 || e.status == 403 => {
            let probe = json!({
                "apiVersion": "authorization.k8s.io/v1",
                "kind": "SelfSubjectRulesReview",
                "spec": { "namespace": "default" }
            });
            kube.post("/apis/authorization.k8s.io/v1/selfsubjectrulesreviews", &probe).await.map_err(|e| {
                if e.status == 401 {
                    ApiError::new(401, "Unauthorized", "the cluster did not accept that token")
                } else {
                    e
                }
            })?;
            UserInfo { username: String::from("(unknown)"), ..Default::default() }
        }
        Err(e) => return Err(e),
    };

    if let Credential::Token { token } = credential
        && let Some(claims) = jwt_claims(token)
    {
        if (user.username.is_empty() || user.username == "(unknown)")
            && let Some(sub) = claims.get("sub").and_then(Value::as_str)
        {
            user.username = sub.to_string();
        }
        user.home_namespace = claims.pointer("/kubernetes.io/namespace").and_then(Value::as_str).map(String::from);
    }
    if user.home_namespace.is_none() {
        // `system:serviceaccount:<namespace>:<name>`
        let parts: Vec<&str> = user.username.split(':').collect();
        if parts.len() == 4 && parts[0] == "system" && parts[1] == "serviceaccount" {
            user.home_namespace = Some(parts[2].to_string());
        }
    }
    Ok(user)
}

/// The unverified claims of a JWT — for display only; the API server has
/// already verified the token by the time this is read.
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}
