//! `kubevirt-webgui netagent`: off-subnet client NAT for bridged VMs.
//!
//! A bridged (Multus) VM answers its own LAN, but a guest that only trusts
//! its local subnet ignores clients from elsewhere — a VPN, say. Rewriting
//! those clients' source to a LAN address inside the virt-launcher pod fixes
//! that without touching the guest, but the pod is recreated on every
//! restart and migration, and hand-applied rules go with it. See
//! <https://github.com/safewords/kubevirt-webgui/issues/1>.
//!
//! This runs on every KubeVirt node as a DaemonSet. Every few seconds it
//! lists the VMIs on its node (and those migrating to it) that carry
//! [`plan::SPEC_ANNOTATION`], and for each launcher pod:
//!
//! 1. SNATs traffic from the client ranges to the guest's address to
//!    `snatTo` (by default the LAN gateway), so the guest sees a LAN peer;
//! 2. pins `snatTo`'s MAC as a permanent neighbour on the in-pod bridge and
//!    routes the client ranges via it, on the bridge — without that,
//!    br_netfilter sends the de-NATed replies out of the pod's `eth0`;
//! 3. removes any of its own rules that are no longer wanted,
//!
//! and reports what it did on the VMI as [`plan::STATUS_ANNOTATION`]. Being a
//! loop rather than a one-shot hook, it repairs what is removed and follows a
//! gateway whose MAC changes. IPv4 only.

pub mod host;
pub mod plan;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use rainier_framework::config::Env;
use serde_json::{Value, json};

use crate::cluster::paths::ResourceRef;
use crate::cluster::{Cluster, Credential, Kube, PatchKind};
use crate::settings::Settings;

use plan::{Entry, Resolved, SPEC_ANNOTATION, STATUS_ANNOTATION};

/// How long a resolved gateway MAC is trusted before it is read again.
const MAC_TTL: Duration = Duration::from_secs(300);
/// How often a status whose only change is its packet counter is rewritten.
const COUNTER_REFRESH: Duration = Duration::from_secs(60);

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default()
}

struct Agent {
    node: String,
    kube: Kube,
    macs: HashMap<String, (String, Instant)>,
    /// Per VMI uid: the status last written (without its volatile fields),
    /// its packet counts, and when.
    written: HashMap<String, (Value, Value, Instant)>,
}

pub async fn run() -> anyhow::Result<()> {
    let node =
        std::env::var("NODE_NAME").map_err(|_| anyhow::anyhow!("NODE_NAME is not set (use the downward API)"))?;
    let interval = std::env::var("NETAGENT_INTERVAL").ok().and_then(|s| s.parse().ok()).unwrap_or(15u64);
    let settings = Settings::from_env(&Env::load_or_default(".env"));
    let cluster = Cluster::load(&settings).await?;
    let kube = cluster.client_for(&Credential::Server).map_err(|e| anyhow::anyhow!(e.message))?;
    tracing::info!(%node, interval, "netagent reconciling off-subnet client NAT");

    let mut agent = Agent { node, kube, macs: HashMap::new(), written: HashMap::new() };
    let mut ticker = tokio::time::interval(Duration::from_secs(interval.max(2)));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if let Err(e) = agent.tick().await {
                    tracing::warn!(error = %e, "reconcile failed");
                }
            }
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
    }
}

/// One interface's outcome.
struct Outcome {
    state: &'static str,
    message: String,
    detail: Value,
}

impl Agent {
    async fn tick(&mut self) -> Result<(), String> {
        let path = ResourceRef::new("kubevirt.io/v1", "virtualmachineinstances").path().map_err(|e| e.message)?;
        let list = self.kube.get(&path).await.map_err(|e| e.message)?;
        let mut live = Vec::new();
        for vmi in list.get("items").and_then(Value::as_array).into_iter().flatten() {
            let on_node = str_at(vmi, "/status/nodeName") == self.node;
            let migrating_here = str_at(vmi, "/status/migrationState/targetNode") == self.node
                && !vmi.pointer("/status/migrationState/completed").and_then(Value::as_bool).unwrap_or(false);
            if !on_node && !migrating_here {
                continue;
            }
            live.push(str_at(vmi, "/metadata/uid").to_string());
            // The source node's agent owns the status until the migration is
            // done; the target's applies quietly so the guest is reachable
            // the moment it lands.
            self.reconcile(vmi, on_node).await;
        }
        self.written.retain(|uid, _| live.contains(uid));
        Ok(())
    }

    async fn reconcile(&mut self, vmi: &Value, owner: bool) {
        let ns = str_at(vmi, "/metadata/namespace").to_string();
        let name = str_at(vmi, "/metadata/name").to_string();
        let spec = vmi.pointer("/metadata/annotations").and_then(|a| a.get(SPEC_ANNOTATION)).and_then(Value::as_str);
        let has_status = vmi.pointer("/metadata/annotations").and_then(|a| a.get(STATUS_ANNOTATION)).is_some();

        let Some(spec) = spec else {
            // Switched off: take down what was put up, then the status.
            if has_status && owner {
                for pid in host::qemu_pids(&ns, &name) {
                    if let Err(e) = self.converge(pid, &[]).await {
                        tracing::warn!(vmi = %format!("{ns}/{name}"), error = %e, "cleanup failed");
                    }
                }
                self.patch_status(vmi, Value::Null).await;
            }
            return;
        };

        let status = match plan::parse(spec) {
            Err(e) => json!({ "state": "Failed", "message": e, "interfaces": [] }),
            Ok(entries) => self.apply(vmi, &ns, &name, &entries).await,
        };
        if owner {
            self.report(vmi, status).await;
        }
    }

    async fn apply(&mut self, vmi: &Value, ns: &str, name: &str, entries: &[Entry]) -> Value {
        let pids = host::qemu_pids(ns, name);
        if pids.is_empty() {
            return json!({
                "state": "Pending",
                "message": format!("the VM's QEMU process is not running on {} yet", self.node),
                "interfaces": [],
            });
        }

        let mut outcomes: Vec<(String, Outcome)> = Vec::new();
        for pid in &pids {
            let bridges = match host::bridges(*pid).await {
                Ok(b) => b,
                Err(e) => return json!({ "state": "Failed", "message": e, "interfaces": [] }),
            };
            let mut desired = Vec::new();
            for entry in entries {
                if !entry.enabled {
                    outcomes.push((
                        entry.interface.clone(),
                        Outcome { state: "Disabled", message: String::new(), detail: json!({}) },
                    ));
                    continue;
                }
                match self.resolve(vmi, entry, &bridges).await {
                    Ok(r) => desired.push(r),
                    Err((state, message)) => {
                        outcomes.push((entry.interface.clone(), Outcome { state, message, detail: json!({}) }))
                    }
                }
            }
            let result = self.converge(*pid, &desired).await;
            let counts = host::counters(*pid).await.map(|l| plan::packet_counts(&l)).unwrap_or_default();
            for r in desired {
                let packets = counts.iter().find(|(i, _)| *i == r.interface).map(|(_, n)| *n).unwrap_or(0);
                // What a pass changed is in the agent's log; the status says
                // what is true now.
                let (state, message) = match &result {
                    Ok(_) => ("Applied", String::new()),
                    Err(e) => ("Failed", e.clone()),
                };
                outcomes.push((
                    r.interface.clone(),
                    Outcome {
                        state,
                        message,
                        detail: json!({
                            "bridge": r.bridge,
                            "guestIP": r.guest_ip,
                            "snatTo": r.snat_to,
                            "gatewayMAC": r.gateway_mac,
                            "clients": r.clients,
                            "packets": packets,
                        }),
                    },
                ));
            }
        }

        // One row per interface; with two pods (a same-node migration) the
        // worse outcome wins.
        let rank = |s: &str| match s {
            "Failed" => 3,
            "Pending" => 2,
            "Applied" => 1,
            _ => 0,
        };
        let mut rows: Vec<Value> = Vec::new();
        for (interface, outcome) in outcomes {
            let row = {
                let mut row = json!({ "interface": interface, "state": outcome.state, "message": outcome.message });
                if let (Some(row), Some(detail)) = (row.as_object_mut(), outcome.detail.as_object()) {
                    row.extend(detail.clone());
                }
                row
            };
            match rows.iter_mut().find(|r| r["interface"] == interface) {
                Some(existing) if rank(outcome.state) > rank(existing["state"].as_str().unwrap_or("")) => {
                    *existing = row
                }
                Some(_) => {}
                None => rows.push(row),
            }
        }
        let worst = rows.iter().map(|r| r["state"].as_str().unwrap_or("")).max_by_key(|s| rank(s)).unwrap_or("Applied");
        let state = if worst == "Disabled" || rows.is_empty() { "Disabled" } else { worst };
        let message = rows
            .iter()
            .filter(|r| r["state"] != "Applied" && r["state"] != "Disabled")
            .map(|r| format!("{}: {}", r["interface"].as_str().unwrap_or(""), r["message"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join("; ");
        json!({ "state": state, "message": message, "interfaces": rows })
    }

    /// Fill in an entry's `auto` fields for this pod.
    async fn resolve(
        &mut self,
        vmi: &Value,
        entry: &Entry,
        bridges: &[String],
    ) -> Result<Resolved, (&'static str, String)> {
        let status = vmi
            .pointer("/status/interfaces")
            .and_then(Value::as_array)
            .and_then(|list| list.iter().find(|i| i["name"] == entry.interface.as_str()));
        let pod_interface = status.map(|i| str_at(i, "/podInterfaceName")).unwrap_or_default();
        if pod_interface.is_empty() {
            return Err((
                "Failed",
                format!("the VMI reports no pod interface for {}; is it a bridged interface?", entry.interface),
            ));
        }
        let bridge = plan::bridge_for(pod_interface, bridges).ok_or_else(|| {
            (
                "Failed",
                format!("no bridge k6t-… for {pod_interface} in the launcher pod (found {})", bridges.join(", ")),
            )
        })?;

        let guest_ip = match entry.guest_ip.as_deref().filter(|ip| *ip != "auto") {
            Some(ip) => ip.to_string(),
            None => status
                .and_then(|i| {
                    let mut all = vec![str_at(i, "/ipAddress").to_string()];
                    all.extend(
                        i.get("ipAddresses")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(String::from),
                    );
                    all.into_iter().find(|a| a.parse::<std::net::Ipv4Addr>().is_ok())
                })
                .ok_or((
                    "Pending",
                    "waiting for the guest's IPv4 address (needs the guest agent, or set guestIP)".to_string(),
                ))?,
        };

        let gateway_mac = match entry.gateway_mac.as_deref().filter(|m| *m != "auto") {
            Some(mac) => mac.to_lowercase(),
            None => match self.macs.get(&entry.snat_to).filter(|(_, at)| at.elapsed() < MAC_TTL) {
                Some((mac, _)) => mac.clone(),
                None => {
                    let mac = host::gateway_mac(&entry.snat_to).await.map_err(|e| ("Failed", e))?;
                    self.macs.insert(entry.snat_to.clone(), (mac.clone(), Instant::now()));
                    mac
                }
            },
        };

        let mut clients: Vec<String> = entry.clients.iter().filter_map(|c| plan::cidr(c).ok()).collect();
        clients.sort();
        clients.dedup();
        Ok(Resolved {
            interface: entry.interface.clone(),
            bridge,
            clients,
            guest_ip,
            snat_to: entry.snat_to.clone(),
            gateway_mac,
        })
    }

    /// Bring one pod to `desired`; the number of commands it took.
    async fn converge(&self, pid: u32, desired: &[Resolved]) -> Result<usize, String> {
        let current = host::current(pid).await?;
        let commands = plan::commands(desired, &current);
        for cmd in &commands {
            host::run(pid, cmd).await?;
            tracing::info!(pid, command = %cmd.join(" "), "applied");
        }
        Ok(commands.len())
    }

    /// Write `status` unless nothing but the counters changed recently.
    async fn report(&mut self, vmi: &Value, mut status: Value) {
        let uid = str_at(vmi, "/metadata/uid").to_string();
        let packets: Value = status["interfaces"]
            .as_array()
            .map(|rows| rows.iter().map(|r| r["packets"].clone()).collect())
            .unwrap_or_default();
        let mut stable = status.clone();
        for row in stable["interfaces"].as_array_mut().into_iter().flatten() {
            if let Some(row) = row.as_object_mut() {
                row.remove("packets");
            }
        }
        let on_vmi =
            vmi.pointer("/metadata/annotations").and_then(|a| a.get(STATUS_ANNOTATION)).and_then(Value::as_str);
        if let Some((last, last_packets, at)) = self.written.get(&uid) {
            let counters_only = *last == stable;
            if counters_only && (*last_packets == packets || at.elapsed() < COUNTER_REFRESH) && on_vmi.is_some() {
                return;
            }
        }
        status["node"] = json!(self.node);
        status["updated"] = json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        self.patch_status(vmi, Value::String(status.to_string())).await;
        self.written.insert(uid, (stable, packets, Instant::now()));
    }

    async fn patch_status(&self, vmi: &Value, value: Value) {
        let ns = str_at(vmi, "/metadata/namespace");
        let name = str_at(vmi, "/metadata/name");
        let Ok(path) = ResourceRef::new("kubevirt.io/v1", "virtualmachineinstances").ns(ns).named(name).path() else {
            return;
        };
        let body = json!({ "metadata": { "annotations": { STATUS_ANNOTATION: value } } });
        if let Err(e) = self.kube.patch(&path, &body, PatchKind::Merge).await {
            tracing::warn!(vmi = %format!("{ns}/{name}"), error = %e.message, "could not write status");
        }
    }
}
