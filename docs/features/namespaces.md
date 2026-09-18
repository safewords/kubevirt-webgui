# Namespaces

A namespace is this GUI's resource pool: the thing you hand to a team, put a
quota on, grant rights in, and fence off with a firewall. Every VM, disk,
Service and policy lives in exactly one, and cannot be moved to another. Each
namespace has its own screens, reached from the tree or from datacenter →
**Namespaces**.

- [Namespaces as resource pools](#namespaces-as-resource-pools)
- [Summary](#summary)
- [Quotas](#quotas)
- [Permissions](#permissions)
- [Firewall](#firewall)
- [Events](#events)
- [YAML](#yaml)
- [Creating a namespace](#creating-a-namespace)
- [Deleting a namespace](#deleting-a-namespace)
- [Gotchas](#gotchas)

## Namespaces as resource pools

A Proxmox pool groups guests so permissions can be given once. A namespace
does that, and is also the unit of quota, of RBAC, of NetworkPolicy, and of
name uniqueness. The differences that matter in practice:

| | Proxmox pool | Namespace |
|---|---|---|
| Membership | a VM can be in one pool, and moved between them | a VM belongs to one namespace for its whole life; moving it means cloning or recreating it |
| Names | unique per cluster (VMIDs) | unique per namespace, so `web` can exist in three namespaces |
| Storage | any storage the node can reach | a VM can only use disks in its own namespace |
| Limits | none | ResourceQuota and LimitRange |
| Permissions | pool ACLs | Roles, ClusterRoles and RoleBindings |
| Firewall | per-guest and per-cluster rules | NetworkPolicy, selecting pods by label |

The panels a namespace has:

| Panel | What it does | Needs |
|---|---|---|
| **Summary** | what is in the namespace and what it asks for | — |
| **Quotas** | ResourceQuotas and LimitRanges | — |
| **Permissions** | RoleBindings, and what you yourself may do here | — |
| **Firewall** | NetworkPolicy rules | `networking.k8s.io/v1/networkpolicies` |
| **Events** | everything the API server has recorded here | — |
| **YAML** | the Namespace object itself | — |

Which namespaces you see at all depends on your own rights. The server asks
for the namespace list with your credential; when that is refused it answers
with your home namespace instead, and the tree is filled out from what you add
under datacenter → **My settings** → **Extra namespaces**. See
[authentication](../authentication.md).

## Summary

Four cards across the top — **Virtual machines**, **vCPU**, **Memory** and
**Disk capacity** — and then a table of the VMs and one of the persistent
volume claims.

| Card | Counts |
|---|---|
| Virtual machines | every VM in the namespace, split into running and not running; *running* here includes paused and migrating |
| vCPU | `sockets × cores × threads` summed over every VM, with the running ones shown separately |
| Memory | guest memory summed the same way |
| Disk capacity | the claims' actual capacity where the PVC reports one, else what it requested |

These are what the definitions *ask for*, not what the guests use. A namespace
whose VMs are all stopped still shows their full vCPU and memory, because that
is what starting them would need. For what the nodes are actually doing, see
[the datacenter](datacenter.md).

Both tables come from the same watches that feed the tree, so they show what
your credential can list, and nothing else. Opening a row goes to that VM or
disk.

## Quotas

Namespace → **Quotas** shows ResourceQuotas with their usage, and LimitRanges
read-only underneath. **Add quota**, **Edit** and the delete button are greyed
unless `access.review` says you may create, patch or delete `resourcequotas`
here.

With no quota, the panel says so plainly: *No quotas: this namespace may use as
much of the cluster as it can schedule.*

### What the dialog can limit

| Field | Key | What it counts |
|---|---|---|
| CPU requests | `requests.cpu` | cores requested by every pod, launcher pods included |
| CPU limits | `limits.cpu` | CPU limits declared by every pod |
| Memory requests | `requests.memory` | memory requested by every pod |
| Memory limits | `limits.memory` | memory limits declared by every pod |
| Storage requests | `requests.storage` | the total size of every PVC |
| Disks (PVCs) | `persistentvolumeclaims` | how many claims exist |
| Virtual machines | `count/virtualmachines.kubevirt.io` | VM objects, running or not |
| Running VM instances | `count/virtualmachineinstances.kubevirt.io` | VMIs, so running guests |
| Pods | `pods` | pods, of which each running VM uses one |

An empty field means no limit. Editing an existing quota keeps its name and
sends a merge patch, so clearing a field removes that limit rather than setting
it to zero. Values are Kubernetes quantities — `16`, `500m`, `64Gi`, `1Ti` —
and the dialog refuses anything that is not.

The usage table shows Used, Limit and a bar per resource, amber past 75% and
red past 90%. Keys whose name contains `memory` or `storage` are rendered as
bytes; the rest are printed as they are.

### Requests, limits, and why a quota can block everything

Requests and limits are counted separately, and a quota on either one makes
that field compulsory for every pod in the namespace:

- A quota on `requests.cpu` or `requests.memory` requires every pod to declare
  requests. KubeVirt does that by itself, deriving the launcher pod's requests
  from the VM's CPU and memory, so these quotas work out of the box.
- A quota on `limits.cpu` or `limits.memory` requires every pod to declare
  *limits*. Nothing in this GUI writes `domain.resources.limits`, so a VM built
  here has none, and such a quota rejects every VM in the namespace until
  something supplies them. KubeVirt's `AutoResourceLimitsGate` feature gate —
  datacenter → **Options**, described there as *automatic limits from namespace
  quotas* — makes virt-controller fill them in; a LimitRange with a default
  limit does the same for ordinary pods.

### What happens when a VM exceeds a quota

The create wizard finds out before anything is created. **Validate (dry run)**
sends the whole VM to the API server with `dryRun`, and a quota refusal comes
back as `exceeded quota: …` naming the key that ran out. **Finish** refuses the
same way: the wizard stays open so the numbers can be changed, and no task is
started — nothing half-made is left behind.

A quota filled later stops things further in. Starting a VM whose launcher pod
would exceed the quota fails at pod creation, and the refusal appears as a
warning in **Events** rather than on the VM's summary.

A quota that is lowered below what already exists does not evict anything. The
usage bar simply reads over 100% until something is deleted.

### Limit ranges

LimitRanges are listed with their type, resource, Min, Max, Default request,
Default limit and Max limit/request ratio. There is no dialog for them: they
are created and changed outside this GUI. They matter here because a default
limit from a LimitRange is one way to satisfy a `limits.*` quota.

## Permissions

Namespace → **Permissions** has two halves: the RoleBindings that grant rights
in this namespace, and an on-demand answer to *what may I do here*.

The table lists one row per subject of each binding — Subject, Type, Role, Role
kind and Binding — so a binding with three subjects is three rows. Roles whose
names start with `kubevirt.io:` are highlighted.

### Adding a permission

**Add permission** creates a RoleBinding in this namespace, always pointing at
a **ClusterRole**:

| Role | What it is for |
|---|---|
| `kubevirt.io:admin` | Full control of VMs, including consoles, migration and snapshots |
| `kubevirt.io:edit` | Create, change and operate VMs |
| `kubevirt.io:view` | See VMs; no changes, no consoles |
| `admin` | Kubernetes namespace admin, including RBAC in the namespace |
| `edit` | Kubernetes: change most objects |
| `view` | Kubernetes: read most objects |
| Other ClusterRole… | any ClusterRole by name |

The `kubevirt.io:*` roles are installed by KubeVirt, not by this GUI, and their
exact rules are whatever the cluster's copy says — `kubectl describe
clusterrole kubevirt.io:edit` is the honest answer. What they do *not* cover
is everything outside KubeVirt's own API: someone who should also create disks
or upload images generally needs `edit` alongside. The quickest check is the
second half of this panel, below.

Subjects are **User**, **Group** or **ServiceAccount**. A user name is whatever
the API server sees — usually an OIDC email or subject, not a name you choose
here. A ServiceAccount also takes the namespace it lives in, defaulting to this
one. The binding is named for what it grants,
`kve-<role>-<subject>` with `:` and `.` flattened to `-`, truncated to 63
characters, and labelled `app.kubernetes.io/managed-by: kubevirt-webgui`.

Two limits worth knowing before planning around this screen:

- You can only grant permissions you hold yourself. The API server refuses a
  binding that would escalate, and the refusal is shown in the dialog.
- The dialog binds ClusterRoles only. A namespaced Role cannot be selected,
  even through **Other ClusterRole…**, which still writes
  `roleRef.kind: ClusterRole`.

### Removing a permission

**Remove** on a row asks first, and the question depends on the binding: with
other subjects left, only that subject is patched out and the confirmation says
how many keep the role; as the last subject, the whole binding is deleted. The
patch carries the binding's `resourceVersion`, so a binding someone else
changed in the meantime fails rather than clobbering their edit.

Removing a binding takes the right away immediately — the GUI's cached access
answers lag by up to a minute, the API server does not.

### Your access in this namespace

**Show** calls `access.rules` (a `SelfSubjectRulesReview`) and prints the rules
that apply to you here as API groups, resources and verbs. It is filtered to
the core group, KubeVirt and CDI, which is what these screens use; rules for
other groups — `networking.k8s.io`, for instance — are not shown even though
they apply. It is a snapshot, not a live view: **Refresh** asks again.

### What permissions mean for the GUI

The server holds no cluster privileges of its own. Every call is made with the
credential of whoever signed in, so RBAC is the only boundary, and a button the
GUI greys out is one the API server would have refused anyway — the greying
comes from batched `access.review` checks, at most 200 per call. The reverse is
also true: a permission granted here is immediately real for the API, tokens
included. See [authentication](../authentication.md).

Cluster-wide ClusterRoleBindings also apply in this namespace and are not
listed here; they live at datacenter → **Permissions**, together with API
tokens for ServiceAccounts. See [the datacenter](datacenter.md).

## Firewall

Namespace → **Firewall** is the same screen as a VM's **Firewall** panel,
showing every NetworkPolicy in the namespace rather than one VM's. **Default
DROP in** here creates `fw-vms-default-drop-in`, selecting
`kubevirt.io: virt-launcher` — every VM in the namespace, including ones
created later. **Add rule** defaults to all VMs too, and can be narrowed to
one.

The panel is hidden unless `networking.k8s.io/v1/networkpolicies` exists, and
the policies do nothing unless the cluster's CNI enforces them. The details,
including what the rules mean and what they cannot express, are in
[networking](networking.md#firewall).

## Events

Namespace → **Events** lists everything the API server has recorded here,
newest first, with a **Warnings only** checkbox and a filter that matches the
reason, the message, and the involved object's kind and name. The columns are
Last seen (hover for the timestamp), Type, Reason, Object, Message and Count.

This is the first place to look when something did not happen: a pod that
cannot be scheduled, a quota refusal, a CNI that cannot attach a network, a PVC
with no provisioner. The VM screens show the same events narrowed to one
object.

Events are short-lived — the API server drops them after about an hour by
default — so an empty list means nothing recent, not nothing ever.

## YAML

Namespace → **YAML** is the Namespace object itself, in the same editor used
everywhere else: **Edit**, then **Validate (dry run)** to have the API server
check it, **Save** to replace it, or **Discard**. `managedFields` is stripped
from the view, and if the object changes on the server while you are editing, a
warning appears rather than a surprise conflict on save.

This is where labels and annotations without a form are set — the description
this GUI reads (`kubevirt-webgui/description`), scheduling or Pod Security
Admission labels, anything a policy engine in your cluster looks for. Objects
*inside* the namespace are edited from their own YAML panels.

## Creating a namespace

Datacenter → **Namespaces** → **Create**:

| Field | Notes |
|---|---|
| **Name** | Lowercase letters, digits and dashes, up to 63 characters. Cannot be changed afterwards. |
| **Description** | Optional, stored as the `kubevirt-webgui/description` annotation and shown in the Namespaces table. |
| **Labels** | Key/value pairs, added as you like. |

Creating a namespace is a cluster-scoped right; without it the **Create**
button is greyed with *You may not create namespaces*. On success the
namespace list is reloaded and the new namespace opens.

The table also reads `openshift.io/description`, so namespaces made on
OpenShift keep their description here. Namespaces matching the built-in system
pattern — `kube-*`, `kubevirt`, `cdi`, `default`, `cattle-*`, `calico-*`,
`cilium*`, `metallb*`, `traefik`, `longhorn*`, `rook-*` — are marked with a
`system` chip. The chip is a warning, not a guard.

One other place makes namespaces: the **Images** panel offers to create a
shared image namespace, labelled `kubevirt-webgui/purpose: images`. See
[storage](storage.md).

## Deleting a namespace

The red button on a row in datacenter → **Namespaces**. The confirmation names
how many VMs and disks go with it and requires the namespace's name to be typed
out, because there is no undo.

Deleting a namespace deletes everything in it: VMs and their running instances,
DataVolumes and PVCs, Services, NetworkPolicies, RoleBindings, ServiceAccounts,
Secrets and ConfigMaps. PersistentVolumes whose reclaim policy is `Retain`
survive the claims that bound them, released but not reused; everything on a
`Delete` policy goes with the claim. See [storage](storage.md).

Deletion is asynchronous. The namespace enters `Terminating` while its contents
are removed, the delete button is disabled for it while that lasts, and it
disappears from the list when the API server finishes. A namespace that stays
`Terminating` is waiting on a finalizer — most often a resource that cannot
finish cleaning up — and no amount of clicking here will move it along;
**Events** and the object's own YAML say what is holding it.

## Gotchas

- **A quota on `limits.cpu` or `limits.memory` rejects every VM built here**,
  because nothing in this GUI sets limits on a VM. Use `requests.*`, or turn on
  KubeVirt's `AutoResourceLimitsGate`.
- **A tight `pods` quota blocks live migration.** Migration runs a second
  launcher pod alongside the first, so a namespace at its pod limit cannot
  migrate anything even though nothing new is being created.
- **Lowering a quota does not stop what already runs.** It only refuses the
  next thing.
- **Snapshots and clones consume storage quota**, through the PVCs they create,
  under names nobody typed.
- **The Add permission dialog cannot bind a namespaced Role**, only
  ClusterRoles.
- **`Your access` hides rules outside core, KubeVirt and CDI**, so it is not a
  complete answer about what you may do — only about what these screens use.
- **The Firewall panel is missing when the cluster has no NetworkPolicy API**,
  and its policies do nothing when the CNI does not enforce them.
- **Summary totals are requests, not usage.** A namespace showing 96 vCPU may
  be using almost none of it.
- **If you cannot list namespaces**, the Namespaces table shows only the ones
  this browser knows about — your home namespace plus whatever is added under
  **My settings**. Namespaces you have access to but never named stay invisible.
- **Deleting a namespace takes the disks with it.** The type-to-confirm prompt
  is the last check there is.

See also: [networking](networking.md) for the firewall rules themselves,
[storage](storage.md) for what happens to disks and volumes,
[the datacenter](datacenter.md) for cluster-wide permissions and API tokens,
and [authentication](../authentication.md) for whose rights are being used.
