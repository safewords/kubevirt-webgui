//! `ceph.*` — the state of an external Ceph cluster, from its manager's
//! Prometheus module.
//!
//! ```text
//! ceph.status  { historyHours? }  → { configured, source?, error?, health, mons,
//!                         osds, capacity, pools, pgs, objects, flags, io,
//!                         history, fetchedAt }
//! ceph.osds                        → { available, manage, osds, flags, hosts }   (dashboard)
//! ceph.osd.detail { id }           → { osd, devices, smart }                    (dashboard)
//! ceph.osd.action { id, action, weight? } → { task }   out | in | down | scrub | deep-scrub | reweight
//! ceph.flag { flag, enabled, osds? }      → { task }   noout, norebalance, … (cluster or per OSD)
//! ```
//!
//! Reading works from the prometheus module alone. OSD details and every
//! change go through the dashboard REST API ([`super::ceph_api`]), and only for
//! users Kubernetes lets `update nodes` — the same people who may cordon and
//! drain the machines those OSDs live on.
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

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{Request, header};
use http_body_util::{BodyExt, Empty};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::TcpStream;

use http::Method;
use serde::Deserialize;

use super::ceph_api::{self, DashboardConfig};
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcError, RpcResult, params};
use crate::tasks::TaskTarget;

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
        r.method("ceph.osds", osds);
        r.method("ceph.osd.detail", osd_detail);
        r.method("ceph.osd.action", osd_action);
        r.method("ceph.flag", flag);
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

async fn status(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct P {
        #[serde(default)]
        history_hours: Option<f64>,
    }
    let p: P = serde_json::from_value(p).unwrap_or_default();
    // Signed-in users only, like every other method.
    ctx.session()?;
    let urls = ctx.state.settings.ceph_metrics_urls.clone();
    if urls.is_empty() {
        return Ok(json!({ "configured": false, "dashboard": dashboard_configured(&ctx) }));
    }
    start_sampler(urls.clone());
    let hours = p.history_hours.unwrap_or(6.0).clamp(0.0, 24.0);

    let cached = cache().lock().unwrap().as_ref().filter(|(at, _)| at.elapsed() < CACHE).map(|(_, v)| v.clone());
    let mut value = match cached {
        Some(v) => v,
        None => match fetch_metrics(&urls).await {
            Ok((url, metrics)) => {
                let mut value = summarize(&metrics);
                value["configured"] = json!(true);
                value["source"] = json!(url);
                value["fetchedAt"] = json!(chrono::Utc::now().to_rfc3339());
                *cache().lock().unwrap() = Some((Instant::now(), value.clone()));
                value
            }
            Err(e) => return Ok(json!({ "configured": true, "error": e, "dashboard": dashboard_configured(&ctx) })),
        },
    };
    value["history"] = history_json(hours);
    value["dashboard"] = json!(dashboard_configured(&ctx));
    Ok(value)
}

/// The first manager in `urls` that answers with cluster figures.
async fn fetch_metrics(urls: &[String]) -> Result<(String, HashMap<String, Vec<Sample>>), String> {
    let mut errors = Vec::new();
    for url in urls {
        match fetch(url).await {
            Ok(text) => {
                let metrics = parse(&text);
                if metrics.contains_key("ceph_health_status") {
                    return Ok((url.clone(), metrics));
                }
                // A standby manager answers, but with no cluster figures.
                errors.push(format!("{url}: no cluster figures (a standby manager?)"));
            }
            Err(e) => errors.push(format!("{url}: {e}")),
        }
    }
    Err(format!(
        "no manager in CEPH_METRICS_URLS answered with cluster figures — is the prometheus module enabled \
         (`ceph mgr module enable prometheus`) and port 9283 reachable from the server? {}",
        errors.join("; ")
    ))
}

// --- history -------------------------------------------------------------------

/// One point of history: what the charts plot.
#[derive(Clone, Debug, Default)]
struct Point {
    ts: i64,
    used: f64,
    total: f64,
    degraded: f64,
    misplaced: f64,
    copies: f64,
    read_ops: f64,
    write_ops: f64,
    read_bytes: f64,
    write_bytes: f64,
    recovery_bytes: f64,
    health: f64,
    latency: BTreeMap<String, f64>,
}

const SAMPLE_EVERY: Duration = Duration::from_secs(30);
const KEEP: usize = 24 * 3600 / 30;

fn history() -> &'static Mutex<VecDeque<Point>> {
    static HISTORY: OnceLock<Mutex<VecDeque<Point>>> = OnceLock::new();
    HISTORY.get_or_init(|| Mutex::new(VecDeque::with_capacity(KEEP)))
}

/// Start sampling once, on first use: one GET every 30 s, kept for 24 h in
/// memory. Counters (ops, bytes) become rates between samples.
fn start_sampler(urls: Vec<String>) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        let mut previous: Option<(i64, [f64; 4])> = None;
        let mut tick = tokio::time::interval(SAMPLE_EVERY);
        loop {
            tick.tick().await;
            let Ok((_, m)) = fetch_metrics(&urls).await else { continue };
            let now = chrono::Utc::now().timestamp_millis();
            let counters = [
                sum(&m, "ceph_pool_rd"),
                sum(&m, "ceph_pool_wr"),
                sum(&m, "ceph_pool_rd_bytes"),
                sum(&m, "ceph_pool_wr_bytes"),
            ];
            let rates = match previous {
                Some((at, before)) if now > at => {
                    let secs = (now - at) as f64 / 1000.0;
                    // A counter that went down was reset (a restarted OSD): no rate this time.
                    counters
                        .iter()
                        .zip(before)
                        .map(|(c, b)| if *c >= b { (c - b) / secs } else { 0.0 })
                        .collect::<Vec<_>>()
                }
                _ => vec![0.0; 4],
            };
            let first_point = previous.is_none();
            previous = Some((now, counters));
            if first_point {
                continue;
            }
            let point = Point {
                ts: now,
                used: first(&m, "ceph_cluster_total_used_raw_bytes").unwrap_or_default(),
                total: first(&m, "ceph_cluster_total_bytes").unwrap_or_default(),
                degraded: first(&m, "ceph_num_objects_degraded").unwrap_or_default(),
                misplaced: first(&m, "ceph_num_objects_misplaced").unwrap_or_default(),
                copies: object_copies(&m),
                read_ops: rates[0],
                write_ops: rates[1],
                read_bytes: rates[2],
                write_bytes: rates[3],
                recovery_bytes: sum(&m, "ceph_pool_recovering_bytes_per_sec"),
                health: first(&m, "ceph_health_status").unwrap_or_default(),
                latency: by(&m, "ceph_osd_commit_latency_ms", "ceph_daemon")
                    .into_iter()
                    .map(|(d, v)| (d.trim_start_matches("osd.").to_string(), v))
                    .collect(),
            };
            let mut h = history().lock().unwrap();
            if h.len() == KEEP {
                h.pop_front();
            }
            h.push_back(point);
        }
    });
}

/// History as columns, which is compact and what the charts want.
fn history_json(hours: f64) -> Value {
    let since = chrono::Utc::now().timestamp_millis() - (hours * 3600.0 * 1000.0) as i64;
    let h = history().lock().unwrap();
    let points: Vec<&Point> = h.iter().filter(|p| p.ts >= since).collect();
    let col = |f: fn(&Point) -> f64| points.iter().map(|p| f(p)).collect::<Vec<_>>();
    let mut latency: BTreeMap<String, Vec<Option<f64>>> = BTreeMap::new();
    for (i, p) in points.iter().enumerate() {
        for (id, v) in &p.latency {
            latency.entry(id.clone()).or_insert_with(|| vec![None; points.len()])[i] = Some(*v);
        }
    }
    json!({
        "intervalSeconds": SAMPLE_EVERY.as_secs(),
        "ts": points.iter().map(|p| p.ts).collect::<Vec<_>>(),
        "usedBytes": col(|p| p.used),
        "totalBytes": col(|p| p.total),
        "degradedObjects": col(|p| p.degraded),
        "misplacedObjects": col(|p| p.misplaced),
        "objectCopies": col(|p| p.copies),
        "readOps": col(|p| p.read_ops),
        "writeOps": col(|p| p.write_ops),
        "readBytes": col(|p| p.read_bytes),
        "writeBytes": col(|p| p.write_bytes),
        "recoveryBytes": col(|p| p.recovery_bytes),
        "health": col(|p| p.health),
        "osdLatencyMs": latency,
    })
}

fn sum(m: &HashMap<String, Vec<Sample>>, name: &str) -> f64 {
    m.get(name).into_iter().flatten().map(|s| s.value).sum()
}

/// Object copies the pools ask for: objects × replica count, read from each
/// pool's `description="replica:N"`. Degraded counts are out of this.
fn object_copies(m: &HashMap<String, Vec<Sample>>) -> f64 {
    let objects = by(m, "ceph_pool_objects", "pool_id");
    m.get("ceph_pool_metadata")
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let id = s.labels.get("pool_id")?;
            let size = s
                .labels
                .get("description")
                .and_then(|d| d.strip_prefix("replica:"))
                .and_then(|n| n.parse::<f64>().ok())
                .unwrap_or(1.0);
            Some(objects.get(id).copied().unwrap_or_default() * size)
        })
        .sum()
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
    // Tentacle's manager no longer exports per-OSD bytes; latency it still does.
    let apply = by(m, "ceph_osd_apply_latency_ms", "ceph_daemon");
    let commit = by(m, "ceph_osd_commit_latency_ms", "ceph_daemon");
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
                "applyLatencyMs": apply.get(d),
                "commitLatencyMs": commit.get(d),
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

    let flags: Vec<String> = m
        .iter()
        .filter_map(|(name, samples)| {
            let flag = name.strip_prefix("ceph_osd_flag_")?;
            (samples.iter().any(|s| s.value > 0.0)).then(|| flag.replace('_', "-"))
        })
        .collect();
    let mut flags = flags;
    flags.sort();

    json!({
        "health": { "status": health, "checks": checks },
        "objects": {
            "degraded": first(m, "ceph_num_objects_degraded"),
            "misplaced": first(m, "ceph_num_objects_misplaced"),
            "unfound": first(m, "ceph_num_objects_unfound"),
            "copies": object_copies(m),
            "total": sum(m, "ceph_pool_objects"),
        },
        "flags": flags,
        "recoveryBytesPerSec": sum(m, "ceph_pool_recovering_bytes_per_sec"),
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
ceph_osd_commit_latency_ms{ceph_daemon="osd.10"} 3.0
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
        assert_eq!(osds[1]["commitLatencyMs"], 3.0);
        assert!(osds[0]["commitLatencyMs"].is_null());

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

// --- the dashboard API: OSD details and management -------------------------------

fn dashboard_config(ctx: &Ctx) -> Option<DashboardConfig> {
    let s = &ctx.state.settings;
    if s.ceph_dashboard_urls.is_empty() || s.ceph_dashboard_user.is_empty() {
        return None;
    }
    Some(DashboardConfig {
        urls: s.ceph_dashboard_urls.clone(),
        user: s.ceph_dashboard_user.clone(),
        password: s.ceph_dashboard_password.clone()?,
        cert_sha256: s.ceph_dashboard_cert_sha256.as_deref().and_then(DashboardConfig::parse_fingerprint),
    })
}

fn dashboard_configured(ctx: &Ctx) -> bool {
    dashboard_config(ctx).is_some()
}

fn require_dashboard(ctx: &Ctx) -> RpcResult<DashboardConfig> {
    dashboard_config(ctx).ok_or_else(|| {
        RpcError::new(
            501,
            "NotConfigured",
            "the Ceph dashboard API is not configured (CEPH_DASHBOARD_URLS, CEPH_DASHBOARD_USER, CEPH_DASHBOARD_PASSWORD)",
        )
    })
}

/// Managing Ceph is for whoever may manage the machines: `update nodes`.
async fn may_manage(ctx: &Ctx) -> bool {
    let Ok(kube) = ctx.kube() else { return false };
    let review = json!({
        "apiVersion": "authorization.k8s.io/v1",
        "kind": "SelfSubjectAccessReview",
        "spec": { "resourceAttributes": { "verb": "update", "resource": "nodes" } }
    });
    kube.post("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", &review)
        .await
        .ok()
        .and_then(|r| r.pointer("/status/allowed").and_then(Value::as_bool))
        .unwrap_or(false)
}

async fn require_manage(ctx: &Ctx) -> RpcResult<()> {
    if may_manage(ctx).await {
        Ok(())
    } else {
        Err(RpcError::new(403, "Forbidden", "managing Ceph needs permission to update nodes in Kubernetes"))
    }
}

fn api_error(e: ceph_api::ApiError) -> RpcError {
    RpcError::new(e.status.unwrap_or(502), "CephError", e.to_string())
}

fn num(v: &Value, ptr: &str) -> Value {
    v.pointer(ptr).cloned().unwrap_or(Value::Null)
}

async fn osds(ctx: Ctx, _: Value) -> RpcResult {
    ctx.session()?;
    let Some(config) = dashboard_config(&ctx) else {
        return Ok(json!({ "available": false, "reason": "not configured" }));
    };
    let (list, flags, individual, hosts, health, manage) = tokio::join!(
        ceph_api::call(&config, Method::GET, "/api/osd?offset=0&limit=1000", None),
        ceph_api::call(&config, Method::GET, "/api/osd/flags", None),
        ceph_api::call(&config, Method::GET, "/api/osd/flags/individual", None),
        ceph_api::call(&config, Method::GET, "/api/host?offset=0&limit=1000", None),
        ceph_api::call(&config, Method::GET, "/api/health/minimal", None),
        may_manage(&ctx),
    );
    let list = match list {
        Ok(v) => v,
        Err(e) => return Ok(json!({ "available": false, "reason": e.to_string(), "manage": manage })),
    };
    let per_osd_flags: HashMap<i64, Value> = individual
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        // The answer mixes state ("exists", "up") in with the flags; keep the flags.
        .filter_map(|e| {
            let flags: Vec<Value> = e
                .get("flags")?
                .as_array()?
                .iter()
                .filter(|f| f.as_str().is_some_and(|f| OSD_FLAGS.contains(&f)))
                .cloned()
                .collect();
            Some((e.get("osd")?.as_i64()?, Value::Array(flags)))
        })
        .collect();
    let osds: Vec<Value> = list
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|o| {
            let id = o.get("id").and_then(Value::as_i64).unwrap_or(-1);
            json!({
                "id": id,
                "host": num(o, "/host/name"),
                "up": o.get("up").and_then(Value::as_i64) == Some(1),
                "in": o.get("in").and_then(Value::as_i64) == Some(1),
                "state": o.get("state"),
                "deviceClass": num(o, "/tree/device_class"),
                "crushWeight": num(o, "/tree/crush_weight"),
                "reweight": num(o, "/tree/reweight"),
                "primaryAffinity": o.get("primary_affinity"),
                "usedBytes": num(o, "/stats/stat_bytes_used"),
                "totalBytes": num(o, "/stats/stat_bytes"),
                "pgs": num(o, "/stats/numpg"),
                "readOps": num(o, "/stats/op_r"),
                "writeOps": num(o, "/stats/op_w"),
                "readBytes": num(o, "/stats/op_out_bytes"),
                "writeBytes": num(o, "/stats/op_in_bytes"),
                "flags": per_osd_flags.get(&id).cloned().unwrap_or(json!([])),
            })
        })
        .collect();
    let hosts: Vec<Value> = hosts
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|h| {
            json!({
                "name": h.get("hostname"),
                "services": h.get("services").and_then(Value::as_array).map(|s| s.iter().map(|x| format!("{}.{}", x["type"].as_str().unwrap_or(""), x["id"].as_str().unwrap_or(""))).collect::<Vec<_>>()),
            })
        })
        .collect();
    // Placement groups by exact state ("active+undersized+degraded"), which
    // the prometheus counters cannot give without counting a PG twice.
    let health = health.unwrap_or(Value::Null);
    Ok(json!({
        "available": true,
        "manage": manage,
        "osds": osds,
        "flags": flags.unwrap_or(json!([])),
        "hosts": hosts,
        "pgStatuses": num(&health, "/pg_info/statuses"),
        "scrubStatus": num(&health, "/scrub_status"),
    }))
}

#[derive(Deserialize)]
struct OsdId {
    id: u32,
}

async fn osd_detail(ctx: Ctx, p: Value) -> RpcResult {
    ctx.session()?;
    let OsdId { id } = params(p)?;
    let config = require_dashboard(&ctx)?;
    let (detail_path, devices_path, smart_path) =
        (format!("/api/osd/{id}"), format!("/api/osd/{id}/devices"), format!("/api/osd/{id}/smart"));
    let (detail, devices, smart) = tokio::join!(
        ceph_api::call(&config, Method::GET, &detail_path, None),
        ceph_api::call(&config, Method::GET, &devices_path, None),
        ceph_api::call(&config, Method::GET, &smart_path, None),
    );
    let detail = detail.map_err(api_error)?;
    let md = detail.get("osd_metadata").cloned().unwrap_or(Value::Null);
    let pick = |k: &str| md.get(k).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "metadata": {
            "hostname": pick("hostname"),
            "devices": pick("devices"),
            "deviceIds": pick("device_ids"),
            "deviceClass": pick("default_device_class"),
            "rotational": pick("rotational"),
            "objectstore": pick("osd_objectstore"),
            "bdevSize": pick("bluestore_bdev_size"),
            "bdevType": pick("bluestore_bdev_type"),
            "dbDevice": pick("bluefs_db_devices"),
            "version": pick("ceph_version_short").as_str().map(String::from).or_else(|| pick("ceph_version").as_str().map(String::from)),
            "frontAddr": pick("front_addr"),
            "memoryBytes": pick("mem_total_kb").as_str().and_then(|k| k.parse::<f64>().ok()).map(|k| k * 1024.0),
            "kernel": pick("kernel_version"),
            "distro": pick("distro_description"),
        },
        "devices": devices.unwrap_or(json!([])),
        "smart": smart.ok().map(trim_smart).unwrap_or(Value::Null),
    }))
}

/// The SMART fields people look at, per device: passed, temperature, hours,
/// wear, and the raw counters that predict failure.
fn trim_smart(all: Value) -> Value {
    let Some(map) = all.as_object() else { return Value::Null };
    let mut out = serde_json::Map::new();
    for (dev, d) in map {
        let attrs = d.pointer("/ata_smart_attributes/table").and_then(Value::as_array).cloned().unwrap_or_default();
        let attr = |name: &str| attrs.iter().find(|a| a["name"] == name).and_then(|a| a.pointer("/raw/value").cloned());
        let nvme = d.get("nvme_smart_health_information_log");
        out.insert(
            dev.clone(),
            json!({
                "model": d.get("model_name"),
                "serial": d.get("serial_number"),
                "firmware": d.get("firmware_version"),
                "passed": d.pointer("/smart_status/passed"),
                "temperatureC": d.pointer("/temperature/current"),
                "powerOnHours": d.pointer("/power_on_time/hours"),
                "capacityBytes": d.pointer("/user_capacity/bytes"),
                "rotationRate": d.get("rotation_rate"),
                "percentageUsed": nvme.and_then(|n| n.get("percentage_used")).cloned()
                    .or_else(|| attrs.iter().find(|a| matches!(a["name"].as_str(), Some("Percent_Lifetime_Remain" | "Wear_Leveling_Count" | "Media_Wearout_Indicator"))).and_then(|a| a.get("value").and_then(Value::as_f64)).map(|v| json!(100.0 - v))),
                "reallocatedSectors": attr("Reallocated_Sector_Ct"),
                "pendingSectors": attr("Current_Pending_Sector"),
                "uncorrectable": attr("Offline_Uncorrectable").or_else(|| attr("Reported_Uncorrect")),
                "mediaErrors": nvme.and_then(|n| n.get("media_errors")).cloned(),
                "error": d.get("error").or_else(|| d.pointer("/smartctl/messages/0/string")),
            }),
        );
    }
    Value::Object(out)
}

fn osd_target(id: u32) -> TaskTarget {
    TaskTarget { kind: "CephOSD".into(), namespace: None, name: format!("osd.{id}") }
}

async fn osd_action(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        id: u32,
        action: String,
        #[serde(default)]
        weight: Option<f64>,
    }
    let p: P = params(p)?;
    let config = require_dashboard(&ctx)?;
    require_manage(&ctx).await?;
    let (method, path, body, describe) = match p.action.as_str() {
        "out" | "in" | "down" => (
            Method::PUT,
            format!("/api/osd/{}/mark", p.id),
            Some(json!({ "action": p.action })),
            format!("Mark osd.{} {}", p.id, p.action),
        ),
        "scrub" => (Method::POST, format!("/api/osd/{}/scrub?deep=false", p.id), None, format!("Scrub osd.{}", p.id)),
        "deep-scrub" => {
            (Method::POST, format!("/api/osd/{}/scrub?deep=true", p.id), None, format!("Deep-scrub osd.{}", p.id))
        }
        "reweight" => {
            let w = p
                .weight
                .filter(|w| (0.0..=1.0).contains(w))
                .ok_or_else(|| RpcError::bad_request("reweight needs a weight between 0 and 1"))?;
            (
                Method::POST,
                format!("/api/osd/{}/reweight", p.id),
                Some(json!({ "weight": w })),
                format!("Reweight osd.{} to {w}", p.id),
            )
        }
        other => return Err(RpcError::bad_request(format!("unknown OSD action {other}"))),
    };
    let id = p.id;
    let action = p.action.clone();
    ctx.task("ceph.osd", osd_target(id), describe, move |task| async move {
        task.log(format!("{method} {path}"));
        ceph_api::call(&config, method, &path, body).await.map_err(api_error)?;
        // Read the OSD back, so the log shows what Ceph now says.
        if let Ok(v) = ceph_api::call(&config, Method::GET, "/api/osd?offset=0&limit=1000", None).await
            && let Some(o) = v.as_array().and_then(|a| a.iter().find(|o| o["id"].as_u64() == Some(id as u64)))
        {
            task.log(format!(
                "osd.{id} is now {} and {}, reweight {}",
                if o["up"].as_i64() == Some(1) { "up" } else { "down" },
                if o["in"].as_i64() == Some(1) { "in" } else { "out" },
                o.pointer("/tree/reweight").and_then(Value::as_f64).unwrap_or(0.0)
            ));
        }
        Ok(Some(match action.as_str() {
            "out" => format!("osd.{id} marked out; Ceph moves its data to other OSDs"),
            "in" => format!("osd.{id} marked in; data moves back onto it"),
            "down" => format!("osd.{id} marked down; a running OSD marks itself up again"),
            "scrub" | "deep-scrub" => format!("{action} of osd.{id} requested; it runs when the OSD has capacity"),
            _ => format!("osd.{id} reweighted"),
        }))
    })
}

/// Flags that change how Ceph reacts, in the order the UI shows them. `pause`
/// (stops all client I/O) is deliberately not offered.
const CLUSTER_FLAGS: &[&str] =
    &["noout", "noin", "nodown", "noup", "norebalance", "norecover", "nobackfill", "noscrub", "nodeep-scrub"];
const OSD_FLAGS: &[&str] = &["noout", "noin", "nodown", "noup"];

async fn flag(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        flag: String,
        enabled: bool,
        #[serde(default)]
        osds: Vec<u32>,
    }
    let p: P = params(p)?;
    let config = require_dashboard(&ctx)?;
    require_manage(&ctx).await?;
    let allowed = if p.osds.is_empty() { CLUSTER_FLAGS } else { OSD_FLAGS };
    if !allowed.contains(&p.flag.as_str()) {
        return Err(RpcError::bad_request(format!(
            "{} is not a flag that can be set here (allowed: {})",
            p.flag,
            allowed.join(", ")
        )));
    }
    let verb = if p.enabled { "Set" } else { "Clear" };
    let scope = if p.osds.is_empty() {
        "the cluster".to_string()
    } else {
        p.osds.iter().map(|i| format!("osd.{i}")).collect::<Vec<_>>().join(", ")
    };
    let target = TaskTarget { kind: "CephCluster".into(), namespace: None, name: "ceph".into() };
    ctx.task("ceph.flag", target, format!("{verb} {} on {scope}", p.flag), move |task| async move {
        if p.osds.is_empty() {
            // The API replaces the whole set, so read it, change one flag, write it back.
            let current = ceph_api::call(&config, Method::GET, "/api/osd/flags", None).await.map_err(api_error)?;
            let mut flags: Vec<String> = current
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|f| f.as_str().map(String::from))
                .collect();
            flags.retain(|f| f != &p.flag);
            if p.enabled {
                flags.push(p.flag.clone());
            }
            task.log(format!("cluster flags → {}", flags.join(", ")));
            ceph_api::call(&config, Method::PUT, "/api/osd/flags", Some(json!({ "flags": flags })))
                .await
                .map_err(api_error)?;
        } else {
            ceph_api::call(
                &config,
                Method::PUT,
                "/api/osd/flags/individual",
                Some(json!({ "flags": { p.flag.clone(): p.enabled }, "ids": p.osds })),
            )
            .await
            .map_err(api_error)?;
        }
        Ok(Some(format!("{} {} on {scope}", p.flag, if p.enabled { "set" } else { "cleared" })))
    })
}
