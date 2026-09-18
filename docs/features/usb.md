# USB devices

A USB device plugged into one node, attached to a VM running on another. This
is [atomic-usb](https://github.com/safewords/kubevirt-atomic-usb) — a separate
project, not part of the GUI — and every USB screen described here appears only
when its CRDs are installed.

- [What the integration is](#what-the-integration-is)
- [The device inventory](#the-device-inventory)
- [Attaching a device to a VM](#attaching-a-device-to-a-vm)
- [Migration, unplugging and moving between nodes](#migration-unplugging-and-moving-between-nodes)
- [Detaching](#detaching)
- [Claims](#claims)
- [Boot hold](#boot-hold)
- [Permissions](#permissions)

## What the integration is

atomic-usb discovers what is plugged into each node, publishes it as Kubernetes
objects, and forwards a chosen device over the pod network into the usbredir
sockets KubeVirt gives a VM. Two custom resources carry the whole model:

| Resource | Scope | What it is |
|---|---|---|
| `UsbDevice` | cluster | one device found plugged into a node |
| `UsbDeviceClaim` | namespaced | "this VM wants that device", and the record of whether it has it |

Both live in `atomicusb.safewords.io/v1alpha1`. The GUI adds a browser plugin
(`web/src/plugins/atomic-usb`) and a server extension
(`src/extensions/atomic_usb.rs`) for them, and both are optional:

- **In the browser**, the plugin requires
  `atomicusb.safewords.io/v1alpha1/usbdeviceclaims`, and its datacenter, node
  and tree screens additionally require `usbdevices`. Discovery is re-read
  every minute, so installing the chart makes the panels appear without a
  reload, and uninstalling it withdraws them and stops the watches.
- **On the server**, `usb.attach` and `usb.detach` answer `ExtensionUnavailable`
  — "atomic-usb is not available: this cluster does not serve
  atomicusb.safewords.io/v1alpha1/usbdeviceclaims" — rather than a bare 404.
  Discovery is rescanned before refusing, so a CRD installed a moment ago is
  picked up.

The extension can also be switched off with its APIs present, by listing
`atomic-usb` in `GUI_DISABLED_EXTENSIONS` (see
[configuration](../configuration.md)).

Two things are true of atomic-usb whatever the GUI does with it, and both are
repeated on the Datacenter screen: **USB traffic is forwarded over the pod
network without encryption**, and **anyone who may create a `UsbDeviceClaim`
can take any device on any node**. There is no per-device authorisation.

## The device inventory

The same inventory is shown three ways:

| Where | Panel | Shows |
|---|---|---|
| Datacenter | **USB Devices**, group **Hardware** | every device in the cluster, plus every claim |
| A node | **USB** | the devices plugged into that node |
| Tree selector | **USB View** | Datacenter → node → the devices plugged into it |

The datacenter panel opens with five counters: **Devices**, **Available**,
**Attached**, **Nodes with devices** and **Claims waiting** — the last one
counts claims whose phase is not `Attached`, and is amber while any are.

The device table has these columns. The node's own panel drops **Node**,
because it is the node you are looking at.

| Column | Comes from | What it means |
|---|---|---|
| **Device** | `spec.product`, else `spec.manufacturer`, with `spec.vendorId:spec.productId` | what the device says it is. A device that reports neither shows only the two IDs. |
| **Serial** | `spec.serial` | the serial the device reports, if any. This is what decides whether a claim can follow the device — see [attaching](#attaching-a-device-to-a-vm). |
| **Class** | `status.deviceClass`, else `status.interfaceClasses` joined | the USB class, which is the quickest way to tell a storage device from a radio. |
| **Node** | `status.node` | the node it is physically plugged into. |
| **Port** | `status.portPath` | the port path on that node, which is how you tell two identical devices apart when neither has a serial. |
| **Identity** | `spec.identity` | how atomic-usb can recognise this device again. Only a value beginning `Serial` is stable enough to follow across re-plugs. |
| **Phase** | `status.phase` | `Available` is shown green, `Lost` red, anything else (including `Unplugged`) amber. |
| **Last seen** | `status.lastSeen` | how long ago atomic-usb last saw the device, as "3m ago". |
| **Attached to** | `status.attachedTo` | `namespace/vmName`, linked to that VM's **USB Devices** panel. Empty when the device is free. |

Device objects are named by atomic-usb, not by you — `usb-8087-0029-23f66d18`
is a real one. The name is what a non-following claim pins itself to.

In the **USB View** tree, each node lists its devices with the count as a hint.
An attached device shows `→ <vm>` and opens that VM's USB panel; a free one
shows its port path and opens the node's. A device whose `status.node` is empty
is filed under `(unplugged)`, which is where a device that has been pulled out
ends up.

## Attaching a device to a VM

There are several ways in, and all of them end in the same `usb.attach` task:

- the **Attach** button on a row of the VM's **USB Devices** panel — or a
  double-click on the row — which attaches that device to the VM you are
  looking at, after a confirmation;
- **Attach USB device…** in the VM's **More** menu, which opens the dialog with
  that VM pre-chosen;
- **Attach** on a row of the datacenter or node device table, which opens the
  dialog with that device pre-chosen;
- **Attach device to VM** on the datacenter panel, which opens the dialog with
  nothing chosen.

### `devices.clientPassthrough` comes first

KubeVirt only creates the usbredir sockets on a VM's virt-launcher pod when the
VM asks for them, with
`spec.template.spec.domain.devices.clientPassthrough`. atomic-usb plugs into
exactly those sockets, so without the field there is nothing to plug into and a
claim for that VM sits in `VMNotConfigured` indefinitely — it does not fail,
it waits.

The VM's USB panel therefore leads with a warning when the field is missing,
and an **Enable** button that patches it in for you (`{}` — the field's mere
presence is the setting). The button needs `patch` on the VM and is greyed out
without it. Every **Attach** button on that panel is disabled until the field
is set.

The gotcha is the running instance. Adding `clientPassthrough` to a VM changes
the definition, not the pod that is already running: KubeVirt builds the
sockets when the virt-launcher pod is created. The panel compares the VM
template against the running VMI and says so — "USB redirection is enabled in
the definition but the running instance predates it. Restart the VM to attach
devices." Restart the VM before attaching; nothing else clears it.

Importing from Proxmox handles this ahead of time: the wizard ticks **Allow USB
passthrough, to attach the device after import** when the source VM had USB
passthrough, and tells you that the passthrough itself is not moved. See
[proxmox-import.md](proxmox-import.md).

### The dialog

| Field | Notes |
|---|---|
| **Device** | free devices, plus the one you started from. A device that is not `Available` is listed with its phase and cannot be chosen. |
| **Virtual machine** | `namespace/name` from the inventory. |
| **Claim name** (optional) | must be a DNS label. Left empty it is `<vm>-<device>`, cut to 63 characters with any trailing `-` removed. |
| **Follow the device by serial number** | on by default. Only selectable when the device has a serial *and* its `spec.identity` begins `Serial`; otherwise the box is disabled and reads "This device has no usable serial; it is pinned by name." |

The choice writes different selectors into the claim, and this is the decision
that matters later:

| Follow | `spec.selector` | Consequence |
|---|---|---|
| on | `vendorId`, `productId`, `serial` | the claim re-attaches the device wherever it is plugged in, on any node |
| off, or no usable serial | `vendorId`, `productId`, `deviceName` | the claim is pinned to that one `UsbDevice` object |

When the device is on a different node from the VM, the dialog says so before
you commit: "The device is on `<node>` and the VM runs on `<node>`: USB traffic
is forwarded over the pod network (unencrypted)."

### What the task does

`usb.attach` refuses immediately, with 409 "the device is already claimed by
`<claim>`", if `status.attachedTo.claim` is already set. Otherwise it creates
the `UsbDeviceClaim`, logs `created UsbDeviceClaim <name>`, and then polls the
claim every two seconds for up to three minutes, logging
`<phase>: <message>` each time either changes. Reaching `Attached` ends the
task with "device attached".

Running out of the three minutes is not a failure. The task ends OK with "claim
created; the device will attach when it and the VM are available", because the
claim is a standing request — see [claims](#claims). The task log dialog opens
by itself for this operation; see [tasks.md](tasks.md).

## Migration, unplugging and moving between nodes

The GUI models none of this itself. It shows what the atomic-usb controller
puts in `status`, and two columns are worth watching:

| Column | Field | Reads |
|---|---|---|
| **Path** | `status.sourceNode` → `status.connection.node` | the node the device is plugged into, then the node the guest is on |
| **Connection** | `status.connection.state` | `Connected` when the forwarding is up |

**Live migration.** The claim and the device lease are Kubernetes objects and
are not tied to the virt-launcher pod, so neither is lost when the VM moves.
The right-hand side of **Path** becomes the new node and **Connection** goes
back to `Connected` once forwarding is re-established. A node's **USB** panel
lists devices forwarded to it from elsewhere ("Guests on this node also receive
2 devices forwarded from other nodes"), which is the quickest way to see where
a migrated VM's devices are now coming from.

**Unplugged.** The `UsbDevice` moves to `Unplugged` or `Lost` — amber and red
in the tables, badged in the tree — and, with `status.node` cleared, drops into
the tree's `(unplugged)` group. The claim stays. Plug the device back in and a
following claim picks it up again.

**Moved to another node.** A claim that follows by serial matches the device
wherever it reappears. A claim pinned by `deviceName` matches only that one
`UsbDevice` object, so if the device comes back as a different object it is not
picked up, and the claim waits. This is the whole reason for the follow
checkbox.

Whatever the claim says, the guest is the last word. A USB connection that is
broken and re-made looks to the guest like an unplug and a re-plug: software
that opened the device once will not necessarily reopen it. If **Connection**
says `Connected` and the guest still has nothing, the guest is what needs
restarting — which is the problem [boot hold](#boot-hold) exists to avoid.

## Detaching

**Detach** is on the claim row of the VM's USB panel, on the **Attached to**
cell of the datacenter and node device tables, and on the claim rows of the
datacenter panel. It asks for confirmation — "The claim is deleted and the
device released" — and then runs `usb.detach`, which deletes the
`UsbDeviceClaim`. The device's lease is released and it becomes `Available`
for someone else.

Detaching does not touch the VM. The guest sees the device disappear, as if
somebody had pulled it out.

## Claims

The claim, not the attachment, is the durable object. It is a standing request
that outlives everything around it:

- **A stopped VM keeps its device.** The claim still holds the lease, the
  device still shows **Attached to** that VM, and nobody else can take it.
  Start the VM and the device comes back. This is deliberate: a device
  reserved for a VM should not be lost because the VM was restarted.
- **A device that is not there yet is waited for.** A claim created for a
  device that is unplugged, or a VM that is not running, stays and attaches
  when both are available.
- **A server restart changes nothing.** Claims are Kubernetes objects; only the
  task that created one is lost (see [tasks.md](tasks.md#where-tasks-live)).

Deleting the claim is the only thing that releases the device.

The datacenter panel's **Claims** table is the full view:

| Column | Field |
|---|---|
| **Claim** | `namespace/name` |
| **VM** | `spec.vmName`, linked to its USB panel |
| **Phase** | `status.phase`, green on `Attached` and amber otherwise, with `status.message` as the tooltip |
| **Device** | `status.deviceName` — which device the selector actually matched |
| **Selector** | `spec.selector` as `key=value` pairs |
| **Path** | `status.sourceNode` → `status.connection.node` |
| **Connection** | `status.connection.state` |
| **Age** | since `metadata.creationTimestamp` |

Phases worth recognising: `Attached` is the goal, `VMNotConfigured` means the
VM has no `clientPassthrough`, and a claim with no phase yet is displayed as
`Pending`.

## Boot hold

Some guests look for their device exactly once. A serial radio opened by a
daemon at start-up, a dongle read by a licence manager as it initialises — if
the device is not there at that moment, it is never picked up, and the claim
reaching `Attached` thirty seconds later makes no difference. Restarting the
VM does not help either, because the race is the same every time.

atomic-usb answers this with `holdBoot` on the claim: the VM is held paused
until its device is attached, and only then released to run, so the guest's
first look already finds the device. It needs `spec.template.spec.startStrategy:
Paused` on the VM, which is VM → **Options** → **Start paused** in the GUI.

Two gotchas, both of them yours to get right:

- The **Attach USB device** dialog does not offer `holdBoot`. Set it on the
  `UsbDeviceClaim` — the resource's YAML editor, or `kubectl` — and see the
  [atomic-usb](https://github.com/safewords/kubevirt-atomic-usb) documentation
  for the field.
- `holdBoot` without **Start paused** holds nothing: the VM boots normally and
  the guest races the claim as before. **Start paused** without a `holdBoot`
  claim is the opposite problem — the VM sits paused until somebody presses
  **Resume**.

Use it when the guest opens the device once at start-up. For a mass-storage
device, a webcam, or anything the guest re-enumerates, plain attach is enough.

## Permissions

Everything happens as the signed-in user; the server holds no privileges of its
own.

| To do this | Verb | Resource | Where |
|---|---|---|---|
| See the device inventory and the USB View | `list`, `watch` | `atomicusb.safewords.io/usbdevices` | cluster-wide |
| See claims | `list`, `watch` | `atomicusb.safewords.io/usbdeviceclaims` | cluster-wide, else per namespace |
| Attach a device | `create` | `atomicusb.safewords.io/usbdeviceclaims` | the VM's namespace |
| Detach a device | `delete` | `atomicusb.safewords.io/usbdeviceclaims` | the claim's namespace |
| Turn on USB redirection | `patch` | `kubevirt.io/virtualmachines` | the VM |

`UsbDevice` is cluster-scoped, so there is no partial view of it: either you may
list devices and the panels work, or you may not and they report the watch
error. Claims degrade more gracefully — without cluster-wide `list`, the GUI
watches each namespace you can reach instead, so you see the claims in your own
namespaces and nothing else.

Two things to know before granting `usbdeviceclaims`:

- **`create` is the whole authorisation.** A claim names a device by vendor,
  product and serial, and any namespace's claim can take a device on any node.
  Somebody who may create claims in one namespace can take the device out from
  under a VM in another.
- **The forwarded traffic is not encrypted.** Everything the device carries
  crosses the pod network in the clear.

**Known quirk:** the **Detach** button on the datacenter and node device tables
is enabled by a `create usbdeviceclaims` check rather than a `delete` one, so a
user granted delete but not create sees it greyed out. The buttons on the VM
panel and the claims table are not gated at all — the API server refuses the
delete, and the error arrives as a toast.

See also [virtual-machines.md](virtual-machines.md) for the VM panels,
[datacenter.md](datacenter.md) for the datacenter screens, [tasks.md](tasks.md)
for the task log, and
[../extending/gateway-protocol.md](../extending/gateway-protocol.md) for
`usb.attach` and `usb.detach` on the wire.
