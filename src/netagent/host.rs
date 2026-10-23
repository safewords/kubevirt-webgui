//! The node side: finding a VM's QEMU process, and running `ip` and
//! `iptables` inside its launcher pod's network namespace with `nsenter`.
//!
//! The agent runs with the host's PID namespace, so `/proc` lists every
//! process on the node, and `nsenter -t <pid> -n` enters the namespace a
//! process lives in — the pod's, for QEMU. It also runs with the host's
//! network, which is where the gateway's MAC is read from; entering PID 1's
//! namespace instead is refused by the runtime's AppArmor profile.

use std::collections::{BTreeSet, HashSet};
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

use super::plan::{COMMENT_PREFIX, Current, ROUTE_PROTO, owned_rules};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

/// Run `cmd` in the network namespace of `pid`, returning its stdout.
pub async fn run(pid: u32, cmd: &[String]) -> Result<String, String> {
    let mut command = Command::new("nsenter");
    command.args(["-t", &pid.to_string(), "-n", "--"]).args(cmd);
    output(command, cmd).await
}

/// Run `cmd` in the agent's own network namespace — the node's, since the
/// agent runs with `hostNetwork`.
pub async fn run_on_node(cmd: &[String]) -> Result<String, String> {
    let mut command = Command::new(&cmd[0]);
    command.args(&cmd[1..]);
    output(command, cmd).await
}

async fn output(mut command: Command, cmd: &[String]) -> Result<String, String> {
    command.kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("`{}` timed out", cmd.join(" ")))?
        .map_err(|e| format!("could not run {}: {e}", cmd[0]))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("`{}` failed: {}", cmd.join(" "), stderr.trim()))
    }
}

fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

/// QEMU processes for `namespace/name` on this node, one per network
/// namespace (two during a same-node migration). libvirt names the domain
/// `<namespace>_<name>`, and QEMU carries it as `-name guest=<domain>,…`.
pub fn qemu_pids(namespace: &str, name: &str) -> Vec<u32> {
    let needle = format!("guest={namespace}_{name}");
    let mut seen = HashSet::new();
    let mut pids = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else { return pids };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else { continue };
        let matches = cmdline.split(|b| *b == 0).any(|arg| {
            let arg = String::from_utf8_lossy(arg);
            arg.strip_prefix(&needle).is_some_and(|rest| rest.is_empty() || rest.starts_with(','))
        });
        if !matches {
            continue;
        }
        let netns =
            std::fs::read_link(format!("/proc/{pid}/ns/net")).map(|p| p.display().to_string()).unwrap_or_default();
        if seen.insert(netns) {
            pids.push(pid);
        }
    }
    pids.sort();
    pids
}

fn json_list(text: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(text).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The bridges in the pod.
pub async fn bridges(pid: u32) -> Result<Vec<String>, String> {
    let out = run(pid, &args(&["ip", "-j", "link", "show", "type", "bridge"])).await?;
    Ok(json_list(&out).iter().map(|l| s(l, "ifname")).filter(|n| !n.is_empty()).collect())
}

/// What the pod has now, of the agent's own objects.
pub async fn current(pid: u32) -> Result<Current, String> {
    let rules = run(pid, &args(&["iptables", "-t", "nat", "-S", "POSTROUTING"])).await?;
    let routes = run(pid, &args(&["ip", "-j", "-4", "route", "show", "proto", &ROUTE_PROTO.to_string()])).await?;
    let neighbours = run(pid, &args(&["ip", "-j", "-4", "neigh", "show", "nud", "permanent"])).await?;
    Ok(Current {
        snat_rules: owned_rules(&rules),
        routes: json_list(&routes).iter().map(|r| (s(r, "dst"), s(r, "gateway"), s(r, "dev"))).collect(),
        neighbours: json_list(&neighbours)
            .iter()
            .filter(|n| s(n, "dev").starts_with("k6t-"))
            .map(|n| (s(n, "dst"), s(n, "lladdr").to_lowercase(), s(n, "dev")))
            .collect::<BTreeSet<_>>(),
    })
}

/// `iptables -L -v` for the agent's rules, for the packet counters.
pub async fn counters(pid: u32) -> Result<String, String> {
    let all = run(pid, &args(&["iptables", "-t", "nat", "-L", "POSTROUTING", "-v", "-x", "-n"])).await?;
    Ok(all.lines().filter(|l| l.contains(COMMENT_PREFIX)).collect::<Vec<_>>().join("\n"))
}

/// The MAC of `address` from the node's own ARP table, pinging it once if
/// the table has nothing usable — the node is on the same LAN as the bridge.
pub async fn gateway_mac(address: &str) -> Result<String, String> {
    for attempt in 0..2 {
        let out = run_on_node(&args(&["ip", "-j", "-4", "neigh", "show", address])).await?;
        let found = json_list(&out).iter().find_map(|n| {
            let state: Vec<String> = n
                .get("state")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect();
            let usable = !state.iter().any(|s| s == "FAILED" || s == "INCOMPLETE");
            let mac = s(n, "lladdr");
            (usable && !mac.is_empty()).then_some(mac.to_lowercase())
        });
        if let Some(mac) = found {
            return Ok(mac);
        }
        if attempt == 0 {
            let _ = run_on_node(&args(&["ping", "-c", "1", "-W", "1", address])).await;
        }
    }
    Err(format!("the node has no ARP entry for {address}; set gatewayMAC by hand"))
}
