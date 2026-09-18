# Nodes

A node is a hypervisor host: the thing a VM actually runs on. The node screen
shows what it offers guests, what is running there now, and how to take it out
of service without shutting those guests down. Maintenance runs as a task, so
a drain that takes an hour is watchable rather than a spinner.

- [The node tree](#the-node-tree)
- [Summary](#summary)
- [Guests](#guests)
- [Capabilities](#capabilities)
- [Labels & Taints](#labels--taints)
- [Pods](#pods)
- [Conditions](#conditions)
- [Events](#events)
- [YAML](#yaml)
- [Cordon, uncordon and drain](#cordon-uncordon-and-drain)
- [CPU models and migration](#cpu-models-and-migration)
- [Metrics](#metrics)

## The node tree

In Server View the tree is nodes with their guests underneath, which is the
view that answers "what is running where". A node's colour and badge come from
two independent facts:

| Appearance | Condition | Meaning |
|---|---|---|
| Normal | `Ready` is `True`, `spec.unschedulable` unset | online |
| Warning, hinted `maintenance` | `Ready` is `True`, `spec.unschedulable` set | cordoned: still running its guests, taking no new ones |
| Error | `Ready` is not `True` | offline |

Guests running on a node the account cannot list still get a tree entry, built
from the VMIs' `status.nodeName` and greyed out. Without it, a user with
namespace-scoped rights would see their own VMs vanish from the tree. The
screen opens, but with no Node object behind it most panels are empty and the
maintenance actions are disabled.

**Online and offline** are the kubelet's business, from the `Ready` condition.
**`kubevirt.io/schedulable`** is KubeVirt's, and is a separate question: the
label is written by virt-handler on the nodes it has checked and found able to
run virtual machines. A node can be `Ready`, take ordinary pods, and still not
be schedulable for VMs — no KVM device, no virt-handler pod, or virt-handler
reporting the node unhealthy. This is the label the datacenter
[Summary](datacenter.md#summary) counts as "can run VMs", and the one worth
checking first when a VM will not start anywhere.

A node screen lives at `/c/node/<name>/<panel>` and registers these panels:

| Panel | Shows |
|---|---|
| **Summary** | Identity, status, usage gauges and charts |
| **Guests** | The VMs running here |
| **Capabilities** | Resources, devices and the node-labeller's findings |
| **Labels & Taints** | Scheduling policy, editable |
| **Pods** | Every pod on the node, launcher pods marked |
| **USB** | USB devices on this node (atomic-usb plugin; see [USB devices](usb.md)) |
| **Conditions** | Node conditions and system identifiers |
| **Events** | Events about the node and its guests |
| **YAML** | The Node object |

## Summary

The left card is identity: status (`online`, `online (maintenance —
cordoned)`, or `offline`), roles from `node-role.kubernetes.io/*` labels, how
many guests run here, whether the node runs VMs at all, the host CPU model,
every address, the OS image, kernel, kubelet and container runtime versions,
and how long ago the node joined.

The right card is capacity and usage: CPU and memory gauges of current usage
over `status.allocatable`, then raw capacity — CPUs, memory, the pod limit —
and the number of `devices.kubevirt.io/kvm` devices advertised. Allocatable is
used for the gauges rather than capacity because that is what the scheduler
subtracts from.

Below both, two charts plot CPU and memory over time from the `metrics.node`
topic, keeping the last 720 samples.

## Guests

The VMIs whose `status.nodeName` is this node, with vCPU, memory, IP
addresses, uptime and whether each one is live-migratable. The
**Live migratable** column is the `LiveMigratable` condition: when it is not
true the column shows the condition's reason, with the full message on hover.
That is the answer to "why did the drain leave this VM behind", and it is worth
reading before starting one.

Each row has a **Migrate** button, disabled unless the VM is live-migratable
and the account may create migrations in its namespace. **Migrate all** starts
a migration for every live-migratable guest here. It does not cordon the node,
so the scheduler is free to place new VMs here while the old ones leave — the
dialog says so and points at Drain, which is the operation that actually takes
a node out of service.

The scheduler picks the target node. Which nodes are eligible is partly a CPU
question; see [CPU models and migration](#cpu-models-and-migration).

## Capabilities

What this node offers virtual machines.

The **Resources and devices** table merges `status.capacity` and
`status.allocatable` and sorts them into Compute, Huge pages, KubeVirt devices
(`devices.kubevirt.io/*`), Accelerators (NVIDIA, AMD, Intel) and Other devices.
The last column, **Running guests request**, is an approximation and is
labelled as one: the virt-launcher pods' own requests are not visible here, so
the figure is summed from the guests' `spec.domain.resources.requests`
instead. It answers "how full is this node" well enough to plan a drain, and
should not be read as the scheduler's arithmetic.

The **Virtualization** card is the short version: whether the node is
schedulable for VMs, virt-handler's last heartbeat
(`kubevirt.io/heartbeat`), whether KVM is advertised, the host CPU model and
vendor, the TSC frequency and whether it is scalable, and how many AMD SEV
slots are available. A node that is not schedulable for VMs gets a notice at
the top of the panel that distinguishes virt-handler saying no from
virt-handler never having labelled the node at all.

**Discovered capabilities** groups KubeVirt's node-labeller labels; see the
next section but one for what each prefix means. Groups with no members are
not shown, and a node with no node-labeller labels says so — usually because
virt-handler is not running there.

## Labels & Taints

Labels are listed with the automatic ones hidden by default and counted in the
checkbox that reveals them. Automatic means written by the kubelet or by
KubeVirt's node-labeller: `kubernetes.io/`, `node.kubernetes.io/`,
`topology.kubernetes.io/`, `*.node.kubevirt.io/`,
`feature.node.kubernetes.io/`, `kubevirt.io/schedulable`, the CPU-manager and
KSM labels, and the control-plane and etcd roles. They are shown with a lock
icon and can still be removed, but the dialog warns that the next labeller pass
will put them back. Editing them by hand only confuses the scheduler, which is
why they are out of the way by default.

Adding a label patches the Node; keys and values are validated against
Kubernetes' own rules before the button enables.

Taints are the other half of scheduling policy:

| Effect | What it does |
|---|---|
| `NoSchedule` | Nothing new is placed here unless it tolerates the taint |
| `PreferNoSchedule` | The scheduler avoids the node when it can |
| `NoExecute` | Also evicts pods already here that do not tolerate it |

> **`NoExecute` is destructive.** It evicts every pod on the node that does not
> tolerate it, including virt-launcher pods, and a VM evicted this way is shut
> down rather than migrated. The GUI asks for confirmation in those words
> before adding one. To empty a node without losing guests, use
> [Drain](#cordon-uncordon-and-drain).

Both tables need `patch` on `nodes`; without it the panel is read-only and says
so.

## Pods

Every pod with `spec.nodeName` equal to this node, watched with a field
selector so the list is the node's own rather than filtered in the browser.
The selector at the top splits them into all pods, VM launcher pods (labelled
`kubevirt.io=virt-launcher`) and everything else.

Columns are Namespace, Pod, VM, Status, Ready, Restarts, IP, Owner and Age.
The **VM** column links to the virtual machine a launcher pod belongs to, read
from `vm.kubevirt.io/name` or `kubevirt.io/domain`. **Status** prefers a
container's waiting reason over the pod phase, so `ImagePullBackOff` or
`CrashLoopBackOff` is shown instead of a uniformly unhelpful `Pending`, and a
pod being deleted reads `Terminating`.

Listing pods cluster-wide is a permission some accounts lack; the panel then
shows the API server's refusal rather than an empty table.

## Conditions

The node's conditions, with `MemoryPressure`, `DiskPressure`, `PIDPressure`,
`NetworkUnavailable`, `KernelDeadlock` and `ReadonlyFilesystem` counted as good
when false — the inverse of `Ready`, and the reason a plain green/red reading
of Kubernetes conditions misleads.

Underneath, the identifiers that matter when a node misbehaves: machine ID,
system UUID, boot ID (which changes on every reboot, so it tells you whether
the node has restarted), architecture and operating system, container runtime,
kube-proxy version, pod CIDRs, how many container images are cached, when the
node was created, and whether it is schedulable.

## Events

Events about this node and, optionally, about the guests running on it. The
node's own events are matched three ways: an involved object of kind `Node`
with this name, `source.host` equal to this node, or `reportingInstance` equal
to it — kubelet events are attributed the second and third way rather than the
first, so matching only on the involved object would miss most of them.

**Include guests on this node** is on by default and adds events for the VMs
and VMIs currently placed here. Kubernetes keeps events for about an hour.

## YAML

The Node object as the API server has it, read-only, with `managedFields`
stripped.

## Cordon, uncordon and drain

Three actions in the header's power group. Cordon and Uncordon share a place —
whichever applies to the node's current state is the one shown.

| Action | Gateway method | Needs |
|---|---|---|
| **Cordon** | `node.cordon` | `patch` on `nodes` |
| **Uncordon** | `node.uncordon` | `patch` on `nodes` |
| **Drain (maintenance mode)** | `node.drain` | `patch` on `nodes`, `create` on `kubevirt.io/virtualmachineinstancemigrations` |

**Cordon** patches `spec.unschedulable: true` and nothing else. Running VMs
and pods keep running; nothing new is placed here until the node is uncordoned.
The confirmation says exactly that, because "cordon" is often mistaken for
"evacuate". **Uncordon** patches it back and does not ask.

### What drain does

Drain is the evacuation, and it is deliberately not `kubectl drain`. It runs
as a [task](tasks.md) with `openLog` set, so the log opens as it starts, and it
logs a line per guest:

1. Cordons the node — the same patch as **Cordon**, so nothing new lands there
   while the evacuation runs.
2. Lists the VMIs on the node with the label selector
   `kubevirt.io/nodeName=<node>` and logs how many there are.
3. For each guest whose `LiveMigratable` condition is `True`, creates a
   `VirtualMachineInstanceMigration` in the guest's namespace with
   `generateName: <vm>-drain-`. The VM is moved, not stopped: memory is copied
   to the target host and the guest keeps running across the switch.
4. For each guest that is not live-migratable, logs the condition's message —
   or `not live-migratable` when there is no such condition — and counts it as
   stuck. Nothing is shut down to get it off the node.
5. Polls every migration every 3 seconds until it reports `Succeeded` or
   `Failed`, logging each result. Failed migrations count as stuck. If
   migrations are still running after **3 hours** the task ends with a 504 and
   the message `migrations did not finish within 3 hours`.
6. Finishes with `<node> drained`, or, if anything was stuck, with a 409 and
   `N guest(s) could not be moved off <node>`.

The node is left cordoned either way. That is the point of maintenance mode:
an evacuated node that quietly became schedulable again would fill up while the
host was still being worked on. Uncordon it when the work is done.

The confirmation dialog is built from the same facts before anything happens.
It names how many guests run on the node and, if any of them cannot live-
migrate, names those VMs and says they will stay until handled. A VM that
refuses to migrate usually has a reason that no amount of retrying fixes — a
disk with `ReadWriteOnce` access on non-shared storage, a host device or GPU
passed through, an unmigratable network binding, or a CPU model the other nodes
do not offer.

### Also evict other pods

An option on the dialog, off by default. With it on, after every migration has
finished, drain walks the pods on the node and evicts them through the
**Eviction API** (`policy/v1 Eviction` on each pod's `eviction` subresource),
so PodDisruptionBudgets are respected and a refusal is a refusal rather than a
deletion. Three kinds of pod are skipped outright:

| Skipped | Why |
|---|---|
| DaemonSet-owned pods | The DaemonSet would immediately recreate them on the same node |
| Mirror pods (`kubernetes.io/config.mirror`) | Static pods are the kubelet's, not the API server's, to remove |
| Pods in `Succeeded` or `Failed` | Already finished; evicting them achieves nothing |

A pod that cannot be evicted is logged and the drain carries on; it does not
count as stuck. Note that the eviction permission is not part of the access
check that enables the Drain button, so with the option on and no `create` on
`pods/eviction` the migrations still succeed and every eviction is logged as
refused.

### Permissions in full

The server acts as the signed-in user, so a drain needs, in that user's own
rights: `patch` on `nodes`; `list` on `virtualmachineinstances` cluster-wide;
`create` on `virtualmachineinstancemigrations` and `get` on them in each
guest's namespace; and, with pod eviction on, `list` on `pods` cluster-wide and
`create` on `pods/eviction`. Only the checks in the table above disable the
button — it greys out with the title "You do not have permission for this" —
and the rest surface as errors in the task log.

## CPU models and migration

KubeVirt's node-labeller writes what it finds on each host onto the Node as
labels, and [Capabilities](#capabilities) groups them:

| Prefix | What it holds |
|---|---|
| `host-model-cpu.node.kubevirt.io/` | The model libvirt reports for `host-model` VMs on this node |
| `cpu-model.node.kubevirt.io/` | Named models a VM may request here |
| `cpu-model-migration.node.kubevirt.io/` | Models a VM can migrate *into* this node with |
| `cpu-feature.node.kubevirt.io/` | Flags a VM can require or forbid |
| `host-model-required-features.node.kubevirt.io/` | Features a `host-model` VM from this node needs on its target |
| `machine-type.node.kubevirt.io/` | QEMU machine types available |
| `hyperv.node.kubevirt.io/` | Hyper-V enlightenments, for Windows guests |
| `cpu-timer.node.kubevirt.io/` | TSC frequency and whether it is scalable |
| `scheduling.node.kubevirt.io/` | Constraints KubeVirt schedules by |
| `cpu-vendor.node.kubevirt.io/` | Intel or AMD |

These labels are why a mixed cluster limits where a VM can go. A running guest
cannot change its CPU while it migrates, so the target host must be able to
present the same CPU the guest already sees. In practice:

- A VM using `host-model` took its CPU from the node it started on. It can
  only migrate to a node whose `cpu-model-migration.node.kubevirt.io/` labels
  include that model and whose CPU features cover this node's
  `host-model-required-features.node.kubevirt.io/` list. On a cluster of two
  CPU generations that usually means the newer machines can send guests to the
  older ones and not the other way round.
- A VM that names a model explicitly can go to any node advertising that model
  under `cpu-model.node.kubevirt.io/`, which is what naming an older baseline
  model buys: a smaller CPU in exchange for the whole cluster as a target.
- A VM using `host-passthrough` sees the host CPU exactly and is generally not
  live-migratable at all. It shows as such in [Guests](#guests) and drain
  leaves it where it is.
- Machine types matter the same way. A guest pinned to a machine type the
  target does not list under `machine-type.node.kubevirt.io/` cannot land
  there. The cluster-wide default is set under
  [Options](datacenter.md#options).

The consequence for maintenance is worth stating plainly: check
[Guests](#guests) before draining. If the cluster's spare capacity is all on
nodes with an incompatible CPU, the migrations will be created and then fail,
and the drain will end with guests still on the node.

## Metrics

Usage figures come from metrics-server through two gateway topics:

| Topic | Source | Interval |
|---|---|---|
| `metrics.node` | `metrics.k8s.io/v1beta1/nodes/<name>` | 5 s |
| `metrics.nodes` | `metrics.k8s.io/v1beta1/nodes` | 10 s |

`metrics.node` backs the node's own gauges and charts; `metrics.nodes` backs
the node tables on the datacenter [Summary](datacenter.md#summary) and
[Nodes](datacenter.md#nodes) panels, and records every node's sample so that
opening one node's screen already has history behind it.

The server keeps a short history in memory and sends it when a subscription
starts — but only after the subscriber's own fetch has succeeded, so history is
never shown to someone who could not read the object now. Samples carrying a
timestamp already seen are dropped rather than plotted: metrics-server refreshes
roughly every 15 seconds, and re-sending the same window would draw a flat step
that looks like real idle time.

**Without metrics-server** nothing here breaks, it simply goes blank. The
Metrics extension declares `metrics.k8s.io/v1beta1/pods`, so
[Extensions](datacenter.md#extensions) marks it "cluster lacks its APIs"; the
node tables show `—` in their CPU and memory columns; the gauges show no value
rather than zero; and the datacenter Nodes panel prints the error once at the
top. Capacity, allocatable, guest counts and everything else on these screens
come from the Node and VMI objects and are unaffected.

A subscription that is refused with 403 ends with that error — a user who may
not read node metrics is told so. Other errors are reported to the panel and
the topic keeps polling, so a metrics-server that is restarting recovers on its
own.
