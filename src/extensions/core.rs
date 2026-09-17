//! The core: signing in, discovery, access reviews, generic resources,
//! watches and the task log.
//!
//! The generic `resource.*` methods are what make the GUI extensible without
//! backend code — a browser plugin for a new CRD can list, watch, create and
//! patch it straight away, with the user's RBAC deciding whether it may.

use std::time::Duration;

use futures_util::future::join_all;
use http::Method;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::cluster::paths::{ResourceRef, segment, with_query};
use crate::cluster::watch::{self, WatchParams};
use crate::cluster::{Credential, PatchKind, slim};
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcError, RpcResult, Sink, params};

pub struct Core;

impl Extension for Core {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "core".into(),
            name: "Core".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Authentication, discovery, generic resources, watches and tasks.".into(),
            requires: vec![],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.public_method("auth.login", login);
        r.public_method("auth.resume", resume);
        r.method("auth.renew", renew);
        r.method("auth.logout", logout);
        r.method("auth.whoami", |ctx, _| async move { Ok(serde_json::to_value(ctx.user()?)?) });

        r.method("cluster.discovery", discovery);
        r.method("cluster.namespaces", namespaces);

        r.method("access.review", access_review);
        r.method("access.rules", access_rules);

        r.method("resource.list", resource_list);
        r.method("resource.get", resource_get);
        r.method("resource.create", resource_create);
        r.method("resource.replace", resource_replace);
        r.method("resource.patch", resource_patch);
        r.method("resource.delete", resource_delete);
        r.method("resource.subresource", resource_subresource);
        r.method("resource.logs", resource_logs);
        r.method("serviceaccount.token", serviceaccount_token);

        r.topic("watch", watch_topic);

        r.method("tasks.list", tasks_list);
        r.method("tasks.detail", tasks_detail);
        r.method("tasks.stop", tasks_stop);
        r.topic("tasks", tasks_topic);
    }
}

// --- authentication -----------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginParams {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    method: Option<String>,
}

async fn login(ctx: Ctx, p: Value) -> RpcResult {
    let p: LoginParams = params(p)?;
    let credential = match (p.method.as_deref(), p.token) {
        (Some("server"), _) => Credential::Server,
        (_, Some(token)) => Credential::Token { token: token.trim().trim_start_matches("Bearer ").trim().to_string() },
        _ => return Err(RpcError::bad_request("a token is required")),
    };

    let (ticket, session) = ctx.state.auth.login(credential).await.map_err(|e| {
        tracing::info!(reason = %e.reason, "sign-in refused");
        RpcError::from(e)
    })?;
    tracing::info!(user = %session.user.username, "signed in");

    let reply = json!({ "ticket": ticket, "user": session.user, "expires": session.expires });
    ctx.conn.cancel_all();
    *ctx.conn.session.write().unwrap() = Some(session);
    Ok(reply)
}

async fn resume(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        ticket: String,
    }
    let p: P = params(p)?;
    let session = ctx.state.auth.resume(&p.ticket)?;
    let reply = json!({ "user": session.user, "expires": session.expires });
    *ctx.conn.session.write().unwrap() = Some(session);
    Ok(reply)
}

async fn renew(ctx: Ctx, _: Value) -> RpcResult {
    let session = ctx.session()?;
    let (ticket, session) = ctx.state.auth.renew(&session).await?;
    let reply = json!({ "ticket": ticket, "user": session.user, "expires": session.expires });
    *ctx.conn.session.write().unwrap() = Some(session);
    Ok(reply)
}

async fn logout(ctx: Ctx, _: Value) -> RpcResult {
    ctx.conn.cancel_all();
    *ctx.conn.session.write().unwrap() = None;
    Ok(json!({ "ok": true }))
}

// --- discovery ----------------------------------------------------------------

async fn discovery(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize, Default)]
    struct P {
        #[serde(default)]
        refresh: bool,
    }
    let p: P = params(p)?;
    let kube = ctx.kube()?;
    let discovery = ctx.state.cluster.discovery.get(&kube, p.refresh).await?;
    Ok(serde_json::to_value(&*discovery)?)
}

/// The namespaces this user can work in.
///
/// Listing namespaces is a cluster-scoped permission many users lack. They
/// still have namespaces — their ServiceAccount's own, at least — so a refusal
/// here narrows the answer rather than failing it.
async fn namespaces(ctx: Ctx, _: Value) -> RpcResult {
    let kube = ctx.kube()?;
    let user = ctx.user()?;

    match kube.get("/api/v1/namespaces").await {
        Ok(list) => {
            let names: Vec<Value> = list
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|ns| {
                    json!({
                        "name": ns.pointer("/metadata/name"),
                        "phase": ns.pointer("/status/phase"),
                        "labels": ns.pointer("/metadata/labels"),
                        "annotations": ns.pointer("/metadata/annotations"),
                        "created": ns.pointer("/metadata/creationTimestamp"),
                    })
                })
                .collect();
            Ok(json!({ "canList": true, "namespaces": names }))
        }
        Err(e) if e.status == 403 => {
            let names: Vec<Value> =
                user.home_namespace.iter().map(|ns| json!({ "name": ns, "phase": "Active" })).collect();
            Ok(json!({ "canList": false, "namespaces": names }))
        }
        Err(e) => Err(e.into()),
    }
}

// --- access -------------------------------------------------------------------

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AccessCheck {
    verb: String,
    #[serde(default)]
    group: String,
    resource: String,
    #[serde(default)]
    subresource: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// Many `SelfSubjectAccessReview`s at once — what the browser uses to grey out
/// buttons the user could not use anyway.
async fn access_review(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        checks: Vec<AccessCheck>,
    }
    let p: P = params(p)?;
    if p.checks.len() > 200 {
        return Err(RpcError::bad_request("at most 200 checks per call"));
    }
    let kube = ctx.kube()?;

    let results = join_all(p.checks.into_iter().map(|check| {
        let kube = kube.clone();
        async move {
            let review = json!({
                "apiVersion": "authorization.k8s.io/v1",
                "kind": "SelfSubjectAccessReview",
                "spec": { "resourceAttributes": {
                    "verb": check.verb,
                    "group": check.group,
                    "resource": check.resource,
                    "subresource": check.subresource,
                    "namespace": check.namespace,
                    "name": check.name,
                }}
            });
            match kube.post("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", &review).await {
                Ok(response) => json!({
                    "allowed": response.pointer("/status/allowed").and_then(Value::as_bool).unwrap_or(false),
                    "reason": response.pointer("/status/reason"),
                }),
                Err(e) => json!({ "allowed": false, "reason": e.message }),
            }
        }
    }))
    .await;

    Ok(Value::Array(results))
}

async fn access_rules(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        namespace: String,
    }
    let p: P = params(p)?;
    segment("namespace", &p.namespace)?;
    let review = json!({
        "apiVersion": "authorization.k8s.io/v1",
        "kind": "SelfSubjectRulesReview",
        "spec": { "namespace": p.namespace }
    });
    let response = ctx.kube()?.post("/apis/authorization.k8s.io/v1/selfsubjectrulesreviews", &review).await?;
    Ok(response.get("status").cloned().unwrap_or(Value::Null))
}

// --- resources ----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    #[serde(flatten)]
    target: ResourceRef,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    field_selector: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default, rename = "continue")]
    continue_token: Option<String>,
}

async fn resource_list(ctx: Ctx, p: Value) -> RpcResult {
    let p: ListParams = params(p)?;
    let path = with_query(
        &p.target.path()?,
        &[
            ("labelSelector", p.label_selector),
            ("fieldSelector", p.field_selector),
            ("limit", p.limit.map(|l| l.to_string())),
            ("continue", p.continue_token),
        ],
    );
    let mut list = ctx.kube()?.get(&path).await?;
    if let Some(items) = list.get_mut("items").and_then(Value::as_array_mut) {
        for item in items.iter_mut() {
            *item = slim(std::mem::take(item));
        }
    }
    Ok(list)
}

async fn resource_get(ctx: Ctx, p: Value) -> RpcResult {
    let target: ResourceRef = params(p)?;
    if target.name.is_none() {
        return Err(RpcError::bad_request("`name` is required"));
    }
    Ok(slim(ctx.kube()?.get(&target.path()?).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteParams {
    #[serde(flatten)]
    target: ResourceRef,
    #[serde(default)]
    body: Value,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    field_manager: Option<String>,
}

fn write_query(path: &str, dry_run: bool, field_manager: Option<String>) -> String {
    with_query(
        path,
        &[
            ("dryRun", dry_run.then(|| "All".to_string())),
            ("fieldManager", Some(field_manager.unwrap_or_else(|| "kubevirt-webgui".into()))),
        ],
    )
}

async fn resource_create(ctx: Ctx, p: Value) -> RpcResult {
    let mut p: WriteParams = params(p)?;
    p.target.name = None;
    let path = write_query(&p.target.path()?, p.dry_run, p.field_manager);
    Ok(slim(ctx.kube()?.post(&path, &p.body).await?))
}

async fn resource_replace(ctx: Ctx, p: Value) -> RpcResult {
    let p: WriteParams = params(p)?;
    if p.target.name.is_none() {
        return Err(RpcError::bad_request("`name` is required"));
    }
    let path = write_query(&p.target.path()?, p.dry_run, p.field_manager);
    Ok(slim(ctx.kube()?.put(&path, Some(&p.body)).await?))
}

async fn resource_patch(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        #[serde(flatten)]
        target: ResourceRef,
        patch: Value,
        #[serde(default)]
        patch_type: PatchKind,
        #[serde(default)]
        dry_run: bool,
        #[serde(default)]
        field_manager: Option<String>,
        #[serde(default)]
        force: bool,
    }
    let p: P = params(p)?;
    if p.target.name.is_none() {
        return Err(RpcError::bad_request("`name` is required"));
    }
    let mut path = write_query(&p.target.path()?, p.dry_run, p.field_manager);
    if matches!(p.patch_type, PatchKind::Apply) && p.force {
        path.push_str("&force=true");
    }
    Ok(slim(ctx.kube()?.patch(&path, &p.patch, p.patch_type).await?))
}

async fn resource_delete(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        #[serde(flatten)]
        target: ResourceRef,
        #[serde(default)]
        propagation_policy: Option<String>,
        #[serde(default)]
        grace_period_seconds: Option<i64>,
        #[serde(default)]
        dry_run: bool,
    }
    let p: P = params(p)?;
    if p.target.name.is_none() {
        return Err(RpcError::bad_request("`name` is required"));
    }
    let body = json!({
        "apiVersion": "v1",
        "kind": "DeleteOptions",
        "propagationPolicy": p.propagation_policy.unwrap_or_else(|| "Background".into()),
        "gracePeriodSeconds": p.grace_period_seconds,
        "dryRun": if p.dry_run { json!(["All"]) } else { Value::Null },
    });
    Ok(slim(ctx.kube()?.delete(&p.target.path()?, Some(&body)).await?))
}

/// Call any subresource — how a plugin reaches an action the core does not
/// wrap, such as a new KubeVirt verb.
async fn resource_subresource(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        #[serde(flatten)]
        target: ResourceRef,
        #[serde(default)]
        method: Option<String>,
        #[serde(default)]
        body: Option<Value>,
        #[serde(default)]
        query: Option<std::collections::BTreeMap<String, String>>,
    }
    let p: P = params(p)?;
    if p.target.subresource.is_none() {
        return Err(RpcError::bad_request("`subresource` is required"));
    }
    let method = match p.method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "PUT" => Method::PUT,
        "POST" => Method::POST,
        "PATCH" => Method::PATCH,
        other => return Err(RpcError::bad_request(format!("method {other} is not allowed"))),
    };
    let query: Vec<(&str, Option<String>)> =
        p.query.iter().flatten().map(|(k, v)| (k.as_str(), Some(v.clone()))).collect();
    let path = with_query(&p.target.path()?, &query);
    let content_type = if method == Method::PATCH { "application/merge-patch+json" } else { "application/json" };
    Ok(ctx.kube()?.request(method, &path, p.body.as_ref(), content_type).await?)
}

async fn resource_logs(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        name: String,
        #[serde(default)]
        container: Option<String>,
        #[serde(default)]
        tail_lines: Option<u32>,
        #[serde(default)]
        previous: bool,
    }
    let p: P = params(p)?;
    let path = with_query(
        &ResourceRef::new("v1", "pods").ns(&p.namespace).named(&p.name).subresource("log").path()?,
        &[
            ("container", p.container),
            ("tailLines", Some(p.tail_lines.unwrap_or(500).min(10_000).to_string())),
            ("previous", p.previous.then(|| "true".into())),
            ("timestamps", Some("true".into())),
        ],
    );
    let (_, _, bytes) = ctx.kube()?.raw(Method::GET, &path, None, "application/json").await?;
    Ok(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Mint a token for a ServiceAccount — Proxmox's "API tokens", with the
/// cluster doing the issuing and RBAC deciding who may.
async fn serviceaccount_token(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        name: String,
        #[serde(default)]
        expiration_seconds: Option<i64>,
    }
    let p: P = params(p)?;
    let path = ResourceRef::new("v1", "serviceaccounts").ns(&p.namespace).named(&p.name).subresource("token").path()?;
    let body = json!({
        "apiVersion": "authentication.k8s.io/v1",
        "kind": "TokenRequest",
        "spec": { "expirationSeconds": p.expiration_seconds.unwrap_or(3600).clamp(600, 60 * 60 * 24 * 365) }
    });
    let response = ctx.kube()?.post(&path, &body).await?;
    Ok(json!({
        "token": response.pointer("/status/token"),
        "expires": response.pointer("/status/expirationTimestamp"),
    }))
}

// --- watches ------------------------------------------------------------------

async fn watch_topic(ctx: Ctx, p: Value, sink: Sink) -> RpcResult<()> {
    let p: WatchParams = params(p)?;
    let kube = ctx.kube()?;
    watch::run(kube, p, move |event| sink.emit(event)).await?;
    Ok(())
}

// --- tasks --------------------------------------------------------------------

async fn tasks_list(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize, Default)]
    struct P {
        #[serde(default)]
        limit: Option<usize>,
    }
    let p: P = params(p)?;
    let user = ctx.user()?;
    Ok(serde_json::to_value(ctx.state.tasks.list(&user.username, p.limit.unwrap_or(200)))?)
}

async fn tasks_detail(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        id: String,
    }
    let p: P = params(p)?;
    let user = ctx.user()?;
    let (info, log) =
        ctx.state.tasks.detail(&user.username, &p.id).ok_or_else(|| RpcError::not_found("no such task"))?;
    Ok(json!({ "task": info, "log": log }))
}

async fn tasks_stop(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        id: String,
    }
    let p: P = params(p)?;
    let user = ctx.user()?;
    Ok(json!({ "stopped": ctx.state.tasks.stop(&user.username, &p.id) }))
}

async fn tasks_topic(ctx: Ctx, _: Value, sink: Sink) -> RpcResult<()> {
    let user = ctx.user()?;
    let mut events = ctx.state.tasks.subscribe();
    if !sink.emit(json!({ "type": "SYNC", "tasks": ctx.state.tasks.list(&user.username, 200) })) {
        return Ok(());
    }

    loop {
        match events.recv().await {
            Ok(event) if event.user == user.username => {
                if !sink.emit(json!({ "type": "UPDATE", "task": event.task, "line": event.line })) {
                    return Ok(());
                }
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if !sink.emit(json!({ "type": "SYNC", "tasks": ctx.state.tasks.list(&user.username, 200) })) {
                    return Ok(());
                }
            }
            Err(_) => return Ok(()),
        }
    }
}
