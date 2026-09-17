//! Live-migration progress: how much guest memory has crossed, how fast, and
//! how fast the guest is dirtying it again.
//!
//! KubeVirt keeps none of this on its objects. The virt-handler on the source
//! node samples libvirt's job info every five seconds while a migration runs
//! and publishes it as `kubevirt_vmi_migration_*` metrics. Those are read here
//! through the API server's pod proxy, as the user — so seeing progress needs
//! `get pods/proxy` in KubeVirt's namespace; without it a migration still
//! works, it simply shows no figures.

use std::time::Duration;

use http::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cluster::paths::{ResourceRef, segment, with_query};
use crate::cluster::{ApiError, Kube};
use crate::rpc::{Ctx, RpcResult, Sink, params};
use crate::tasks::{Progress, TaskHandle};

/// One sample of a migration's transfer.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    /// Guest data to move, in bytes (memory, plus disks for a block migration).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Bytes sent so far, re-sent dirty pages included — it can pass `total`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processed: Option<u64>,
    /// Bytes still to send.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<u64>,
    /// Bytes per second going across.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_rate: Option<f64>,
    /// Bytes per second the guest writes to memory already sent. Above the
    /// transfer rate, a pre-copy migration cannot converge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty_rate: Option<f64>,
    /// When virt-handler took the sample (ms since the epoch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled_at: Option<i64>,
}

impl Transfer {
    /// Bytes of `total` no longer outstanding.
    pub fn done(&self) -> Option<u64> {
        Some(self.total?.saturating_sub(self.remaining?))
    }

    pub fn is_empty(&self) -> bool {
        self.total.is_none() && self.processed.is_none() && self.remaining.is_none()
    }
}

/// Parse virt-handler's metrics for one VMI, keeping the newest sample of each.
pub fn parse_transfer(metrics: &str, namespace: &str, vmi: &str) -> Transfer {
    let mut transfer = Transfer::default();
    let mut newest: std::collections::HashMap<&str, i64> = Default::default();
    for line in metrics.lines() {
        let Some(rest) = line.strip_prefix("kubevirt_vmi_migration_") else {
            continue;
        };
        let Some((metric, rest)) = rest.split_once('{') else {
            continue;
        };
        let Some((labels, rest)) = rest.split_once('}') else {
            continue;
        };
        if label(labels, "namespace") != Some(namespace) || label(labels, "name") != Some(vmi) {
            continue;
        }
        let mut fields = rest.split_whitespace();
        let Some(value) = fields.next().and_then(|v| v.parse::<f64>().ok()) else {
            continue;
        };
        let at = fields.next().and_then(|t| t.parse::<i64>().ok()).unwrap_or(0);
        if newest.get(metric).is_some_and(|seen| *seen > at) {
            continue;
        }
        newest.insert(metric, at);
        let bytes = value.max(0.0) as u64;
        match metric {
            "data_bytes_total" | "data_total_bytes" => transfer.total = Some(bytes),
            "data_processed_bytes" => transfer.processed = Some(bytes),
            "data_remaining_bytes" => transfer.remaining = Some(bytes),
            "memory_transfer_rate_bytes" => transfer.transfer_rate = Some(value),
            "dirty_memory_rate_bytes" => transfer.dirty_rate = Some(value),
            _ => continue,
        }
        if at > 0 {
            transfer.sampled_at = Some(transfer.sampled_at.map_or(at, |t| t.max(at)));
        }
    }
    transfer
}

/// The value of `key="…"` in a Prometheus label set.
fn label<'a>(labels: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = labels;
    while let Some(eq) = rest.find("=\"") {
        let name = rest[..eq].trim_start_matches(',').trim();
        let after = &rest[eq + 2..];
        let end = after.find('"')?;
        if name == key {
            return Some(&after[..end]);
        }
        rest = &after[end + 1..];
    }
    None
}

/// Where a node's virt-handler publishes its metrics.
#[derive(Debug, Clone)]
pub struct HandlerMetrics {
    path: String,
}

impl HandlerMetrics {
    /// The virt-handler on `node`, found as the user.
    pub async fn locate(kube: &Kube, node: &str) -> Result<Self, ApiError> {
        segment("node", node)?;
        let namespace = kubevirt_namespace(kube).await;
        let pods = kube
            .get(&with_query(
                &ResourceRef::new("v1", "pods").ns(&namespace).path()?,
                &[
                    ("labelSelector", Some("kubevirt.io=virt-handler".into())),
                    ("fieldSelector", Some(format!("spec.nodeName={node}"))),
                ],
            ))
            .await?;
        let pod = pods
            .get("items")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find_map(|p| p.pointer("/metadata/name").and_then(Value::as_str)))
            .ok_or_else(|| ApiError::new(404, "NotFound", format!("no virt-handler pod on {node} in `{namespace}`")))?;
        Ok(Self { path: format!("/api/v1/namespaces/{namespace}/pods/https:{pod}:8443/proxy/metrics") })
    }

    /// The latest transfer sample for a VMI.
    pub async fn read(&self, kube: &Kube, namespace: &str, vmi: &str) -> Result<Transfer, ApiError> {
        let (_, _, body) = kube.raw(Method::GET, &self.path, None, "text/plain").await?;
        Ok(parse_transfer(&String::from_utf8_lossy(&body), namespace, vmi))
    }
}

/// The namespace KubeVirt is installed in: its CR's, when the user may list
/// it, or the conventional `kubevirt`.
async fn kubevirt_namespace(kube: &Kube) -> String {
    kube.get("/apis/kubevirt.io/v1/kubevirts")
        .await
        .ok()
        .and_then(|list| list.pointer("/items/0/metadata/namespace").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| "kubevirt".into())
}

fn gib(bytes: u64) -> String {
    format!("{:.2} GiB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

fn mib_per_s(rate: f64) -> String {
    format!("{:.0} MiB/s", rate / (1024.0 * 1024.0))
}

/// A sample as a task progress bar and, now and then, a log line.
pub struct TaskReporter {
    metrics: Option<HandlerMetrics>,
    unavailable: bool,
    last_logged_quarter: u64,
    reported: bool,
}

impl Default for TaskReporter {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskReporter {
    pub fn new() -> Self {
        Self { metrics: None, unavailable: false, last_logged_quarter: 0, reported: false }
    }

    /// Read the source's metrics once before the migration is created.
    ///
    /// virt-handler keeps one sampling queue per VMI and deletes a finished
    /// one only when its metrics are scraped. Without Prometheus nobody
    /// scrapes, so after a VM has migrated once the stale queue stops the
    /// next migration from being sampled at all. Reading now, while the last
    /// migration still counts as completed, clears it.
    pub async fn prepare(&mut self, kube: &Kube, namespace: &str, vmi: &str, source_node: &str) {
        if source_node.is_empty() {
            return;
        }
        if let Ok(metrics) = HandlerMetrics::locate(kube, source_node).await {
            let _ = metrics.read(kube, namespace, vmi).await;
            self.metrics = Some(metrics);
        }
    }

    /// Take a sample while the migration moves data. Failures are logged once.
    pub async fn sample(&mut self, task: &TaskHandle, kube: &Kube, namespace: &str, vmi: &str, source_node: &str) {
        if self.unavailable || source_node.is_empty() {
            return;
        }
        if self.metrics.is_none() {
            match HandlerMetrics::locate(kube, source_node).await {
                Ok(metrics) => self.metrics = Some(metrics),
                Err(e) => return self.give_up(task, &e),
            }
        }
        let Some(metrics) = &self.metrics else { return };
        let transfer = match metrics.read(kube, namespace, vmi).await {
            Ok(transfer) => transfer,
            Err(e) => return self.give_up(task, &e),
        };
        let (Some(total), Some(done)) = (transfer.total, transfer.done()) else {
            return;
        };
        if total == 0 {
            return;
        }
        if !self.reported {
            task.log(format!("transferring guest data: {}", gib(total)));
            self.reported = true;
        }
        let quarter = done * 4 / total;
        if quarter > self.last_logged_quarter && quarter < 4 {
            self.last_logged_quarter = quarter;
            let mut line = format!("transferred {}% ({} of {})", quarter * 25, gib(done), gib(total));
            if let Some(rate) = transfer.transfer_rate {
                line.push_str(&format!(" at {}", mib_per_s(rate)));
            }
            if let Some(dirty) = transfer.dirty_rate {
                line.push_str(&format!(", guest dirtying {}", mib_per_s(dirty)));
            }
            task.log(line);
        }
        let mut detail = format!("{} left", gib(transfer.remaining.unwrap_or_default()));
        if let Some(dirty) = transfer.dirty_rate.filter(|d| *d > 0.0) {
            detail.push_str(&format!(", dirtying {}", mib_per_s(dirty)));
        }
        task.progress(Progress::bytes(done, Some(total)).rate(transfer.transfer_rate).detail(detail));
    }

    fn give_up(&mut self, task: &TaskHandle, e: &ApiError) {
        self.unavailable = true;
        let why = if e.status == 403 {
            "reading virt-handler's metrics needs `get pods/proxy` in KubeVirt's namespace".to_string()
        } else {
            e.message.clone()
        };
        task.log(format!("live transfer figures unavailable: {why}"));
    }
}

/// `migration.progress { namespace, name }` — while the VMI migrates, its
/// transfer every few seconds: `{ migrating, phase…, transfer }`; otherwise
/// `{ migrating: false }` whenever that changes.
pub async fn progress_topic(ctx: Ctx, p: Value, sink: Sink) -> RpcResult<()> {
    #[derive(Deserialize)]
    struct P {
        namespace: String,
        name: String,
    }
    let p: P = params(p)?;
    segment("namespace", &p.namespace)?;
    segment("name", &p.name)?;
    let kube = ctx.kube()?;
    let vmi_path =
        ResourceRef::new("kubevirt.io/v1", "virtualmachineinstances").ns(&p.namespace).named(&p.name).path()?;

    let mut metrics: Option<(String, HandlerMetrics)> = None;
    let mut last: Option<Value> = None;
    loop {
        let vmi = match kube.get(&vmi_path).await {
            Ok(vmi) => Some(vmi),
            Err(e) if e.is_not_found() => None,
            Err(e) => return Err(e.into()),
        };
        let state = vmi.as_ref().and_then(|v| v.pointer("/status/migrationState")).cloned().unwrap_or(Value::Null);
        let migrating = !state.is_null()
            && state.get("completed").and_then(Value::as_bool) != Some(true)
            && state.get("failed").and_then(Value::as_bool) != Some(true);

        let event = if migrating {
            let source = state.get("sourceNode").and_then(Value::as_str).unwrap_or_default().to_string();
            let mut event = json!({
                "migrating": true,
                "sourceNode": source,
                "targetNode": state.get("targetNode"),
                "mode": state.get("mode"),
                "startTimestamp": state.get("startTimestamp"),
            });
            if !source.is_empty() {
                if metrics.as_ref().is_none_or(|(node, _)| node != &source) {
                    metrics = match HandlerMetrics::locate(&kube, &source).await {
                        Ok(found) => Some((source.clone(), found)),
                        Err(e) => {
                            event["unavailable"] = json!(e.message);
                            None
                        }
                    };
                }
                if let Some((_, handler)) = &metrics {
                    match handler.read(&kube, &p.namespace, &p.name).await {
                        Ok(transfer) if !transfer.is_empty() => event["transfer"] = json!(transfer),
                        Ok(_) => {}
                        Err(e) => {
                            event["unavailable"] = json!(if e.status == 403 {
                                "reading virt-handler's metrics needs get pods/proxy in KubeVirt's namespace"
                                    .to_string()
                            } else {
                                e.message
                            });
                        }
                    }
                }
            }
            event
        } else {
            // After a migration, one read of the VMI's current node clears
            // virt-handler's finished queue (see `TaskReporter::prepare`), so
            // a migration started elsewhere — a node drain — is sampled too.
            let node = vmi
                .as_ref()
                .and_then(|v| v.pointer("/status/nodeName"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !state.is_null() && !node.is_empty() && metrics.as_ref().is_none_or(|(seen, _)| seen != &node) {
                metrics = match HandlerMetrics::locate(&kube, &node).await {
                    Ok(found) => {
                        let _ = found.read(&kube, &p.namespace, &p.name).await;
                        Some((node, found))
                    }
                    Err(_) => None,
                };
            }
            json!({ "migrating": false })
        };

        if last.as_ref() != Some(&event) {
            if !sink.emit(event.clone()) {
                return Ok(());
            }
            last = Some(event);
        }
        tokio::time::sleep(Duration::from_secs(if migrating { 2 } else { 5 })).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const METRICS: &str = r#"# HELP kubevirt_vmi_migration_data_bytes_total The total Guest OS data to be migrated to the new VM.
# TYPE kubevirt_vmi_migration_data_bytes_total counter
kubevirt_vmi_migration_data_bytes_total{name="web",namespace="prod",node="pve-thin-2"} 2.147483648e+09 1726500000000
kubevirt_vmi_migration_data_bytes_total{name="web",namespace="prod",node="pve-thin-2"} 2.147483648e+09 1726500005000
kubevirt_vmi_migration_data_bytes_total{name="db",namespace="prod",node="pve-thin-2"} 9e+09 1726500005000
kubevirt_vmi_migration_data_remaining_bytes{name="web",namespace="prod",node="pve-thin-2"} 1.073741824e+09 1726500005000
kubevirt_vmi_migration_data_remaining_bytes{name="web",namespace="prod",node="pve-thin-2"} 1.5e+09 1726500000000
kubevirt_vmi_migration_data_processed_bytes{namespace="prod",name="web",node="pve-thin-2"} 1.2e+09 1726500005000
kubevirt_vmi_migration_memory_transfer_rate_bytes{name="web",namespace="prod",node="pve-thin-2"} 1.048576e+08 1726500005000
kubevirt_vmi_migration_dirty_memory_rate_bytes{name="web",namespace="prod",node="pve-thin-2"} 1048576 1726500005000
kubevirt_vmi_memory_resident_bytes{name="web",namespace="prod",node="pve-thin-2"} 5
"#;

    #[test]
    fn keeps_the_newest_sample_for_the_right_vmi() {
        let t = parse_transfer(METRICS, "prod", "web");
        assert_eq!(t.total, Some(2_147_483_648));
        assert_eq!(t.remaining, Some(1_073_741_824), "the older, larger remaining sample is ignored");
        assert_eq!(t.processed, Some(1_200_000_000));
        assert_eq!(t.transfer_rate, Some(104_857_600.0));
        assert_eq!(t.dirty_rate, Some(1_048_576.0));
        assert_eq!(t.sampled_at, Some(1_726_500_005_000));
        assert_eq!(t.done(), Some(1_073_741_824));
    }

    #[test]
    fn another_vmi_or_namespace_has_nothing() {
        assert!(parse_transfer(METRICS, "prod", "cache").is_empty());
        assert!(parse_transfer(METRICS, "dev", "web").is_empty());
    }

    #[test]
    fn labels_are_read_in_any_order() {
        assert_eq!(label(r#"namespace="a",name="b""#, "name"), Some("b"));
        assert_eq!(label(r#"name="b",namespace="a""#, "namespace"), Some("a"));
        assert_eq!(label(r#"name="b""#, "node"), None);
    }
}
