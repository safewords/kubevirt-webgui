# Troubleshooting

Most problems here are one of three things: RBAC, a missing cluster component,
or storage. This page is ordered by what you actually see.

- [A screen or panel is missing](#a-screen-or-panel-is-missing)
- [Something is greyed out](#something-is-greyed-out)
- [Forbidden](#forbidden)
- [Signed out unexpectedly](#signed-out-unexpectedly)
- [The socket will not open](#the-socket-will-not-open)
- [A console will not connect, or dies after a minute](#a-console-will-not-connect-or-dies-after-a-minute)
- [An upload or import fails](#an-upload-or-import-fails)
- [A VM will not start](#a-vm-will-not-start)
- [A migration will not start, or never finishes](#a-migration-will-not-start-or-never-finishes)
- [No usage figures](#no-usage-figures)
- [A task vanished](#a-task-vanished)
- [Where to look next](#where-to-look-next)

## A screen or panel is missing

It is missing because the cluster does not serve what it needs. Open
**Datacenter → Extensions**: every extension and plugin is listed with its
state and, when inactive, what is missing. **Re-scan cluster** re-reads
discovery immediately rather than waiting for the next minute.

| Missing | Cause |
|---|---|
| every VM screen | no KubeVirt (`kubevirt.io/v1`) |
| Images, uploads, disk creation | no CDI (`cdi.kubevirt.io`) |
| VM **Snapshots** tab | no `snapshot.kubevirt.io`, or KubeVirt's `Snapshot` feature gate is off |
| Disk **Snapshots** tab | no `snapshot.storage.k8s.io` (no snapshot controller) |
| **Instance Types** | no `instancetype.kubevirt.io` |
| **USB Devices** | atomic-usb is not installed |
| **Import from Proxmox** in the Create menu | `PROXMOX_ALLOWED_HOSTS` is unset on the server |

If a method is called anyway, the answer says the same thing in words:
`ExtensionUnavailable: … this cluster does not serve …`.

## Something is greyed out

The GUI asked the API server whether you may do it, with a
`SelfSubjectAccessReview`, and the answer was no. The check is the same one
`kubectl` makes:

```sh
kubectl auth can-i create virtualmachines.kubevirt.io -n prod
kubectl auth can-i put virtualmachines/start.subresources.kubevirt.io -n prod
```

Power actions need the **subresource**, not just the object: a role with
`virtualmachines` but not `virtualmachines/start` shows the VM and greys out
Start. KubeVirt's `kubevirt.io:edit` covers both.

## Forbidden

The message is the API server's own, so read it whole — it names the resource,
the verb and the user. Two that look alike but are not:

- `... is forbidden: User "system:serviceaccount:team-a:alice" cannot ...` —
  RBAC. Bind a role.
- `... is forbidden: exceeded quota ...` — a ResourceQuota. See
  [namespaces](features/namespaces.md).

If you signed in as the server identity, the user in the message is the pod's
ServiceAccount, which is bound to nothing by design.

## Signed out unexpectedly

| Cause | Sign |
|---|---|
| `APP_KEY` is not set, and the server restarted | the log warns that a temporary key was generated |
| `APP_KEY` changed | everybody is signed out at once |
| the session reached `AUTH_SESSION_TTL` | one person, at a predictable interval (8 h by default) |
| the token itself expired or was revoked | renewing fails; `kubectl create token` again |

Set a stable `APP_KEY` — see [configuration](configuration.md#application).

## The socket will not open

The server refuses a WebSocket whose `Origin` is not the host it is served
from, and logs `refused a socket from a foreign origin` with both values. That
is deliberate: it stops another site driving a signed-in browser.

When the GUI is reached through a name the server does not see (an Ingress with
a different external hostname, a proxy that rewrites `Host`), list the external
origin in `GUI_ALLOWED_ORIGINS` / `settings.allowedOrigins`.

## A console will not connect, or dies after a minute

| Symptom | Cause |
|---|---|
| refuses immediately | no `virtualmachineinstances/vnc` (or `/console`) permission, or the VM is not running |
| connects, then drops after ~60 s | an ingress controller timing the idle connection out — raise `proxy-read-timeout`/`proxy-send-timeout` |
| ticket expired | the ticket is valid for `CONSOLE_TICKET_TTL` (60 s) between being issued and used |
| noVNC shows a black screen | the guest has no graphics device (`autoattachGraphicsDevice: false`), or it genuinely is a black screen — try the serial console |

## An upload or import fails

Start with the disk's **Import Log** panel, which shows CDI's own importer
output, and `datavolume.diagnose`, which turns the common failures into an
explanation rather than a pod name.

| Message | Meaning |
|---|---|
| `Unable to process data: ... permission denied` on a Block volume | the node's containerd cannot open the device — see the node configuration note in the [installation](installation.md) requirements |
| the DataVolume sits in `Pending` | no default StorageClass, or the claim cannot be bound |
| the DataVolume sits in `UploadReady` and nothing moves | the browser cannot reach the upload proxy; check `CDI_UPLOAD_PROXY_URL` when running outside the cluster |
| `reserved block type encountered` during a Proxmox import | the CDI zstd bug this importer already works around — if it reappears, the first frame workaround is not being applied; see [importing from Proxmox](features/proxmox-import.md#how-a-disk-is-copied) |

A failed import deletes the half-made VM and its disks with background
propagation. If a name still appears taken, look for the object stuck
`Terminating` with a finalizer.

## A VM will not start

Look at the VM's **Events** panel first: the scheduler and KubeVirt both
explain themselves there.

| Cause | What you see |
|---|---|
| the disk is not ready | `ErrorPvcNotFound`, `ErrorDataVolumeNotFound`, or a DataVolume still importing |
| no node matches | `ErrorUnschedulable` with the scheduler's reason — often a node selector or affinity the VM carries from its import |
| the node has no virtualisation | nodes without `kubevirt.io/schedulable` are marked in the **Nodes** table |
| a UEFI guest with no boot entry | it boots to the firmware shell; EFI variables do not survive an import |
| a BIOS guest with no graphics device | SeaBIOS has nothing to boot from; keep the display for BIOS guests |

## A migration will not start, or never finishes

| Cause | What to do |
|---|---|
| a disk is `ReadWriteOnce` | migration needs storage that two pods can hold at once; the Migrate dialog says which volume blocks it |
| the target node's CPU differs | a `host-model` VM can only land on the same host CPU; pick a common model under **Hardware → Processors** |
| the guest dirties memory faster than the link carries it | the progress panel says so; the transfer cannot converge until the guest quietens or the link improves |
| no figures at all | the progress figures come from virt-handler through the API server's pod proxy, which needs `get pods/proxy` in KubeVirt's namespace — migration still works without it |

## No usage figures

CPU and memory graphs come from metrics-server (`metrics.k8s.io`). Without it
the panels show no data and everything else works.

## A task vanished

Tasks live in the server's memory. A restart — a rollout, a crash, a scale to
two replicas where the browser reconnects to the other one — loses the log, not
the work: whatever the task created in Kubernetes carries on. Look at the
object's **Events** panel, or the disk's **Import Log**, for what happened
after that point.

## Where to look next

```sh
kubectl -n kubevirt-webgui logs deploy/kubevirt-webgui -f
kubectl -n kubevirt-webgui set env deploy/kubevirt-webgui RUST_LOG=info,kubevirt_webgui=debug
```

`debug` logs every gateway call with its method and how long it took, which is
usually enough to tell "the GUI never asked" from "the cluster said no".
