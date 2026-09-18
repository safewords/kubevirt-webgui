# kubevirt-webgui

[![CI](https://github.com/safewords/kubevirt-webgui/actions/workflows/ci.yml/badge.svg)](https://github.com/safewords/kubevirt-webgui/actions/workflows/ci.yml)
[![Release](https://github.com/safewords/kubevirt-webgui/actions/workflows/release.yml/badge.svg)](https://github.com/safewords/kubevirt-webgui/actions/workflows/release.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](#license)

An extensible, Proxmox-inspired web interface for **KubeVirt** — libvirt/QEMU
virtual machines running on Kubernetes.

- **Rust backend** on [rainier-framework](https://github.com/safewords/rainier-framework), talking to the Kubernetes API with [kube-rs](https://kube.rs).
- **Vue 3 + Tailwind CSS + Font Awesome** frontend, with noVNC and xterm.js consoles.
- **Every action travels over a WebSocket.** No REST API for the browser: calls, live watches, task logs, metrics, consoles and uploads all use sockets.
- **Cluster authentication.** Users sign in with their own Kubernetes credentials; the server holds no privileges, and Kubernetes RBAC decides what each person can see and do.
- **Extensible on both ends.** Server extensions add gateway methods; browser plugins add screens, toolbar actions, tree views and create-menu entries — built-in or loaded at runtime.

---

![The datacenter summary: cluster health, resources and every node](docs/images/datacenter.png)

## Documentation

Everything below is a summary. The [documentation](docs/) is the long form.

| | |
|---|---|
| [Installation](docs/installation.md) | what the cluster needs, Helm, plain manifests, Ingress |
| [Authentication and permissions](docs/authentication.md) | signing in, tickets, RBAC, handing out access |
| [Configuration](docs/configuration.md) | every environment variable, and the chart value that sets it |
| [Virtual machines](docs/features/virtual-machines.md) · [Storage](docs/features/storage.md) · [Networking](docs/features/networking.md) | the screens, panel by panel |
| [Datacenter](docs/features/datacenter.md) · [Nodes](docs/features/nodes.md) · [Namespaces](docs/features/namespaces.md) | the cluster screens |
| [USB devices](docs/features/usb.md) · [Proxmox import](docs/features/proxmox-import.md) · [Tasks](docs/features/tasks.md) | the rest |
| [Gateway protocol](docs/extending/gateway-protocol.md) · [Server extensions](docs/extending/server-extensions.md) · [Browser plugins](docs/extending/browser-plugins.md) | extending it |
| [Architecture](docs/architecture.md) · [Development](docs/development.md) · [Troubleshooting](docs/troubleshooting.md) | how it works and how to work on it |


## Proxmox → KubeVirt

The layout follows Proxmox VE: a resource tree on the left, the selected object's panels in the middle, the task log along the bottom.

| Proxmox VE | Here | Kubernetes / KubeVirt underneath |
|---|---|---|
| Datacenter | Datacenter | the cluster |
| Node | Node | `Node` (+ `kubevirt.io/schedulable`, CPU model labels) |
| VM (qemu) | Virtual Machine | `VirtualMachine` + `VirtualMachineInstance` |
| Resource pool | Namespace | `Namespace`, `ResourceQuota`, `RoleBinding` |
| Start / Shutdown / Stop / Reboot / Reset / Pause / Resume | same | `virtualmachines/{start,stop,restart}`, `virtualmachineinstances/{softreboot,reset,pause,unpause}` |
| Console (noVNC / xterm.js) | same | `virtualmachineinstances/{vnc,console}` proxied over WebSocket |
| Migrate | Migrate (live) | `VirtualMachineInstanceMigration` |
| Snapshots / Rollback | Snapshots / Restore | `VirtualMachineSnapshot`, `VirtualMachineRestore` |
| Clone | Clone | `VirtualMachineClone` |
| Hardware / Options / Cloud-Init | same | `spec.template.spec`, `cloudInitNoCloud` |
| Storage content: ISO images, templates | Images | CDI `DataVolume`s, `DataSource`s |
| Upload / Download from URL | same | CDI upload proxy / http importer |
| Task log (UPID) | Task log (UPID) | tracked by the server, streamed live |
| Cluster log | Cluster log | Kubernetes `Event`s |
| Maintenance mode | Cordon / Drain | node cordon + live-migrate every guest |
| Permissions, API tokens | Permissions, API tokens | RBAC, `ServiceAccount` `TokenRequest` |
| Firewall | Firewall | `NetworkPolicy` |
| USB passthrough | USB devices | [atomic-usb](https://github.com/safewords/kubevirt-atomic-usb) (plugin) |

## Architecture

```mermaid
flowchart LR
    subgraph browser["Browser"]
        ui["Vue app<br/>plugins · stores"]
        vnc["noVNC / xterm.js"]
        up["file upload"]
    end
    subgraph server["kubevirt-webgui (Rust, rainier)"]
        gw["/ws gateway<br/>methods · topics · tasks"]
        cp["/ws/console/{ticket}"]
        uw["/ws/upload/{ticket}"]
        reg["extension registry"]
    end
    subgraph k8s["Kubernetes API (as the user)"]
        api["core · kubevirt.io · cdi"]
        virt["virt-api subresources<br/>vnc · console"]
        cdi["cdi-uploadproxy"]
    end
    ui <-->|JSON frames| gw
    vnc <-->|bytes| cp
    up -->|chunks + acks| uw
    gw --- reg
    gw -->|user's token| api
    cp -->|plain.kubevirt.io| virt
    uw --> cdi
```

### The gateway protocol

One socket, JSON frames:

```jsonc
// a call: one answer
→ { "id": "7", "op": "call", "method": "vm.start", "params": { "namespace": "prod", "name": "db" } }
← { "id": "7", "op": "result", "result": { "task": "UPID:alice:18A…:vm.start:prod/db" } }

// a subscription: events until unsubscribed
→ { "id": "8", "op": "subscribe", "topic": "watch", "params": { "apiVersion": "kubevirt.io/v1", "resource": "virtualmachines" } }
← { "id": "8", "op": "event", "data": { "type": "SYNC", "items": [ … ] } }
← { "id": "8", "op": "event", "data": { "type": "MODIFIED", "object": { … } } }
→ { "id": "8", "op": "unsubscribe" }
← { "id": "8", "op": "end" }
```

Calls run concurrently, so a slow migration never blocks the reads sent after it. The browser client reconnects on its own, resumes the session from its ticket, and re-establishes every subscription.

Long operations return a **task** straight away. The task records each step (`VMI phase: Scheduling`, `migration phase: Running → pve-thin-5`, …) and streams to every browser the user has open, exactly like Proxmox's task viewer.

Consoles use Proxmox's two-step pattern: `console.ticket` over the authenticated gateway returns a one-time ticket (valid for 60 s), and `/ws/console/{ticket}` becomes a raw byte pipe to KubeVirt's `vnc` or `console` subresource, opened with the user's credential.

### Authentication

There is no user database. The login form accepts a **Kubernetes bearer token** — a ServiceAccount token or an OIDC ID token. The server asks the API server who it belongs to (`SelfSubjectReview`) and, from then on, makes every request **with that token**. The browser keeps a ticket (the credential and identity, encrypted with `APP_KEY`), not the token.

Consequences:

- RBAC applies exactly as it would with `kubectl`. A user bound to `kubevirt.io:edit` in one namespace sees and manages that namespace only.
- The GUI greys out actions RBAC would refuse, using batched `SelfSubjectAccessReview`s.
- Deployed in a cluster, the server's own ServiceAccount is bound to **nothing**.
- `AUTH_ALLOW_SERVER_IDENTITY=true` adds "sign in as the server's kubeconfig identity" for a single-user desktop install. Never enable it on a shared deployment.

Tokens for people:

```sh
kubectl create serviceaccount alice -n team-a
kubectl create rolebinding alice-vms -n team-a --clusterrole=kubevirt.io:admin --serviceaccount=team-a:alice
kubectl create token alice -n team-a --duration=8h
```

The Datacenter → Permissions → API Tokens screen does the same from the GUI.

## Disk images: ISOs, VMDKs and other formats

Every disk is a **PersistentVolumeClaim**, filled by CDI (the Containerized Data Importer) through a **DataVolume**:

| You have | DataVolume `source` | What CDI does |
|---|---|---|
| A URL to a `.qcow2`, `.raw`, `.img`, `.vmdk`, `.vdi`, `.vhd(x)` (optionally `.gz`/`.xz`) | `http: { url }` | An importer pod downloads it **inside the cluster** and converts it with `qemu-img` to a raw disk on the PVC. VMDKs need no separate conversion step. |
| A URL to an `.iso` | `http: { url }` | Stored as the PVC's disk image. Attach it to a VM as a `cdrom` (bus `sata`). |
| A file on your machine | `upload: {}` | The browser streams it over `/ws/upload/{ticket}` with acknowledgements; the server forwards it to `cdi-uploadproxy` with a CDI upload token. Converted as above. |
| A container image (`quay.io/containerdisks/…`) | `registry: { url }` | Pulled and written to the PVC. Or use it directly as an ephemeral `containerDisk`. |
| An existing disk or golden image | `pvc: { … }` / `sourceRef` → `DataSource` | Cloned — on Ceph RBD this is a copy-on-write CSI clone and nearly instant. |
| A VM on VMware | `vddk: { … }` | Reads the VMDK straight from vSphere; for bulk moves use Forklift / MTV. |
| A VM on Proxmox VE | `upload: {}` | **Create → Import from Proxmox**: the server reads the disks over SSH and streams them in — see below. |

The **Images** screen is the ISO and template library, like a Proxmox storage's ISO Images and CT Templates content:

- **Download from URL** creates a labelled DataVolume and shows the import progress.
- **Upload** streams a local file over the WebSocket.
- The **Create VM** wizard boots from an ISO by cloning the ISO's PVC into a per-VM CD-ROM disk next to a blank root disk. Each VM gets its own copy because RBD volumes are `ReadWriteOnce`; with CSI cloning that copy costs nothing.

Storage defaults come from the `StorageProfile` for the chosen StorageClass (on `ceph-rbd`: `Block` volume mode, `ReadWriteMany` when possible so VMs can live-migrate).

## Importing from Proxmox VE

**Create → Import from Proxmox** copies a stopped Proxmox VM — settings and
disks — into a KubeVirt VM. It connects over SSH from the server, shows the
host key fingerprint before any credential is sent, maps the configuration for
you to review, and streams each disk straight into CDI's upload proxy: no
temporary files on either side, and nothing on the Proxmox host is changed.

While it copies it re-checks the source every 20 seconds on a second
connection, and stops if the VM is started on Proxmox mid-copy — a disk that
changes while it is read is not a copy. A failed import cleans up after itself.

Importing is off until an administrator lists the hosts the server may reach in
`PROXMOX_ALLOWED_HOSTS`.

The details — what is mapped, what stays behind, the shell pipeline each disk
travels through and the CDI zstd bug it works around — are in
[importing from Proxmox VE](docs/features/proxmox-import.md).

## Optional integrations

Only Kubernetes itself is assumed. Everything else is detected through API discovery and switched on or off **while the GUI is running**:

| Integration | Detected by | Without it |
|---|---|---|
| KubeVirt | `kubevirt.io/v1` | nodes, namespaces and disks still work; no VM screens |
| CDI | `cdi.kubevirt.io` | disks are plain PVCs; no import, upload or image library |
| VM snapshots, restores | `snapshot.kubevirt.io` | no Snapshots tab |
| VM clones | `clone.kubevirt.io` | no Clone action |
| Instance types / preferences | `instancetype.kubevirt.io` | manual CPU and memory only |
| CSI volume snapshots | `snapshot.storage.k8s.io` | disk snapshot screens hidden, with a note on the VM Snapshots tab |
| metrics-server | `metrics.k8s.io` | usage graphs show "no data" |
| Multus | `k8s.cni.cncf.io` | pod network only |
| [atomic-usb](https://github.com/safewords/kubevirt-atomic-usb) | `atomicusb.safewords.io` | no USB panels, tree view or attach action |

- **In the browser:** discovery is re-read every minute. A plugin whose required APIs appear is set up at once; one whose APIs disappear has its panels, actions and tree views withdrawn and its `teardown()` called — no reload. Datacenter → Extensions shows each one's state and has a **Re-scan cluster** button.
- **On the server:** a method belonging to an extension whose APIs the cluster does not serve answers `ExtensionUnavailable` ("atomic-usb is not available: this cluster does not serve atomicusb.safewords.io/v1alpha1/usbdeviceclaims") instead of an opaque 404. The server rescans discovery before refusing, so a CRD installed a moment ago is picked up.

For atomic-usb specifically, the VM's USB panel offers to enable `devices.clientPassthrough`, which atomic-usb needs, and warns when the running instance predates it.

### Live migration and CPU models

A VM started with the default `host-model` CPU can only migrate to a node with the **same host CPU**. The Migrate dialog marks nodes with a different host CPU and suggests models every node supports. A migration that cannot be placed reports the scheduler's reason in the task log within seconds; KubeVirt itself only fails it after five minutes. On a mixed cluster, give the VM a common CPU model — Hardware → Processors — the way you would pick a common CPU type in Proxmox.

A running migration shows its **live transfer**:

- memory sent and remaining
- the transfer rate
- how fast the guest is dirtying memory, with a warning when the guest dirties memory faster than it can be sent

It appears on the VM's Migrations tab, under Datacenter → Migrations and as a progress bar on the migrate task. The figures are what virt-handler samples from libvirt every five seconds, read through the API server's pod proxy as the signed-in user. They need `get pods/proxy` in KubeVirt's namespace; without that permission migrations still work, just without figures.

## Extending it

### A server extension

```rust
pub struct Backups;

impl Extension for Backups {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "backups".into(),
            name: "Backups".into(),
            version: "1.0.0".into(),
            description: "Scheduled VM backups.".into(),
            requires: vec!["backup.kubevirt.io/v1alpha1/virtualmachinebackups".into()],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.method("backup.now", |ctx, params| async move {
            let kube = ctx.kube()?; // acts as the signed-in user
            ctx.task("backup.now", target, "Back up db", move |task| async move {
                task.log("snapshotting…");
                Ok(Some("backup complete".into()))
            })
        });
        r.topic("backup.progress", |ctx, params, sink| async move { /* sink.emit(json) */ Ok(()) });
    }
}
```

Add it to `extensions::builtin()`. The `hello` frame lists every extension, and the browser shows them under Datacenter → Extensions. `GUI_DISABLED_EXTENSIONS=backups` switches one off.

Many plugins need no server code at all: the generic `resource.list/get/create/replace/patch/delete/subresource` methods and the `watch` topic reach any resource, with the user's RBAC.

### A browser plugin

```ts
export default definePlugin({
  id: 'backups',
  name: 'Backups',
  requires: ['backup.kubevirt.io/v1alpha1/virtualmachinebackups'], // skipped if the cluster lacks it
  setup(api) {
    api.panel({ id: 'backups', kind: 'vm', title: 'Backup', icon: faBoxArchive, component: BackupPanel })
    api.action({ id: 'backup-now', kind: 'vm', group: 'more', title: 'Back up now', icon: faBoxArchive,
                 access: (ctx) => ({ verb: 'create', group: 'backup.kubevirt.io', resource: 'virtualmachinebackups', namespace: ctx.namespace }),
                 run: (ctx) => gateway.call('backup.now', { namespace: ctx.namespace, name: ctx.name }) })
    api.treeView({ id: 'backups', title: 'Backup View', build: () => [ /* TreeNode[] */ ] })
    api.createItem({ id: 'backup-job', title: 'Backup job', icon: faClock, run: () => openDialog(NewJob) })
    api.kind({ id: 'backupjob', title: 'Backup job', icon: faClock, scope: 'namespaced', resource: … })
  },
})
```

The built-in screens are plugins registered through this same API (`web/src/plugins/core`, `web/src/plugins/atomic-usb`), so a plugin can do anything they do.

**Runtime plugins** need no rebuild. Point `GUI_PLUGIN_DIR` at a directory of ES modules, or list URLs in `GUI_PLUGIN_URLS`. They receive Vue and the API from `window.KubeVirtGui` so they share the app's reactivity and socket — see [`examples/plugins/ssh-helper.js`](examples/plugins/ssh-helper.js).

## Running it

### Development

```sh
# backend against your kubeconfig context
cp .env.example .env            # set KUBE_CONTEXT, optionally AUTH_ALLOW_SERVER_IDENTITY=true
cargo run                       # serves on SERVER_PORT (8006)

# frontend with hot reload, proxying /ws to the backend
cd web && npm install && npm run dev      # http://127.0.0.1:5173
```

To develop the frontend against the **in-cluster** deployment instead:

```sh
kubectl -n kubevirt-webgui port-forward svc/kubevirt-webgui 18006:8006
cd web && KVE_BACKEND=http://127.0.0.1:18006 npm run dev
kubectl -n <namespace> create token <serviceaccount> --duration=8h   # sign in with this
```

### Testing

```sh
cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
cd web && npm run typecheck && npm run build
```

CI runs exactly those on every push and pull request.

The end-to-end suites in [`web/e2e/`](web/e2e) drive the real GUI with
playwright-core against a **real cluster** — creating VMs, uploading disks,
migrating, snapshotting, importing from Proxmox — and check the outcome through
the gateway. They are not run in CI, because no hosted runner has KubeVirt and
CDI on it.

```sh
cd web && E2E_BASE=http://127.0.0.1:5173 npm run e2e
```

Each suite works in its own `kve-e2e-*` namespace and deletes it afterwards.
The ones that touch shared resources refuse to disturb anything they did not
create: drain skips a node running other VMs, the USB suite refuses a device
already claimed, and the Proxmox suite creates and destroys its own throwaway
source VM. See [development](docs/development.md#the-e2e-suite).

### Deploying

```sh
helm install kubevirt-webgui oci://ghcr.io/safewords/charts/kubevirt-webgui   --namespace kubevirt-webgui --create-namespace   --set ingress.enabled=true --set ingress.hosts[0].host=virt.example.com
```

Images are published for amd64 and arm64 at
`ghcr.io/safewords/kubevirt-webgui`, and the chart both as an OCI artifact and
as a Helm repository on the `gh-pages` branch. `deploy/kubevirt-webgui.yaml` is
the same deployment without Helm.

Full instructions, including what the cluster needs and the WebSocket timeouts
an ingress controller needs raised, are in
[installation](docs/installation.md).

### Configuration

Everything is an environment variable, and the chart is a thin wrapper over
them. The ones worth knowing before the first run:

| Variable | Default | |
|---|---|---|
| `APP_KEY` | random per boot | seals sign-in tickets; set it so sessions survive restarts |
| `AUTH_ALLOW_SERVER_IDENTITY` | `false` | offer signing in as the server's own identity — single-user installs only |
| `KUBE_CONTEXT` | in-cluster, then current context | which cluster to manage |
| `GUI_ALLOWED_ORIGINS` | same host | origins allowed to open sockets, when the public hostname differs |
| `PROXMOX_ALLOWED_HOSTS` | — (import off) | Proxmox VE hosts the importer may reach |
| `GUI_PLUGIN_DIR`, `GUI_PLUGIN_URLS` | — | runtime plugins |

The complete list, with defaults and the chart value that sets each one, is in
[configuration](docs/configuration.md).

## Security notes

- Sockets check `Origin` against the serving host, so another site cannot drive a signed-in browser.
- Every API path is built from validated segments; a name containing `/`, `?` or `..` is rejected before any request is made.
- Console and upload tickets are random 256-bit values, single-use and short-lived, and carry the user's own client.
- The browser stores an encrypted ticket, never the raw token; tickets expire (`AUTH_SESSION_TTL`) and renewal re-validates the token with the API server.
- The Proxmox importer connects only to `PROXMOX_ALLOWED_HOSTS`, to the address it checked (no DNS rebinding in between), pins the SSH host key the person confirmed, and keeps credentials in memory only, bound to the person who entered them.
- Responses carry a strict Content-Security-Policy (`script-src 'self'`); runtime plugins must be served from the same origin (`GUI_PLUGIN_DIR`).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project by you, as defined in the Apache-2.0 license,
shall be dual licensed as above, without any additional terms or conditions.
