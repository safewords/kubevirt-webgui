//! Virtual machines: power, consoles, the guest agent, migration, snapshots,
//! clones and creation — each long operation run as a task with a log.

use std::time::{Duration, Instant};

use base64::Engine;
use http::Method;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::cluster::paths::{ResourceRef, segment, with_query};
use crate::cluster::{ApiError, Kube};
use crate::gateway::console::ConsoleKind;
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcError, RpcResult, params};
use crate::tasks::{TaskHandle, TaskTarget};

use super::datavolumes::{self, Settled};

pub struct KubeVirt;

impl Extension for KubeVirt {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "kubevirt".into(),
            name: "KubeVirt".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Virtual machine lifecycle, consoles, guest agent, migration, snapshots and clones.".into(),
            requires: vec!["kubevirt.io/v1/virtualmachines".into()],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        for action in
            ["start", "stop", "shutdown", "restart", "reboot", "reset", "pause", "resume", "freeze", "unfreeze"]
        {
            r.method(&format!("vm.{action}"), move |ctx, p| power(ctx, p, action));
        }
        r.method("vm.migrate", migrate);
        r.method("vm.migrate.cancel", migrate_cancel);
        r.topic("migration.progress", super::migration::progress_topic);
        r.method("vm.guest", guest);
        r.method("vm.screenshot", screenshot);
        r.method("vm.expandSpec", expand_spec);
        r.method("vm.objectGraph", object_graph);
        r.method("vm.delete", delete);
        r.method("vm.create", create);
        r.method("vm.snapshot", snapshot);
        r.method("vm.restore", restore);
        r.method("vm.clone", clone);
        r.method("vm.volume.add", volume_add);
        r.method("vm.volume.remove", volume_remove);
        r.method("console.ticket", console_ticket);
        r.method("datavolume.create", datavolume_create);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VmParams {
    namespace: String,
    name: String,
}

fn vm(ns: &str, name: &str) -> ResourceRef {
    ResourceRef::new("kubevirt.io/v1", "virtualmachines").ns(ns).named(name)
}

fn vmi(ns: &str, name: &str) -> ResourceRef {
    ResourceRef::new("kubevirt.io/v1", "virtualmachineinstances").ns(ns).named(name)
}

fn target(ns: &str, name: &str) -> TaskTarget {
    TaskTarget { kind: "VirtualMachine".into(), namespace: Some(ns.into()), name: name.into() }
}

/// GET that answers `None` for a 404.
async fn find(kube: &Kube, target: ResourceRef) -> Result<Option<Value>, ApiError> {
    match kube.get(&target.path()?).await {
        Ok(object) => Ok(Some(object)),
        Err(e) if e.is_not_found() => Ok(None),
        Err(e) => Err(e),
    }
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default()
}

/// Poll until `done` says so, logging each change in what `describe` reports.
async fn wait_until<F>(
    task: &TaskHandle,
    timeout: Duration,
    mut probe: impl FnMut() -> F,
    mut done: impl FnMut(&Option<Value>) -> Option<Result<Option<String>, RpcError>>,
    describe: impl Fn(&Option<Value>) -> String,
) -> RpcResult<Option<String>>
where
    F: std::future::Future<Output = Result<Option<Value>, ApiError>>,
{
    let started = Instant::now();
    let mut last = String::new();
    loop {
        let current = probe().await?;
        let description = describe(&current);
        if !description.is_empty() && description != last {
            task.log(description.clone());
            last = description;
        }
        if let Some(outcome) = done(&current) {
            return outcome;
        }
        if started.elapsed() > timeout {
            return Err(RpcError::new(504, "Timeout", format!("gave up waiting after {}s", timeout.as_secs())));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn vmi_state(vmi: &Option<Value>) -> String {
    match vmi {
        None => "VMI: not present".into(),
        Some(vmi) => {
            let phase = str_at(vmi, "/status/phase");
            let node = str_at(vmi, "/status/nodeName");
            let paused = vmi
                .pointer("/status/conditions")
                .and_then(Value::as_array)
                .is_some_and(|c| c.iter().any(|c| c["type"] == "Paused" && c["status"] == "True"));
            let mut state = format!("VMI phase: {phase}");
            if !node.is_empty() {
                state.push_str(&format!(" on {node}"));
            }
            if paused {
                state.push_str(" (paused)");
            }
            state
        }
    }
}

// --- power --------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PowerOptions {
    #[serde(default)]
    force: bool,
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    wait: Option<bool>,
}

async fn power(ctx: Ctx, p: Value, action: &'static str) -> RpcResult {
    let VmParams { namespace, name } = params(p.clone())?;
    let options: PowerOptions = params(p)?;
    segment("namespace", &namespace)?;
    segment("name", &name)?;
    let kube = ctx.kube()?;
    let wait = options.wait.unwrap_or(true);

    let description = match (action, options.force) {
        ("stop", true) | ("shutdown", true) => "Stop (force)".to_string(),
        ("stop", false) => "Stop".to_string(),
        ("shutdown", false) => "Shutdown".to_string(),
        ("restart", true) => "Restart (force)".to_string(),
        (action, _) => {
            let mut chars = action.chars();
            chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
        }
    };
    let kind = format!("vm.{action}");

    ctx.task(&kind, target(&namespace, &name), format!("{description} {namespace}/{name}"), move |task| async move {
        let ns = namespace.as_str();
        let n = name.as_str();
        let vm_sub = |sub: &str| {
            ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachines").ns(ns).named(n).subresource(sub)
        };
        let vmi_sub = |sub: &str| {
            ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachineinstances").ns(ns).named(n).subresource(sub)
        };

        let before = find(&kube, vmi(ns, n)).await?;
        let before_uid = before.as_ref().map(|v| str_at(v, "/metadata/uid").to_string());
        task.log(format!("requesting {action} of {ns}/{n}"));

        match action {
            "start" => {
                kube.put(&vm_sub("start").path()?, Some(&json!({ "paused": options.paused }))).await?;
                if !wait {
                    return Ok(None);
                }
                wait_until(
                    &task,
                    Duration::from_secs(600),
                    || find(&kube, vmi(ns, n)),
                    |vmi| match vmi.as_ref().map(|v| str_at(v, "/status/phase")) {
                        Some("Running") => Some(Ok(Some("VM is running".into()))),
                        Some("Failed") => Some(Err(RpcError::internal("the VMI failed to start"))),
                        _ => None,
                    },
                    vmi_state,
                )
                .await
            }
            "stop" | "shutdown" => {
                // Shutdown is ACPI with the guest's grace period; stop without
                // force is the same request, and `force` pulls the plug.
                let body = if options.force { json!({ "gracePeriod": 0 }) } else { json!({}) };
                kube.put(&vm_sub("stop").path()?, Some(&body)).await?;
                if !wait || before.is_none() {
                    return Ok(Some("VM was not running".into()).filter(|_| before.is_none()));
                }
                wait_until(
                    &task,
                    Duration::from_secs(900),
                    || find(&kube, vmi(ns, n)),
                    |vmi| match vmi {
                        None => Some(Ok(Some("VM is stopped".into()))),
                        Some(v) if Some(str_at(v, "/metadata/uid").to_string()) != before_uid => {
                            Some(Ok(Some("VM is stopped".into())))
                        }
                        _ => None,
                    },
                    vmi_state,
                )
                .await
            }
            "restart" => {
                let body = if options.force { json!({ "gracePeriodSeconds": 0 }) } else { json!({}) };
                kube.put(&vm_sub("restart").path()?, Some(&body)).await?;
                if !wait {
                    return Ok(None);
                }
                wait_until(
                    &task,
                    Duration::from_secs(900),
                    || find(&kube, vmi(ns, n)),
                    |vmi| match vmi {
                        Some(v)
                            if Some(str_at(v, "/metadata/uid").to_string()) != before_uid
                                && str_at(v, "/status/phase") == "Running" =>
                        {
                            Some(Ok(Some("VM restarted and is running".into())))
                        }
                        _ => None,
                    },
                    vmi_state,
                )
                .await
            }
            "reboot" => {
                kube.put(&vmi_sub("softreboot").path()?, None).await?;
                Ok(Some("soft reboot requested from the guest".into()))
            }
            "reset" => {
                kube.put(&vmi_sub("reset").path()?, None).await?;
                Ok(Some("VM was reset".into()))
            }
            "pause" => {
                kube.put(&vmi_sub("pause").path()?, Some(&json!({}))).await?;
                Ok(Some("VM paused".into()))
            }
            "resume" => {
                kube.put(&vmi_sub("unpause").path()?, Some(&json!({}))).await?;
                Ok(Some("VM resumed".into()))
            }
            "freeze" => {
                kube.put(&vmi_sub("freeze").path()?, Some(&json!({ "unfreezeTimeout": "5m" }))).await?;
                Ok(Some("guest filesystems frozen (auto-thaw in 5m)".into()))
            }
            "unfreeze" => {
                kube.put(&vmi_sub("unfreeze").path()?, None).await?;
                Ok(Some("guest filesystems thawed".into()))
            }
            other => Err(RpcError::bad_request(format!("unknown action {other}"))),
        }
    })
}

// --- migration ----------------------------------------------------------------

async fn migrate(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        name: String,
        #[serde(default)]
        target_node: Option<String>,
    }
    let p: P = params(p)?;
    segment("namespace", &p.namespace)?;
    segment("name", &p.name)?;
    let kube = ctx.kube()?;

    let mut spec = json!({ "vmiName": p.name });
    if let Some(node) = p.target_node.as_deref().filter(|n| !n.is_empty()) {
        segment("targetNode", node)?;
        spec["addedNodeSelector"] = json!({ "kubernetes.io/hostname": node });
    }
    let body = json!({
        "apiVersion": "kubevirt.io/v1",
        "kind": "VirtualMachineInstanceMigration",
        "metadata": { "generateName": format!("{}-migration-", p.name), "namespace": p.namespace },
        "spec": spec,
    });

    let description = match &p.target_node {
        Some(node) if !node.is_empty() => format!("Migrate {}/{} to {node}", p.namespace, p.name),
        _ => format!("Migrate {}/{}", p.namespace, p.name),
    };

    ctx.task("vm.migrate", target(&p.namespace, &p.name), description, move |task| async move {
        let ns = p.namespace.as_str();
        let current =
            find(&kube, vmi(ns, &p.name)).await?.ok_or_else(|| RpcError::bad_request("the VM is not running"))?;
        let source_node = str_at(&current, "/status/nodeName").to_string();
        task.log(format!("source node: {source_node}"));
        let cpu_hint = host_cpu_hint(&kube, &current, &source_node).await;
        let mut transfer = super::migration::TaskReporter::new();
        transfer.prepare(&kube, &p.namespace, &p.name, &source_node).await;

        let created = kube
            .post(&ResourceRef::new("kubevirt.io/v1", "virtualmachineinstancemigrations").ns(ns).path()?, &body)
            .await?;
        let migration = str_at(&created, "/metadata/name").to_string();
        task.log(format!("created migration {migration}"));

        let path = ResourceRef::new("kubevirt.io/v1", "virtualmachineinstancemigrations").ns(ns).named(&migration);
        let started = Instant::now();
        let mut last_phase = String::new();
        let mut last_scheduling = String::new();
        loop {
            let Some(m) = find(&kube, path.clone()).await? else {
                return Err(RpcError::new(409, "Cancelled", "the migration was cancelled (its object was deleted)"));
            };
            let phase = str_at(&m, "/status/phase").to_string();

            let mut line = format!("migration phase: {}", if phase.is_empty() { "Pending" } else { &phase });
            let target_node = str_at(&m, "/status/migrationState/targetNode");
            if !target_node.is_empty() {
                line.push_str(&format!(" → {target_node}"));
            }
            let mode = str_at(&m, "/status/migrationState/mode");
            if !mode.is_empty() {
                line.push_str(&format!(" ({mode})"));
            }
            if line != last_phase {
                task.log(line.clone());
                last_phase = line;
            }

            // A target that cannot be placed is the commonest failure, and
            // KubeVirt only says "unschedulable" after five minutes. The
            // scheduler's own reason — no node with this CPU model, not
            // enough memory — is on the target pod straight away.
            if matches!(phase.as_str(), "" | "Pending" | "Scheduling")
                && let Some(reason) = target_pod_scheduling(&kube, ns, str_at(&m, "/metadata/uid")).await
                && reason != last_scheduling
            {
                task.log(format!("target pod cannot be scheduled: {reason}"));
                if last_scheduling.is_empty()
                    && let Some(hint) = &cpu_hint
                {
                    task.log(format!("hint: {hint}"));
                }
                last_scheduling = reason;
            }

            // Memory moves while the migration is Running; the source
            // virt-handler samples it every five seconds.
            if matches!(phase.as_str(), "TargetReady" | "Running") {
                transfer.sample(&task, &kube, ns, &p.name, &source_node).await;
            }

            match phase.as_str() {
                "Succeeded" => return Ok(Some("migration finished successfully".into())),
                "Failed" => {
                    let reason = str_at(&m, "/status/migrationState/failureReason").to_string();
                    let events = migration_events(&kube, ns, &migration).await;
                    for event in &events {
                        task.log(format!("event: {event}"));
                    }
                    let detail = if !reason.is_empty() {
                        reason
                    } else if !last_scheduling.is_empty() {
                        format!("the target pod could not be scheduled: {last_scheduling}")
                    } else {
                        events.last().cloned().unwrap_or_else(|| "no reason reported".into())
                    };
                    return Err(RpcError::internal(format!("migration failed: {detail}")));
                }
                _ => {}
            }

            if started.elapsed() > Duration::from_secs(3600) {
                return Err(RpcError::new(504, "Timeout", "gave up waiting after 3600s"));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
}

/// When a VM runs with the host's CPU model and no other schedulable node
/// has that CPU, the reason a migration cannot be placed, in words — the
/// scheduler only says "didn't match node affinity".
async fn host_cpu_hint(kube: &Kube, vmi: &Value, source_node: &str) -> Option<String> {
    let model = str_at(vmi, "/spec/domain/cpu/model");
    if !(model.is_empty() || model == "host-model" || model == "host-passthrough") {
        return None;
    }
    const PREFIX: &str = "host-model-cpu.node.kubevirt.io/";
    let host_models = |node: &Value| -> Vec<String> {
        node.pointer("/metadata/labels")
            .and_then(Value::as_object)
            .map(|labels| labels.keys().filter_map(|k| k.strip_prefix(PREFIX)).map(String::from).collect())
            .unwrap_or_default()
    };
    // Needs `list nodes`; users without it simply get no hint.
    let nodes = kube.get("/api/v1/nodes").await.ok()?;
    let nodes = nodes.get("items")?.as_array()?;
    let source = nodes.iter().find(|n| str_at(n, "/metadata/name") == source_node)?;
    let source_models = host_models(source);
    let source_model = source_models.first()?;
    let compatible = nodes.iter().any(|n| {
        str_at(n, "/metadata/name") != source_node
            && n.pointer("/metadata/labels/kubevirt.io~1schedulable").and_then(Value::as_str) == Some("true")
            && host_models(n).iter().any(|m| m == source_model)
    });
    (!compatible).then(|| {
        format!(
            "the VM uses the host CPU model ({source_model} on {source_node}) and no other node has that CPU; give it a CPU model every node supports (Hardware → Processors) and restart it — like a common CPU type in Proxmox"
        )
    })
}

/// Why a migration's target pod is not scheduled, if it is not.
async fn target_pod_scheduling(kube: &Kube, namespace: &str, migration_uid: &str) -> Option<String> {
    if migration_uid.is_empty() {
        return None;
    }
    let path = with_query(
        &ResourceRef::new("v1", "pods").ns(namespace).path().ok()?,
        &[("labelSelector", Some(format!("kubevirt.io/migrationJobUID={migration_uid}")))],
    );
    let pods = kube.get(&path).await.ok()?;
    pods.get("items")?.as_array()?.iter().find_map(|pod| {
        let condition = pod
            .pointer("/status/conditions")?
            .as_array()?
            .iter()
            .find(|c| c["type"] == "PodScheduled" && c["status"] == "False")?;
        Some(str_at(condition, "/message").to_string()).filter(|m| !m.is_empty())
    })
}

/// The events about a migration, oldest first, as "Reason: message".
async fn migration_events(kube: &Kube, namespace: &str, migration: &str) -> Vec<String> {
    let Ok(base) = ResourceRef::new("v1", "events").ns(namespace).path() else {
        return Vec::new();
    };
    let path = with_query(&base, &[("fieldSelector", Some(format!("involvedObject.name={migration}")))]);
    let Ok(list) = kube.get(&path).await else {
        return Vec::new();
    };
    let mut events: Vec<(String, String)> = list
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|e| {
            let at = e
                .get("lastTimestamp")
                .and_then(Value::as_str)
                .or_else(|| e.get("eventTime").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();
            (at, format!("{}: {}", str_at(e, "/reason"), str_at(e, "/message")))
        })
        .collect();
    events.sort();
    events.into_iter().map(|(_, text)| text).collect()
}

async fn migrate_cancel(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        namespace: String,
        migration: String,
    }
    let p: P = params(p)?;
    let path =
        ResourceRef::new("kubevirt.io/v1", "virtualmachineinstancemigrations").ns(&p.namespace).named(&p.migration);
    ctx.kube()?.delete(&path.path()?, None).await?;
    Ok(json!({ "ok": true }))
}

// --- guest agent, screenshots, specs --------------------------------------------

async fn guest(ctx: Ctx, p: Value) -> RpcResult {
    let VmParams { namespace, name } = params(p)?;
    let kube = ctx.kube()?;
    let sub = |s: &str| {
        ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachineinstances")
            .ns(&namespace)
            .named(&name)
            .subresource(s)
    };

    let (os, users, filesystems) = tokio::join!(
        async { kube.get(&sub("guestosinfo").path()?).await },
        async { kube.get(&sub("userlist").path()?).await },
        async { kube.get(&sub("filesystemlist").path()?).await },
    );
    let pack = |r: Result<Value, ApiError>| match r {
        Ok(v) => json!({ "ok": true, "data": v }),
        Err(e) => json!({ "ok": false, "error": e.message }),
    };
    Ok(json!({ "os": pack(os), "users": pack(users), "filesystems": pack(filesystems) }))
}

async fn screenshot(ctx: Ctx, p: Value) -> RpcResult {
    let VmParams { namespace, name } = params(p)?;
    let path = with_query(
        &ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachineinstances")
            .ns(&namespace)
            .named(&name)
            .subresource("vnc/screenshot")
            .path()?,
        &[("moveCursor", Some("false".into()))],
    );
    let (_, headers, bytes) = ctx.kube()?.raw(Method::GET, &path, None, "application/json").await?;
    let content_type = headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("image/png");
    Ok(json!({
        "dataUrl": format!("data:{content_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
        "takenAt": chrono::Utc::now().timestamp_millis(),
    }))
}

async fn expand_spec(ctx: Ctx, p: Value) -> RpcResult {
    let VmParams { namespace, name } = params(p)?;
    let path = ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachines")
        .ns(&namespace)
        .named(&name)
        .subresource("expand-spec");
    Ok(ctx.kube()?.get(&path.path()?).await?)
}

async fn object_graph(ctx: Ctx, p: Value) -> RpcResult {
    let VmParams { namespace, name } = params(p)?;
    let path = ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachines")
        .ns(&namespace)
        .named(&name)
        .subresource("objectgraph");
    Ok(ctx.kube()?.get(&path.path()?).await?)
}

// --- delete / create ------------------------------------------------------------

async fn delete(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        name: String,
        /// Also delete the PVCs and DataVolumes the VM's disks use.
        #[serde(default)]
        delete_disks: bool,
    }
    let p: P = params(p)?;
    segment("namespace", &p.namespace)?;
    segment("name", &p.name)?;
    let kube = ctx.kube()?;

    ctx.task(
        "vm.delete",
        target(&p.namespace, &p.name),
        format!("Destroy {}/{}", p.namespace, p.name),
        move |task| async move {
            let ns = p.namespace.as_str();
            let object = find(&kube, vm(ns, &p.name)).await?.ok_or_else(|| RpcError::not_found("no such VM"))?;

            let mut claims: Vec<(&'static str, String)> = Vec::new();
            if p.delete_disks {
                for volume in
                    object.pointer("/spec/template/spec/volumes").and_then(Value::as_array).into_iter().flatten()
                {
                    if let Some(dv) = volume.pointer("/dataVolume/name").and_then(Value::as_str) {
                        claims.push(("datavolume", dv.to_string()));
                    } else if let Some(pvc) = volume.pointer("/persistentVolumeClaim/claimName").and_then(Value::as_str)
                    {
                        claims.push(("pvc", pvc.to_string()));
                    }
                }
            }

            let options = json!({ "apiVersion": "v1", "kind": "DeleteOptions", "propagationPolicy": "Foreground" });
            kube.delete(&vm(ns, &p.name).path()?, Some(&options)).await?;
            task.log(format!("deleting VM {ns}/{}", p.name));

            wait_until(
                &task,
                Duration::from_secs(600),
                || find(&kube, vm(ns, &p.name)),
                |v| v.is_none().then_some(Ok(None)),
                |v| {
                    if v.is_some() { "waiting for the VM to be removed".into() } else { "VM removed".into() }
                },
            )
            .await?;

            for (kind, claim) in claims {
                let target = match kind {
                    "datavolume" => ResourceRef::new("cdi.kubevirt.io/v1beta1", "datavolumes").ns(ns).named(&claim),
                    _ => ResourceRef::new("v1", "persistentvolumeclaims").ns(ns).named(&claim),
                };
                match kube.delete(&target.path()?, None).await {
                    Ok(_) => task.log(format!("deleted {kind} {claim}")),
                    Err(e) if e.is_not_found() => task.log(format!("{kind} {claim} already gone")),
                    Err(e) => task.log(format!("could not delete {kind} {claim}: {}", e.message)),
                }
                // A DataVolume's PVC shares its name and is owned by it; remove a
                // leftover claim too so no disk is orphaned.
                if kind == "datavolume" {
                    let pvc = ResourceRef::new("v1", "persistentvolumeclaims").ns(ns).named(&claim);
                    if let Ok(()) = kube.delete(&pvc.path()?, None).await.map(|_| ()) {
                        task.log(format!("deleted pvc {claim}"));
                    }
                }
            }
            Ok(Some(format!("VM {ns}/{} destroyed", p.name)))
        },
    )
}

/// Create a VM, with any standalone DataVolumes its disks need first, and
/// follow imports until the disks are ready.
async fn create(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        vm: Value,
        #[serde(default)]
        data_volumes: Vec<Value>,
        #[serde(default)]
        extra_objects: Vec<Value>,
        #[serde(default)]
        start: bool,
    }
    let mut p: P = params(p)?;
    let namespace = p.vm.pointer("/metadata/namespace").and_then(Value::as_str).unwrap_or_default().to_string();
    let name = p.vm.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default().to_string();
    segment("namespace", &namespace)?;
    segment("name", &name)?;
    let kube = ctx.kube()?;

    if p.start {
        p.vm["spec"]["runStrategy"] = json!("Always");
        if let Some(spec) = p.vm.get_mut("spec").and_then(Value::as_object_mut) {
            spec.remove("running");
        }
    }

    ctx.task("vm.create", target(&namespace, &name), format!("Create VM {namespace}/{name}"), move |task| async move {
        let ns = namespace.as_str();

        // Server-side dry runs first, so a mistake in the VM does not leave
        // half-created disks behind.
        let vm_collection = ResourceRef::new("kubevirt.io/v1", "virtualmachines").ns(ns).path()?;
        kube.post(&format!("{vm_collection}?dryRun=All"), &p.vm).await?;
        task.log("VM definition validated by the API server");

        for object in &p.extra_objects {
            let (path, kind) = collection_for(object, ns)?;
            kube.post(&path, object).await?;
            task.log(format!("created {kind} {}", str_at(object, "/metadata/name")));
        }

        for dv in &p.data_volumes {
            let path = ResourceRef::new("cdi.kubevirt.io/v1beta1", "datavolumes").ns(ns).path()?;
            kube.post(&path, dv).await?;
            task.log(format!("created DataVolume {}", str_at(dv, "/metadata/name")));
        }

        kube.post(&vm_collection, &p.vm).await?;
        task.log(format!("created VM {ns}/{}", name));

        // Follow the disks: template DataVolumes are named in the VM spec.
        let mut disks: Vec<String> = p.data_volumes.iter().map(|dv| str_at(dv, "/metadata/name").to_string()).collect();
        for template in p.vm.pointer("/spec/dataVolumeTemplates").and_then(Value::as_array).into_iter().flatten() {
            disks.push(str_at(template, "/metadata/name").to_string());
        }
        for disk in disks.into_iter().filter(|d| !d.is_empty()) {
            let result = datavolumes::follow(
                &task,
                &kube,
                ns,
                &disk,
                &format!("disk {disk}"),
                &[],
                Duration::from_secs(4 * 3600),
            )
            .await;
            if let Err(e) = result {
                task.log(format!("disk {disk}: {}", e.message));
            }
        }

        Ok(Some(if p.start { "VM created and starting".into() } else { "VM created".into() }))
    })
}

fn collection_for(object: &Value, namespace: &str) -> Result<(String, String), RpcError> {
    let kind = str_at(object, "/kind");
    let target = match kind {
        "Secret" => ResourceRef::new("v1", "secrets"),
        "ConfigMap" => ResourceRef::new("v1", "configmaps"),
        "PersistentVolumeClaim" => ResourceRef::new("v1", "persistentvolumeclaims"),
        "Service" => ResourceRef::new("v1", "services"),
        other => {
            return Err(RpcError::bad_request(format!("extra objects of kind {other} are not supported")));
        }
    };
    Ok((target.ns(namespace).path()?, kind.to_string()))
}

// --- snapshots, restores, clones ------------------------------------------------

async fn snapshot(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        name: String,
        snapshot: String,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        api_version: Option<String>,
    }
    let p: P = params(p)?;
    segment("snapshot", &p.snapshot)?;
    let kube = ctx.kube()?;
    let api_version = p.api_version.clone().unwrap_or_else(|| "snapshot.kubevirt.io/v1beta1".into());

    let body = json!({
        "apiVersion": api_version,
        "kind": "VirtualMachineSnapshot",
        "metadata": {
            "name": p.snapshot,
            "namespace": p.namespace,
            "annotations": { "kubevirt-webgui/description": p.description.clone().unwrap_or_default() }
        },
        "spec": { "source": { "apiGroup": "kubevirt.io", "kind": "VirtualMachine", "name": p.name } }
    });

    ctx.task(
        "vm.snapshot",
        target(&p.namespace, &p.name),
        format!("Snapshot {}/{} as {}", p.namespace, p.name, p.snapshot),
        move |task| async move {
            let collection = ResourceRef::new(&api_version, "virtualmachinesnapshots").ns(&p.namespace);
            kube.post(&collection.path()?, &body).await?;
            task.log(format!("created VirtualMachineSnapshot {}", p.snapshot));
            let path = collection.named(&p.snapshot);
            wait_until(
                &task,
                Duration::from_secs(3600),
                || find(&kube, path.clone()),
                |s| match s {
                    None => Some(Err(RpcError::internal("the snapshot disappeared"))),
                    Some(s) if s.pointer("/status/readyToUse").and_then(Value::as_bool) == Some(true) => Some(Ok(None)),
                    Some(s) if str_at(s, "/status/phase") == "Failed" => Some(Err(RpcError::internal(format!(
                        "snapshot failed: {}",
                        s.pointer("/status/error/message").and_then(Value::as_str).unwrap_or("unknown error")
                    )))),
                    _ => None,
                },
                |s| s.as_ref().map(|s| format!("snapshot phase: {}", str_at(s, "/status/phase"))).unwrap_or_default(),
            )
            .await?;

            // KubeVirt leaves out disks it cannot capture — a containerDisk, or a
            // claim whose storage has no VolumeSnapshotClass — and still calls the
            // snapshot ready. Say so, or a rollback later restores less than the
            // person expects.
            let snapshot = find(&kube, path.clone()).await?.unwrap_or(Value::Null);
            let names = |pointer: &str| -> Vec<String> {
                snapshot
                    .pointer(pointer)
                    .and_then(Value::as_array)
                    .map(|v| v.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default()
            };
            let included = names("/status/snapshotVolumes/includedVolumes");
            let excluded = names("/status/snapshotVolumes/excludedVolumes");
            let indications = names("/status/indications");
            if !indications.is_empty() {
                task.log(format!("consistency: {}", indications.join(", ")));
            }
            task.log(format!(
                "disks included: {}",
                if included.is_empty() { "none".to_string() } else { included.join(", ") }
            ));
            if !excluded.is_empty() {
                let vm_object = find(&kube, vm(&p.namespace, &p.name)).await?.unwrap_or(Value::Null);
                for volume in &excluded {
                    let reason = vm_object
                        .pointer("/status/volumeSnapshotStatuses")
                        .and_then(Value::as_array)
                        .and_then(|s| s.iter().find(|s| str_at(s, "/name") == volume))
                        .map(|s| str_at(s, "/reason").to_string())
                        .unwrap_or_default();
                    task.log(format!(
                        "disk {volume} not included: {}",
                        if reason.is_empty() { "its volume cannot be snapshotted".into() } else { reason }
                    ));
                }
            }
            Ok(Some(if included.is_empty() && !excluded.is_empty() {
                format!(
                    "snapshot is ready, without disk data: {} excluded (only the VM definition was captured)",
                    excluded.join(", ")
                )
            } else if !excluded.is_empty() {
                format!("snapshot is ready; not included: {}", excluded.join(", "))
            } else {
                "snapshot is ready".into()
            }))
        },
    )
}

async fn restore(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        name: String,
        snapshot: String,
        #[serde(default)]
        api_version: Option<String>,
    }
    let p: P = params(p)?;
    let kube = ctx.kube()?;
    let api_version = p.api_version.clone().unwrap_or_else(|| "snapshot.kubevirt.io/v1beta1".into());
    let restore_name = format!("{}-restore-{}", p.snapshot, chrono::Utc::now().format("%Y%m%d%H%M%S"));
    let body = json!({
        "apiVersion": api_version,
        "kind": "VirtualMachineRestore",
        "metadata": { "name": restore_name, "namespace": p.namespace },
        "spec": {
            "target": { "apiGroup": "kubevirt.io", "kind": "VirtualMachine", "name": p.name },
            "virtualMachineSnapshotName": p.snapshot
        }
    });

    ctx.task(
        "vm.restore",
        target(&p.namespace, &p.name),
        format!("Restore {}/{} from {}", p.namespace, p.name, p.snapshot),
        move |task| async move {
            if let Some(running) = find(&kube, vmi(&p.namespace, &p.name)).await?
                && str_at(&running, "/status/phase") == "Running"
            {
                return Err(RpcError::new(409, "Conflict", "stop the VM before restoring a snapshot"));
            }
            let collection = ResourceRef::new(&api_version, "virtualmachinerestores").ns(&p.namespace);
            kube.post(&collection.path()?, &body).await?;
            task.log(format!("created VirtualMachineRestore {restore_name}"));
            let path = collection.named(&restore_name);
            wait_until(
                &task,
                Duration::from_secs(3600),
                || find(&kube, path.clone()),
                |r| match r {
                    None => Some(Err(RpcError::internal("the restore disappeared"))),
                    Some(r) if r.pointer("/status/complete").and_then(Value::as_bool) == Some(true) => {
                        Some(Ok(Some("restore complete".into())))
                    }
                    _ => None,
                },
                |r| {
                    r.as_ref()
                        .and_then(|r| r.pointer("/status/conditions").and_then(Value::as_array))
                        .map(|c| {
                            c.iter()
                                .filter(|c| c["status"] == "True")
                                .map(|c| format!("{}: {}", str_at(c, "/type"), str_at(c, "/reason")))
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default()
                },
            )
            .await
        },
    )
}

async fn clone(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        name: String,
        target: String,
        #[serde(default)]
        api_version: Option<String>,
        #[serde(default)]
        label_filters: Option<Vec<String>>,
        #[serde(default)]
        annotation_filters: Option<Vec<String>>,
        #[serde(default)]
        new_mac_addresses: Option<Value>,
    }
    let p: P = params(p)?;
    segment("target", &p.target)?;
    let kube = ctx.kube()?;
    let api_version = p.api_version.clone().unwrap_or_else(|| "clone.kubevirt.io/v1beta1".into());
    let clone_name = format!("{}-clone-{}", p.name, chrono::Utc::now().format("%Y%m%d%H%M%S"));
    let mut spec = json!({
        "source": { "apiGroup": "kubevirt.io", "kind": "VirtualMachine", "name": p.name },
        "target": { "apiGroup": "kubevirt.io", "kind": "VirtualMachine", "name": p.target },
    });
    if let Some(filters) = &p.label_filters {
        spec["labelFilters"] = json!(filters);
    }
    if let Some(filters) = &p.annotation_filters {
        spec["annotationFilters"] = json!(filters);
    }
    if let Some(macs) = &p.new_mac_addresses {
        spec["newMacAddresses"] = macs.clone();
    }
    let body = json!({
        "apiVersion": api_version,
        "kind": "VirtualMachineClone",
        "metadata": { "name": clone_name, "namespace": p.namespace },
        "spec": spec,
    });

    ctx.task(
        "vm.clone",
        target(&p.namespace, &p.name),
        format!("Clone {}/{} to {}", p.namespace, p.name, p.target),
        move |task| async move {
            let collection = ResourceRef::new(&api_version, "virtualmachineclones").ns(&p.namespace);
            kube.post(&collection.path()?, &body).await?;
            task.log(format!("created VirtualMachineClone {clone_name}"));
            let path = collection.named(&clone_name);
            wait_until(
                &task,
                Duration::from_secs(4 * 3600),
                || find(&kube, path.clone()),
                |c| match c.as_ref().map(|c| str_at(c, "/status/phase")) {
                    None => Some(Err(RpcError::internal("the clone disappeared"))),
                    Some("Succeeded") => Some(Ok(Some(format!("clone {} created", p.target)))),
                    Some("Failed") => Some(Err(RpcError::internal("clone failed"))),
                    _ => None,
                },
                |c| c.as_ref().map(|c| format!("clone phase: {}", str_at(c, "/status/phase"))).unwrap_or_default(),
            )
            .await
        },
    )
}

// --- hotplug ------------------------------------------------------------------

async fn volume_add(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        name: String,
        volume: String,
        claim: String,
        #[serde(default)]
        bus: Option<String>,
        #[serde(default)]
        data_volume: bool,
        #[serde(default)]
        serial: Option<String>,
    }
    let p: P = params(p)?;
    segment("volume", &p.volume)?;
    segment("claim", &p.claim)?;
    let kube = ctx.kube()?;
    let source = if p.data_volume {
        json!({ "dataVolume": { "name": p.claim, "hotpluggable": true } })
    } else {
        json!({ "persistentVolumeClaim": { "claimName": p.claim, "hotpluggable": true } })
    };
    let mut disk = json!({ "name": p.volume, "disk": { "bus": p.bus.clone().unwrap_or_else(|| "scsi".into()) } });
    if let Some(serial) = &p.serial {
        disk["serial"] = json!(serial);
    }
    let body = json!({ "name": p.volume, "disk": disk, "volumeSource": source });

    ctx.task("vm.hotplug", target(&p.namespace, &p.name), format!("Hotplug {} into {}/{}", p.claim, p.namespace, p.name), move |task| async move {
        let path = ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachineinstances").ns(&p.namespace).named(&p.name).subresource("addvolume");
        kube.put(&path.path()?, Some(&body)).await?;
        task.log(format!("attached {} as {}", p.claim, p.volume));
        // Make it persistent in the VM spec, as `virtctl addvolume --persist` does.
        let vm_obj = find(&kube, vm(&p.namespace, &p.name)).await?;
        if let Some(vm_obj) = vm_obj {
            let mut spec = vm_obj.pointer("/spec/template/spec").cloned().unwrap_or(json!({}));
            let volumes = spec["volumes"].as_array().cloned().unwrap_or_default();
            if !volumes.iter().any(|v| v["name"] == p.volume.as_str()) {
                let mut volumes = volumes;
                let mut volume = body["volumeSource"].clone();
                volume["name"] = json!(p.volume);
                volumes.push(volume);
                spec["volumes"] = json!(volumes);
                let mut disks = spec.pointer("/domain/devices/disks").and_then(Value::as_array).cloned().unwrap_or_default();
                disks.push(body["disk"].clone());
                spec["domain"]["devices"]["disks"] = json!(disks);
                let patch = json!({ "spec": { "template": { "spec": { "volumes": spec["volumes"], "domain": { "devices": { "disks": spec["domain"]["devices"]["disks"] } } } } } });
                kube.patch(&vm(&p.namespace, &p.name).path()?, &patch, crate::cluster::PatchKind::Merge).await?;
                task.log("persisted the volume in the VM definition");
            }
        }
        Ok(None)
    })
}

async fn volume_remove(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        namespace: String,
        name: String,
        volume: String,
    }
    let p: P = params(p)?;
    let kube = ctx.kube()?;
    ctx.task("vm.unplug", target(&p.namespace, &p.name), format!("Unplug {} from {}/{}", p.volume, p.namespace, p.name), move |task| async move {
        let path = ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachineinstances").ns(&p.namespace).named(&p.name).subresource("removevolume");
        match kube.put(&path.path()?, Some(&json!({ "name": p.volume }))).await {
            Ok(_) => task.log(format!("detached {}", p.volume)),
            Err(e) => task.log(format!("live detach skipped: {}", e.message)),
        }
        if let Some(vm_obj) = find(&kube, vm(&p.namespace, &p.name)).await? {
            let mut volumes = vm_obj.pointer("/spec/template/spec/volumes").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut disks = vm_obj.pointer("/spec/template/spec/domain/devices/disks").and_then(Value::as_array).cloned().unwrap_or_default();
            volumes.retain(|v| v["name"] != p.volume.as_str());
            disks.retain(|d| d["name"] != p.volume.as_str());
            let patch = json!({ "spec": { "template": { "spec": { "volumes": volumes, "domain": { "devices": { "disks": disks } } } } } });
            kube.patch(&vm(&p.namespace, &p.name).path()?, &patch, crate::cluster::PatchKind::Merge).await?;
            task.log("removed the volume from the VM definition");
        }
        Ok(None)
    })
}

// --- consoles -------------------------------------------------------------------

async fn console_ticket(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        namespace: String,
        name: String,
        kind: ConsoleKind,
    }
    let p: P = params(p)?;
    let session = ctx.session()?;
    // Check access now, so a refusal is a clear error rather than a socket
    // that opens and immediately closes.
    let object = session.kube.get(&vmi(&p.namespace, &p.name).path()?).await.map_err(RpcError::from)?;
    if str_at(&object, "/status/phase") != "Running" {
        return Err(RpcError::new(409, "Conflict", "the VM is not running"));
    }
    let ticket =
        ctx.state.consoles.issue(session.kube.clone(), &p.namespace, &p.name, p.kind, &session.user.username)?;
    Ok(json!({ "ticket": ticket, "path": format!("/ws/console/{ticket}") }))
}

// --- disks ------------------------------------------------------------------

async fn datavolume_create(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        body: Value,
    }
    let p: P = params(p)?;
    let namespace = str_at(&p.body, "/metadata/namespace").to_string();
    let name = str_at(&p.body, "/metadata/name").to_string();
    segment("namespace", &namespace)?;
    segment("name", &name)?;
    let kube = ctx.kube()?;
    let target = TaskTarget { kind: "DataVolume".into(), namespace: Some(namespace.clone()), name: name.clone() };

    ctx.task("disk.create", target, format!("Create disk {namespace}/{name}"), move |task| async move {
        let collection = ResourceRef::new("cdi.kubevirt.io/v1beta1", "datavolumes").ns(&namespace);
        let created = kube.post(&collection.path()?, &p.body).await?;
        task.log(format!("created DataVolume {}", str_at(&created, "/metadata/name")));
        match datavolumes::follow(&task, &kube, &namespace, &name, "disk", &[], Duration::from_secs(4 * 3600)).await? {
            Settled::Ready(phase) if phase == "WaitForFirstConsumer" || phase == "PendingPopulation" => {
                Ok(Some("disk will be filled when a VM uses it".into()))
            }
            _ => Ok(Some("disk is ready".into())),
        }
    })
}
