//! What off-subnet client NAT should look like inside one launcher pod, and
//! the commands that get it there from what is there now.
//!
//! Everything here is pure: the agent reads the pod's current state, this
//! decides, and the agent runs the result. Every object the agent creates is
//! recognisable as its own — SNAT rules by their comment, routes by their
//! protocol number — so it only ever removes what it made.

use std::collections::BTreeSet;
use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

/// The VM annotation (on `spec.template.metadata`, so every VMI carries it).
pub const SPEC_ANNOTATION: &str = "kubevirt-webgui/offsubnet-nat";
/// The VMI annotation the agent reports into.
pub const STATUS_ANNOTATION: &str = "kubevirt-webgui/offsubnet-nat-status";
/// The comment prefix on every SNAT rule the agent owns.
pub const COMMENT_PREFIX: &str = "kvw-offsubnet:";
/// The routing protocol number on every route the agent owns (`ip route … proto 252`).
pub const ROUTE_PROTO: u8 = 252;

/// One bridged interface's setting, as written in the annotation.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The VM interface name (`spec.domain.devices.interfaces[].name`).
    pub interface: String,
    /// Client ranges to translate, as CIDRs.
    pub clients: Vec<String>,
    /// The guest's LAN address; `auto` (or absent) takes it from the VMI.
    #[serde(default, rename = "guestIP", alias = "guestIp")]
    pub guest_ip: Option<String>,
    /// The LAN address clients are rewritten to — usually the gateway.
    pub snat_to: String,
    /// The MAC of `snat_to`; `auto` (or absent) reads the node's ARP table.
    #[serde(default, rename = "gatewayMAC", alias = "gatewayMac")]
    pub gateway_mac: Option<String>,
    /// Off keeps the entry but applies nothing.
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// Parse the annotation: YAML or JSON, a list of entries.
pub fn parse(annotation: &str) -> Result<Vec<Entry>, String> {
    let entries: Vec<Entry> =
        serde_saphyr::from_str(annotation).map_err(|e| format!("{SPEC_ANNOTATION} is not a list of entries: {e}"))?;
    for entry in &entries {
        if entry.interface.trim().is_empty() {
            return Err("an entry has no interface".into());
        }
        for client in &entry.clients {
            cidr(client).map_err(|e| format!("{}: client range {client}: {e}", entry.interface))?;
        }
        entry
            .snat_to
            .parse::<Ipv4Addr>()
            .map_err(|_| format!("{}: snatTo {} is not an IPv4 address", entry.interface, entry.snat_to))?;
        if let Some(ip) = entry.guest_ip.as_deref().filter(|ip| *ip != "auto") {
            ip.parse::<Ipv4Addr>().map_err(|_| format!("{}: guestIP {ip} is not an IPv4 address", entry.interface))?;
        }
        if let Some(mac) = entry.gateway_mac.as_deref().filter(|m| *m != "auto")
            && !is_mac(mac)
        {
            return Err(format!("{}: gatewayMAC {mac} is not a MAC address", entry.interface));
        }
    }
    Ok(entries)
}

/// An IPv4 CIDR in canonical form (`10.1.0.7/24` → `10.1.0.0/24`; a bare
/// address is a /32), which is how iptables and ip print it back.
pub fn cidr(text: &str) -> Result<String, String> {
    let (addr, len) = match text.trim().split_once('/') {
        Some((a, l)) => (a, l.parse::<u8>().map_err(|_| "bad prefix length".to_string())?),
        None => (text.trim(), 32),
    };
    let addr: Ipv4Addr = addr.parse().map_err(|_| "not an IPv4 address".to_string())?;
    if len > 32 {
        return Err("bad prefix length".into());
    }
    let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
    Ok(format!("{}/{len}", Ipv4Addr::from(u32::from(addr) & mask)))
}

pub fn is_mac(text: &str) -> bool {
    let parts: Vec<&str> = text.split(':').collect();
    parts.len() == 6 && parts.iter().all(|p| p.len() == 2 && u8::from_str_radix(p, 16).is_ok())
}

/// An entry with everything `auto` resolved, for one pod.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub interface: String,
    pub bridge: String,
    pub clients: Vec<String>,
    pub guest_ip: String,
    pub snat_to: String,
    pub gateway_mac: String,
}

/// What a launcher pod has now, of the things the agent manages.
#[derive(Debug, Default, Clone)]
pub struct Current {
    /// `iptables -t nat -S POSTROUTING` lines carrying the agent's comment,
    /// normalised by [`owned_rules`] — duplicates kept, so they get removed.
    pub snat_rules: Vec<String>,
    /// `(destination, gateway, device)` of routes with the agent's protocol.
    pub routes: BTreeSet<(String, String, String)>,
    /// `(address, mac, device)` of permanent IPv4 neighbours on `k6t-` bridges.
    pub neighbours: BTreeSet<(String, String, String)>,
}

/// The SNAT rule in the form [`owned_rules`] normalises `iptables -S` to.
pub fn snat_rule(r: &Resolved, client: &str) -> String {
    format!(
        "-A POSTROUTING -s {client} -d {}/32 -m comment --comment {COMMENT_PREFIX}{} -j SNAT --to-source {}",
        r.guest_ip, r.interface, r.snat_to
    )
}

/// Keep only the lines of `iptables -t nat -S POSTROUTING` the agent owns,
/// with the comment unquoted: iptables 1.8.11 prints `--comment "x"` even
/// when nothing needs quoting, older versions do not. The agent's comments
/// never contain spaces, so unquoted is also the form that splits into argv.
pub fn owned_rules(listing: &str) -> Vec<String> {
    let quoted = format!("--comment \"{COMMENT_PREFIX}");
    let plain = format!("--comment {COMMENT_PREFIX}");
    listing
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("-A POSTROUTING"))
        .filter_map(|l| match l.find(&quoted) {
            Some(at) => {
                let rest = &l[at + quoted.len()..];
                let end = rest.find('"')?;
                Some(format!("{}{plain}{}{}", &l[..at], &rest[..end], &rest[end + 1..]))
            }
            None => l.contains(&plain).then(|| l.to_string()),
        })
        .collect()
}

/// A command for the pod's network namespace, as argv.
pub type Command = Vec<String>;

fn argv(parts: &[&str]) -> Command {
    parts.iter().map(|s| s.to_string()).collect()
}

/// The commands that turn `current` into what `desired` describes. Removals
/// come first, so a changed address never briefly has two rules competing.
pub fn commands(desired: &[Resolved], current: &Current) -> Vec<Command> {
    let want_rules: BTreeSet<String> =
        desired.iter().flat_map(|r| r.clients.iter().map(move |c| snat_rule(r, c))).collect();
    let want_routes: BTreeSet<(String, String, String)> = desired
        .iter()
        .flat_map(|r| r.clients.iter().map(move |c| (c.clone(), r.snat_to.clone(), r.bridge.clone())))
        .collect();
    let want_neighbours: BTreeSet<(String, String, String)> =
        desired.iter().map(|r| (r.snat_to.clone(), r.gateway_mac.to_lowercase(), r.bridge.clone())).collect();

    let mut out = Vec::new();
    // Each wanted rule may stay once; anything else of ours goes, a second
    // copy of a wanted one included.
    let mut kept = BTreeSet::new();
    for rule in &current.snat_rules {
        if want_rules.contains(rule) && kept.insert(rule.clone()) {
            continue;
        }
        let mut cmd = argv(&["iptables", "-t", "nat"]);
        cmd.extend(rule.replacen("-A ", "-D ", 1).split_whitespace().map(String::from));
        out.push(cmd);
    }
    for (dst, via, dev) in current.routes.difference(&want_routes) {
        out.push(argv(&["ip", "route", "del", dst, "via", via, "dev", dev, "proto", &ROUTE_PROTO.to_string()]));
    }
    for (addr, _, dev) in current.neighbours.difference(&want_neighbours) {
        // A neighbour that only changed MAC is replaced below, not removed.
        if !want_neighbours.iter().any(|(a, _, d)| a == addr && d == dev) {
            out.push(argv(&["ip", "neigh", "del", addr, "dev", dev]));
        }
    }

    for (addr, mac, dev) in want_neighbours.difference(&current.neighbours) {
        out.push(argv(&["ip", "neigh", "replace", addr, "lladdr", mac, "dev", dev, "nud", "permanent"]));
    }
    for (dst, via, dev) in want_routes.difference(&current.routes) {
        out.push(argv(&[
            "ip",
            "route",
            "replace",
            dst,
            "via",
            via,
            "dev",
            dev,
            "onlink",
            "proto",
            &ROUTE_PROTO.to_string(),
        ]));
    }
    for rule in want_rules.difference(&kept) {
        let mut cmd = argv(&["iptables", "-t", "nat"]);
        cmd.extend(rule.split_whitespace().map(String::from));
        out.push(cmd);
    }
    out
}

/// The bridge KubeVirt made for a bridged interface: `podInterfaceName` is a
/// dummy device `pod<id>`, and the bridge is `k6t-<id>`.
pub fn bridge_for(pod_interface: &str, bridges: &[String]) -> Option<String> {
    let id = pod_interface.strip_prefix("pod").unwrap_or(pod_interface);
    let expected = format!("k6t-{id}");
    bridges.iter().find(|b| **b == expected).cloned()
}

/// Packets translated per interface, from `iptables -t nat -L POSTROUTING -v -x -n`.
pub fn packet_counts(listing: &str) -> Vec<(String, u64)> {
    let mut counts: Vec<(String, u64)> = Vec::new();
    for line in listing.lines() {
        let Some(at) = line.find(&format!("/* {COMMENT_PREFIX}")) else { continue };
        let interface: String =
            line[at + 3 + COMMENT_PREFIX.len()..].chars().take_while(|c| !c.is_whitespace()).collect();
        let packets = line.split_whitespace().next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
        match counts.iter_mut().find(|(i, _)| *i == interface) {
            Some((_, n)) => *n += packets,
            None => counts.push((interface, packets)),
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lan() -> Resolved {
        Resolved {
            interface: "lan".into(),
            bridge: "k6t-094a367b026".into(),
            clients: vec!["10.1.0.0/24".into(), "10.2.0.0/24".into()],
            guest_ip: "10.0.5.120".into(),
            snat_to: "10.0.0.1".into(),
            gateway_mac: "AA:BB:CC:00:11:22".into(),
        }
    }

    #[test]
    fn parses_the_issue_example_in_yaml() {
        let yaml = "- interface: lan\n  clients: [10.1.0.0/24, 10.2.0.0/24]\n  guestIP: 10.0.5.120\n  snatTo: 10.0.0.1\n  gatewayMAC: auto\n";
        let entries = parse(yaml).unwrap();
        assert_eq!(entries[0].interface, "lan");
        assert_eq!(entries[0].guest_ip.as_deref(), Some("10.0.5.120"));
        assert_eq!(entries[0].gateway_mac.as_deref(), Some("auto"));
        assert!(entries[0].enabled);
    }

    #[test]
    fn parses_json_too_and_rejects_nonsense() {
        let json = r#"[{"interface":"lan","clients":["10.1.0.0/24"],"snatTo":"10.0.0.1","enabled":false}]"#;
        assert!(!parse(json).unwrap()[0].enabled);
        assert!(parse(r#"[{"interface":"lan","clients":["10.1.0.0/33"],"snatTo":"10.0.0.1"}]"#).is_err());
        assert!(parse(r#"[{"interface":"lan","clients":[],"snatTo":"fe80::1"}]"#).is_err());
        assert!(parse(r#"[{"interface":"lan","clients":[],"snatTo":"10.0.0.1","gatewayMAC":"nope"}]"#).is_err());
    }

    #[test]
    fn canonicalises_cidrs() {
        assert_eq!(cidr("10.1.0.7/24").unwrap(), "10.1.0.0/24");
        assert_eq!(cidr("10.1.0.7").unwrap(), "10.1.0.7/32");
    }

    #[test]
    fn from_nothing_adds_neighbour_then_routes_then_rules() {
        let cmds = commands(&[lan()], &Current::default());
        let text: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        assert_eq!(text[0], "ip neigh replace 10.0.0.1 lladdr aa:bb:cc:00:11:22 dev k6t-094a367b026 nud permanent");
        assert_eq!(text[1], "ip route replace 10.1.0.0/24 via 10.0.0.1 dev k6t-094a367b026 onlink proto 252");
        assert_eq!(
            text[3],
            "iptables -t nat -A POSTROUTING -s 10.1.0.0/24 -d 10.0.5.120/32 -m comment --comment kvw-offsubnet:lan -j SNAT --to-source 10.0.0.1"
        );
        assert_eq!(cmds.len(), 5);
    }

    #[test]
    fn applied_state_needs_nothing() {
        let r = lan();
        let current = Current {
            snat_rules: r.clients.iter().map(|c| snat_rule(&r, c)).collect(),
            routes: r.clients.iter().map(|c| (c.clone(), r.snat_to.clone(), r.bridge.clone())).collect(),
            neighbours: [(r.snat_to.clone(), "aa:bb:cc:00:11:22".into(), r.bridge.clone())].into(),
        };
        assert!(commands(&[r], &current).is_empty());
    }

    #[test]
    fn removing_a_range_and_disabling_clean_up_only_ours() {
        let r = lan();
        let current = Current {
            snat_rules: r.clients.iter().map(|c| snat_rule(&r, c)).collect(),
            routes: r.clients.iter().map(|c| (c.clone(), r.snat_to.clone(), r.bridge.clone())).collect(),
            neighbours: [(r.snat_to.clone(), "aa:bb:cc:00:11:22".into(), r.bridge.clone())].into(),
        };
        let mut narrower = r.clone();
        narrower.clients.truncate(1);
        let text: Vec<String> = commands(&[narrower], &current).iter().map(|c| c.join(" ")).collect();
        assert_eq!(text.len(), 2);
        assert!(text[0].starts_with("iptables -t nat -D POSTROUTING -s 10.2.0.0/24"));
        assert_eq!(text[1], "ip route del 10.2.0.0/24 via 10.0.0.1 dev k6t-094a367b026 proto 252");

        let everything: Vec<String> = commands(&[], &current).iter().map(|c| c.join(" ")).collect();
        assert_eq!(everything.len(), 5);
        assert!(everything.contains(&"ip neigh del 10.0.0.1 dev k6t-094a367b026".to_string()));
    }

    #[test]
    fn a_new_gateway_mac_replaces_the_neighbour_without_deleting_it() {
        let r = lan();
        let current = Current {
            neighbours: [(r.snat_to.clone(), "00:00:00:00:00:01".into(), r.bridge.clone())].into(),
            ..Default::default()
        };
        let text: Vec<String> = commands(&[r], &current).iter().map(|c| c.join(" ")).collect();
        assert!(!text.iter().any(|t| t.starts_with("ip neigh del")));
        assert!(text[0].starts_with("ip neigh replace 10.0.0.1 lladdr aa:bb:cc:00:11:22"));
    }

    #[test]
    fn reads_quoted_comments_and_removes_duplicates() {
        // iptables 1.8.11, in the agent's image and on the cluster, after a
        // pass that did not recognise its own rules and added them again.
        let rule = "-A POSTROUTING -s 10.1.0.0/24 -d 10.0.5.120/32 -m comment --comment \"kvw-offsubnet:lan\" -j SNAT --to-source 10.0.0.1";
        let listing = format!("-P POSTROUTING ACCEPT\n{rule}\n{rule}\n-A POSTROUTING -j MASQUERADE\n");
        let rules = owned_rules(&listing);
        let r = Resolved { clients: vec!["10.1.0.0/24".into()], ..lan() };
        assert_eq!(rules, vec![snat_rule(&r, "10.1.0.0/24"); 2], "normalised to the form the agent writes");

        let current = Current {
            snat_rules: rules,
            routes: [("10.1.0.0/24".into(), r.snat_to.clone(), r.bridge.clone())].into(),
            neighbours: [(r.snat_to.clone(), "aa:bb:cc:00:11:22".into(), r.bridge.clone())].into(),
        };
        let text: Vec<String> = commands(&[r], &current).iter().map(|c| c.join(" ")).collect();
        assert_eq!(
            text,
            [
                "iptables -t nat -D POSTROUTING -s 10.1.0.0/24 -d 10.0.5.120/32 -m comment --comment kvw-offsubnet:lan -j SNAT --to-source 10.0.0.1"
            ],
            "one copy goes, one stays, nothing is added"
        );
    }

    #[test]
    fn reads_owned_rules_and_counters() {
        let listing = "-P POSTROUTING ACCEPT\n-A POSTROUTING -s 10.1.0.0/24 -d 10.0.5.120/32 -m comment --comment kvw-offsubnet:lan -j SNAT --to-source 10.0.0.1\n-A POSTROUTING -j MASQUERADE\n";
        assert_eq!(owned_rules(listing).len(), 1);
        let verbose = "Chain POSTROUTING (policy ACCEPT 0 packets, 0 bytes)\n    pkts      bytes target     prot opt in     out     source               destination\n      12      720 SNAT       0    --  *      *       10.1.0.0/24          10.0.5.120           /* kvw-offsubnet:lan */ to:10.0.0.1\n       3      180 SNAT       0    --  *      *       10.2.0.0/24          10.0.5.120           /* kvw-offsubnet:lan */ to:10.0.0.1\n";
        assert_eq!(packet_counts(verbose), vec![("lan".to_string(), 15)]);
    }

    #[test]
    fn finds_kubevirts_bridge() {
        let bridges = vec!["k6t-eth0".to_string(), "k6t-094a367b026".to_string()];
        assert_eq!(bridge_for("pod094a367b026", &bridges).as_deref(), Some("k6t-094a367b026"));
        assert_eq!(bridge_for("pod0000", &bridges), None);
    }
}
