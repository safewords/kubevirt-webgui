//! Nodes: maintenance mode — cordon, and drain by live-migrating guests away.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cluster::paths::{ResourceRef, segment, with_query};
use crate::cluster::PatchKind;
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcError, RpcResult, params};
use crate::tasks::TaskTarget;

pub struct Nodes;

impl Extension for Nodes {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "nodes".into(),
            name: "Nodes".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Node maintenance: cordon, uncordon, and drain with live migration.".into(),
            requires: vec!["v1/nodes".into()],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.method("node.cordon", |ctx, p| cordon(ctx, p, true));
        r.method("node.uncordon", |ctx, p| cordon(ctx, p, false));
        r.method("node.drain", drain);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeParams {
    name: String,
    #[serde(default)]
    evict_pods: bool,
}

fn node_target(name: &str) -> TaskTarget {
    TaskTarget { kind: "Node".into(), namespace: None, name: name.into() }
}

async fn cordon(ctx: Ctx, p: Value, unschedulable: bool) -> RpcResult {
    let p: NodeParams = params(p)?;
    segment("name", &p.name)?;
    let kube = ctx.kube()?;
    let verb = if unschedulable { "Cordon" } else { "Uncordon" };
    ctx.task(if unschedulable { "node.cordon" } else { "node.uncordon" }, node_target(&p.name), format!("{verb} {}", p.name), move |_task| async move {
        let path = ResourceRef::new("v1", "nodes").named(&p.name).path()?;
        kube.patch(&path, &json!({ "spec": { "unschedulable": unschedulable } }), PatchKind::Merge).await?;
        Ok(Some(if unschedulable { "node cordoned".into() } else { "node schedulable again".into() }))
    })
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default()
}

async fn drain(ctx: Ctx, p: Value) -> RpcResult {
    let p: NodeParams = params(p)?;
    segment("name", &p.name)?;
    let kube = ctx.kube()?;

    ctx.task("node.drain", node_target(&p.name), format!("Drain {}", p.name), move |task| async move {
        let node = p.name.as_str();
        kube.patch(&ResourceRef::new("v1", "nodes").named(node).path()?, &json!({ "spec": { "unschedulable": true } }), PatchKind::Merge).await?;
        task.log(format!("cordoned {node}"));

        let vmis = kube
            .get(&with_query(
                &ResourceRef::new("kubevirt.io/v1", "virtualmachineinstances").path()?,
                &[("labelSelector", Some(format!("kubevirt.io/nodeName={node}")))],
            ))
            .await?;
        let vmis = vmis.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        task.log(format!("{} guest(s) on {node}", vmis.len()));

        let mut migrations: Vec<(String, String, String)> = Vec::new();
        let mut stuck = 0;
        for vmi in &vmis {
            let ns = str_at(vmi, "/metadata/namespace").to_string();
            let name = str_at(vmi, "/metadata/name").to_string();
            let migratable = vmi
                .pointer("/status/conditions")
                .and_then(Value::as_array)
                .and_then(|c| c.iter().find(|c| c["type"] == "LiveMigratable"))
                .cloned();
            match migratable {
                Some(c) if c["status"] == "True" => {
                    let body = json!({
                        "apiVersion": "kubevirt.io/v1",
                        "kind": "VirtualMachineInstanceMigration",
                        "metadata": { "generateName": format!("{name}-drain-"), "namespace": ns },
                        "spec": { "vmiName": name }
                    });
                    match kube.post(&ResourceRef::new("kubevirt.io/v1", "virtualmachineinstancemigrations").ns(&ns).path()?, &body).await {
                        Ok(created) => {
                            let migration = str_at(&created, "/metadata/name").to_string();
                            task.log(format!("{ns}/{name}: live migration {migration} started"));
                            migrations.push((ns, name, migration));
                        }
                        Err(e) => {
                            stuck += 1;
                            task.log(format!("{ns}/{name}: could not start migration: {}", e.message));
                        }
                    }
                }
                other => {
                    stuck += 1;
                    let reason = other.map(|c| str_at(&c, "/message").to_string()).unwrap_or_else(|| "not live-migratable".into());
                    task.log(format!("{ns}/{name}: cannot live-migrate ({reason})"));
                }
            }
        }

        let started = Instant::now();
        let mut pending = migrations;
        while !pending.is_empty() {
            if started.elapsed() > Duration::from_secs(3 * 3600) {
                return Err(RpcError::new(504, "Timeout", "migrations did not finish within 3 hours"));
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
            let mut still = Vec::new();
            for (ns, name, migration) in pending {
                let path = ResourceRef::new("kubevirt.io/v1", "virtualmachineinstancemigrations").ns(&ns).named(&migration);
                match kube.get(&path.path()?).await.map(|m| str_at(&m, "/status/phase").to_string()) {
                    Ok(phase) if phase == "Succeeded" => task.log(format!("{ns}/{name}: migrated")),
                    Ok(phase) if phase == "Failed" => {
                        stuck += 1;
                        task.log(format!("{ns}/{name}: migration failed"));
                    }
                    Ok(_) => still.push((ns, name, migration)),
                    Err(e) => {
                        stuck += 1;
                        task.log(format!("{ns}/{name}: {}", e.message));
                    }
                }
            }
            pending = still;
        }

        if p.evict_pods {
            let pods = kube
                .get(&with_query(&ResourceRef::new("v1", "pods").path()?, &[("fieldSelector", Some(format!("spec.nodeName={node}")))]))
                .await?;
            for pod in pods.get("items").and_then(Value::as_array).into_iter().flatten() {
                let ns = str_at(pod, "/metadata/namespace");
                let name = str_at(pod, "/metadata/name");
                let daemon = pod
                    .pointer("/metadata/ownerReferences")
                    .and_then(Value::as_array)
                    .is_some_and(|o| o.iter().any(|o| o["kind"] == "DaemonSet"));
                let mirror = pod.pointer("/metadata/annotations/kubernetes.io~1config.mirror").is_some();
                let finished = matches!(str_at(pod, "/status/phase"), "Succeeded" | "Failed");
                if daemon || mirror || finished {
                    continue;
                }
                let eviction = json!({
                    "apiVersion": "policy/v1",
                    "kind": "Eviction",
                    "metadata": { "name": name, "namespace": ns }
                });
                let path = ResourceRef::new("v1", "pods").ns(ns).named(name).sub("eviction").path()?;
                match kube.post(&path, &eviction).await {
                    Ok(_) => task.log(format!("evicted pod {ns}/{name}")),
                    Err(e) => task.log(format!("could not evict pod {ns}/{name}: {}", e.message)),
                }
            }
        }

        if stuck > 0 {
            Err(RpcError::new(409, "Conflict", format!("{stuck} guest(s) could not be moved off {node}")))
        } else {
            Ok(Some(format!("{node} drained")))
        }
    })
}
