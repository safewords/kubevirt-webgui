# Networking

A VM here runs inside a pod, so its network is the pod's network: an address
from the cluster's CNI, a Service to reach it from elsewhere, a NetworkPolicy
to fence it in. Secondary networks — VLANs and host bridges, Proxmox's
`vmbrN` — come from Multus, when it is installed. These screens manage all
three, and none of them invent a network of their own.

- [How a VM gets a network](#how-a-vm-gets-a-network)
- [Networks, at datacenter level](#networks-at-datacenter-level)
- [The Network panel](#the-network-panel)
- [Adding and editing a network device](#adding-and-editing-a-network-device)
- [Services](#services)
- [Firewall](#firewall)
- [Gotchas](#gotchas)

## How a VM gets a network

Every network device is two entries in the VM's template, joined by a name:

| Where | What it says |
|---|---|
| `spec.template.spec.domain.devices.interfaces[]` | the card the guest sees — `name`, `model`, `macAddress`, and the binding |
| `spec.template.spec.networks[]` | where that card plugs in — `pod: {}` or `multus: { networkName: … }` |

The GUI always writes both together. A name in one list and not the other is
what a `—` in the **Network** column, or a `no network` in **Hardware**, is
telling you.

### Pod network or Multus

| Network | Written as | The guest's address |
|---|---|---|
| Pod network | `pod: {}` | Comes from the cluster's CNI, through the launcher pod. With `masquerade` the guest sees a private address on a link KubeVirt manages and the pod's own IP is what leaves the node; with `bridge` the pod's IP is handed to the guest itself. |
| Multus attachment | `multus: { networkName: … }` | Comes from the attachment — a DHCP server on the VLAN, the plugin's own IPAM, or static configuration inside the guest. KubeVirt does not assign it and does not report it unless the guest agent does. |

Only one interface may use the pod network. The dialog refuses a second with
*Only one interface can use the pod network*, and the **Network** option for it
is greyed as `Pod network (in use)`.

The create wizard's **Network** step writes at most two of these: `default` on
the pod network with the binding chosen there, and `secondary`, bridged, for a
NetworkAttachmentDefinition in the VM's namespace. A VM created with **No
network device** and no secondary network also gets
`domain.devices.autoattachPodInterface: false`, so KubeVirt does not quietly
add one back.

### Bindings

| Binding | Where it is offered | What it means for the guest |
|---|---|---|
| `masquerade` | pod network only | The guest gets a private address and its traffic is NAT'd to the pod's IP. `networks[].pod.vmNetworkCIDR` overrides the range, and the **Network** panel shows it in brackets when it is set. The default, and the only binding that survives the guest's address changing under it. |
| `bridge` | pod network or Multus | The guest takes the address of the link it is on. On the pod network that is the pod's own IP, which **blocks live migration**; on a Multus attachment it is whatever that L2 segment hands out. |
| `passt` | either | Userspace networking, no bridge. KubeVirt has been moving `passt` from a core binding to a network binding plugin; on a cluster where the core binding is gone, saving the device fails and the API server's message appears in the dialog. |
| `sriov` | Multus only | A virtual function is assigned to the guest. Needs an SR-IOV device plugin and an attachment with a `k8s.v1.cni.cncf.io/resourceName` annotation. |

`slirp` and `macvtap` are displayed if a VM already uses them, and so is a
binding plugin (as `plugin: <name>`), but the dialog does not offer them. See
[Gotchas](#gotchas) before editing such a device.

### MAC addresses

Leave **MAC address** empty and KubeVirt assigns one when the instance is
created. That address lives in the running instance, not in the VM's
definition, so it can differ after the VM is deleted and recreated — anything
pinned to a MAC (DHCP reservations, licences tied to hardware) wants an address
written down instead. Type one and it is stored as `interfaces[].macAddress`,
lowercased, with `-` accepted for `:`. The **Network** panel marks a MAC fixed
that way with a star and says so in the cell's tooltip.

## Networks, at datacenter level

Datacenter → **Networks**, under the **Network** heading in the datacenter
menu. It answers two questions: what secondary networks exist, and what is
exposed.

**Secondary networks** lists NetworkAttachmentDefinitions:

| Column | Where it comes from |
|---|---|
| Network / Namespace | the object's name and namespace |
| CNI plugin | `type` in `spec.config`, or the `type` of its first `plugins[]` entry |
| Bridge / device | the plugin's `bridge`, `master`, `device` or `ipam.type`, plus `· VLAN n` when the config sets one |
| Resource | the `k8s.v1.cni.cncf.io/resourceName` annotation, for SR-IOV and other device-plugin networks |
| VMs | how many VMs name this attachment, matching either `name` or `namespace/name` |

Config that is not JSON shows as `invalid JSON` rather than being hidden.

If `k8s.cni.cncf.io` is not in the API server's discovery, the table is
replaced by a notice saying Multus is not installed: every VM then gets the pod
network and nothing else.

**Services exposing VMs** lists every Service in reach whose selector names a
single VM, through `vm.kubevirt.io/name` or `kubevirt.io/vm` — so Services made
by `virtctl expose`, by this GUI, or by hand all appear. Opening a row goes to
that VM's **Services** panel.

Both tables watch cluster-wide when `access.review` says you may list the
resource, and fall back to your reachable namespaces when it does not. A
network in a namespace you cannot see is simply absent.

## The Network panel

VM → **Network** is a read-only view of what is configured and what the guest
reports. Its rows are the union of the configured interfaces and the ones the
running instance reports, so a device attached outside the GUI still shows up.

| Column | What it shows |
|---|---|
| Device | the `name` that joins the interface to its network |
| Binding | `masquerade`, `bridge`, `sriov`, `passt`, `slirp`, `macvtap`, or `—` |
| Network | `pod network`, with the CIDR when `vmNetworkCIDR` is set, or `Multus <name>` |
| Model | `virtio` unless the device says otherwise |
| MAC address | reported by the instance, else the configured one; starred when fixed in the definition |
| IP addresses | what the instance reports; `not running` with no instance, `none reported` with one |
| In guest | the interface name inside the guest, e.g. `eth0` — guest agent only |
| Link | `up`, `down`, or the configured `state` |
| Reported by | KubeVirt's `infoSource`, e.g. `domain, guest-agent` |

Below the table, **Declared ports** appears when any interface carries a
`ports:` list, and **Guest-only interfaces** lists addresses the guest agent
reports for interfaces the VM does not define — bridges made inside the guest,
container networks, VPNs. A notice points out that guest interface names and
extra addresses only arrive once the QEMU guest agent runs; see
[virtual machines](virtual-machines.md).

## Adding and editing a network device

Network devices are edited from VM → **Hardware**: **Add** → **Network
Device**, or **Edit** / **Remove** on a `Network Device (name)` row.

| Field | Notes |
|---|---|
| **Name** | The device name, fixed once created. Defaults to the first free `net0`, `net1`, … |
| **Model** | `virtio` (paravirtualized), `e1000e`, `e1000`, `rtl8139`. The create wizard offers only the first two. |
| **Network** | **Pod network** or **Multus attachment**. Multus is greyed as *(Multus not installed)* when `k8s.cni.cncf.io` is absent from discovery. |
| **Binding** | Masquerade (NAT), Bridge, passt, SR-IOV, each greyed where it does not apply. |
| **Network attachment definition** | Multus only. `name`, or `namespace/name` to borrow an attachment from another namespace; the suggestion list holds the attachments in the VM's own namespace. |
| **MAC address** | Empty means KubeVirt assigns one. |
| **Disconnect (link down)** | Writes `state: down`: the card exists, the cable does not. |

The dialog refuses to save while any of these hold: the name is not a DNS label
or is already used; a second interface asks for the pod network; a Multus
device has no attachment named; `masquerade` is chosen with a Multus
attachment; or the MAC is not `aa:bb:cc:dd:ee:ff`.

### What takes effect when

Nothing here hot-plugs. The dialog patches `spec.template.spec`, which is the
definition of the *next* instance:

| Change | When it applies |
|---|---|
| Adding a device | at the next restart; **Hardware** marks the row pending until then |
| Changing model, MAC, binding, network or link state | at the next restart |
| Removing a device | at the next restart — the confirmation says so |

The GUI hot-plugs disks (`vm.volume.add`, `vm.volume.remove`) and has no
equivalent for interfaces. A guest that must gain a network without downtime
has to be restarted anyway.

The patch is built from the VM as it is at the moment of saving, not as it was
when the dialog opened, and a `409` conflict in the narrow window between the
two is retried against the newer object. Two people editing different devices
of the same VM therefore do not overwrite each other.

## Services

VM → **Services** lists the Services in the VM's namespace that select this VM,
with **Expose** to make another. This is `virtctl expose` as a dialog: it
creates a Service in front of the VM's launcher pod, and nothing else.

The table shows Service, Type, Cluster IP, Ports, External address and Age.
Ports read as `port→targetPort/PROTOCOL (node 3xxxx)`, with the arrow left out
when the two ports match. A **Connect** card underneath lists the endpoints
worth copying, with a copy button each:

| Endpoint | When |
|---|---|
| `<service>.<namespace>.svc:<port>` | always — the in-cluster name |
| `<external address>:<port>` | a LoadBalancer with an address, or `externalIPs` |
| `<node address>:<nodePort>` | NodePort and LoadBalancer, using the first node's external address, or its internal one when it has none |

Deleting is the trash button in the **External address** column, with a
confirmation naming what stops being reachable. **Expose** and delete are
greyed when `access.review` says you may not create or delete Services here.

### The Expose dialog

| Field | Notes |
|---|---|
| **Service name** | Must be a DNS label. Defaults to `<vm>-ssh`, and follows the first preset you pick. |
| **Type** | `ClusterIP` — inside the cluster; `NodePort` — on every node's address; `LoadBalancer` — its own external address. |
| **Requested address (optional, MetalLB)** | LoadBalancer only. Writes the annotation `metallb.universe.tf/loadBalancerIPs`; empty means the pool decides. |
| **Ports** | Name, Port, Guest port, Protocol (TCP/UDP/SCTP) and, for NodePort and LoadBalancer, Node port. The presets SSH, RDP, HTTP, HTTPS and VNC (guest) add 22, 3389, 80, 443 and 5900. |

A live YAML preview of the Service sits beside the form. What it creates is a
plain Service with `selector: { vm.kubevirt.io/name: <vm> }` and the labels
`app.kubernetes.io/managed-by: kubevirt-webgui` and
`kubevirt-webgui/exposes: <vm>`. **Create service** stays disabled while the
name is not a DNS label, there are no ports, a port is outside 1–65535, a node
port is outside 30000–32767, a port name is not a DNS label, or two port names
collide.

Two things are worth knowing before exposing anything:

- The Service selects the **launcher pod**, not the guest. With masquerade
  binding those are the same address and it works. With bridge binding the
  guest holds the address instead, and the Service may route to nothing — the
  dialog says so in a notice.
- `LoadBalancer` needs a controller to fulfil it. Without MetalLB or a cloud
  provider, the external address stays `pending…` forever and nothing in the
  cluster will change that.

VNC in the preset list is the guest's own VNC server on 5900, not KubeVirt's
console — the console goes over the GUI's WebSocket and needs no Service. See
[virtual machines](virtual-machines.md).

## Firewall

VM → **Firewall** and namespace → **Firewall** are the same screen: a list of
NetworkPolicy rules, laid out the way a Proxmox firewall lists them. The VM
version narrows it to the policies that apply to that VM. Both panels are
hidden entirely unless `networking.k8s.io/v1/networkpolicies` is in discovery.

Each rule of each policy is one row:

| Column | What it holds |
|---|---|
| Direction | `IN` for an Ingress rule, `OUT` for an Egress one |
| Applies to | the policy's `podSelector`, read back as `all pods`, `all VMs`, `VM <name>`, or the raw labels |
| Source / destination | the rule's peers: a CIDR with its exceptions, `ns <name>`, a pod selector, or `any` |
| Ports | `TCP/22`, `UDP/53`, `TCP/8000-8080`, or `all ports` |
| Policy | the NetworkPolicy's name |
| Comment | the `kubevirt-webgui/comment` annotation, if there is one |

A policy that names a direction in `policyTypes` but has no rules for it gets a
row reading `DROP all (no allow rules)`. An empty table means what it says: *No
policies: all traffic is allowed (policy ACCEPT)*.

Per row there is a YAML button, which opens the policy in the same editor as
everywhere else — **Edit**, **Validate (dry run)**, **Save**, **Discard** —
and a delete button that removes the whole policy, rules and all.

### Default DROP in

**Default DROP in** creates one policy with `policyTypes: [Ingress]` and no
rules, selecting either `vm.kubevirt.io/name: <vm>` (from a VM's panel) or
`kubevirt.io: virt-launcher` (from a namespace's), named
`fw-<vm>-default-drop-in` or `fw-vms-default-drop-in`. Everything incoming is
then dropped except what other policies allow. It changes nothing about egress.

### Add rule

| Field | Notes |
|---|---|
| **Direction** | `IN (ingress)` or `OUT (egress)`. |
| **Action** | Fixed at `ACCEPT` and disabled: NetworkPolicy has no deny rules. |
| **Applies to** | All VMs in the namespace (`kubevirt.io: virt-launcher`) or one VM (`vm.kubevirt.io/name`). |
| **Source** / **Destination** | One or more peers: **Any**; **IP / CIDR** with an optional comma-separated except list; **Namespace**, matched on `kubernetes.io/metadata.name`; **Pods with labels**, as `app=web,tier=frontend`; or **VM in \<namespace\>**. |
| **Ports** | Protocol and port, a range like `8000-8080`, a named port, or empty for every port. Presets: SSH, RDP, HTTP, HTTPS, DNS, VNC. |
| **Rule name** | A DNS label; defaults to `fw-<vm|vms>-in-<random>`. |
| **Comment** | Stored as the `kubevirt-webgui/comment` annotation and shown in the table. |

The generated NetworkPolicy is rendered beside the form as you type. The
dialog states the rule that surprises people: as soon as *any* policy selects a
VM for a direction, everything not allowed in that direction is dropped —
adding one allow rule is what turns the firewall on. For egress that includes
DNS, so a rule allowing UDP 53 is usually needed next to whatever you meant to
allow. NetworkPolicy has no ICMP rules at all; whether ping works is up to the
CNI.

### What actually enforces this

The API server accepts NetworkPolicies whatever CNI is installed. Only a CNI
that implements them enforces them — Calico, Cilium, Antrea and similar. With
one that does not, the policies are created, the panel lists them, and no
packet is ever dropped. Nothing in the GUI can detect the difference, so a
firewall you rely on is worth proving once with a client pod, the way
`web/e2e/network.test.mjs` does.

Policies match the launcher pod's labels, not the guest. With masquerade the
guest's traffic *is* the pod's traffic, so a rule applies as expected. Traffic
on a Multus secondary interface never touches the pod's primary interface, so
NetworkPolicy does not see it at all.

## Gotchas

- **Multicast and mDNS do not cross masquerade NAT.** Avahi/Bonjour, SSDP,
  Windows network discovery, cluster heartbeats that rely on broadcast: none of
  them find anything from behind the pod network's NAT, and they fail quietly
  rather than with an error. A protocol that depends on discovery needs a
  bridged Multus attachment on a real L2 segment.
- **A node without the bridge named in the attachment cannot run the VM.**
  A NetworkAttachmentDefinition naming `br0` is a promise about every node; on
  a node without it, the CNI refuses the launcher pod and it never leaves
  `ContainerCreating`. The reason is in the namespace's **Events**, not on the
  VM's summary. Either configure the bridge on every node, or pin the VM with
  **Node placement** in VM → **Options**.
- **Bridge on the pod network blocks live migration.** The guest holds the
  pod's address, and that address cannot move to another node.
- **Editing a device with an unusual binding rewrites it.** The dialog offers
  masquerade, bridge, passt and SR-IOV. A device using `slirp`, `macvtap` or a
  binding plugin is shown as `bridge` when opened for editing, and saving makes
  that true. Edit those in YAML instead.
- **`interfaces[].ports` is not a firewall the GUI writes.** The **Declared
  ports** card shows the field for VMs that have it; nothing in this GUI sets
  it. With masquerade binding, a non-empty list limits what KubeVirt forwards
  into the guest, which can look exactly like a firewall dropping traffic.
- **A LoadBalancer Service without a controller never gets an address.** The
  panel shows `pending…` and means it.
- **The Firewall panels vanish without the NetworkPolicy API**, and do nothing
  without a CNI that enforces policies.
- **A VM's Firewall panel can under-report.** It shows policies whose selector
  is empty, is `kubevirt.io: virt-launcher`, or names that VM. A policy that
  matches the launcher pod by some other label — `app=web`, or a
  `matchExpressions` selector — applies to the VM but is not listed there. The
  namespace's **Firewall** shows every policy.
- **Deleting a Service does not tell the guest.** Existing connections are cut
  when the endpoints go, and the guest sees a reset, not a shutdown.

See also: [namespaces](namespaces.md) for the firewall at namespace scope and
who may change it, [virtual machines](virtual-machines.md) for the guest agent
and consoles, and [configuration](../configuration.md) for what the server
itself needs.
