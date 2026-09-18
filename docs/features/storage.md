# Storage, disks and images

Every disk here is a PersistentVolumeClaim, and nearly every one of them was
created and filled by a CDI DataVolume — from a URL, a container registry,
another claim, a snapshot, or a file in your browser. The Disk screen shows
both halves: the claim that a VM attaches, and the DataVolume that populated
it. Nothing in this GUI writes image bytes to disk itself.

- [Storage classes and profiles](#storage-classes-and-profiles)
- [Images](#images)
- [Uploading a disk](#uploading-a-disk)
- [Creating and attaching disks](#creating-and-attaching-disks)
- [Resizing, cloning and removing](#resizing-cloning-and-removing)
- [Disk snapshots and restore](#disk-snapshots-and-restore)
- [When an import goes wrong](#when-an-import-goes-wrong)
- [What needs which cluster feature](#what-needs-which-cluster-feature)

## Storage classes and profiles

**Datacenter → Storage** is three tables: the cluster's StorageClasses, CDI's
StorageProfiles, and the VolumeSnapshotClasses. It is read-only; double-click
any row for the object's YAML.

| Column | Where it comes from | Why it matters |
|---|---|---|
| **Default** | `storageclass.kubernetes.io/is-default-class`, or `VMs` for `storageclass.kubevirt.io/is-default-virt-class` | what a disk gets when no class is named |
| **Binding** | `volumeBindingMode`, `Immediate` when unset | `WaitForFirstConsumer` leaves a new disk unfilled until a VM uses it |
| **Reclaim** | `reclaimPolicy`, `Delete` when unset | whether removing a disk destroys the volume |
| **Expandable** | `allowVolumeExpansion` | `no` disables **Resize** entirely |
| **Claims** / **Provisioned** | the claims you can see | not a cluster total — it counts only what RBAC lets you list |

The StorageProfile is the more consequential table. CDI keeps one profile per
storage class, and a DataVolume that does not name an access mode or a volume
mode gets them from there. The **Volume modes / access modes** column shows
each `claimPropertySet`; the first is what CDI will use. A profile with
nothing in it shows **not configured**, and that is the thing to fix: CDI then
falls back to whatever the provisioner defaults to, which is usually
`Filesystem` and `ReadWriteOnce`.

`ReadWriteOnce` can only be attached on one node, and live migration needs the
claim mounted on the source and the target at the same time — so a VM whose
disks are RWO cannot migrate, and KubeVirt refuses at the first non-migratable
volume rather than half-way through. `ReadWriteMany` is what makes migration
possible. The storage-class picker says so: under the select it prints the CDI
profile as, for example, `Block · ReadWriteMany (live-migratable)`, and the
VM wizard's per-disk **Access mode** row offers `storage profile default`,
`ReadWriteMany` and `ReadWriteOnce` with the same note. See
[virtual machines](virtual-machines.md) for migration itself.

**Clone strategy** on the profile decides how [cloning](#resizing-cloning-and-removing)
is done — a CSI or snapshot clone where the driver supports it, a host-assisted
copy otherwise — and **Snapshot class** is the VolumeSnapshotClass CDI will use
for that storage.

## Images

**Datacenter → Images** is the ISO and template library. There is no separate
image store: an image is an ordinary DataVolume labelled
`kubevirt-webgui/image-type` with `iso` or `disk`, so everything on the Disk
screen applies to it, and anything labelled by hand appears here too.

The library namespace defaults to `kubevirt-images` and is remembered per
browser, not per cluster — it is a preference, not configuration. If the
namespace does not exist the panel says so and offers **Create it** when you
may create namespaces. Images are deliberately kept in one namespace and
cloned from there, so a VM in another namespace gets its own copy and the
library can be tidied without touching VMs built from it.

| Button | What it does |
|---|---|
| **Download from URL** | a DataVolume with an `http` source. CDI fetches it inside the cluster; nothing passes through your browser. |
| **Upload** | a DataVolume with an `upload` source, filled over this GUI's socket — see [uploading a disk](#uploading-a-disk). |
| **Create VM** (per row) | opens the VM wizard with the image preset: an ISO as the boot medium, a disk image as the thing to clone. Enabled only once the row reads `Succeeded`. |
| **Remove** (per row) | deletes the DataVolume and its claim, after typing the name. VMs made from it keep their own copies, and the dialog lists them. |

CDI converts as it imports: qcow2, raw, VMDK and VHD/VHDX, each optionally
`xz`- or `gzip`-compressed, all end up as a raw image in the claim. The dialog
guesses the format from the name and says what will happen (`VMware VMDK —
CDI converts it to raw with qemu-img`). OVA archives are not imported
directly; extract the VMDK and import that.

The size you give is the claim, not the file. A compressed or qcow2 image
expands, so size it for the image's virtual disk — the dialog warns when the
name suggests one of those. Getting this wrong fails late, in the importer,
with `no space left on device`.

### DataSources and golden images

Below the library, **Golden images** lists CDI DataSources and any
DataImportCrons keeping them current. A DataSource is a named pointer to a PVC
or a VolumeSnapshot; a DataVolume references it with `sourceRef` instead of
naming a claim, so a VM template does not hard-code today's image. A
DataImportCron re-imports on its **Schedule**, repoints the DataSource at the
new copy and keeps the last few (**Keep**, `importsToKeep`, 3 by default). The
**Up to date** column is the cron's `UpToDate` condition. This GUI shows them
and can create a VM from a DataSource; it does not create the crons.

## Uploading a disk

An upload is the one case where the image bytes are in the browser, so they
travel over a socket instead of being fetched in the cluster. The browser never
talks to CDI directly.

```text
browser → upload.begin { namespace, name, size, … }   (the gateway socket)
server  ← { task, ticket, path: "/ws/upload/<ticket>" }
browser → opens /ws/upload/<ticket>
server  → {"status":"preparing"}         while CDI starts its upload server
server  → {"ready":true,"chunkSize":N}   once the upstream request is open
browser → <binary chunk>                  then waits for…
server  → {"ack":<bytes so far>}          …before sending the next chunk
server  → {"done":true}                   after the last byte is accepted
server  → {"error":"…"}                   on any failure, then closes
```

`upload.begin` creates the DataVolume with an `upload` source, starts a
`disk.upload` task and issues a ticket: 32 random bytes, single-use, valid for
two minutes. It travels in a URL, which is why it is short-lived and why
redeeming it removes it.

The ack after every chunk is the backpressure. A browser reads a local file far
faster than Ceph can write it, so without it a multi-gigabyte ISO would be
buffered somewhere; with it, memory stays flat and the browser advances only as
fast as the storage does. Chunks are 4 MiB. The server streams them straight
into one `POST /v1beta1/upload-async` request to CDI's upload proxy, with the
declared size as `Content-Length`.

Reaching that proxy is the fiddly part. Its token is read from the
`Authorization` header, which the API server strips when it proxies a service,
so the proxy has to be reached directly: at `CDI_UPLOAD_PROXY_URL`, at
`https://cdi-uploadproxy.<CDI_NAMESPACE>.svc:443` when the server runs in the
cluster, or — running outside one — through a port-forward to the proxy pod,
made as the signed-in user. That last route needs permission to port-forward in
CDI's namespace; without it the error says so and names
`CDI_UPLOAD_PROXY_URL` as the way out. The proxy's certificate is verified
against CDI's own `cdi-uploadproxy-signer-bundle` when that ConfigMap is
readable, and otherwise accepted unverified, which the task log records as
`(certificate not verified: CDI's CA was not readable)`. Set
`CDI_UPLOAD_PROXY_VERIFY=strict` to refuse instead. All of these are in
[configuration](../configuration.md#uploads-and-cdi).

The DataVolume is annotated
`cdi.kubevirt.io/storage.bind.immediate.requested: "true"`. Without it, a
storage class that binds on first consumer would leave the claim waiting for a
VM, and there would be nothing to upload into.

**When it goes wrong.** Every failure ends the upstream request with an error
rather than closing it cleanly, so CDI sees a broken upload and not a truncated
image:

| Situation | What happens |
|---|---|
| The browser closes or the tab is shut | the upload fails with `the browser closed the upload before it finished`; the page also asks before unloading while one is running |
| **Cancel** | the socket closes and `tasks.stop` stops the task. The DataVolume is left behind deliberately — remove it from the Images or Disk screen |
| More bytes arrive than were declared | refused with `more data than the declared size` |
| CDI never becomes ready | the task gives up after 15 minutes |
| The socket opens but no bytes follow | the task gives up after 10 minutes |
| CDI rejects the image | the upload proxy's status and body are reported verbatim |

Progress is listed under **Uploads from this browser** on the Images panel, not
in the dialog — closing the dialog does not stop an upload. The states read
`Starting…`, `Waiting for CDI to prepare the disk…`, `Uploading`, `Received;
CDI is writing the image…`, then `Done`. That second-to-last state is real
work: every byte has arrived, and CDI is still converting and writing.

**Sizes.** An empty file is refused outright. The dialog refuses a disk smaller
than the file, and suggests the file's size plus a tenth rounded up to whole
GiB — the same formula the server uses when the browser sends no size. There is
no cap on the file; the ceiling is the 4-hour timeout on CDI processing the
image afterwards. Uploads do not pass through `SERVER_MAX_BODY`, which applies
to ordinary HTTP bodies only.

## Creating and attaching disks

**Create → Create Disk** builds a DataVolume through `datavolume.create`,
which creates it and then follows it in a `disk.create` task until it settles.
The sources are:

| Source | Becomes | Notes |
|---|---|---|
| **Empty disk** | `source: { blank: {} }` | zeroed, ready to partition |
| **Import from a URL** | `source: { http: { url } }` | qcow2, raw, VMDK, VHD/VHDX, ISO; xz/gz |
| **Import from a container registry** | `source: { registry: { url } }` | a container disk — an image with the disk under `/disk`. `docker://` is added if you leave it off |
| **Clone an existing disk** | `source: { pvc: { namespace, name } }` | cloning across namespaces needs permission to clone from the source |
| **Upload a file from this computer** | `source: { upload: {} }` | takes the socket route above |

Every one of them can also be labelled for the image library from the same
dialog, with **Image library**. The name must be a DNS label and unique in the
namespace; the dialog checks both before enabling the button.

On a storage class that binds on first consumer, a new disk stops at
`WaitForFirstConsumer` or `PendingPopulation` and the task finishes saying
`disk will be filled when a VM uses it`. That is not a failure — CDI is waiting
to learn which node will run the VM, so it can provision the volume there.

**Attach to VM** on a disk behaves differently depending on the VM:

- **The VM is stopped.** The volume and its disk device are written into the VM
  definition with a merge patch that carries the VM's `resourceVersion`, so a
  concurrent edit makes the patch fail rather than silently overwrite. You
  choose the bus — VirtIO, SCSI or SATA — and may tick **Attach as CD/DVD
  drive (for ISO images)**, which turns a VirtIO choice into SATA, because
  VirtIO has no CD-ROM.
- **The VM is running.** The disk is hot-plugged through `vm.volume.add`,
  which calls KubeVirt's `addvolume` subresource and then writes the volume
  into the VM definition with `hotpluggable: true`, as `virtctl addvolume
  --persist` does. The bus is forced to SCSI; the bus select is disabled and
  the CD/DVD option is hidden, because hotplug only works on the SCSI bus.

The guest sees a new SCSI device appear without a reboot. KubeVirt reports it
in the VMI's `status.volumeStatus` with `hotplugVolume` set and `target` naming
the device once it reaches `Ready`; the VM's **Hardware** panel marks the row
**hot-plugged**. Because the volume is persisted, the disk is still there after
a restart. Unplugging is done from that same **Hardware** panel — it calls
`vm.volume.remove`, which detaches from the running guest and removes the
volume from the definition, leaving the disk itself alone.

Hotplug needs KubeVirt's `HotplugVolumes` feature gate. Without it the
`addvolume` call is rejected and the task reports the error.

One warning is worth reading rather than clicking past: if the claim is already
used by another VM and is not `ReadWriteMany`, two VMs cannot run with it at
the same time. Attaching anyway is allowed — it is the second VM's start that
will fail.

## Resizing, cloning and removing

**Resize** patches the claim's `spec.resources.requests.storage`. Before it
offers anything it reads the storage class and checks `allowVolumeExpansion`;
if that is false the dialog says **Cannot be resized** and the button stays
disabled, because the patch would be accepted and then ignored. Claims only
grow — a smaller target is refused — and the request is rounded up to a whole
MiB. A running guest sees the new size straight away only with KubeVirt's
`ExpandDisks` feature gate; otherwise after a restart. Either way the partition
table and filesystem inside the guest are yours to grow afterwards.

**Clone** creates a new DataVolume with a `pvc` source and follows it in a
task. The target may go in another namespace and on another storage class, and
must be at least as large as the source. When the target keeps the source's
storage class, the source's volume mode is carried over too; when it does not,
the mode is left to the new class's storage profile. CDI uses a CSI clone when
source and target share a storage class that supports it — fast and
copy-on-write on Ceph RBD — and a host-assisted copy otherwise, which is why
the same clone can take seconds or many minutes. The new disk is annotated
`kubevirt-webgui/cloned-from`.

Cloning a disk a VM is actively writing to gives a crash-consistent copy at
best. The dialog names the running VMs and suggests stopping or snapshotting
first; it does not stop you.

**Remove** deletes the DataVolume and then the claim — deleting the DataVolume
usually takes the claim with it, so a 404 on the second delete is expected and
ignored. It asks you to type the disk's name, and it tells you who is still
using it: a running VM keeps the volume until it stops and will not start again
without it, and a stopped VM will not start until the disk is removed from its
definition.

## Disk snapshots and restore

The **Snapshots** panel on a disk creates plain CSI VolumeSnapshots of that one
claim. It has nothing to do with KubeVirt's VM snapshots, which capture the
whole VM and its memory state and need KubeVirt's own `Snapshot` feature gate;
these need only the external-snapshotter CRDs. The panel hides itself when the
cluster does not serve `snapshot.storage.k8s.io`.

Take one by naming it and pressing **Take snapshot**. The **Snapshot class**
select defaults to `default`, which means no `volumeSnapshotClassName` is set
at all and the snapshot controller fills in the cluster's default class. If
there is no default and you do not choose one, the VolumeSnapshot is created
and never becomes ready; the **Ready** column stays `no` and the error is on
the row's tooltip. **Datacenter → Storage** lists the classes and marks the
default, and says plainly when there is none.

A snapshot of a running guest is crash-consistent: the CSI driver knows nothing
about what the guest has in flight. The confirmation says to freeze the guest's
filesystems first, or use a VM snapshot, which does that through the guest
agent.

**Restore to new disk** never touches the original. It creates a DataVolume
named `<disk>-from-<snapshot>` (truncated to 63 characters) with a `snapshot`
source, sized at the larger of the snapshot's `restoreSize` and the current
disk, keeping the source's storage class and volume mode, and opens its task
log. To put the old contents back where they were, restore into a new disk,
stop the VM, and swap the disks over in its definition.

Deleting a snapshot is subject to the VolumeSnapshotClass's **Deletion
policy**, shown on the Storage screen: `Delete` destroys the underlying
snapshot on the storage, `Retain` leaves it behind.

## When an import goes wrong

CDI retries a failing importer, upload server or clone pod forever, and the
DataVolume only reports a restart count. A disk that sits in
`ImportInProgress` for an hour is usually a pod dying every minute, and the
reason is in the pod's termination message, which nothing surfaces by default.

Two screens do surface it.

**The Summary panel** shows a red notice as soon as the DataVolume has a
restart, or its `Running` condition is false with `Error`,
`CrashLoopBackOff`, `ImagePullBackOff` or `ErrImagePull`. It calls
`datavolume.diagnose` and repeats every 15 seconds, and prints the error, the
pod, the node it ran on, and a hint when the error is one of the familiar ones.
`datavolume.diagnose` finds the worker by looking for pods labelled
`app=containerized-data-importer` that mount the target claim, its `-scratch`
claim, or the `prime-<uid>` claims CDI's populators use, and reads the
termination message from the container's last or current state. If reading
pods is forbidden the notice quietly falls back to the restart count.

The message is reduced before it is shown. Termination messages are klog
output — a prefix like `E0916 23:43:59.213251 1 importer.go:138]`, the error,
then a Go stack trace. Only the error lines survive, the klog prefix is
stripped, the stack frames are dropped, and the result is capped at 400
characters. `blockdev: cannot open /dev/cdi-block-volume: Permission denied`
buried in eight lines of `kubevirt.io/containerized-data-importer/pkg/…`
becomes one line.

| Error | The hint |
|---|---|
| `cdi-block-volume` and `Permission denied` | the node cannot give unprivileged pods access to block volumes: enable `device_ownership_from_security_context` in its container runtime (containerd or CRI-O), or keep CDI workloads and VMs with block disks off that node |
| `no space left on device` | the claim is smaller than the image once expanded; recreate the disk larger |
| `404` or `Not Found` | the source URL answered 404; check the address |

That first one is worth knowing about before you meet it. The importer runs
unprivileged and opens the block device as a non-root user; a container runtime
that does not set `device_ownership_from_security_context` leaves the device
owned by root, and every import to a block volume on that node fails the same
way while imports on other nodes succeed.

**The Import Log panel** shows the CDI worker pod's own output — the importer,
the upload server or the clone pod — 1000 lines at a time, refreshed every four
seconds while the DataVolume is still working, with **Following** to stop that.
When several workers have run it offers a list; when the import has finished it
says the pod is gone, because CDI removes it. A claim that was not created by a
DataVolume has no import to follow, and the panel says that instead.

Tasks give up where the screens do not. `datavolume.create` and the upload task
follow the DataVolume, log each phase and progress change, and stop after the
worker pod has failed **three** times, with the summarised error and its hint
as the task's message — rather than repeating the same error every minute for
four hours. See [tasks](tasks.md).

## What needs which cluster feature

| Feature | Requirement | Without it |
|---|---|---|
| Disks, images, imports, uploads | CDI (`cdi.kubevirt.io/v1beta1/datavolumes`) | **Create Disk**, **Upload image**, **Download image from URL** and the **Images** panel are not registered at all |
| **Clone** | `cdi.kubevirt.io` | the action is hidden |
| Storage profiles | CDI's `storageprofiles` | the Storage screen drops that section, and the class picker shows no profile line |
| **Snapshots** panel and restore | `snapshot.storage.k8s.io` (the external-snapshotter CRDs) | the panel is not registered; the Storage screen says so in place of the class table |
| A snapshot that becomes ready | a `VolumeSnapshotClass`, default or chosen | the VolumeSnapshot is created and stays `no` under **Ready** |
| **Resize** | `allowVolumeExpansion: true` on the class | the dialog says **Cannot be resized** |
| A running guest seeing a resize | KubeVirt's `ExpandDisks` feature gate | the new size appears after a restart |
| Hot-plugging into a running VM | KubeVirt's `HotplugVolumes` feature gate | the `addvolume` call is rejected and the task fails |
| Live migration with disks | `ReadWriteMany` claims | migration is offered and fails at the first non-migratable volume |
| Uploads | the CDI upload proxy reachable: in-cluster, `CDI_UPLOAD_PROXY_URL`, or permission to port-forward in `CDI_NAMESPACE` | `upload.begin` succeeds and the socket then fails with the reason |
| Block volumes on a node | a container runtime with `device_ownership_from_security_context` | importer pods die with `blockdev: … Permission denied` on that node only |
| Importing an existing VM's disks | see [importing from Proxmox](proxmox-import.md) | — |

The GUI asks the API server what exists and hides what is missing, so a cluster
without CDI has no Images screen rather than a screen full of errors. See
[installation](../installation.md#what-the-cluster-needs).
