# Virtual machines

A virtual machine here is a KubeVirt `VirtualMachine` — the definition — and,
while it runs, its `VirtualMachineInstance`. The screen keeps both in view at
once: the definition is what you edit, the instance is what is actually
running, and where the two disagree the panels say so rather than pretending
the change already took effect.

- [The VM in the resource tree](#the-vm-in-the-resource-tree)
- [Summary](#summary)
- [Console](#console)
- [Hardware](#hardware)
- [Cloud-Init](#cloud-init)
- [Options](#options)
- [Network](#network)
- [USB Devices](#usb-devices)
- [Services](#services)
- [Firewall](#firewall)
- [Guest Agent](#guest-agent)
- [Snapshots](#snapshots)
- [Migrations](#migrations)
- [Events](#events)
- [YAML](#yaml)
- [Power actions](#power-actions)
- [Live migration](#live-migration)
- [Snapshots, restore and clone](#snapshots-restore-and-clone)
- [Destroying a VM](#destroying-a-vm)
- [What needs which cluster feature](#what-needs-which-cluster-feature)

## The VM in the resource tree

Every tree view shows VMs with a monitor icon. The icon's colour and the small
badge over its corner are the whole status at a glance, so a tree of fifty
guests can be read without opening any of them.

| State | Icon | Badge |
|---|---|---|
| `running` | normal foreground | small green dot |
| `paused` | dimmed | amber pause glyph |
| `migrating` | dimmed | blue left-right arrows |
| `starting`, `stopping`, `provisioning` | dimmed | pulsing blue dot |
| `error` | red | red exclamation mark |
| `stopped`, `unknown` | dimmed | none |

The state is worked out in `vmState()` from both objects, in this order: a VMI
with the `Paused` condition true is **paused**; a VMI with an unfinished
`status.migrationState` is **migrating**; otherwise the VM's
`status.printableStatus` decides. `CrashLoopBackOff`, `ErrorUnschedulable`,
`ErrImagePull`, `ImagePullBackOff`, `ErrorPvcNotFound`,
`ErrorDataVolumeNotFound` and `DataVolumeError` all map to **error** — one red
badge covers every way a VM can be stuck, and the reason is on the
[Events](#events) panel.

A `VirtualMachineInstance` with no `VirtualMachine` behind it — started by
`virtctl` or another controller — still gets a node, with the hint
`<namespace> · VMI`. It opens the same screen, with the panels that need a
definition switched off.

In the Server View a stopped VM has no node, so it is collected under **Not
running**. The Tag View groups by the tags you set in [Options](#options).

Above the panels the heading reads `Virtual Machine <name> (<namespace>) on
node '<node>'`, with the state badge beside it.

## Summary

What the VM is, what it is doing, and a picture of its screen.

The left card lists **Status**, **Node** (a link to the node screen),
**Uptime** (since the VMI's `Ready` condition last flipped), **Operating
system**, **Guest agent**, **IP addresses**, **Run strategy**, **Instance
type**, **Live migratable**, **Created** and **Tags**. **Live migratable** is
KubeVirt's own `LiveMigratable` condition: when it is false the reason is shown
next to it and the full message is the tooltip. That is the field to read
before planning a node drain.

The thumbnail is a real screenshot of the guest's display, taken through
`vm.screenshot` (`virtualmachineinstances/vnc/screenshot`, with
`moveCursor=false` so looking does not move the guest's pointer) every 15
seconds while the VM is running or paused. Clicking it opens the
[Console](#console) panel. A VM with no graphics device shows *No display*.

The right card holds two gauges and, below them, the configured processors,
memory, disk count and interface count. Under it are **CPU usage** and **Memory
usage** charts.

The figures come from the `metrics.vmi` topic, which reads `metrics.k8s.io`
for the VM's `virt-launcher` pod. That is the pod's usage, not the guest's
own accounting — hence the labels **Memory (host, incl. overhead)** and **Host
memory (QEMU)**. Without metrics-server, or without `get pods` in the
namespace, the gauges stay blank and the charts stay empty; nothing else on the
screen is affected. metrics-server refreshes about every 15 seconds, and
repeated samples with the same timestamp are dropped rather than drawn as a
flat step.

The **Notes** card appears when the VM has notes. A notice appears when
`status.stateChangeRequests` is not empty — KubeVirt has a power change queued
that it has not carried out yet.

## Console

Two consoles, switched with the **noVNC** and **Serial (xterm.js)** buttons.
noVNC is greyed out when the VM has `autoattachGraphicsDevice: false`, and the
panel then opens on the serial console instead. When the VMI is not `Running`
the panel says so; there is nothing to connect to.

Both go through the gateway's two-step ticket, the same shape as Proxmox's
`vncproxy` → `vncwebsocket`: the browser calls `console.ticket`, gets a
single-use ticket valid for `CONSOLE_TICKET_TTL` seconds (60 by default, see
[configuration](../configuration.md)), and opens `/ws/console/{ticket}` as a
raw byte socket. The ticket carries your Kubernetes client, so the upstream
connection to `subresources.kubevirt.io/v1/…/vnc` or `…/console` is made as
you, not as the server. `console.ticket` checks the VMI is running first and
answers 409 otherwise, so a refusal is a clear error rather than a socket that
opens and immediately shuts.

The noVNC toolbar has a **Keys** menu (Ctrl+Alt+Del, Ctrl+Alt+F1, F2, F7,
Ctrl+Alt+Backspace, Alt+Tab, Super, Escape), **Paste**, a **Scaled** / **1:1**
toggle, **Reconnect**, pop-out and full screen. **Paste** types the clipboard
in as keystrokes rather than using the VNC clipboard channel: guests rarely run
a clipboard agent, but they always read keys. Over plain HTTP the browser
refuses clipboard access altogether and the button prompts for the text.

The toolbar's **Console** menu — **noVNC** and **xterm.js (serial)** — opens
the same consoles in a separate window at `/console/{namespace}/{name}`, which
is useful for keeping a console open while working elsewhere in the GUI.

Both actions are greyed out unless the VM is running and you hold `get` on
`virtualmachineinstances/vnc` or `/console`.

## Hardware

The VM's devices as a Proxmox-style table. Select a row and use **Edit**,
**Remove** or **Resize disk**, or double-click it. **Add** offers Hard Disk,
CD/DVD Drive, Network Device, TPM State, VirtIO RNG and Watchdog; the last
three are greyed out once the device exists.

Everything on this panel is a merge patch on the `VirtualMachine`, so it needs
`patch virtualmachines`. Without it the whole toolbar is disabled and the panel
says *Read-only: you may not change this VM*.

| Row | Shows | Edit | Remove |
|---|---|---|---|
| **Memory** | guest memory, the request when it differs, hugepage size | yes | — |
| **Processors** | total vCPU with sockets, cores, threads, CPU model, `dedicated` | yes | — |
| **BIOS** | `SeaBIOS` or `OVMF (UEFI)` with secure boot and persistent variables | yes | — |
| **Machine** | machine type, or `q35 (cluster default)` | yes | — |
| **Display** | `VGA (VNC)` or `none`, and whether a serial console is attached | yes | — |
| **Hard Disk** / **CD/DVD Drive** / **LUN** `(bus: name)` | volume kind and claim, size, storage class, boot order, cache, serial, read-only | yes | yes |
| **Network Device** `(name)` | model, MAC, network, binding, `link down` | yes | yes |
| **Filesystem** `(name)` | `virtiofs` | — | — |
| **GPU** / **PCI/USB Device** `(name)` | the device name | — | yes |
| **TPM State** | `v2.0`, persistent or ephemeral | yes | yes |
| **VirtIO RNG** | `/dev/urandom` | — | yes |
| **Watchdog** | model and action | yes | yes |
| **Input** `(name)` | type and bus | — | yes |

Two badges appear in the value column. **after restart**, in amber, means the
row is in the definition but not in the running instance. **hot-plugged**, in
blue, means KubeVirt reports the volume as a hotplug volume, so it is in the
running instance but arrived after it started.

Three notices sit above the table:

- **Pending changes**, when the VM carries KubeVirt's `RestartRequired`
  condition, with a **Restart now** button. Without it an edit to a running VM
  looks saved and silently does nothing until somebody happens to restart it.
- An instance-type notice, when the VM uses `spec.instancetype` or
  `spec.preference`. The effective values only exist in the expanded spec, so
  the panel calls `vm.expandSpec` (`virtualmachines/expand-spec`) and shows
  that. **Memory** and **Processors** are then not editable: resize by changing
  the instance type.
- A standalone-VMI notice: a bare instance has no definition to change.

Edits carry the `resourceVersion` the screen was showing, so two people editing
the same VM get a conflict rather than one silently undoing the other. The
patch is built from the VM as it is *now*, not as it was when the dialog
opened, and a conflict in that narrow window is retried twice against the newer
object.

**Adding a disk.** A new blank disk becomes a `dataVolumeTemplates` entry named
`<vm>-<device>`, so it is created with the VM and destroyed with it, the way a
Proxmox disk belongs to its guest. An existing disk is referenced as a PVC.
On a running VM, ticking **Hot-plug into the running VM** takes a different
route: a standalone DataVolume is created and `vm.volume.add` calls
`virtualmachineinstances/addvolume`, then writes the volume into the VM
definition as well, exactly as `virtctl addvolume --persist` does. Hot-plugged
disks always use the SCSI bus; the bus selector is disabled. More in
[storage](storage.md).

**Removing a disk** asks whether to destroy the claim too — unreferenced disks
are otherwise kept. A hot-plugged disk on a running VM is detached with
`vm.volume.remove` (`removevolume`); any other disk is removed from the
definition and stays attached until the VM restarts, which the confirmation
says.

**Resize disk** patches the PVC's `spec.resources.requests.storage`. Disks can
only grow, the storage class must allow volume expansion, and the partition and
filesystem inside the guest are your job afterwards.

**Network devices** are edited in their own dialog: name, model (VirtIO,
E1000E, E1000, RTL8139), network (pod network or a Multus attachment), binding
(masquerade, bridge, passt, SR-IOV), MAC address and **Disconnect (link down)**.
Only one interface may use the pod network, masquerade only works on the pod
network, and bridge binding on the pod network hands the pod's IP to the guest,
which prevents live migration. The Multus option is disabled unless the cluster
serves `k8s.cni.cncf.io`. See [networking](networking.md).

## Cloud-Init

The first-boot configuration of most cloud images, edited either as a form or
as raw YAML.

A VM with no cloud-init volume gets **Add a cloud-init drive**, which appends a
NoCloud volume named `cloudinitdisk` holding `#cloud-config` and a virtio disk
for it.

**Settings** covers the fields people actually change: **User**, **Password**,
**SSH public keys**, **Hostname**, **Upgrade packages on first boot**, and for
the first interface **IP configuration** — leave as is, DHCP, or static with
address, gateway and DNS servers. They are merged into the existing user data,
so anything else in the document survives. Two details worth knowing:

- The password is stored in plain text in the VM definition and is readable by
  anyone who can read the VM. The panel says so under the field.
- The hostname is written as both `hostname` and `fqdn`. `hostname` alone loses
  on Fedora and RHEL-family images: they prefer the FQDN, which cloud-init
  otherwise takes from the `local-hostname` KubeVirt writes into the
  meta-data — the VM's name. Setting both makes the chosen name stick.
- Static addresses produce netplan v2 with `match: {name: 'e*'}` rather than a
  fixed device name. On the pod network with masquerade KubeVirt runs DHCP for
  the guest, so static addresses are for bridged and Multus networks.

**Raw user data & network config** gives two YAML editors. When the user data
is not plain cloud-config YAML — a shell script, a MIME multipart document —
the **Settings** button is disabled and the panel says so; raw editing still
works.

When the user data comes from a Secret (`secretRef` or `userDataSecretRef`) the
fields and **Save** are disabled, and the notice names the Secret to edit
instead.

Saving is a merge patch on the VM's volumes; `userDataBase64` and
`networkDataBase64` are replaced by plain text. The guest sees the change after
a restart, and per-instance cloud-init modules only run again if the instance
ID changes — the panel says this whenever the VM is running.

## Options

VM-wide settings, one per row, each edited in a small dialog. As with
[Hardware](#hardware), everything needs `patch virtualmachines`.

| Row | What it sets |
|---|---|
| **Name** | `<namespace>/<name>`, read-only — Kubernetes names cannot change; clone to rename |
| **Notes** | the `kubevirt-webgui/notes` annotation, shown on the Summary |
| **Tags** | labels under `tags.kubevirt-webgui/`, which drive the Tag View |
| **Run strategy (start at boot)** | `spec.runStrategy`: `Always`, `RerunOnFailure`, `Once`, `Manual`, `Halted` |
| **Eviction strategy** | `evictionStrategy`: cluster default, `LiveMigrate`, `LiveMigrateIfPossible`, `External`, `None` |
| **Boot order** | `bootOrder` across disks and network devices |
| **Shutdown timeout** | `terminationGracePeriodSeconds`, shown as `default (180s)` when unset |
| **Node placement** | `nodeSelector`: any node, pinned to one, or matching labels |
| **Affinity** | `affinity`, as YAML |
| **Tolerations** | `tolerations`, as YAML |
| **Hostname** | `hostname` and `subdomain` |
| **Requests / limits** | `domain.resources.requests` and `.limits` |
| **Start paused** | `startStrategy: Paused` |
| **Priority class** | `priorityClassName` |

Some of these act immediately and some do not, which is the usual surprise:

- **Run strategy** `Always` starts the VM the moment it is saved, and `Halted`
  stops it. The dialog says so. Saving also clears the older `spec.running`
  field, since the two cannot both be set.
- **Eviction strategy** decides what a node drain does to this guest.
  `LiveMigrate` blocks the drain if the VM cannot move; `LiveMigrateIfPossible`
  shuts it down instead; `None` always shuts it down. See [tasks](tasks.md) for
  what a drain then reports.
- **Node placement** pinned to one node makes the VM unable to live-migrate and
  keeps it down while that node is down. The label mode shows which nodes match
  as you type.
- **Requests / limits** are what the scheduler reserves, separately from what
  the guest sees. Requests below the guest size overcommit the node.
- Scheduling changes apply the next time the VM starts.

**Affinity** and **Tolerations** are replaced rather than merged: the field is
nulled first and then written again, so rules you delete actually go away. A
merge patch alone would keep them.

## Network

A read-only view of the VM's network devices, with the definition and what the
guest reports side by side: **Device**, **Binding**, **Network**, **Model**,
**MAC address**, **IP addresses**, **In guest**, **Link** and **Reported by**.
A ★ beside a MAC means it is fixed in the VM definition; without one it was
assigned at start and will change if the instance is recreated.

Interfaces the guest agent reports but the VM does not declare — bridges,
tunnels, container networks inside the guest — are listed separately under
**Guest-only interfaces**. Declared ports get their own card. Guest device
names and extra addresses only appear once `qemu-guest-agent` is running, and
the panel says so until then.

Editing happens on [Hardware](#hardware); this panel is for reading. See
[networking](networking.md) for the bindings and Multus.

## USB Devices

Present only when the cluster serves `atomicusb.safewords.io/usbdeviceclaims`.
The panel lists the claims attached to this VM and every USB device discovered
in the cluster, and attaches a device plugged into any node to a VM running on
any other.

atomic-usb plugs devices into the usbredir sockets KubeVirt only creates for
VMs that ask for them, so the VM needs
`spec.template.spec.domain.devices.clientPassthrough`. Without it, **Attach**
is greyed out, a warning explains that claims would sit in `VMNotConfigured`,
and **Enable** patches the VM (needs `patch virtualmachines`). If the VM is
already running when passthrough is enabled, the running instance predates it
and the VM has to be restarted before devices can attach.

**Attach USB device…** in the toolbar's **More** menu does the same from
anywhere on the screen. Full details in [USB devices](usb.md).

## Services

The Kubernetes Services in this namespace that expose this VM: **Service**,
**Type**, **Cluster IP**, **Ports**, **External address** and **Age**.
**Expose** creates one; it is disabled without `create services`, and the
per-row delete button without `delete services`.

The **Connect** card below turns each service into addresses you can paste
somewhere — the external address or first node address with the node port, and
always `<service>.<namespace>.svc:<port>` — each with a copy button.

A VM with no service is reachable only from inside the cluster through its pod
address, which is what the empty table says.

## Firewall

Present only when the cluster serves `networking.k8s.io/v1/networkpolicies`.
It is the namespace firewall narrowed to the `NetworkPolicy` objects whose
selectors cover this VM, so you can see what already applies to this guest
before adding another rule. See [networking](networking.md).

## Guest Agent

Everything only the guest itself can tell you. The panel needs
`qemu-guest-agent` installed and running in the guest; when it is not
connected, the notice says so and names what is lost — OS details, logged-in
users, filesystems, extra addresses, consistent snapshots and soft reboot.

`vm.guest` fetches three subresources at once — `guestosinfo`, `userlist` and
`filesystemlist` — and returns each with its own ok/error, so one of them
failing leaves the others on screen instead of blanking the panel. It refreshes
every 30 seconds, and **Refresh** does it on demand.

- **Operating system**: name, version, kernel, architecture, hostname,
  timezone, agent version, and the filesystem freeze status. `frozen` is shown
  in amber — a guest left frozen after a failed snapshot will not write
  anything.
- **Logged-in users**: user, domain and login time.
- **Filesystems**: mount point, device, type and a usage gauge. This is the
  only place the GUI knows how full a guest's disks are; the storage panels
  only know the size of the claim.
- **Network interfaces**: from the VMI status, shown whenever the VM runs even
  without the agent, with **Reported by** saying which source each row came
  from.

A VMI carrying KubeVirt's `UnsupportedAgent` condition gets its own warning.

## Snapshots

Registered only when the cluster serves the `snapshot.kubevirt.io` group.

The table lists this VM's `VirtualMachineSnapshot` objects: **Name**,
**Date/Status**, **State**, **Consistency** (KubeVirt's `status.indications`),
**Disks** (how many volumes were captured) and **Description**.

| Button | Needs | Greyed out when |
|---|---|---|
| **Take snapshot** | `create virtualmachinesnapshots` | no VM definition, or the `Snapshot` gate is off |
| **Rollback** | `create virtualmachinerestores` | no selection, the snapshot is not ready, or the gate is off |
| **Remove** | `delete virtualmachinesnapshots` | no selection |

**Rollback** additionally requires the VM to be stopped. Clicking it on a
running VM opens a dialog saying so; the server refuses with 409 as well, so
neither route can restore over a running guest.

Two notices warn before you try rather than after: KubeVirt's `Snapshot`
feature gate being off, and the cluster not serving `snapshot.storage.k8s.io`,
without which persistent disks cannot be captured at all. A **Rollback
history** table appears once restores exist.

See [Snapshots, restore and clone](#snapshots-restore-and-clone) for what each
one does on the cluster.

## Migrations

Registered only when the cluster serves
`kubevirt.io/v1/virtualmachineinstancemigrations`.

While a migration runs, a live progress panel sits at the top; after a failed
one, a warning with KubeVirt's `failureReason`. The table lists this VM's
migrations: **Started**, **Phase**, **Source → target**, **Duration**,
**Mode**, **Result** and the migration object's **Migration** name. KubeVirt
cleans migration objects up after a while, so an empty table does not mean the
VM has never moved.

**Migrate** is disabled without a running instance or without `create
virtualmachineinstancemigrations`, and carries the tooltip *KubeVirt reports
this VM is not live-migratable* when the condition says so. **Cancel** is
disabled for `Succeeded` and `Failed` migrations and without `delete
virtualmachineinstancemigrations`.

## Events

Two histories, because the interesting one is usually not the Kubernetes one.

**Task history** is what this GUI did to this VM: start time, end time,
description, the user who asked, and the outcome. Double-click a row to reopen
its log. These live in the server's memory, so a restart of the GUI clears them
— the table says *No tasks for this VM in this server's memory* rather than
implying nothing ever happened. See [tasks](tasks.md).

**Kubernetes events** covers the VM itself and, by name prefix, its
`virt-launcher-<name>-*` pods and `<name>-*` objects, which is where a failed
start, an unschedulable pod or a stuck import actually reports itself.

## YAML

The raw objects. The toggle switches between **VirtualMachine** and
**VirtualMachineInstance**; the latter is disabled when the VM is not running
and is always read-only, since KubeVirt owns it.

The VirtualMachine document is editable: **Edit**, then **Validate (dry run)**
— a server-side dry run that says *The API server accepts this* — **Save**,
which is a full replace, **Discard**, and **Copy**. `metadata.managedFields` is
stripped from what is shown. If the object changes on the server while you are
editing, a warning appears before you find out through a conflict.

## Power actions

**Start** and **Migrate** are buttons in the toolbar. The rest live in the
**Shutdown** split button: clicking its main half shuts the VM down, and the
arrow opens the others.

| Action | What it does | KubeVirt subresource | Offered when |
|---|---|---|---|
| **Start** | Starts the VM and follows it until the VMI reports `Running`, for up to 600 s | `virtualmachines/start` | state is `stopped`, `error` or `unknown` |
| **Shutdown** | Asks the guest to power off (ACPI) and lets it use its grace period; follows it for up to 900 s | `virtualmachines/stop` | `running`, `paused` or `migrating` |
| **Stop** | Sends `gracePeriod: 0` — like pulling the power cable; unsaved data in the guest is lost | `virtualmachines/stop` | `running`, `paused`, `migrating`, `starting` or `stopping` |
| **Reboot** | Soft reboot from inside the guest; keeps the same instance | `virtualmachineinstances/softreboot` | `running` |
| **Restart (new instance)** | Recreates the instance, picking up configuration changes; it may land on another node | `virtualmachines/restart` | `running`, `paused` or `migrating` |
| **Reset** | Hard reset; the guest restarts without shutting down | `virtualmachineinstances/reset` | `running` |
| **Pause** | Freezes the guest's vCPUs | `virtualmachineinstances/pause` | `running` |
| **Resume** | Unfreezes them | `virtualmachineinstances/unpause` | `paused` |

Each is the gateway method `vm.<action>` — `vm.start`, `vm.shutdown`,
`vm.stop`, `vm.reboot`, `vm.restart`, `vm.reset`, `vm.pause`, `vm.resume` —
and each runs as a task that logs the VMI's phase and node as they change, so
a VM that will not start says where it got stuck. **Shutdown**, **Stop**,
**Reboot**, **Restart** and **Reset** ask for confirmation first; **Stop** and
**Reset** are marked as dangerous.

Each entry is greyed out unless you hold `update` on the subresource above
(group `subresources.kubevirt.io`); a toolbar button refused this way carries
the tooltip *You do not have permission for this*. **Reboot** needs the guest
agent or working ACPI in the guest; without either it is accepted and nothing
happens.

Two more methods exist with no button on this screen: `vm.freeze`
(`virtualmachineinstances/freeze`, with a five-minute auto-thaw) and
`vm.unfreeze`. They are there for scripts and other extensions — see the
[gateway protocol](../extending/gateway-protocol.md).

## Live migration

**Migrate** is offered only while the VM is `running` and needs `create
virtualmachineinstancemigrations` in the namespace.

The dialog states the source node, the mode (online — the guest keeps
running), the VM's CPU model, and KubeVirt's `LiveMigratable` verdict with its
message. Then it lists every other node: either how many guests it already
holds and how much memory it has allocatable, or the reason it cannot take this
one — `offline`, `in maintenance`, `cannot run VMs`, *excluded by the VM's node
selector*, *different host CPU (X ≠ Y)*, or *does not support CPU model X*.
**Automatic — let the scheduler choose** is the first option.

**The CPU constraint is the one that catches people.** KubeVirt's default CPU
model is `host-model`, which — like `host-passthrough` — pins the guest to
nodes with the same physical CPU. The GUI reads this from node labels:
`host-model-cpu.node.kubevirt.io/<model>` for the host model, and
`cpu-model.node.kubevirt.io/<model>` for the models a node can emulate. When
every other node is ruled out the dialog says the migration would sit
unschedulable and fail, and offers the models every schedulable node supports,
to set under Hardware → Processors. A VM has to be restarted for a CPU model
change to take effect, so this is a thing to fix before you need to drain a
node, not during.

`vm.migrate` creates a `VirtualMachineInstanceMigration` with `generateName:
<name>-migration-` and, when a target node was chosen, `spec.addedNodeSelector:
{kubernetes.io/hostname: <node>}`. It then polls every two seconds, logging
each phase change with the target node and mode, and gives up after 3600 s.
While the migration is `Pending` or `Scheduling` it also reads the target pod's
`PodScheduled=False` message and logs that, because KubeVirt only reports
"unschedulable" after five minutes whereas the scheduler's own reason — no node
with this CPU model, not enough memory — is on the pod straight away. If the
VM uses the host CPU model and no other schedulable node has that CPU, the task
logs the explanation in words; that check needs `list nodes`, and users without
it simply get no hint. A failed migration logs the migration's events before
reporting `failureReason`, the scheduling reason, or the last event.

### Progress figures

KubeVirt keeps none of this on its objects. The source node's virt-handler
samples libvirt's job info every five seconds while a migration runs and
publishes it as `kubevirt_vmi_migration_*` metrics; the server reads them
through the API server's pod proxy, **as the signed-in user**. Seeing progress
therefore needs `get pods/proxy` in KubeVirt's namespace. Without it the
migration still works exactly the same — it just shows no figures, and says
*live transfer figures unavailable: reading virt-handler's metrics needs `get
pods/proxy` in KubeVirt's namespace*.

| Figure | Meaning |
|---|---|
| total | Guest data to move: memory, plus disks for a block migration |
| processed / **Sent** | Bytes sent so far, re-sent dirty pages included — it can exceed the total |
| remaining / **Remaining** | Bytes still to send; the percentage is `(total − remaining) / total` |
| transfer rate | Bytes per second going across |
| dirty rate / **Guest dirtying** | Bytes per second the guest writes to memory already sent |

The task log names the amount to transfer once (`transferring guest data: N
GiB`) and then logs a line at 25%, 50% and 75% with the rate and the dirtying
rate; the task's progress bar is a byte count with `N GiB left`. The
[Migrations](#migrations) panel subscribes to the `migration.progress` topic —
every two seconds while migrating, every five otherwise — and shows the same
thing live, with source → target and the mode.

When the dirty rate reaches or passes the transfer rate, the panel turns that
figure amber and adds *faster than the transfer; consider auto-converge or
post-copy*. A pre-copy migration cannot converge while the guest dirties memory
faster than it is sent, and it will keep going until it times out.

One quirk worth knowing about: virt-handler keeps one sampling queue per VMI
and only deletes a finished one when its metrics are scraped. In a cluster
without Prometheus nobody scrapes, so after a VM has migrated once the stale
queue would stop the next migration from being sampled at all. The server
therefore reads the metrics once before creating the migration, and once after
a migration finishes, purely to clear that queue.

### Cancelling

**Cancel** on the [Migrations](#migrations) panel calls `vm.migrate.cancel`,
which deletes the `VirtualMachineInstanceMigration` object. The guest stays on
its source node, which the confirmation names. If a migrate task is following
that object when it disappears, the task ends with 409 *the migration was
cancelled (its object was deleted)* rather than hanging.

## Snapshots, restore and clone

All three are KubeVirt features gated behind its `Snapshot` feature gate. The
GUI reads the gate from the KubeVirt CR when you may list `kubevirts`, so the
screen can say *switched off in this cluster* instead of letting an admission
webhook refuse the request some seconds later. Users who cannot read the CR get
`null` — unknown — and the action is simply allowed to try; if the webhook then
refuses, the message is rewritten to point at Datacenter → Options → Feature
gates.

**Take snapshot** (`vm.snapshot`) creates a `VirtualMachineSnapshot` named
`<vm>-<YYYYMMDDHHmm>` by default, with the description stored in the
`kubevirt-webgui/description` annotation. The API version follows what the
cluster serves, falling back to `snapshot.kubevirt.io/v1beta1`. Before you
start, the dialog reads the VM's `status.volumeSnapshotStatuses` and tells you
which disks will be captured, which will not and KubeVirt's reason for each,
and whether the guest agent will freeze the filesystems (consistent) or the
snapshot will be crash-consistent, *like pulling the plug*.

The task waits for `status.readyToUse` for up to an hour, then logs the
consistency indications, the included volumes, and each excluded one with its
reason. This matters: KubeVirt leaves out disks it cannot capture — a
containerDisk, or a claim whose storage has no `VolumeSnapshotClass` — and
still marks the snapshot ready. Without that log line a rollback later restores
less than expected. When everything was excluded, the task's result says so
outright: *snapshot is ready, without disk data … (only the VM definition was
captured)*.

**Rollback** (`vm.restore`) creates a `VirtualMachineRestore` named
`<snapshot>-restore-<timestamp>` targeting the VM, and waits for
`status.complete`. The VM must be stopped; the server refuses a running one
with 409. Everything written since the snapshot was taken is lost, which the
confirmation says.

**Remove** deletes the `VirtualMachineSnapshot`, and with it the volume
snapshots it holds.

**Clone** (`vm.clone`) is in the toolbar's **More** menu and is hidden unless
the cluster serves `clone.kubevirt.io`. It creates a `VirtualMachineClone`
named `<name>-clone-<timestamp>` and waits for phase `Succeeded`, for up to
four hours. The dialog checks the target name is a valid DNS label and not
already taken. Two checkboxes control the clone's `labelFilters` and
`annotationFilters` — `['*']` to copy labels and tags, or annotations and
notes, `['!*']` to drop them. It is a full clone: every disk is copied, as a
CSI clone where the storage supports it, and MAC addresses and the SMBIOS
serial are regenerated so the copy does not collide with the original on the
network. Cloning a running VM needs snapshot-capable storage; the dialog warns
and suggests stopping it first.

## Destroying a VM

**Remove** at the bottom of the **More** menu. The confirmation asks you to
type the VM's name, and offers **Also destroy its disks (PVCs and
DataVolumes)**, ticked by default — unreferenced disks are otherwise kept and
will quietly occupy storage.

`vm.delete` deletes the `VirtualMachine` with `propagationPolicy: Foreground`
and waits up to 600 s for it to go, so the disks are not removed out from under
a still-terminating guest. It then deletes each DataVolume and PVC named by the
VM's volumes, and, for a DataVolume, its same-named PVC if one is left behind,
so no disk is orphaned. Failures are logged rather than aborting the rest.

## What needs which cluster feature

| Feature | Needs | Without it |
|---|---|---|
| The VM screen | `kubevirt.io/v1/virtualmachines` | the KubeVirt extension does not register at all |
| Any edit (Hardware, Cloud-Init, Options, Tags, Notes) | `patch virtualmachines` | panels are read-only and say so |
| Summary gauges and charts | metrics-server (`metrics.k8s.io`) and `get pods` | gauges blank, charts empty |
| Summary screenshot | `get virtualmachineinstances/vnc/screenshot` | placeholder tile |
| noVNC console | `get virtualmachineinstances/vnc`, and a graphics device on the VM | button greyed out; the panel opens on serial |
| Serial console | `get virtualmachineinstances/console` | button greyed out |
| Hardware values with instance types | `virtualmachines/expand-spec` | the notice shows the error instead of the values |
| Hot-plugging a disk into a running VM | KubeVirt volume hotplug | the disk goes into the definition and appears after a restart |
| Resizing a disk | a storage class with volume expansion | the PVC patch is refused |
| Multus networks in the NIC dialog | `k8s.cni.cncf.io` | the option is disabled |
| Guest Agent panel, soft reboot, consistent snapshots | `qemu-guest-agent` running in the guest | a warning; snapshots are crash-consistent |
| Snapshots panel, **Take snapshot**, **Rollback** | the `snapshot.kubevirt.io` group and KubeVirt's `Snapshot` gate | the panel is not registered; the action is hidden or refused |
| Capturing persistent disks in a snapshot | `snapshot.storage.k8s.io` and a `VolumeSnapshotClass` for the storage | disks are excluded; only the VM definition is captured |
| **Clone** | the `clone.kubevirt.io` group and the `Snapshot` gate | the action is hidden or refused |
| "switched off in this cluster" warnings | `list kubevirts` | the gate is unknown and the action is allowed to try |
| Migrations panel and **Migrate** | `kubevirt.io/v1/virtualmachineinstancemigrations` | the panel is absent; **Migrate** is greyed out |
| Live migration transfer figures | `get pods/proxy` in KubeVirt's namespace | the migration works; no figures are shown |
| The host-CPU hint in a failed migration | `list nodes` | the task logs the scheduler's message only |
| Firewall panel | `networking.k8s.io/v1/networkpolicies` | the panel is absent |
| Services panel buttons | `create` and `delete services` | the table is read-only |
| USB Devices panel and **Attach USB device…** | `atomicusb.safewords.io` CRDs, and `clientPassthrough` on the VM | the plugin is inactive; **Attach** is greyed out |

Who holds what is decided entirely by Kubernetes RBAC for the account you
signed in with — the server holds no privileges of its own. See
[authentication](../authentication.md). VMs imported from Proxmox arrive
through [Proxmox import](proxmox-import.md) and are ordinary VMs afterwards.
