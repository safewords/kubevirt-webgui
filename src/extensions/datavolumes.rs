//! Following a DataVolume, and saying why when CDI's worker pod keeps failing.
//!
//! CDI retries a failing importer, upload server or clone pod forever, and
//! the DataVolume only reports a restart count and the first line of the
//! pod's output. The actual reason — `blockdev: cannot open
//! /dev/cdi-block-volume: Permission denied`, a 404 from the source URL — is
//! in the pod's termination message. This finds it, so a task log and the
//! Disk screen can show it instead of a disk stuck in `ImportInProgress`.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};

use crate::cluster::paths::{ResourceRef, with_query};
use crate::cluster::{ApiError, Kube};
use crate::rpc::{RpcError, RpcResult};
use crate::tasks::TaskHandle;

/// A worker pod that is failing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerTrouble {
    pub pod: String,
    pub node: String,
    pub restarts: i64,
    /// The error, from the pod's termination message.
    pub message: String,
    /// What usually causes it, when recognised.
    pub hint: Option<String>,
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default()
}

/// The lines of a termination message worth showing: errors, without klog's
/// `E0916 23:43:59.213251       1 importer.go:138]` prefix.
pub fn summarize(message: &str) -> String {
    let strip = |line: &str| -> String {
        let line = line.trim();
        match line.find("] ") {
            Some(i) if line.starts_with(['E', 'W', 'I', 'F']) && line[..i].contains(".go:") => line[i + 2..].trim().to_string(),
            _ => line.to_string(),
        }
    };
    let lines: Vec<&str> = message.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let errors: Vec<String> = lines
        .iter()
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            l.starts_with('E') && l.contains(".go:") || lower.contains("error") || lower.contains("denied") || lower.contains("failed") || lower.contains("unable")
        })
        // Stack frames repeat the function names; they say nothing a person needs.
        .filter(|l| !l.starts_with("kubevirt.io/") && !l.contains(".go:") || l.contains("] "))
        .map(|l| strip(l))
        .collect();
    let chosen = if errors.is_empty() { lines.last().map(|l| strip(l)).unwrap_or_default() } else { errors.join("; ") };
    chosen.chars().take(400).collect()
}

/// A likely cause, for errors seen often enough to recognise.
pub fn hint_for(message: &str, node: &str) -> Option<String> {
    if message.contains("cdi-block-volume") && message.contains("Permission denied") {
        return Some(format!(
            "node {node} cannot give unprivileged pods access to block volumes: enable `device_ownership_from_security_context` in its container runtime (containerd/CRI-O), or keep CDI workloads (CDI spec.workload) and VMs with block disks off that node"
        ));
    }
    if message.contains("no space left on device") {
        return Some("the claim is smaller than the image once expanded; recreate the disk larger".into());
    }
    if message.contains("404") || message.contains("Not Found") {
        return Some("the source URL answered 404; check the address".into());
    }
    None
}

/// Why the DataVolume's worker pod is failing, if it is.
pub async fn worker_trouble(kube: &Kube, namespace: &str, dv: &Value) -> Option<WorkerTrouble> {
    let name = str_at(dv, "/metadata/name");
    let restarts = dv.pointer("/status/restartCount").and_then(Value::as_i64).unwrap_or(0);
    let running_failed = dv
        .pointer("/status/conditions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|c| c["type"] == "Running" && c["status"] == "False" && matches!(str_at(c, "/reason"), "Error" | "CrashLoopBackOff" | "ImagePullBackOff" | "ErrImagePull"));
    if restarts == 0 && !running_failed {
        return None;
    }

    // CDI's populators work on a "prime" claim named after the target claim's uid.
    let pvc = kube.get(&ResourceRef::new("v1", "persistentvolumeclaims").ns(namespace).named(name).path().ok()?).await.ok();
    let mut claims = vec![name.to_string(), format!("{name}-scratch")];
    if let Some(uid) = pvc.as_ref().map(|p| str_at(p, "/metadata/uid")).filter(|u| !u.is_empty()) {
        claims.push(format!("prime-{uid}"));
        claims.push(format!("prime-{uid}-scratch"));
    }

    let path = with_query(&ResourceRef::new("v1", "pods").ns(namespace).path().ok()?, &[("labelSelector", Some("app=containerized-data-importer".into()))]);
    let pods = kube.get(&path).await.ok()?;
    pods.get("items")?.as_array()?.iter().find_map(|pod| {
        let mounts_claim = pod
            .pointer("/spec/volumes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|v| claims.iter().any(|c| c == str_at(v, "/persistentVolumeClaim/claimName")));
        if !mounts_claim {
            return None;
        }
        let status = pod.pointer("/status/containerStatuses").and_then(Value::as_array)?.first()?;
        let raw = [
            "/lastState/terminated/message",
            "/state/terminated/message",
            "/state/waiting/message",
        ]
        .iter()
        .map(|p| str_at(status, p))
        .find(|m| !m.is_empty())?;
        let node = str_at(pod, "/spec/nodeName").to_string();
        let message = summarize(raw);
        Some(WorkerTrouble {
            pod: str_at(pod, "/metadata/name").to_string(),
            restarts: status.get("restartCount").and_then(Value::as_i64).unwrap_or(restarts),
            hint: hint_for(raw, &node),
            node,
            message,
        })
    })
}

/// Give up once the worker has failed this many times: CDI would retry
/// forever, and the same error every minute helps nobody.
const GIVE_UP_AFTER: i64 = 3;

/// How a followed DataVolume ended.
pub enum Settled {
    /// `Succeeded`, or bound-when-used (`WaitForFirstConsumer`, `PendingPopulation`).
    Ready(String),
    /// Reached `phase`, which the caller asked to stop at (e.g. `UploadReady`).
    Reached(String),
}

/// Follow a DataVolume, logging phase and progress, until it is ready, reaches
/// one of `stop_at`, fails, or its worker pod keeps failing.
pub async fn follow(task: &TaskHandle, kube: &Kube, namespace: &str, name: &str, label: &str, stop_at: &[&str], timeout: Duration) -> RpcResult<Settled> {
    let path = ResourceRef::new("cdi.kubevirt.io/v1beta1", "datavolumes").ns(namespace).named(name);
    let started = Instant::now();
    let mut last = String::new();
    let mut reported_restarts = 0i64;
    loop {
        let dv = match kube.get(&path.path()?).await {
            Ok(dv) => dv,
            Err(e) if e.is_not_found() => return Err(RpcError::internal(format!("{label}: the DataVolume disappeared"))),
            Err(e) => return Err(e.into()),
        };
        let phase = str_at(&dv, "/status/phase").to_string();
        let progress = str_at(&dv, "/status/progress");
        let line = format!(
            "{label}: {}{}",
            if phase.is_empty() { "Pending" } else { &phase },
            if progress.is_empty() || progress == "N/A" { String::new() } else { format!(" {progress}") }
        );
        if line != last {
            task.log(line.clone());
            last = line;
        }

        if stop_at.contains(&phase.as_str()) {
            return Ok(Settled::Reached(phase));
        }
        match phase.as_str() {
            "Succeeded" | "WaitForFirstConsumer" | "PendingPopulation" => return Ok(Settled::Ready(phase)),
            "Failed" => {
                let detail = worker_trouble(kube, namespace, &dv).await.map(|t| t.message).unwrap_or_else(|| {
                    dv.pointer("/status/conditions")
                        .and_then(Value::as_array)
                        .and_then(|c| c.iter().find(|c| c["type"] == "Running"))
                        .map(|c| str_at(c, "/message").to_string())
                        .unwrap_or_default()
                });
                return Err(RpcError::internal(format!("{label} failed: {detail}")));
            }
            _ => {}
        }

        let restarts = dv.pointer("/status/restartCount").and_then(Value::as_i64).unwrap_or(0);
        if restarts > reported_restarts {
            reported_restarts = restarts;
            if let Some(trouble) = worker_trouble(kube, namespace, &dv).await {
                task.log(format!("{label}: CDI pod {} on {} failed ({} restart{}): {}", trouble.pod, trouble.node, trouble.restarts, if trouble.restarts == 1 { "" } else { "s" }, trouble.message));
                if let Some(hint) = &trouble.hint {
                    task.log(format!("hint: {hint}"));
                }
                if trouble.restarts >= GIVE_UP_AFTER {
                    return Err(RpcError::internal(format!(
                        "{label}: CDI's pod keeps failing on {}: {}{}",
                        trouble.node,
                        trouble.message,
                        trouble.hint.map(|h| format!(" — {h}")).unwrap_or_default()
                    )));
                }
            }
        }

        if started.elapsed() > timeout {
            return Err(RpcError::new(504, "Timeout", format!("{label}: not ready after {}s", timeout.as_secs())));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// `datavolume.diagnose` — the Disk screen's view of a failing worker pod.
pub async fn diagnose(kube: &Kube, namespace: &str, name: &str) -> Result<Value, ApiError> {
    let dv = kube.get(&ResourceRef::new("cdi.kubevirt.io/v1beta1", "datavolumes").ns(namespace).named(name).path()?).await?;
    Ok(json!({ "trouble": worker_trouble(kube, namespace, &dv).await }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: &str = "I0916 23:43:59.212466       1 importer.go:108] Starting importer\nE0916 23:43:59.213251       1 importer.go:138] exit status 1, blockdev: cannot open /dev/cdi-block-volume: Permission denied\n\nkubevirt.io/containerized-data-importer/pkg/importer.GetAvailableSpaceBlock\n\tpkg/importer/file.go:79\nmain.main\n\tcmd/cdi-importer/importer.go:136";

    #[test]
    fn a_termination_message_is_reduced_to_its_error() {
        assert_eq!(summarize(BLOCK), "exit status 1, blockdev: cannot open /dev/cdi-block-volume: Permission denied");
    }

    #[test]
    fn a_block_device_permission_error_gets_the_containerd_hint() {
        let hint = hint_for(BLOCK, "devbox").expect("a hint");
        assert!(hint.contains("devbox") && hint.contains("device_ownership_from_security_context"), "{hint}");
    }

    #[test]
    fn plain_output_falls_back_to_the_last_line() {
        assert_eq!(summarize("Starting importer\nsomething odd happened"), "something odd happened");
    }
}
