//! Usage graphs, from metrics-server.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cluster::paths::{ResourceRef, segment, with_query};
use crate::cluster::{ApiError, Kube};
use crate::metrics::{Sample, quantity};
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcResult, Sink, params};

pub struct Metrics;

const INTERVAL: Duration = Duration::from_secs(5);

impl Extension for Metrics {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "metrics".into(),
            name: "Metrics".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: "CPU and memory usage graphs for guests and nodes, from metrics-server.".into(),
            requires: vec!["metrics.k8s.io/v1beta1/pods".into()],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.topic("metrics.vmi", vmi_metrics);
        r.topic("metrics.node", node_metrics);
        r.topic("metrics.nodes", nodes_metrics);
    }
}

fn usage(object: &Value) -> (f64, f64, i64) {
    let ts = object
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp_millis())
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    if let Some(usage) = object.get("usage") {
        return (quantity(usage["cpu"].as_str().unwrap_or("0")), quantity(usage["memory"].as_str().unwrap_or("0")), ts);
    }
    let mut cpu = 0.0;
    let mut memory = 0.0;
    for container in object.get("containers").and_then(Value::as_array).into_iter().flatten() {
        cpu += quantity(container.pointer("/usage/cpu").and_then(Value::as_str).unwrap_or("0"));
        memory += quantity(container.pointer("/usage/memory").and_then(Value::as_str).unwrap_or("0"));
    }
    (cpu, memory, ts)
}

/// The running launcher pod of a VMI.
async fn launcher_pod(kube: &Kube, namespace: &str, name: &str) -> Result<Option<String>, ApiError> {
    let vmi = kube
        .get(&ResourceRef::new("kubevirt.io/v1", "virtualmachineinstances").ns(namespace).named(name).path()?)
        .await?;
    let uid = vmi.pointer("/metadata/uid").and_then(Value::as_str).unwrap_or_default();
    let node = vmi.pointer("/status/nodeName").and_then(Value::as_str).unwrap_or_default();
    let pods = kube
        .get(&with_query(
            &ResourceRef::new("v1", "pods").ns(namespace).path()?,
            &[("labelSelector", Some(format!("kubevirt.io/created-by={uid}")))],
        ))
        .await?;
    Ok(pods
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| p.pointer("/status/phase").and_then(Value::as_str) == Some("Running"))
        .find(|p| node.is_empty() || p.pointer("/spec/nodeName").and_then(Value::as_str) == Some(node))
        .and_then(|p| p.pointer("/metadata/name").and_then(Value::as_str))
        .map(String::from))
}

async fn stream(
    ctx: Ctx,
    sink: Sink,
    key: String,
    mut fetch: impl FnMut(Kube) -> futures_util::future::BoxFuture<'static, Result<Option<Sample>, ApiError>>,
) -> RpcResult<()> {
    let kube = ctx.kube()?;
    let mut sent_history = false;
    let mut last_ts = 0i64;
    loop {
        match fetch(kube.clone()).await {
            // metrics-server refreshes every 15s or so; repeating a window
            // would only draw a flat step in the chart.
            Ok(Some(sample)) if sent_history && sample.ts == last_ts => {}
            Ok(Some(sample)) => {
                last_ts = sample.ts;
                if !sent_history {
                    // Only after the user's own fetch succeeded: history is
                    // shown to people who can read the object now.
                    if !sink.emit(json!({ "type": "history", "samples": ctx.state.metrics.history(&key) })) {
                        return Ok(());
                    }
                    sent_history = true;
                }
                ctx.state.metrics.record(&key, sample.clone());
                if !sink.emit(json!({ "type": "sample", "sample": sample })) {
                    return Ok(());
                }
            }
            Ok(None) => {
                if !sink.emit(json!({ "type": "idle" })) {
                    return Ok(());
                }
            }
            Err(e) if e.status == 403 => return Err(e.into()),
            Err(e) => {
                if !sink.emit(json!({ "type": "error", "error": e })) {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(INTERVAL).await;
    }
}

#[derive(Deserialize)]
struct VmiParams {
    namespace: String,
    name: String,
}

async fn vmi_metrics(ctx: Ctx, p: Value, sink: Sink) -> RpcResult<()> {
    let p: VmiParams = params(p)?;
    segment("namespace", &p.namespace)?;
    segment("name", &p.name)?;
    let key = format!("vmi/{}/{}", p.namespace, p.name);
    stream(ctx, sink, key, move |kube| {
        let namespace = p.namespace.clone();
        let name = p.name.clone();
        Box::pin(async move {
            let Some(pod) = (match launcher_pod(&kube, &namespace, &name).await {
                Ok(pod) => pod,
                Err(e) if e.is_not_found() => None,
                Err(e) => return Err(e),
            }) else {
                return Ok(None);
            };
            let path = ResourceRef::new("metrics.k8s.io/v1beta1", "pods").ns(&namespace).named(&pod).path()?;
            match kube.get(&path).await {
                Ok(metrics) => {
                    let (cpu, memory, ts) = usage(&metrics);
                    Ok(Some(Sample { ts, cpu, memory }))
                }
                Err(e) if e.is_not_found() => Ok(None),
                Err(e) => Err(e),
            }
        })
    })
    .await
}

async fn node_metrics(ctx: Ctx, p: Value, sink: Sink) -> RpcResult<()> {
    #[derive(Deserialize)]
    struct P {
        name: String,
    }
    let p: P = params(p)?;
    segment("name", &p.name)?;
    let key = format!("node/{}", p.name);
    stream(ctx, sink, key, move |kube| {
        let name = p.name.clone();
        Box::pin(async move {
            let path = ResourceRef::new("metrics.k8s.io/v1beta1", "nodes").named(&name).path()?;
            match kube.get(&path).await {
                Ok(metrics) => {
                    let (cpu, memory, ts) = usage(&metrics);
                    Ok(Some(Sample { ts, cpu, memory }))
                }
                Err(e) if e.is_not_found() => Ok(None),
                Err(e) => Err(e),
            }
        })
    })
    .await
}

/// Every node's current usage, for the datacenter summary.
async fn nodes_metrics(ctx: Ctx, _: Value, sink: Sink) -> RpcResult<()> {
    let kube = ctx.kube()?;
    loop {
        match kube.get("/apis/metrics.k8s.io/v1beta1/nodes").await {
            Ok(list) => {
                let mut nodes = serde_json::Map::new();
                for item in list.get("items").and_then(Value::as_array).into_iter().flatten() {
                    let name = item.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default().to_string();
                    let (cpu, memory, ts) = usage(item);
                    ctx.state.metrics.record(&format!("node/{name}"), Sample { ts, cpu, memory });
                    nodes.insert(name, json!({ "cpu": cpu, "memory": memory, "ts": ts }));
                }
                if !sink.emit(json!({ "type": "nodes", "nodes": nodes })) {
                    return Ok(());
                }
            }
            Err(e) if e.status == 403 => return Err(e.into()),
            Err(e) => {
                if !sink.emit(json!({ "type": "error", "error": e })) {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}
