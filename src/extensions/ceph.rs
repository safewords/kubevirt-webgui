//! `ceph.*` — the state of an external Ceph cluster, from its manager's
//! Prometheus module.
//!
//! ```text
//! ceph.status        → { configured, source?, error?, health, mons, osds,
//!                         capacity, pools, pgs, fetchedAt }
//! ```
//!
//! Kubernetes only sees Ceph through its CSI driver, which says nothing about
//! the cluster's health. The manager's `prometheus` module does, over plain
//! read-only HTTP and without a key: `ceph mgr module enable prometheus`, then
//! list the manager hosts in `CEPH_METRICS_URLS`. Only the active manager
//! serves figures, so each URL is tried in turn and the first that answers
//! with them wins.
//!
//! The URLs come from the server's configuration, never from the browser, so
//! this cannot be used to make the server fetch arbitrary addresses.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{Request, header};
use http_body_util::{BodyExt, Empty};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::TcpStream;

use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcResult};

pub struct Ceph;

impl Extension for Ceph {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "ceph".into(),
            name: "Ceph".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description:
                "Health, capacity, OSDs and pools of an external Ceph cluster, from its manager's Prometheus module."
                    .into(),
            requires: vec![],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.method("ceph.status", status);
    }
}

/// How long one answer is reused: the module itself refreshes every 15 s.
const CACHE: Duration = Duration::from_secs(10);
const TIMEOUT: Duration = Duration::from_secs(5);
/// The module's output for a small cluster is tens of kilobytes; this is a guard, not a limit anyone should meet.
const MAX_BODY: usize = 16 * 1024 * 1024;

fn cache() -> &'static Mutex<Option<(Instant, Value)>> {
    static CACHE_CELL: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
    CACHE_CELL.get_or_init(|| Mutex::new(None))
}

async fn status(ctx: Ctx, _: Value) -> RpcResult {
    // Signed-in users only, like every other method.
    ctx.session()?;
    let urls = ctx.state.settings.ceph_metrics_urls.clone();
    if urls.is_empty() {
        return Ok(json!({ "configured": false }));
    }
    if let Some((at, value)) = cache().lock().unwrap().as_ref()
        && at.elapsed() < CACHE
    {
        return Ok(value.clone());
    }

    let mut errors = Vec::new();
    for url in &urls {
        match fetch(url).await {
            Ok(text) => {
                let metrics = parse(&text);
                if !metrics.contains_key("ceph_health_status") {
                    // A standby manager answers, but with no cluster figures.
                    errors.push(format!("{url}: no cluster figures (a standby manager?)"));
                    continue;
                }
                let mut value = summarize(&metrics);
                value["configured"] = json!(true);
                value["source"] = json!(url);
                value["fetchedAt"] = json!(chrono::Utc::now().to_rfc3339());
                *cache().lock().unwrap() = Some((Instant::now(), value.clone()));
                return Ok(value);
            }
            Err(e) => errors.push(format!("{url}: {e}")),
        }
    }
    Ok(json!({
        "configured": true,
        "error": format!(
            "no manager in CEPH_METRICS_URLS answered with cluster figures — is the prometheus module enabled \
             (`ceph mgr module enable prometheus`) and port 9283 reachable from the server? {}",
            errors.join("; ")
        ),
    }))
}

/// GET a plain-HTTP URL and return its body as text.
async fn fetch(url: &str) -> Result<String, String> {
    let uri: http::Uri = url.parse().map_err(|e| format!("not a URL: {e}"))?;
    if uri.scheme_str() != Some("http") {
        return Err("only http:// URLs are supported (the prometheus module serves plain HTTP)".into());
    }
    let host = uri.host().ok_or("the URL has no host")?.to_string();
    let port = uri.port_u16().unwrap_or(9283);
    let work = async {
        let tcp = TcpStream::connect((host.as_str(), port)).await.map_err(|e| format!("could not connect: {e}"))?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake::<_, Empty<Bytes>>(TokioIo::new(tcp))
            .await
            .map_err(|e| format!("HTTP failed: {e}"))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let path = uri.path_and_query().map(|p| p.as_str()).filter(|p| *p != "/").unwrap_or("/metrics");
        let request = Request::get(path)
            .header(header::HOST, format!("{host}:{port}"))
            .header(header::USER_AGENT, concat!("kubevirt-webgui/", env!("CARGO_PKG_VERSION")))
            .body(Empty::new())
            .map_err(|e| format!("could not build the request: {e}"))?;
        let response = sender.send_request(request).await.map_err(|e| format!("the request failed: {e}"))?;
        let status = response.status();
        let mut body = response.into_body();
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|e| format!("reading the answer failed: {e}"))?;
            if let Some(data) = frame.data_ref() {
                bytes.extend_from_slice(data);
                if bytes.len() > MAX_BODY {
                    return Err("the answer is too large".to_string());
                }
            }
        }
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        String::from_utf8(bytes).map_err(|_| "the answer is not text".to_string())
    };
    tokio::time::timeout(TIMEOUT, work).await.map_err(|_| "timed out".to_string())?
}

/// One sample: its labels and value.
#[derive(Debug, Clone, PartialEq)]
struct Sample {
    labels: BTreeMap<String, String>,
    value: f64,
}

/// Prometheus text exposition format: `name{label="v",…} value [timestamp]`.
fn parse(text: &str) -> HashMap<String, Vec<Sample>> {
    let mut out: HashMap<String, Vec<Sample>> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (name, labels, rest) = match line.find(['{', ' ']) {
            Some(i) if line.as_bytes()[i] == b'{' => {
                let Some((labels, rest)) = parse_labels(&line[i + 1..]) else { continue };
                (&line[..i], labels, rest)
            }
            Some(i) => (&line[..i], BTreeMap::new(), &line[i..]),
            None => continue,
        };
        let Some(value) = rest.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()) else { continue };
        out.entry(name.to_string()).or_default().push(Sample { labels, value });
    }
    out
}

/// The labels after `{`, and what follows the closing `}`.
fn parse_labels(s: &str) -> Option<(BTreeMap<String, String>, &str)> {
    let mut labels = BTreeMap::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    loop {
        while i < bytes.len() && (bytes[i] == b',' || bytes[i] == b' ') {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        if bytes[i] == b'}' {
            return Some((labels, &s[i + 1..]));
        }
        let eq = s[i..].find('=')? + i;
        let key = s[i..eq].trim().to_string();
        if bytes.get(eq + 1) != Some(&b'"') {
            return None;
        }
        let mut value = String::new();
        let mut j = eq + 2;
        loop {
            match *bytes.get(j)? {
                b'\\' => {
                    match *bytes.get(j + 1)? {
                        b'n' => value.push('\n'),
                        other => value.push(other as char),
                    }
                    j += 2;
                }
                b'"' => break,
                _ => {
                    let ch = s[j..].chars().next()?;
                    value.push(ch);
                    j += ch.len_utf8();
                }
            }
        }
        labels.insert(key, value);
        i = j + 1;
    }
}

fn first(m: &HashMap<String, Vec<Sample>>, name: &str) -> Option<f64> {
    m.get(name)?.first().map(|s| s.value)
}

/// `label → value` for one metric keyed by one label.
fn by(m: &HashMap<String, Vec<Sample>>, name: &str, key: &str) -> HashMap<String, f64> {
    m.get(name).into_iter().flatten().filter_map(|s| s.labels.get(key).map(|k| (k.clone(), s.value))).collect()
}

fn summarize(m: &HashMap<String, Vec<Sample>>) -> Value {
    let health = match first(m, "ceph_health_status").map(|v| v as i64) {
        Some(0) => "HEALTH_OK",
        Some(1) => "HEALTH_WARN",
        Some(_) => "HEALTH_ERR",
        None => "unknown",
    };
    let mut checks: Vec<Value> = m
        .get("ceph_health_detail")
        .into_iter()
        .flatten()
        .filter(|s| s.value > 0.0)
        .map(|s| json!({ "name": s.labels.get("name"), "severity": s.labels.get("severity") }))
        .collect();
    checks.sort_by_key(|c| c["name"].as_str().unwrap_or_default().to_string());

    // Mons and OSDs: metadata names them and their hosts; status gauges say up/in.
    let quorum = by(m, "ceph_mon_quorum_status", "ceph_daemon");
    let mut mons: Vec<Value> = m
        .get("ceph_mon_metadata")
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let daemon = s.labels.get("ceph_daemon")?;
            Some(json!({
                "name": daemon.trim_start_matches("mon."),
                "host": s.labels.get("hostname"),
                "address": s.labels.get("public_addr"),
                "version": s.labels.get("ceph_version"),
                "inQuorum": quorum.get(daemon).copied().unwrap_or(0.0) > 0.0,
            }))
        })
        .collect();
    if mons.is_empty() {
        mons =
            quorum.iter().map(|(d, v)| json!({ "name": d.trim_start_matches("mon."), "inQuorum": *v > 0.0 })).collect();
    }
    mons.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_string());

    let up = by(m, "ceph_osd_up", "ceph_daemon");
    let inn = by(m, "ceph_osd_in", "ceph_daemon");
    let size = by(m, "ceph_osd_stat_bytes", "ceph_daemon");
    let used = by(m, "ceph_osd_stat_bytes_used", "ceph_daemon");
    let meta: HashMap<String, &Sample> = m
        .get("ceph_osd_metadata")
        .into_iter()
        .flatten()
        .filter_map(|s| s.labels.get("ceph_daemon").map(|d| (d.clone(), s)))
        .collect();
    let mut osd_names: Vec<&String> = up.keys().chain(meta.keys()).collect();
    osd_names.sort_by_key(|d| d.trim_start_matches("osd.").parse::<u64>().unwrap_or(u64::MAX));
    osd_names.dedup();
    let osds: Vec<Value> = osd_names
        .into_iter()
        .map(|d| {
            let md = meta.get(d);
            json!({
                "id": d.trim_start_matches("osd."),
                "host": md.and_then(|s| s.labels.get("hostname")),
                "deviceClass": md.and_then(|s| s.labels.get("device_class")),
                "up": up.get(d).copied().unwrap_or(0.0) > 0.0,
                "in": inn.get(d).copied().unwrap_or(0.0) > 0.0,
                "bytes": size.get(d),
                "usedBytes": used.get(d),
            })
        })
        .collect();

    let stored = by(m, "ceph_pool_stored", "pool_id");
    let avail = by(m, "ceph_pool_max_avail", "pool_id");
    let percent = by(m, "ceph_pool_percent_used", "pool_id");
    let objects = by(m, "ceph_pool_objects", "pool_id");
    let pg_total = by(m, "ceph_pg_total", "pool_id");
    let mut pools: Vec<Value> = m
        .get("ceph_pool_metadata")
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let id = s.labels.get("pool_id")?;
            Some(json!({
                "id": id,
                "name": s.labels.get("name"),
                "type": s.labels.get("type"),
                "storedBytes": stored.get(id),
                "maxAvailBytes": avail.get(id),
                "percentUsed": percent.get(id).map(|p| p * 100.0),
                "objects": objects.get(id),
                "pgs": pg_total.get(id),
            }))
        })
        .collect();
    pools.sort_by_key(|p| p["name"].as_str().unwrap_or_default().to_string());

    // PG states, summed over pools. Only states with PGs in them are listed.
    let mut states = BTreeMap::new();
    for (name, samples) in m {
        if let Some(state) = name.strip_prefix("ceph_pg_")
            && state != "total"
        {
            let sum: f64 = samples.iter().map(|s| s.value).sum();
            if sum > 0.0 {
                states.insert(state.to_string(), sum);
            }
        }
    }
    let pg_sum: f64 = pg_total.values().sum();

    json!({
        "health": { "status": health, "checks": checks },
        "mons": mons,
        "osds": osds,
        "capacity": {
            "totalBytes": first(m, "ceph_cluster_total_bytes"),
            "usedBytes": first(m, "ceph_cluster_total_used_raw_bytes").or_else(|| first(m, "ceph_cluster_total_used_bytes")),
        },
        "pools": pools,
        "pgs": { "total": pg_sum, "states": states },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
# HELP ceph_health_status Cluster health status
# TYPE ceph_health_status untyped
ceph_health_status 1.0
ceph_health_detail{name="OSD_DOWN",severity="HEALTH_WARN"} 1.0
ceph_health_detail{name="MON_CLOCK_SKEW",severity="HEALTH_WARN"} 0.0
ceph_mon_quorum_status{ceph_daemon="mon.vulpes-corsac"} 1.0
ceph_mon_quorum_status{ceph_daemon="mon.vulpes-lagopus"} 0.0
ceph_mon_metadata{ceph_daemon="mon.vulpes-corsac",hostname="vulpes-corsac",public_addr="10.0.4.2",rank="0",ceph_version="ceph version 19.2.3 (x) squid (stable)"} 1.0
ceph_osd_metadata{back_iface="",ceph_daemon="osd.10",cluster_addr="10.0.4.2",device_class="nvme",front_iface="",hostname="vulpes-corsac",objectstore="bluestore",public_addr="10.0.4.2",ceph_version="19.2.3"} 1.0
ceph_osd_metadata{back_iface="",ceph_daemon="osd.2",cluster_addr="10.0.4.1",device_class="ssd",front_iface="",hostname="vulpes-lagopus",objectstore="bluestore",public_addr="10.0.4.1",ceph_version="19.2.3"} 1.0
ceph_osd_up{ceph_daemon="osd.10"} 1.0
ceph_osd_up{ceph_daemon="osd.2"} 0.0
ceph_osd_in{ceph_daemon="osd.10"} 1.0
ceph_osd_in{ceph_daemon="osd.2"} 1.0
ceph_osd_stat_bytes{ceph_daemon="osd.10"} 1000.0
ceph_osd_stat_bytes_used{ceph_daemon="osd.10"} 250.0
ceph_cluster_total_bytes 4000.0
ceph_cluster_total_used_raw_bytes 1000.0
ceph_pool_metadata{pool_id="2",name="kube",type="replicated",description="replica:3",compression_mode="none"} 1.0
ceph_pool_stored{pool_id="2"} 300.0
ceph_pool_max_avail{pool_id="2"} 900.0
ceph_pool_percent_used{pool_id="2"} 0.25
ceph_pool_objects{pool_id="2"} 42.0
ceph_pg_total{pool_id="2"} 32.0
ceph_pg_active{pool_id="2"} 32.0
ceph_pg_degraded{pool_id="2"} 8.0
ceph_pg_down{pool_id="2"} 0.0
odd_metric{label="with \"quotes\", commas"} 7 1700000000000
"#;

    #[test]
    fn parses_labels_values_and_escapes() {
        let m = parse(SAMPLE);
        assert_eq!(first(&m, "ceph_health_status"), Some(1.0));
        let odd = &m["odd_metric"][0];
        assert_eq!(odd.labels["label"], "with \"quotes\", commas");
        assert_eq!(odd.value, 7.0);
    }

    #[test]
    fn summarizes_health_daemons_pools_and_pgs() {
        let s = summarize(&parse(SAMPLE));
        assert_eq!(s["health"]["status"], "HEALTH_WARN");
        assert_eq!(s["health"]["checks"].as_array().unwrap().len(), 1, "a check at 0 is not raised");
        assert_eq!(s["health"]["checks"][0]["name"], "OSD_DOWN");

        assert_eq!(s["mons"].as_array().unwrap().len(), 1);
        assert_eq!(s["mons"][0]["inQuorum"], true);

        let osds = s["osds"].as_array().unwrap();
        assert_eq!(osds.iter().map(|o| o["id"].as_str().unwrap()).collect::<Vec<_>>(), ["2", "10"], "numeric order");
        assert_eq!(osds[0]["up"], false);
        assert_eq!(osds[0]["host"], "vulpes-lagopus");
        assert_eq!(osds[1]["usedBytes"], 250.0);

        assert_eq!(s["capacity"]["usedBytes"], 1000.0);
        assert_eq!(s["pools"][0]["name"], "kube");
        assert_eq!(s["pools"][0]["percentUsed"], 25.0);
        assert_eq!(s["pgs"]["total"], 32.0);
        assert_eq!(s["pgs"]["states"]["degraded"], 8.0);
        assert!(s["pgs"]["states"].get("down").is_none(), "empty states are left out");
    }

    #[test]
    fn a_standby_answer_has_no_health() {
        assert!(!parse("# standby\n").contains_key("ceph_health_status"));
    }
}
