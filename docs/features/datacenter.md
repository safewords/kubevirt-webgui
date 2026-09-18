# The datacenter

The Datacenter is the root of the resource tree and the cluster-wide screen:
everything that is not one VM, one disk or one node lives here. Its panels are
grouped the way Proxmox groups a datacenter's menu, and each one hides itself
when the cluster does not serve the API it needs.

- [The screen and its panels](#the-screen-and-its-panels)
- [Summary](#summary)
- [Nodes](#nodes)
- [Options](#options)
- [Events](#events)
- [Storage](#storage)
- [Networks](#networks)
- [Migrations](#migrations)
- [Instance Types](#instance-types)
- [USB Devices](#usb-devices)
- [Namespaces](#namespaces)
- [Permissions](#permissions)
- [My Settings](#my-settings)
- [Extensions](#extensions)

## The screen and its panels

The datacenter lives at `/dc/<panel>` — `/dc/options`, `/dc/permissions` and so
on — and the tree's top node opens it. Panels come from plugins, so the list
below is what a default build registers; a browser plugin can add more without
touching the GUI (see [browser plugins](../extending/browser-plugins.md)).

| Panel | Group | Needs the cluster to serve | Source |
|---|---|---|---|
| **Summary** | — | — | core |
| **Nodes** | Cluster | — | core |
| **Options** | Cluster | — | core |
| **Events** | Cluster | — | core |
| **Storage** | Storage | — | core |
| **Networks** | Network | — | core (network plugin) |
| **Migrations** | Virtualization | `kubevirt.io/v1/virtualmachineinstancemigrations` | core |
| **Instance Types** | Virtualization | `instancetype.kubevirt.io` | core |
| **USB Devices** | Hardware | `atomicusb.safewords.io/v1alpha1/usbdevices` | atomic-usb plugin |
| **Namespaces** | Access | — | core |
| **Permissions** | Access | — | core |
| **My Settings** | GUI | — | core |
| **Extensions** | GUI | — | core |

A panel's `requires` list is checked against discovery (`cluster.discovery`),
which is re-read every 60 seconds. Install the external snapshotter or the
instance-type CRDs and the matching panel appears within the minute; uninstall
them and it goes away again. Nothing needs a reload.

What a panel *shows* is a second question, decided by RBAC rather than by
discovery. Almost every table here is a watch over a resource: when the user
may list it cluster-wide the GUI watches it that way, and when they may not it
watches each namespace they can reach instead — the set of namespaces the
cluster reported plus any added under [My Settings](#my-settings). A panel with
nothing to show says so rather than looking empty by accident.

## Summary

Two cards and a node table, meant to answer "is the cluster all right" without
scrolling.

**Health** reads the KubeVirt object at `kubevirt/kubevirt`. A `Degraded`
condition of `True` is reported with its message; otherwise `Available` decides
between "KubeVirt: all components ready" and the reason it is not available.
When the object cannot be read the card distinguishes "KubeVirt is not
installed" from "KubeVirt status not readable" by asking discovery whether the
`kubevirt.io` group exists at all, which separates a missing install from a
missing permission.

The same card counts nodes as online or offline by their `Ready` condition, and
adds how many carry `kubevirt.io/schedulable=true` — the count that matters,
because a node can be perfectly healthy for Kubernetes and still refuse VMs.
Guests are counted from the VM inventory: running (including paused and
migrating), stopped, in error, and transitioning.

**Resources** gauges CPU and memory as used over allocatable, summed across
every node, with usage from the `metrics.nodes` topic. It also prints the
Kubernetes and KubeVirt versions from discovery, whether CDI is installed, and
the API server address the gateway is talking to. Without metrics-server the
gauges are blank rather than zero — see [Metrics](nodes.md#metrics).

The node table repeats the columns of the [Nodes](#nodes) panel in short form.
Status is `online`, `maintenance` (ready but cordoned) or `offline`; double-
clicking a row opens that [node](nodes.md).

## Nodes

Every node the user may list, with usage bars. Columns: Name, Status, Roles
(from `node-role.kubernetes.io/*` labels, falling back to `worker`), Runs VMs,
Guests, CPU usage, CPUs, Memory usage, Memory, Address (the `InternalIP`),
Kubelet, Kernel and Age. Capacity figures are `status.allocatable`, not
`status.capacity`, so they are what a VM can actually be scheduled against.

Two notices appear where they are needed rather than as general advice. If the
account may not list nodes the panel says so and names the permission
(`nodes: list`); if the `metrics.nodes` subscription fails, usage columns show
`—` and the reason is printed once at the top instead of in every row.

Everything else about a node is on the [node screen](nodes.md).

## Options

The KubeVirt configuration, edited as a form instead of as YAML. The panel
watches `kubevirt.io/v1 kubevirts` and edits the first object it finds.

The header card is read-only: `status.phase`, the observed, operator and target
KubeVirt versions, the image registry, the default architecture, and the
object's conditions with `Degraded` and `Progressing` counted as good when
false. Below it, the form is disabled unless the user may `patch` that
KubeVirt object; if not, a notice says "You can view this configuration but not
change it" rather than letting a save fail later.

| Section | Field | Writes to |
|---|---|---|
| Feature gates | 36 gates by name, plus free text for any other | `spec.configuration.developerConfiguration.featureGates` |
| Live migration | Parallel migrations (cluster), Parallel outbound per node, Bandwidth per migration, Completion timeout per GiB, Progress timeout, Dedicated migration network, Post-copy, Auto-converge | `spec.configuration.migrations` |
| Virtual machines | Eviction strategy, VM rollout strategy, Default machine type (amd64), Memory overcommit, CPU allocation ratio, Persistent state storage class | `spec.configuration` |
| Workload updates | Methods (`LiveMigrate`, `Evict`), Batch eviction size, Batch eviction interval | `spec.workloadUpdateStrategy` |

Two of these decide what happens to running VMs and are worth knowing before a
maintenance window. **Eviction strategy (node drain)** is KubeVirt's own
answer to eviction: the default `None` lets VMs be shut down, `LiveMigrate`
blocks the drain until they have moved, `LiveMigrateIfPossible` moves what it
can, and `External` hands the decision to another controller. **Workload
updates** decides how running VMs move to a new KubeVirt version — that is the
only thing it governs; it does not act on ordinary configuration changes.

**Containerized Data Importer** is shown at the bottom, read-only: CDI's phase
and version, the upload proxy URL, the scratch-space class, filesystem
overhead, CDI's own feature gates, the import proxy and the default importer
pod resources. Changing them is out of scope for this panel; edit the CDI
object with `kubectl`.

### How a save is written

Saves are a JSON merge patch, and the patch is reduced to what actually
changes before it is sent. That matters because the KubeVirt object is
usually owned by Helm or a GitOps controller: writing back an unchanged
`parallelMigrationsPerCluster: 5` or leaving an empty `migrations: {}` behind
makes the live object drift from the manifest that installed it, and the next
reconcile fights the GUI. An emptied field is sent as `null`, so KubeVirt's
own default applies again, and a field that was never set is left alone.

Numeric fields are checked before anything is sent, then the patch is applied
twice: once with `dryRun` for the API server to validate and reject, and then
for real. Both go through `resource.patch`. If the object changed on the
server while the form was open, a notice offers the choice between resetting
to the server's version and overwriting those fields.

### Changing a feature gate

Turning a gate on or off is a change to the cluster's virtualisation control
plane, not to one VM. virt-operator rolls the new configuration out to
KubeVirt's components; the object reports `Progressing` while it does, and the
end-to-end test that exercises this panel allows up to ten minutes for KubeVirt
to report `Available` and neither `Progressing` nor `Degraded` again.

> **Warning.** Do not toggle gates while VMs are migrating or a node is being
> drained. The rollout restarts KubeVirt's components underneath those
> operations. Running VMs are not restarted by the rollout itself — that is
> what **Workload updates** governs, and only on a KubeVirt version change —
> but a gate that is switched off stops being available to anything that asks
> for it afterwards: with `Snapshot` off, no new snapshot is admitted; with
> `HotplugVolumes` off, no new disk can be attached to a running VM.

Gates the GUI does not know by name are not hidden. They appear as chips under
**Other gates**, keep working, and can be removed there; new ones can be typed
in by name. The named list is a convenience with one-line hints, not a
whitelist.

## Events

Every Kubernetes event the user can see, cluster-wide, from a watch on
`v1/events`. Kubernetes keeps events for about an hour, so this is a view of
the recent past, not an audit log.

Three filters sit in the toolbar:

| Control | Default | Effect |
|---|---|---|
| **Virtualization only** | on | Keeps events whose involved object is one of the virtualisation kinds (VirtualMachine, VirtualMachineInstance, VirtualMachineInstanceMigration, snapshots, restores, clones, exports, pools, DataVolume, DataSource, DataImportCron, PersistentVolumeClaim, Node, KubeVirt, CDI, UsbDevice, UsbDeviceClaim), or whose name begins with `virt-launcher-`, `importer-`, `cdi-upload-` or `hp-volume-` |
| **Warnings only** | off | Keeps `type: Warning` |
| Object kind | all | The kinds actually present in the current list |

A warnings count and the number of rows shown sit beside them. Columns are
Last seen, Type, Object, Reason, Message, Source and Count; the count folds
repeats, which is why a single noisy event does not flood the table.

Double-clicking a row follows the involved object where the GUI has a screen
for it: VirtualMachine and VirtualMachineInstance go to the
[VM](virtual-machines.md), Node to the [node](nodes.md), PersistentVolumeClaim
and DataVolume to the [disk](storage.md), Namespace to the
[namespace](namespaces.md). Other kinds are not clickable.

Listing events cluster-wide is a permission many accounts lack. Without it the
panel watches events in each reachable namespace instead, which is the same
view minus the namespaces the user cannot see.

## Storage

Storage classes, CDI storage profiles and volume snapshot classes, cluster-
wide and read-only; double-clicking any row opens its definition. The two
default-class annotations are shown as a star:
`storageclass.kubernetes.io/is-default-class` for the cluster default and
`storageclass.kubevirt.io/is-default-virt-class` for the default used by VM
disks, which can be a different class.

When the cluster does not serve `snapshot.storage.k8s.io` the panel says so
plainly, because that is the reason VM snapshots cannot capture disk contents.
Claims and provisioned capacity count only the disks the user can see. See
[storage](storage.md) for disks themselves.

## Networks

Secondary networks (`NetworkAttachmentDefinition`s from `k8s.cni.cncf.io`) and
the Services that expose VMs, cluster-wide. It is registered by the network
plugin rather than the datacenter plugin, which is why it sits in its own
**Network** group. See [networking](networking.md).

## Migrations

Every `VirtualMachineInstanceMigration` the user can see, newest first, and the
policies that tune them. The panel is hidden unless the cluster serves
`kubevirt.io/v1/virtualmachineinstancemigrations`.

Columns: VM, Phase, Source, Target, Mode, Started, Duration, Progress, Policy.
A migration counts as in progress while its phase is one of `Pending`,
`Scheduling`, `Scheduled`, `PreparingTarget`, `TargetReady`, `Running`,
`WaitingForSync` or `Synchronizing`; those rows show live progress and a
**Cancel** button, which calls `vm.migrate.cancel` and leaves the VM running on
its source node. A failed migration shows its `failureReason` beside the
phase.

**Remove finished** deletes the records of migrations that have ended. It only
removes history — VMs are not touched — but it is a bulk delete, so it asks
first and names the count.

**Migration policies** (`migrations.kubevirt.io/migrationpolicies`) override
the cluster-wide live-migration settings from [Options](#options) for the VMs
and namespaces their selectors match. They are created and edited as YAML;
**Create** opens a worked example with both selector kinds filled in, since a
policy with no selectors applies to everything. Creating one needs `create` on
`migrationpolicies`, and the button is disabled without it.

Migrations started from a [node drain](nodes.md#cordon-uncordon-and-drain)
appear here like any other, named `<vm>-drain-<suffix>`.

## Instance Types

Instance types and preferences — KubeVirt's answer to templates. Hidden unless
the cluster serves `instancetype.kubevirt.io`. Both scopes are listed
together: the cluster-scoped `virtualmachineclusterinstancetypes` and
`virtualmachineclusterpreferences` alongside the namespaced
`virtualmachineinstancetypes` and `virtualmachinepreferences`, with a **Scope**
column showing either `cluster` or the namespace.

An **instance type** fixes CPU and memory, the way a cloud flavour does. The
table shows vCPU, memory, the series (the part of the name before the first
dot), the class label, and features worth knowing before choosing one:
dedicated CPUs, isolated emulator thread, NUMA, huge pages and their size, GPU
and host-device counts, and memory overcommit.

A **preference** supplies OS-appropriate defaults: preferred disk bus, NIC
model, firmware (BIOS, EFI, EFI with Secure Boot), CPU topology, and the
minimum CPU and memory it requires. The **Vendor** filter reads the
`instancetype.kubevirt.io/vendor` label, so the common-instancetypes bundle can
be separated from locally written ones, which show as `custom`.

The panel is read-only; double-clicking a row shows the full definition.
Create and edit them with `kubectl`. A VM that references an instance type or
preference picks up changes to it when it is restarted, not while it runs.

## USB Devices

USB devices plugged into any node, and the claims that attach them to VMs.
Contributed by the atomic-usb plugin and hidden unless the cluster serves the
atomic-usb CRDs. See [USB devices](usb.md).

## Namespaces

Namespaces as Proxmox's resource pools: one row each, with VM and running-VM
counts, the number of persistent volume claims, the storage they add up to, a
description and an age. Namespaces matching the usual system prefixes
(`kube-`, `kubevirt`, `cdi`, `default`, `cattle-`, `calico-`, `cilium`,
`metallb`, `traefik`, `longhorn`, `rook-`) are marked with a `system` chip so
they can be told apart at a glance.

**Create** asks for a DNS-label name, an optional description — stored as the
`kubevirt-webgui/description` annotation, which is also what the list reads —
and any labels. Deleting a namespace destroys everything in it; the dialog
names how many VMs and disks that is and requires the namespace name to be
typed before it will proceed. Both buttons are disabled without `create` and
`delete` on `namespaces`.

An account that cannot list namespaces sees only the namespaces this browser
already knows about, with a notice pointing at
[My Settings](#my-settings) for adding more. See
[namespaces](namespaces.md) for what a single namespace's screen offers.

## Permissions

Three tabs over Kubernetes RBAC. Nothing here is a GUI-specific permission
model: what is granted here is what `kubectl auth can-i` would report.

### My permissions

The signed-in username and groups, a namespace picker, and two views of what
that account may do there.

The matrix asks `access.review` — batched `SelfSubjectAccessReview`s — for 20
virtualisation-relevant resources against the verbs `list`, `get`, `create`,
`update`, `patch` and `delete`: virtual machines and their instances, the
start, stop, restart, pause, VNC, serial console and guest-agent subresources,
migrations, snapshots, restores, clones, DataVolumes, disk uploads, persistent
volume claims, services, secrets, role bindings and ServiceAccount tokens.
Each cell is allowed, denied, or still being fetched. This is the same
mechanism that greys out buttons elsewhere in the GUI, which is why a button is
never enabled for an action the API server would refuse.

Below it, `access.rules` (a `SelfSubjectRulesReview`) lists the effective rules
in that namespace: API groups, resources, resource names and verbs, filterable,
with non-resource URL rules folded into a details block. When the API server
marks the answer incomplete the panel says so and prints the evaluation error —
authorisers such as webhooks cannot always enumerate their rules, and an
incomplete list is not the same as a short one.

### Role bindings

RoleBindings and ClusterRoleBindings the user can see, with Scope, Subjects,
Role, Binding name and Age. By default the list shows only virtualisation-
related roles (`kubevirt.io:*`, `cdi.kubevirt.io:*`, `instancetype.kubevirt.io:*`,
and `admin`, `edit`, `view`, `cluster-admin`) and hides `system:`, `kubeadm:`
and `k3s` bindings; both filters can be switched off, as can including
cluster-wide bindings.

**Add permission** creates a RoleBinding in a namespace. It takes a role —
`kubevirt.io:view`, `kubevirt.io:edit`, `kubevirt.io:admin`, `view`, `edit` and
`admin` are offered with hints, and any ClusterRole in the cluster can be typed
or picked — a role kind (ClusterRole or Role), and a subject that is a User, a
Group or a ServiceAccount. Users and groups are matched by the name the
cluster knows them by, which for OIDC is usually an email address. The binding
is labelled `app.kubernetes.io/managed-by: kubevirt-webgui` and given a
generated name unless one is supplied.

Removing a binding deletes it, which takes the permission away from every
subject on it — the dialog names the role, the subjects and the scope for that
reason. Access answers are cached for a minute, so a right granted or removed
here can take up to that long to show up in another browser's buttons.

### API tokens

ServiceAccounts, which is how automation and anyone without single sign-on
signs in. The table lists each account in the chosen namespace with the roles
bound to it (from the bindings the user can see), a description annotation and
an age.

Creating an account, granting it a role and minting a token are three separate
steps, deliberately: a fresh ServiceAccount can do nothing at all until a role
is bound to it. **Create token** calls `serviceaccount.token`, which posts a
`TokenRequest` to the account's `token` subresource — the cluster issues the
token, and RBAC decides who may ask. Expiry is chosen from 1 hour to 1 year;
the server defaults to 3600 seconds and clamps the request to between 10
minutes and 365 days.

> The token is shown once and is not stored anywhere. It cannot be listed or
> revoked individually — deleting the ServiceAccount revokes every token issued
> for it, which is why the delete dialog says so and asks for the name to be
> typed.

The same token works with `kubectl`, with the API directly, and as a sign-in on
this GUI's login screen; the dialog includes the two `kubectl config` commands
for it. See [authentication](../authentication.md).

## My Settings

Per-browser preferences, kept in `localStorage` under `kve.ui`. Nothing here
is stored on the server or shared between browsers.

| Card | What it holds |
|---|---|
| **Account** | Username, groups, home namespace and session expiry, all read-only |
| **Appearance** | Theme (Dark, Light, Follow the system), which resource tree view to show, and whether the task and cluster log panel is open |
| **Extra namespaces** | Namespaces to watch in addition to the ones the cluster reported |

**Extra namespaces** exists for accounts that cannot list namespaces. Such an
account still has namespaces — its ServiceAccount's own, at least — and the
server narrows its answer to those rather than failing outright. Naming the
others here makes their VMs and disks appear in the tree, in the pickers, and
in every cluster-wide table that falls back to per-namespace watches.

**Reset local preferences** forgets the layout, theme, tree state and extra
namespaces, then reloads. The session is not affected.

## Extensions

What this build can do, and why a piece of it is or is not working.

**Server extensions** are compiled into the server; each contributes gateway
methods and topics, and declares the cluster APIs it needs. The card shows the
name, version, description, the methods and topics it registers, and its state:

| State | Meaning |
|---|---|
| **available** | Discovery reports every API in the extension's `requires` list |
| **cluster lacks its APIs** | At least one is missing, so its methods will refuse |

The state is computed in the browser by checking each `requires` entry against
discovery, which is exactly how panels decide whether to appear. It is not a
health check: an extension marked available can still fail a call the user
lacks permission for. An extension can be switched off by name with
`GUI_DISABLED_EXTENSIONS` even when its APIs are present — see
[configuration](../configuration.md) and
[server extensions](../extending/server-extensions.md).

**Re-scan cluster** re-reads discovery immediately, passing `refresh: true` to
`cluster.discovery` so the server's cached discovery is rebuilt rather than
re-served. Extensions and panels switch themselves on and off within a minute
of their CRDs being installed or removed; this button is for not waiting the
minute after installing something.

**Browser plugins** lists what the GUI itself loaded: the plugin's name and id,
its source (built in, or the URL it came from), its status — `active`, or the
error that stopped it — how many panels, actions and tree views it contributes,
and its description. Extra plugins are loaded from `GUI_PLUGIN_URLS`; a plugin
that fails to load leaves its error in this table rather than a blank screen.
See [browser plugins](../extending/browser-plugins.md).
