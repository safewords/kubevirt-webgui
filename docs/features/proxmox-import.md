# Importing from Proxmox VE

**Create → Import from Proxmox** copies a stopped Proxmox VM — its settings and
its disks — into a KubeVirt VirtualMachine. Nothing is written to a temporary
file on either side and nothing on the Proxmox host is changed.

- [Before you start](#before-you-start)
- [The allow-list](#the-allow-list)
- [Connecting](#connecting)
- [Choosing a VM](#choosing-a-vm)
- [What gets mapped](#what-gets-mapped)
- [What does not come across](#what-does-not-come-across)
- [The import itself](#the-import-itself)
- [How a disk is copied](#how-a-disk-is-copied)
- [Guarding the source](#guarding-the-source)
- [When it fails](#when-it-fails)
- [Afterwards](#afterwards)
- [Limitations](#limitations)

## Before you start

| Requirement | Why |
|---|---|
| `PROXMOX_ALLOWED_HOSTS` set on the server | importing is off entirely without it |
| SSH reachability from the **server** to the Proxmox node | the server opens the connection, not your browser |
| A Proxmox user who may run `pvesh`, `pvesm` and `qm` (in practice `root`) | the import reads the configuration and exports the disks |
| CDI installed | each disk arrives through a CDI upload DataVolume |
| The source VM **stopped** | a disk that changes while it is read is not a copy |

## The allow-list

`PROXMOX_ALLOWED_HOSTS` is a comma-separated list of names, addresses, CIDR
ranges, or `*`. It is a boundary, not a convenience: a signed-in user names the
host to connect to, so without a list the server would open SSH connections to
anywhere its network reaches.

Two details worth knowing:

- A host must be listed before anyone can even **ask for its host key**.
- The address the allow-list checked is the address the connection is made to
  (`AllowList::resolve` pins it), so a name that resolves differently a moment
  later cannot be used to reach a host that was never allowed.

## Connecting

The wizard asks for a node, a user and either a password or an SSH private key,
and before any of that is sent it shows the node's **SSH host key
fingerprint**. Compare it with the node's own:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Credentials are sent only after you accept the key, and the accepted key is
pinned for the session: if the host key changes mid-session the connection is
refused rather than the credentials re-sent. The browser remembers keys you
have accepted and warns when one changes.

Credentials live in the server's memory, bound to the session that entered
them, and are dropped after 30 minutes idle (`SESSION_IDLE`) or when you press
**Disconnect**. They are never written anywhere.

| Method | Purpose |
|---|---|
| `proxmox.status` | is importing enabled, and for which hosts |
| `proxmox.hostKey` | the host's SSH key, to confirm before credentials are sent |
| `proxmox.connect` | open a session with a confirmed fingerprint |
| `proxmox.vms` | every QEMU VM in the Proxmox cluster, with its node and state |
| `proxmox.vm` | one VM's configuration, parsed |
| `proxmox.import` | start the import; returns a task |
| `proxmox.disconnect` | end the session and drop the credentials |

## Choosing a VM

Every QEMU VM in the Proxmox **cluster** is listed, not only those on the node
you connected to — `pvesh` answers for the cluster, and disks on another node's
local storage are read over that cluster's own root SSH.

Running VMs are listed but cannot be selected. LXC containers are not VMs and
are not offered: there is nothing in KubeVirt to import them into.

## What gets mapped

The browser maps the Proxmox configuration into a VirtualMachine and shows you
every field before anything is created (`web/src/plugins/core/proxmox/mapping.ts`).

| Proxmox | Becomes | Notes |
|---|---|---|
| `bios: seabios` / `ovmf` | SeaBIOS / UEFI, Secure Boot preserved | BIOS guests keep a graphics device — without one SeaBIOS has nothing to boot from |
| `machine: i440fx` | q35 | KubeVirt offers only q35 |
| sockets, cores, memory | `spec.domain.cpu` and `resources` | |
| `smbios1` UUID and serial | `spec.domain.firmware` | keeps licences and guest identity stable |
| each disk | a DataVolume plus a disk entry | bus preserved, IDE becomes SATA; serial and boot order preserved |
| `virtio` disks | `dedicatedIOThread` | only virtio supports it |
| each NIC | a network interface | model and MAC preserved; pod network or Multus |
| Windows guest (`ostype: win*`) | Hyper-V enlightenments and `clock: localtime` | the set Proxmox itself uses |

The wizard warns where a choice is likely to matter — for example, a guest with
a static address or slot-pinned network configuration, whose networking will
not simply work on a different fabric.

## What does not come across

Listed in the wizard before you confirm, because each is a reason to keep the
Proxmox VM until you have checked:

- EFI variables and TPM contents (`efidisk0`, `tpmstate0`)
- Snapshots
- PCI passthrough devices
- Per-device rate limits and similar Proxmox-only settings

## The import itself

**Import** runs a server-side dry run first, then starts a task
(see [tasks](tasks.md)). The task:

1. Re-reads the source VM and refuses if it is running, locked, or its
   configuration digest has changed since you reviewed it.
2. Creates the VirtualMachine **stopped**, with one upload DataVolume per disk.
3. Waits for KubeVirt and CDI to settle the DataVolumes, then streams each disk
   into CDI's upload proxy, reporting bytes, rate and time remaining.
4. Optionally starts the VM when every disk is in.

## How a disk is copied

```text
pvesm export <volid> raw+size - | tail -c +9 | dd bs=4M | zstd -1 | → CDI upload proxy
```

Each stage earns its place:

| Stage | Why |
|---|---|
| `pvesm export … raw+size` | the one export format that is a plain raw image, for every storage type |
| `tail -c +9` | strips the 8-byte size header that `raw+size` puts in front |
| `dd bs=4M status=progress` | large reads, and a progress source on the Proxmox side |
| `zstd -1 -T0` (or `gzip -1` if zstd is missing) | the network is the bottleneck, not the CPU |

Then the workaround that is not obvious from the pipeline: the stream begins
with **a 4 KiB zstd frame holding one uncompressed block**.

CDI 1.65 detects the stream's format by reading its first 512 bytes into a
buffer — and then hands that same buffer to a lazily-initialised zstd decoder
that has not read it yet. If the start of the disk compresses into many small
blocks, the decoder reads a buffer that has been reused underneath it and
fails with "reserved block type encountered", or worse, writes corrupt data
without failing at all. A first frame large enough that the detector's read
cannot reach past it makes the reuse harmless.

This was confirmed by replaying CDI's read pattern against its own decoder, not
guessed. The constant is `ZSTD_RAW_BLOCK_4K` in `src/extensions/proxmox.rs`.

## Guarding the source

A copy is only a copy if the source holds still. While a disk is being read,
the task re-checks the source VM every 20 seconds (`SOURCE_CHECK`) over a
**second SSH connection** — a second connection rather than the one carrying
the disk, because a multiplexed exec on a saturated channel would block behind
the transfer.

If the VM is started on Proxmox mid-copy, the import stops and says so rather
than finishing with an image of a half-written filesystem.

## When it fails

The half-imported VirtualMachine and its DataVolumes are deleted, with
background propagation — the name is free immediately and Kubernetes removes
the disks and CDI's upload pods behind it.

What is *not* touched, ever, is the Proxmox side. The import only reads.

## Afterwards

- Start the imported VM from the GUI and check it boots and finds its disks.
- Keep the Proxmox VM **stopped**: both copies carry the same MAC address, and
  two of them on one network is a bad afternoon.
- Compare something in the guest before deleting anything on the Proxmox side.
  The e2e suite goes further and compares a data disk byte for byte
  (`web/e2e/proxmox-import.test.mjs`).

## Limitations

| Limitation | Detail |
|---|---|
| Stopped VMs only | live import would need a changed-block mechanism Proxmox does not expose |
| ZFS-backed disks | `pvesm` exports them only as ZFS streams, which CDI cannot read |
| LXC containers | not virtual machines; nothing to import into |
| EFI variables, TPM state | not transferred; a Secure Boot guest may need its boot entry recreated |
| One disk at a time | the network is shared, and serial copying keeps the progress figures honest |
