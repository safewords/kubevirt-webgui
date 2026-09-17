//! `proxmox.*` — the server side of the Proxmox import wizard.
//!
//! ```text
//! proxmox.status                         is importing enabled, and from where
//! proxmox.hostKey  { host, port }        the host's SSH key, to confirm
//! proxmox.connect  { host, …, fingerprint, password | privateKey }
//!                                        → { session, node, version }
//! proxmox.vms      { session }           the cluster's VMs and nodes
//! proxmox.vm       { session, node, vmid }   one VM's configuration, parsed
//! proxmox.import   { session, node, vmid, digest, vm, disks, start } → { task }
//! proxmox.disconnect { session }
//! ```
//!
//! The browser maps the Proxmox configuration to a VirtualMachine (the person
//! reviews and edits it); the import task creates that VM with an upload
//! DataVolume per disk and streams each disk into it. See [`crate::proxmox`].

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use secrecy::SecretString;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::cluster::paths::{ResourceRef, segment};
use crate::cluster::{Kube, PatchKind};
use crate::gateway::upload::{Upstream, open_upstream, uploads};
use crate::proxmox::config::{self, VmConfig};
use crate::proxmox::ssh::{Auth, Ssh, Target, probe, quote};
use crate::proxmox::{AllowList, valid_name, valid_volid};
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcError, RpcResult, params};
use crate::tasks::{Progress, TaskHandle, TaskTarget};

use super::datavolumes::{self, Settled};
use super::storage::upload_token;

pub struct Proxmox;

impl Extension for Proxmox {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "proxmox".into(),
            name: "Proxmox import".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Import virtual machines from Proxmox VE: settings mapped to KubeVirt, disks streamed over SSH into CDI.".into(),
            requires: vec!["kubevirt.io/v1/virtualmachines".into(), "cdi.kubevirt.io/v1beta1/datavolumes".into()],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.method("proxmox.status", status);
        r.method("proxmox.hostKey", host_key);
        r.method("proxmox.connect", connect);
        r.method("proxmox.vms", vms);
        r.method("proxmox.vm", vm);
        r.method("proxmox.import", import);
        r.method("proxmox.disconnect", disconnect);
    }
}

const SESSION_IDLE: Duration = Duration::from_secs(30 * 60);
const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const MARK: &str = "@@kubevirt-webgui@@";

fn pve_error(message: impl Into<String>) -> RpcError {
    RpcError::new(502, "ProxmoxError", message)
}

// --- sessions -----------------------------------------------------------------

/// A signed-in Proxmox host, for one person, in memory only.
struct PveSession {
    owner: String,
    target: Target,
    auth: Auth,
    fingerprint: String,
    /// The node signed in to.
    node: String,
    last_used: Mutex<Instant>,
}

impl PveSession {
    async fn ssh(&self) -> RpcResult<Ssh> {
        Ssh::connect(&self.target, &self.auth, &self.fingerprint).await.map_err(pve_error)
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<PveSession>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<PveSession>>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

fn session(ctx: &Ctx, id: &str) -> RpcResult<Arc<PveSession>> {
    let user = ctx.user()?.username;
    let mut all = sessions().lock().unwrap();
    all.retain(|_, s| s.last_used.lock().unwrap().elapsed() < SESSION_IDLE);
    let found = all.get(id).filter(|s| s.owner == user).cloned();
    let found = found.ok_or_else(|| RpcError::new(401, "ProxmoxSessionExpired", "the Proxmox session has ended; connect again"))?;
    *found.last_used.lock().unwrap() = Instant::now();
    Ok(found)
}

fn allow_list(ctx: &Ctx) -> AllowList {
    AllowList::parse(&ctx.state.settings.proxmox_allowed_hosts)
}

async fn status(ctx: Ctx, _: Value) -> RpcResult {
    let hosts = &ctx.state.settings.proxmox_allowed_hosts;
    Ok(json!({ "enabled": !hosts.is_empty(), "allowedHosts": hosts }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostParams {
    host: String,
    #[serde(default)]
    port: Option<u16>,
}

async fn host_key(ctx: Ctx, p: Value) -> RpcResult {
    let p: HostParams = params(p)?;
    let port = p.port.unwrap_or(22);
    let addr = allow_list(&ctx).resolve(&p.host, port).await.map_err(RpcError::bad_request)?;
    let key = probe(addr, &p.host).await.map_err(pve_error)?;
    Ok(json!({ "host": p.host, "address": addr.ip().to_string(), "port": port, "algorithm": key.algorithm, "fingerprint": key.fingerprint }))
}

async fn connect(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        host: String,
        #[serde(default)]
        port: Option<u16>,
        #[serde(default)]
        user: Option<String>,
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        private_key: Option<String>,
        #[serde(default)]
        passphrase: Option<String>,
        fingerprint: String,
    }
    let p: P = params(p)?;
    let owner = ctx.user()?.username;
    let user = p.user.filter(|u| !u.trim().is_empty()).unwrap_or_else(|| "root".into());
    if !valid_name(&user) {
        return Err(RpcError::bad_request("the user name is not valid"));
    }
    let auth = match (p.private_key.filter(|k| !k.trim().is_empty()), p.password.filter(|k| !k.is_empty())) {
        (Some(key), _) => Auth::Key { pem: SecretString::from(key), passphrase: p.passphrase.filter(|s| !s.is_empty()).map(SecretString::from) },
        (None, Some(password)) => Auth::Password(SecretString::from(password)),
        (None, None) => return Err(RpcError::bad_request("a password or a private key is required")),
    };
    let port = p.port.unwrap_or(22);
    let addr = allow_list(&ctx).resolve(&p.host, port).await.map_err(RpcError::bad_request)?;
    let target = Target { host: p.host.clone(), addr, user };

    let ssh = Ssh::connect(&target, &auth, &p.fingerprint).await.map_err(pve_error)?;
    let out = ssh.run("command -v pvesh >/dev/null || { echo 'pvesh not found' >&2; exit 3; }; hostname; pveversion", 64 * 1024).await.map_err(pve_error)?;
    ssh.close().await;
    if !out.ok() {
        return Err(pve_error(format!("{} is not a Proxmox VE host ({})", p.host, if out.stderr.is_empty() { "no pvesh" } else { &out.stderr })));
    }
    let text = out.stdout_text();
    let mut lines = text.lines().map(str::trim);
    let node = lines.next().unwrap_or_default().to_string();
    let version = lines.next().unwrap_or_default().to_string();

    let id = {
        use rand::RngCore;
        let mut bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut bytes);
        hex::encode(bytes)
    };
    tracing::info!(user = %owner, host = %p.host, node = %node, "Proxmox session opened");
    let session = PveSession { owner, target, auth, fingerprint: p.fingerprint, node: node.clone(), last_used: Mutex::new(Instant::now()) };
    sessions().lock().unwrap().insert(id.clone(), Arc::new(session));
    Ok(json!({ "session": id, "node": node, "version": version, "host": p.host }))
}

async fn disconnect(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        session: String,
    }
    let p: P = params(p)?;
    let user = ctx.user()?.username;
    sessions().lock().unwrap().retain(|id, s| !(id == &p.session && s.owner == user));
    Ok(json!({ "ok": true }))
}

// --- reading ------------------------------------------------------------------

/// Run a script and split its output at [`MARK`] lines into JSON documents.
async fn documents(ssh: &Ssh, script: &str) -> RpcResult<Vec<Value>> {
    let out = ssh.run(script, OUTPUT_LIMIT).await.map_err(pve_error)?;
    if !out.ok() {
        return Err(pve_error(if out.stderr.is_empty() { format!("the command failed ({:?})", out.status) } else { out.stderr }));
    }
    Ok(out
        .stdout_text()
        .split(MARK)
        .map(|part| serde_json::from_str::<Value>(part.trim()).unwrap_or(Value::Null))
        .collect())
}

async fn vms(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        session: String,
    }
    let p: P = params(p)?;
    let session = session(&ctx, &p.session)?;
    let ssh = session.ssh().await?;
    let docs = documents(
        &ssh,
        &format!("pvesh get /cluster/resources --type vm --output-format json; echo; echo '{MARK}'; pvesh get /cluster/status --output-format json 2>/dev/null || echo '[]'"),
    )
    .await;
    ssh.close().await;
    let docs = docs?;

    let resources = docs.first().and_then(Value::as_array).cloned().unwrap_or_default();
    let vms: Vec<Value> = resources
        .iter()
        .filter(|r| r["type"] == "qemu")
        .map(|r| {
            json!({
                "vmid": r["vmid"],
                "name": r["name"],
                "node": r["node"],
                "status": r["status"],
                "template": r["template"] == 1,
                "cpus": r["maxcpu"],
                "memoryBytes": r["maxmem"],
                "diskBytes": r["maxdisk"],
                "tags": r["tags"].as_str().map(|t| t.split(';').filter(|s| !s.is_empty()).collect::<Vec<_>>()).unwrap_or_default(),
                "lock": r["lock"],
            })
        })
        .collect();
    let nodes: Vec<Value> = docs
        .get(1)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|n| n["type"] == "node")
        .map(|n| json!({ "name": n["name"], "ip": n["ip"], "online": n["online"] == 1, "local": n["local"] == 1 }))
        .collect();
    Ok(json!({ "node": session.node, "vms": vms, "nodes": nodes }))
}

struct Fetched {
    config: VmConfig,
    raw: Map<String, Value>,
    status: String,
    timezone: Option<String>,
}

/// A VM's configuration, run state, exact disk sizes and its node's time zone.
async fn fetch(ssh: &Ssh, node: &str, vmid: u32) -> RpcResult<Fetched> {
    let base = format!("/nodes/{node}/qemu/{vmid}");
    let docs = documents(
        ssh,
        &format!(
            "set -e; pvesh get {base}/config --output-format json; echo; echo '{MARK}'; pvesh get {base}/status/current --output-format json; echo; echo '{MARK}'; pvesh get /nodes/{node}/time --output-format json 2>/dev/null || echo '{{}}'"
        ),
    )
    .await?;
    let raw = docs.first().and_then(Value::as_object).cloned().ok_or_else(|| pve_error(format!("VM {vmid} on {node} has no readable configuration")))?;
    let status = docs.get(1).and_then(|s| s["status"].as_str()).unwrap_or("unknown").to_string();
    let timezone = docs.get(2).and_then(|t| t["timezone"].as_str()).map(String::from);

    // Exact sizes: the storage's own listing, per storage the VM uses.
    let first_pass = config::parse(&raw, &BTreeMap::new());
    let mut storages: Vec<(String, bool)> = Vec::new();
    for disk in &first_pass.disks {
        if let Some(storage) = &disk.storage {
            let iso = disk.media == "cdrom";
            if valid_name(storage) && !storages.iter().any(|(s, i)| s == storage && *i == iso) {
                storages.push((storage.clone(), iso));
            }
        }
    }
    let mut sizes = BTreeMap::new();
    if !storages.is_empty() {
        let script = storages
            .iter()
            .map(|(storage, iso)| {
                let filter = if *iso { "--content iso".to_string() } else { format!("--vmid {vmid}") };
                format!("pvesh get /nodes/{node}/storage/{storage}/content {filter} --output-format json 2>/dev/null || echo '[]'; echo; echo '{MARK}'")
            })
            .collect::<Vec<_>>()
            .join("; ");
        for listing in documents(ssh, &script).await? {
            for item in listing.as_array().into_iter().flatten() {
                if let (Some(volid), Some(size)) = (item["volid"].as_str(), item["size"].as_u64()) {
                    sizes.insert(volid.to_string(), size);
                }
            }
        }
    }
    Ok(Fetched { config: config::parse(&raw, &sizes), raw, status, timezone })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VmParams {
    session: String,
    node: String,
    vmid: u32,
}

async fn vm(ctx: Ctx, p: Value) -> RpcResult {
    let p: VmParams = params(p)?;
    if !valid_name(&p.node) {
        return Err(RpcError::bad_request("the node name is not valid"));
    }
    let session = session(&ctx, &p.session)?;
    let ssh = session.ssh().await?;
    let fetched = fetch(&ssh, &p.node, p.vmid).await;
    ssh.close().await;
    let fetched = fetched?;
    Ok(json!({
        "node": p.node,
        "vmid": p.vmid,
        "status": fetched.status,
        "timezone": fetched.timezone,
        "config": fetched.config,
        "raw": fetched.raw,
    }))
}

// --- importing ----------------------------------------------------------------

/// A zstd frame header for one raw block of 4096 bytes, as `printf` octal
/// escapes: the magic number, a single-segment descriptor with a two-byte
/// content size (4096 − 256), and the block header (last block, raw, 4096).
///
/// It is there for CDI 1.65. Its format detection keeps the first 512 bytes of
/// the stream in a buffer that it then overwrites with decompressed data,
/// while its zstd decoder reads lazily. When a stream's first 512 bytes hold
/// several small blocks, as a mostly empty disk start does, the decoder later
/// reads decompressed bytes as compressed ones and fails with "reserved block
/// type encountered". A 4 KiB raw block spans that buffer, so the decoder
/// consumes it whole before anything is decompressed.
const ZSTD_RAW_BLOCK_4K: &str = r"\050\265\057\375\140\000\017\001\200\000";

/// The command that streams one volume: raw data (the `raw+size` header cut
/// off), counted by `dd` on stderr, compressed with zstd (or gzip) — run on
/// the VM's own node, through the cluster's root SSH when that is not the node
/// signed in to. With zstd the first 4 KiB go out as a raw-block frame of
/// their own ([`ZSTD_RAW_BLOCK_4K`]); concatenated frames decode as one stream.
pub fn export_command(volid: &str, hop: Option<(&str, &str)>) -> String {
    let volume = quote(volid);
    let inner = format!(
        "set -o pipefail; export LC_ALL=C; \
perl -MPVE::Storage -e 'PVE::Storage::activate_volumes(PVE::Storage::config(), [$ARGV[0]])' {volume} && \
pvesm export {volume} raw+size - --with-snapshots 0 2> >(grep -v -e ' copied, ' -e ' records in$' -e ' records out$' -e '^Exporting image' >&2) \
| tail -c +9 | dd bs=4M iflag=fullblock status=progress \
| if command -v zstd >/dev/null; then {{ printf '{ZSTD_RAW_BLOCK_4K}'; dd bs=4096 count=1 iflag=fullblock status=none; zstd -q -1 -T0 -c; }}; else gzip -1 -c; fi"
    );
    let local = format!("bash -c {}", quote(&inner));
    match hop {
        None => local,
        Some((node, ip)) => {
            let known = format!("/etc/pve/nodes/{node}/ssh_known_hosts");
            format!(
                "if [ -f {k} ]; then o='-o UserKnownHostsFile={known} -o GlobalKnownHostsFile=none'; fi; exec ssh -e none -o BatchMode=yes -o HostKeyAlias={n} $o root@{ip} {cmd}",
                k = quote(&known),
                n = quote(node),
                ip = quote(ip),
                cmd = quote(&local)
            )
        }
    }
}

/// The byte count in a `dd status=progress` line, if it is one.
pub fn dd_bytes(line: &str) -> Option<u64> {
    let line = line.trim();
    let (number, rest) = line.split_once(' ')?;
    if !rest.starts_with("bytes") {
        return None;
    }
    number.parse().ok()
}

/// Bytes per second over the last few seconds.
struct Meter {
    samples: VecDeque<(Instant, u64)>,
}

impl Meter {
    fn new() -> Self {
        Self { samples: VecDeque::new() }
    }

    fn rate(&mut self, done: u64) -> Option<f64> {
        let now = Instant::now();
        self.samples.push_back((now, done));
        while self.samples.len() > 2 && now.duration_since(self.samples[0].0) > Duration::from_secs(8) {
            self.samples.pop_front();
        }
        let (at, then) = *self.samples.front()?;
        let seconds = now.duration_since(at).as_secs_f64();
        (seconds >= 1.0).then(|| done.saturating_sub(then) as f64 / seconds)
    }
}

/// Deletes a half-imported VM (and, through its owner references, its disks)
/// unless disarmed — also when the task is stopped mid-copy.
struct Cleanup {
    kube: Kube,
    path: String,
    armed: bool,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.armed {
            let (kube, path) = (self.kube.clone(), self.path.clone());
            tokio::spawn(async move {
                // Background: the name is free at once, and the garbage collector
                // removes the disks and CDI's upload pods after. (Foreground
                // deletion pushes its finalizer onto those pods, where it can stick.)
                if let Err(e) = kube.delete(&path, Some(&json!({ "propagationPolicy": "Background" }))).await {
                    tracing::warn!(path = %path, error = %e.message, "could not remove a partially imported VM");
                }
            });
        }
    }
}

struct DiskJob {
    vmid: u32,
    key: String,
    volid: String,
    data_volume: String,
    size: Option<u64>,
}

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

async fn import(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DiskParam {
        key: String,
        data_volume: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        session: String,
        node: String,
        vmid: u32,
        digest: String,
        vm: Value,
        #[serde(default)]
        disks: Vec<DiskParam>,
        #[serde(default)]
        start: bool,
    }
    let mut p: P = params(p)?;
    if !valid_name(&p.node) {
        return Err(RpcError::bad_request("the node name is not valid"));
    }
    let pve = session(&ctx, &p.session)?;
    let kube = ctx.kube()?;

    if p.vm["kind"] != "VirtualMachine" {
        return Err(RpcError::bad_request("`vm` must be a VirtualMachine"));
    }
    let namespace = p.vm.pointer("/metadata/namespace").and_then(Value::as_str).unwrap_or_default().to_string();
    let name = p.vm.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default().to_string();
    segment("namespace", &namespace)?;
    segment("name", &name)?;

    // Every disk to copy has an upload DataVolume, and every upload
    // DataVolume a disk — otherwise the VM would wait forever.
    let mut uploads_expected = Vec::new();
    for template in p.vm.pointer_mut("/spec/dataVolumeTemplates").and_then(Value::as_array_mut).into_iter().flatten() {
        if template.pointer("/spec/source/upload").is_some() {
            let dv = template.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default().to_string();
            segment("dataVolume", &dv)?;
            uploads_expected.push(dv);
            // Bind now: the upload server is the claim's first user, not the VM.
            template["metadata"]["annotations"]["cdi.kubevirt.io/storage.bind.immediate.requested"] = json!("true");
        }
    }
    let mut seen_keys = Vec::new();
    for disk in &p.disks {
        if seen_keys.contains(&disk.key) {
            return Err(RpcError::bad_request(format!("{} is listed twice", disk.key)));
        }
        seen_keys.push(disk.key.clone());
        if !uploads_expected.contains(&disk.data_volume) {
            return Err(RpcError::bad_request(format!("{} maps to {}, which is not an upload DataVolume template of the VM", disk.key, disk.data_volume)));
        }
    }
    if let Some(orphan) = uploads_expected.iter().find(|dv| !p.disks.iter().any(|d| &d.data_volume == *dv)) {
        return Err(RpcError::bad_request(format!("the upload DataVolume {orphan} has no Proxmox disk to fill it")));
    }

    // Created stopped; started only once every disk is in.
    if let Some(spec) = p.vm.get_mut("spec").and_then(Value::as_object_mut) {
        spec.remove("running");
        spec.insert("runStrategy".into(), json!("Halted"));
    }
    let source = format!("proxmox://{}/{}/{}", pve.target.host, p.node, p.vmid);
    p.vm["metadata"]["annotations"]["kubevirt-webgui/imported-from"] = json!(source);

    let target = TaskTarget { kind: "VirtualMachine".into(), namespace: Some(namespace.clone()), name: name.clone() };
    let description = format!("Import Proxmox VM {} from {} as {namespace}/{name}", p.vmid, pve.target.host);
    ctx.task("proxmox.import", target, description, move |task| async move {
        let ns = namespace.as_str();
        let vmid = p.vmid;
        let node = p.node.clone();
        task.log(format!("connecting to {} ({}) as {}", pve.target.host, pve.target.addr, pve.target.user));
        let ssh = pve.ssh().await?;

        // The source must be as reviewed, and stopped: a running VM's disks
        // change while they are read.
        let fetched = fetch(&ssh, &node, vmid).await?;
        if fetched.status != "stopped" {
            return Err(RpcError::new(409, "SourceRunning", format!("VM {vmid} is {} on Proxmox — shut it down first; an import copies the disks of a stopped VM", fetched.status)));
        }
        if fetched.config.digest != p.digest {
            return Err(RpcError::new(409, "SourceChanged", format!("VM {vmid}'s configuration changed since it was reviewed; open the import again")));
        }
        if let Some(lock) = &fetched.config.lock {
            return Err(RpcError::new(409, "SourceLocked", format!("VM {vmid} is locked on Proxmox ({lock})")));
        }
        task.log(format!("source: VM {vmid} ({}) on {node}, stopped, configuration {}", fetched.config.name, &p.digest.chars().take(12).collect::<String>()));

        let mut jobs = Vec::new();
        for disk in &p.disks {
            let found = fetched.config.disks.iter().find(|d| d.key == disk.key).ok_or_else(|| RpcError::bad_request(format!("VM {vmid} has no disk {}", disk.key)))?;
            let volid = found.volid.clone().filter(|v| found.importable && valid_volid(v)).ok_or_else(|| {
                RpcError::bad_request(format!("{} cannot be imported: {}", disk.key, found.note.clone().unwrap_or_else(|| "it is not on a Proxmox storage".into())))
            })?;
            jobs.push(DiskJob { vmid, key: disk.key.clone(), volid, data_volume: disk.data_volume.clone(), size: found.size_bytes });
        }

        // Disks on a node's local storage are read on that node.
        let hop_ip = if node != pve.node && !jobs.is_empty() {
            let docs = documents(&ssh, "pvesh get /cluster/status --output-format json").await?;
            let ip = docs
                .first()
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|n| n["type"] == "node" && n["name"] == node.as_str())
                .and_then(|n| n["ip"].as_str())
                .and_then(|ip| ip.parse::<std::net::IpAddr>().ok())
                .ok_or_else(|| pve_error(format!("the address of node {node} is unknown to {}", pve.node)))?;
            task.log(format!("{node} holds the VM; reading its disks there through the cluster's SSH from {}", pve.node));
            Some(ip.to_string())
        } else {
            None
        };

        let vm_collection = ResourceRef::new("kubevirt.io/v1", "virtualmachines").ns(ns);
        kube.post(&format!("{}?dryRun=All", vm_collection.path()?), &p.vm).await?;
        kube.post(&vm_collection.path()?, &p.vm).await?;
        let mut cleanup = Cleanup { kube: kube.clone(), path: vm_collection.clone().named(&name).path()?, armed: true };
        // A second connection watches the source while the first streams: a
        // stalled stream would otherwise hold up the watcher's answers too.
        let watcher = pve.ssh().await?;
        task.log(format!("created VM {ns}/{name} (stopped) with {} disk(s) to fill", jobs.len()));

        let total: u64 = jobs.iter().filter_map(|j| j.size).sum();
        let mut copied_before = 0u64;
        let mut meter = Meter::new();
        for (index, job) in jobs.iter().enumerate() {
            let label = format!("{} ({} of {})", job.key, index + 1, jobs.len());
            let result = copy_disk(&task, &kube, &ssh, &watcher, ns, job, hop_ip.as_deref().map(|ip| (node.as_str(), ip)), &label, copied_before, total, &mut meter).await;
            match result {
                Ok(bytes) => copied_before += job.size.unwrap_or(bytes),
                Err(e) => {
                    task.log(format!("removing the partially imported VM {ns}/{name}"));
                    return Err(e);
                }
            }
        }
        ssh.close().await;
        watcher.close().await;
        task.clear_progress();
        cleanup.armed = false;

        if p.start {
            let path = vm_collection.named(&name).path()?;
            kube.patch(&path, &json!({ "spec": { "runStrategy": "Always" } }), PatchKind::Merge).await?;
            task.log("starting the VM");
        }
        Ok(Some(format!("imported VM {vmid} as {ns}/{name}: {} disk(s), {:.2} GiB", jobs.len(), copied_before as f64 / GIB)))
    })
}

/// How often the source VM is checked while its disks are read.
const SOURCE_CHECK: Duration = Duration::from_secs(20);

/// Whether the source runs, and where, as the Proxmox cluster sees it now.
async fn source_state(ssh: &Ssh, vmid: u32) -> Option<(String, String)> {
    let docs = documents(ssh, "pvesh get /cluster/resources --type vm --output-format json").await.ok()?;
    let found = docs.first()?.as_array()?.iter().find(|r| r["vmid"] == vmid)?;
    Some((found["status"].as_str().unwrap_or("unknown").to_string(), found["node"].as_str().unwrap_or_default().to_string()))
}


#[allow(clippy::too_many_arguments)]
async fn copy_disk(
    task: &TaskHandle,
    kube: &Kube,
    ssh: &Ssh,
    watcher: &Ssh,
    ns: &str,
    job: &DiskJob,
    hop: Option<(&str, &str)>,
    label: &str,
    copied_before: u64,
    total: u64,
    meter: &mut Meter,
) -> RpcResult<u64> {
    let dv = job.data_volume.as_str();
    task.log(format!("{label}: {} → DataVolume {dv}{}", job.volid, job.size.map(|s| format!(", {:.2} GiB", s as f64 / GIB)).unwrap_or_default()));
    // KubeVirt creates a template's DataVolume a moment after the VM.
    let dv_path = ResourceRef::new("cdi.kubevirt.io/v1beta1", "datavolumes").ns(ns).named(dv).path()?;
    let waiting = Instant::now();
    loop {
        match kube.get(&dv_path).await {
            Ok(_) => break,
            Err(e) if e.is_not_found() && waiting.elapsed() < Duration::from_secs(120) => tokio::time::sleep(Duration::from_secs(2)).await,
            Err(e) if e.is_not_found() => return Err(RpcError::internal(format!("KubeVirt did not create DataVolume {dv} within two minutes"))),
            Err(e) => return Err(e.into()),
        }
    }
    match datavolumes::follow(task, kube, ns, dv, &format!("disk {dv}"), &["UploadReady"], Duration::from_secs(15 * 60)).await? {
        Settled::Reached(_) => {}
        Settled::Ready(phase) => return Err(RpcError::internal(format!("CDI did not start an upload server for {dv} (DataVolume {phase})"))),
    }
    let token = upload_token(kube, ns, dv).await?;
    let upstream = open_upstream(&uploads().config, kube, &token, None).await.map_err(RpcError::internal)?;
    task.log(format!("{label}: upload proxy reached {}", upstream.route));

    let command = export_command(&job.volid, hop);
    let raw = pump(task, ssh, watcher, &command, upstream, job, label, copied_before, total, meter).await?;
    task.log(format!("{label}: sent {:.2} GiB; CDI is writing the image", raw as f64 / GIB));
    task.progress(Progress::bytes(copied_before + raw, (total > 0).then_some(total)).detail(format!("{label}: CDI is finishing the disk")));
    datavolumes::follow(task, kube, ns, dv, &format!("disk {dv}"), &[], Duration::from_secs(4 * 3600)).await?;
    Ok(raw)
}

#[allow(clippy::too_many_arguments)]
async fn pump(
    task: &TaskHandle,
    ssh: &Ssh,
    watcher: &Ssh,
    command: &str,
    upstream: Upstream,
    job: &DiskJob,
    label: &str,
    copied_before: u64,
    total: u64,
    meter: &mut Meter,
) -> RpcResult<u64> {
    let mut channel = match ssh.exec(command).await {
        Ok(channel) => channel,
        Err(e) => {
            upstream.abort().await;
            return Err(pve_error(e));
        }
    };
    let mut raw = 0u64;
    let mut compressed = 0u64;
    let mut status = None;
    let mut signal = None;
    let mut partial = String::new();
    let mut errors: VecDeque<String> = VecDeque::new();
    let mut logged_tenth = 0u64;
    let mut proxy_gone = false;
    let mut source_started = None;

    let mut watch = tokio::time::interval(SOURCE_CHECK);
    watch.tick().await;
    loop {
        let message = tokio::select! {
            message = channel.wait() => message,
            _ = watch.tick() => {
                if let Some((state, node)) = source_state(watcher, job.vmid).await {
                    if state != "stopped" {
                        source_started = Some(format!("{state} on {node}"));
                        break;
                    }
                }
                continue;
            }
        };
        let Some(message) = message else { break };
        match message {
            ChannelMsg::Data { data } => {
                compressed += data.len() as u64;
                if upstream.body.send(Ok(data)).await.is_err() {
                    proxy_gone = true;
                    break;
                }
            }
            ChannelMsg::ExtendedData { data, .. } => {
                partial.push_str(&String::from_utf8_lossy(&data));
                while let Some(end) = partial.find(['\r', '\n']) {
                    let line: String = partial.drain(..=end).collect();
                    let line = line.trim();
                    if let Some(bytes) = dd_bytes(line) {
                        raw = bytes;
                        let done = copied_before + raw;
                        let rate = meter.rate(done);
                        task.progress(Progress::bytes(done, (total > 0).then_some(total)).rate(rate).detail(format!("copying {label}")));
                        if let Some(size) = job.size.filter(|s| *s > 0) {
                            let tenth = raw * 10 / size;
                            if tenth > logged_tenth && tenth < 10 {
                                logged_tenth = tenth;
                                task.log(format!("{label}: {}% ({:.2} GiB){}", tenth * 10, raw as f64 / GIB, rate.map(|r| format!(" at {:.0} MiB/s", r / (1024.0 * 1024.0))).unwrap_or_default()));
                            }
                        }
                    } else if !line.is_empty() && !line.ends_with("records in") && !line.ends_with("records out") {
                        if errors.len() >= 20 {
                            errors.pop_front();
                        }
                        errors.push_back(line.to_string());
                    }
                }
            }
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            ChannelMsg::ExitSignal { signal_name, .. } => signal = Some(format!("{signal_name:?}")),
            _ => {}
        }
    }
    let stderr = errors.into_iter().collect::<Vec<_>>().join("; ");

    if let Some(how) = source_started {
        upstream.abort().await;
        return Err(RpcError::new(
            409,
            "SourceStarted",
            format!("VM {} was started on Proxmox during the copy ({how}): a disk that changes while it is read is not a copy, so the import stopped. Shut the VM down and import it again.", job.vmid),
        ));
    }
    if proxy_gone {
        let reason = upstream.finish(Duration::from_secs(30)).await.err().unwrap_or_else(|| "it closed the request early".into());
        return Err(RpcError::internal(format!("{label}: the upload proxy stopped accepting data: {reason}")));
    }
    if status != Some(0) {
        upstream.abort().await;
        let how = match (status, signal) {
            (Some(code), _) => format!("exit status {code}"),
            (None, Some(signal)) => format!("signal {signal}"),
            (None, None) => "the connection closed".into(),
        };
        return Err(pve_error(format!("{label}: reading {} on Proxmox failed ({how}){}", job.volid, if stderr.is_empty() { String::new() } else { format!(": {stderr}") })));
    }
    if let Some(size) = job.size.filter(|s| raw != *s) {
        upstream.abort().await;
        return Err(pve_error(format!("{label}: Proxmox sent {raw} bytes of {}, expected {size}", job.volid)));
    }
    upstream.finish(Duration::from_secs(15 * 60)).await.map_err(|e| RpcError::internal(format!("{label}: {e}")))?;
    task.log(format!(
        "{label}: {:.2} GiB read, {:.2} GiB on the wire ({:.0}%)",
        raw as f64 / GIB,
        compressed as f64 / GIB,
        if raw > 0 { compressed as f64 * 100.0 / raw as f64 } else { 100.0 }
    ));
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dd_progress_lines() {
        assert_eq!(dd_bytes("524288000 bytes (524 MB, 500 MiB) copied, 4 s, 131 MB/s"), Some(524_288_000));
        assert_eq!(dd_bytes("1073741824 bytes (1.1 GB, 1.0 GiB) copied, 9.2 s, 117 MB/s"), Some(1_073_741_824));
        assert_eq!(dd_bytes("256+0 records in"), None);
        assert_eq!(dd_bytes("rbd: error opening image"), None);
    }

    #[test]
    fn the_export_command_quotes_the_volume_and_hops_through_the_cluster() {
        let local = export_command("ceph-ssd:vm-120-disk-0", None);
        assert!(local.starts_with("bash -c '"));
        assert!(local.contains("pvesm export '\\''ceph-ssd:vm-120-disk-0'\\'' raw+size -"));
        assert!(local.contains("tail -c +9 | dd bs=4M iflag=fullblock status=progress"));
        // The raw-block frame goes first, octal escapes intact through the quoting.
        assert!(local.contains(r"printf '\''\050\265\057\375\140\000\017\001\200\000'\''; dd bs=4096 count=1 iflag=fullblock status=none; zstd -q -1 -T0 -c;"));

        let hop = export_command("local-lvm:vm-120-disk-0", Some(("pve-thin-4", "10.0.4.4")));
        assert!(hop.contains("-o HostKeyAlias='pve-thin-4'"));
        assert!(hop.contains("root@'10.0.4.4'"));
        assert!(hop.starts_with("if [ -f '/etc/pve/nodes/pve-thin-4/ssh_known_hosts' ]"));
    }

    #[test]
    fn the_meter_needs_a_second_of_samples() {
        let mut meter = Meter::new();
        assert_eq!(meter.rate(0), None);
        meter.samples[0].0 -= Duration::from_secs(2);
        let rate = meter.rate(2 * 1024 * 1024).unwrap();
        assert!((rate - 1024.0 * 1024.0).abs() < 50_000.0, "{rate}");
    }
}
