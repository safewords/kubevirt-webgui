# Tasks

Every operation that outlives its request becomes a task: an entry in the log
along the bottom of the window, with its own output, its own progress bar and
its own ending. This is Proxmox's task log, and it exists for the same reason —
one place where a long operation explains itself while it runs, and afterwards.

- [What a task is](#what-a-task-is)
- [The UPID](#the-upid)
- [The task panel and the task viewer](#the-task-panel-and-the-task-viewer)
- [Progress](#progress)
- [Stopping a task](#stopping-a-task)
- [Where tasks live](#where-tasks-live)

## What a task is

Starting a VM returns as soon as the API server accepts the request. The VM
being *up* happens later — a pod is scheduled, an image is pulled, the guest
boots — and none of that is in the reply. A task is where that arc goes: what
was asked, by whom, each step as it happened, and how it ended.

So anything long-running answers immediately with a task id and does the work
in the background:

```json
← { "id": "7", "op": "result", "result": { "task": "UPID:alice:1A0AFC0028D:1F:vm.start:prod/db" } }
```

From then on the task streams over the `tasks` topic to every browser that user
has open. These are the operations that become tasks:

| Kind | Operation |
|---|---|
| `vm.start`, `vm.stop`, `vm.shutdown`, `vm.restart`, `vm.reboot`, `vm.reset`, `vm.pause`, `vm.resume`, `vm.freeze`, `vm.unfreeze` | power actions, each waiting for the VMI to reach the state it asked for |
| `vm.create`, `vm.delete` | creating a VM, and destroying one — with its disks when you ask for that |
| `vm.migrate` | live migration |
| `vm.snapshot`, `vm.restore`, `vm.clone` | snapshots, restores and clones |
| `vm.hotplug`, `vm.unplug` | adding and removing a disk on a running VM |
| `disk.create`, `disk.upload` | creating a disk, and uploading an image into one |
| `node.cordon`, `node.uncordon`, `node.drain` | node maintenance |
| `proxmox.import` | importing a VM from Proxmox |
| `usb.attach`, `usb.detach` | [USB devices](usb.md) |

A task carries an id, a kind from that table, a description ("Start prod/db"),
a target (`kind`, `namespace`, `name`), the user who started it, start and end
times in milliseconds, a status, a closing message and, while it runs, its
[progress](#progress).

| Status | Shown as | Means |
|---|---|---|
| `running` | spinner | still going |
| `ok` | green tick | finished; last log line `TASK OK` |
| `error` | red cross | failed; last log line `TASK ERROR: <message>`, and the message is the row's status |
| `stopped` | grey stop | [stopped by the user](#stopping-a-task); last log line `TASK STOPPED by user request` |
| `warning` | amber triangle | defined in the model and rendered by the browser, but no built-in extension produces one |

The failure message is always in the log as well as on the task, because the
log is where a failure is explained: a `vm.migrate` that cannot be placed says
so in the scheduler's own words, a `disk.create` that fails carries CDI's
importer pod output.

## The UPID

A task id is a UPID — the same idea as Proxmox's, not the same layout. It is
one line, unique, and readable without a lookup:

```
UPID:alice:1A0AFC0028D:1F:vm.start:prod/db
```

| Field | In the example | What it is |
|---|---|---|
| `UPID` | `UPID` | the literal prefix |
| user | `alice` | the username Kubernetes knows, exactly as it authenticated |
| started | `1A0AFC0028D` | the start time in milliseconds since the epoch, uppercase hex — here 2026-09-17 14:23:11.501 UTC |
| sequence | `1F` | a counter within this server process, uppercase hex, so two tasks started in the same millisecond are still distinct |
| kind | `vm.start` | the kind from the table above |
| target | `prod/db` | `namespace/name`, or just `name` for something cluster-scoped such as a node |

**Gotcha:** do not split a UPID on `:` from the left. A service account's
username *contains* colons — `system:serviceaccount:kve:admin` — so that id has
eight colon-separated pieces, not six. Parse from the right, where the last
four fields are fixed. (The panel shows such users as `admin@kve`, but the UPID
keeps the real name.)

The sequence restarts at zero when the server does, which is harmless: the
millisecond timestamp differs, and tasks do not survive a restart anyway — see
[where tasks live](#where-tasks-live).

## The task panel and the task viewer

The panel along the bottom has two tabs.

**Tasks** lists your tasks, newest first, with **Start time**, **End time**,
**Target**, **User**, **Description** and **Status**. A running task shows a
progress bar when it reports progress and "running 2m 14s" when it does not.
The tab's header carries a "3 running" chip while anything is going. Empty, it
says "No tasks yet in this session. Actions you take appear here, with their
logs."

**Cluster log** is the other half of the story: Kubernetes events about
virtualization objects — `VirtualMachine`, `VirtualMachineInstance`,
`VirtualMachineInstanceMigration`, `DataVolume`, snapshots, restores, clones,
`Node`, `PersistentVolumeClaim`, `KubeVirt`, exports, `UsbDeviceClaim` and
anything named `virt-launcher-*` — newest first, capped at 300 rows. It only
watches while that tab is open and the panel is expanded, so leaving the panel
on **Tasks** costs nothing.

Drag the panel's top edge to resize it, or use the chevron to collapse it; the
height and the open state are remembered in the browser.

**Double-click a row** to open the task viewer, a modal titled "Task viewer:
`<description>`" with two tabs:

- **Output** — the log, each line timestamped, auto-scrolling as lines arrive,
  with `TASK OK` green and `TASK ERROR` red, and a pulsing `…` while the task
  is still running.
- **Status** — Status, Type (the kind), Target, User, Started, Duration and
  **Unique task ID**, which is the UPID to quote in a bug report.

While the task runs, the viewer also has a **Stop** button and, when there is
progress to show, a full-width progress bar above the log.

The viewer opens by itself for operations you started from a dialog and are
expected to watch — attaching a USB device, adding or cloning a disk,
migrating, snapshotting, restoring. Everything else raises a small "Task
started" toast with a **View task log** link.

Per object, a VM's **Events** panel opens with **Task history**: the tasks
whose target is that VM, above the Kubernetes events for the same object.

Tasks reach the browser over the `tasks` topic. On subscribing it receives a
`SYNC` of your 200 most recent tasks, then an `UPDATE` per change, each
carrying the whole task and, where there is one, the new log line. Opening the
viewer calls `tasks.detail` for the stored log and then follows the topic.
Tasks are private: `tasks.list`, `tasks.detail`, `tasks.stop` and the topic all
filter on the signed-in username, so you see your own tasks and nobody else's —
including your own tasks in another browser, which is the point. If a browser
falls behind the stream, the server sends a fresh `SYNC` rather than a gap. See
[../extending/gateway-protocol.md](../extending/gateway-protocol.md).

## Progress

A task can report how far it has got, which becomes a bar in the panel row, in
the viewer, and wherever else the task is shown.

| Field | Meaning |
|---|---|
| `done` | units finished so far |
| `total` | units in all, when known. Without it the bar is an indeterminate shimmer and only the figure is shown. |
| `unit` | `bytes` or `items` |
| `rate` | units per second, when meaningful |
| `detail` | what is happening now, in a few words: `copying scsi0` |

From these the GUI renders "4.2 GiB of 20.0 GiB · 118.4 MiB/s · 2m 14s left" —
the time left being simply the units remaining divided by the rate, so it moves
about while the rate does. The compact form in the panel row shows the bar, the
percentage, and either the rate or the detail.

Progress events are rate-limited on the server: **at most one per task every
500 ms**, and identical progress is never re-sent. The event that completes the
total always goes, so a bar never sticks at 99%. This matters because the
things that report progress report it constantly — a byte pump would otherwise
flood every open browser.

Two operations report progress today:

| Task | Unit | What it reports |
|---|---|---|
| `proxmox.import` | bytes | bytes copied across all of the VM's disks against their total, with the rate measured over the transfer and `copying <disk>` as the detail. Between disks it switches to `<disk>: CDI is finishing the disk` while CDI converts what was sent. |
| `vm.migrate` | bytes | guest memory sent against the total, the transfer rate from virt-handler, and a detail of `12.4 GiB left, dirtying 48 MiB/s` |

Uploads are the exception worth knowing about. `disk.upload` does **not**
report task progress — the bar you watch during an upload is the browser's own
count of the bytes it has pushed through the WebSocket, which is the only place
that knows. The task logs `sent 60% (3072 MiB)` at each tenth instead, and then
follows CDI's own `status.progress` as log lines (`DataVolume:
ImportInProgress 42.0%`) while the image is written. The same is true of
`disk.create` from a URL: CDI's percentage arrives as log lines, not a bar. See
[storage.md](storage.md).

Live migration has a second, independent source of figures: the
`migration.progress` topic, which samples virt-handler directly and reports
memory sent and remaining, the transfer rate and how fast the guest is dirtying
memory — with a warning when the guest dirties faster than the link can send,
because pre-copy cannot converge in that state. It appears on the VM's
**Migrations** panel and under Datacenter → **Migrations**, and needs
`get pods/proxy` in KubeVirt's namespace; without that permission migrations
still work, just without figures. See
[virtual-machines.md](virtual-machines.md).

## Stopping a task

**Stop** in the task viewer calls `tasks.stop`. The server aborts the work,
writes `TASK STOPPED by user request` to the log, and marks the task `stopped`.
You can only stop your own tasks; anyone else's id is simply not found.

Be clear about what that does and does not do. **It stops the server's side of
the operation, not the cluster's.**

| Stopping | Actually stops | Carries on regardless |
|---|---|---|
| `vm.start`, `vm.stop`, … | the waiting and the logging | the power request itself, which reached the API server in the first seconds. The VM still starts. |
| `vm.migrate` | watching the migration | the `VirtualMachineInstanceMigration`. Use **Cancel** on the Migrations panel (`vm.migrate.cancel`) to actually stop a migration. |
| `disk.create`, `disk.upload` | the server's half of the transfer, and the waiting on CDI | the `DataVolume` and CDI's importer pod. Delete the disk yourself if you do not want it. |
| `proxmox.import` | the SSH transfer, which is genuinely cancelled | the DataVolumes already created, and any VM already defined |
| `node.drain` | waiting for the migrations to finish | the cordon, and every `VirtualMachineInstanceMigration` the task already started. Uncordon the node yourself. |
| `usb.attach` | waiting for the claim to attach | the `UsbDeviceClaim`, which stays and keeps trying. Detach it to undo. |

The rule behind the table: a task's real effect is the objects it creates in
Kubernetes, and controllers keep working on those whether or not anybody is
watching. Stopping a task ends the watching.

Cancelling an upload from the Images panel does both halves — it closes the
WebSocket and calls `tasks.stop` — and still leaves the DataVolume behind for
you to remove.

## Where tasks live

In the server's memory, and nowhere else. The process keeps the last **1000
tasks** and the last **2000 log lines** of each, both as ring buffers, and a
restart loses all of them. Nothing is written to disk, and nothing is written
into the cluster.

This is a deliberate trade — the server stores nothing, so it needs no database
and no volume — but it has consequences worth knowing before you go looking for
a task that is not there:

- **A restart empties the log while the work continues.** A `proxmox.import`
  whose server was restarted mid-copy loses its task; the DataVolumes it
  created keep filling, because CDI is doing that, not the GUI. The VM's
  **Events** panel says as much where the history would be: "No tasks for this
  VM in this server's memory."
- **Each replica has its own list.** The chart runs one replica for this
  reason; scaling up scatters tasks across pods, and a browser only sees the
  ones belonging to the pod it is connected to.
- **Tasks are per user.** Another operator's import does not appear in your
  panel, however much you might want it to.

When the task is gone, the cluster still remembers what happened. Look here
instead:

| For | Look at |
|---|---|
| What happened to one VM | VM → **Events** — Kubernetes events for the VM and its virt-launcher pod |
| Anything cluster-wide | Datacenter → **Events**, or the **Cluster log** tab of the task panel |
| A disk import or upload | the disk's **Import Log** panel, which shows CDI's importer pod output, including the pod's termination message after it has gone |
| A migration | VM → **Migrations**, which lists the `VirtualMachineInstanceMigration` objects and their outcomes |

Kubernetes events are themselves short-lived — about an hour in a default
cluster — so for anything that must survive, the objects are the record:
snapshots, DataVolumes and migrations each carry their own status and
conditions, visible on their panels and in **YAML**.

See also [virtual-machines.md](virtual-machines.md),
[storage.md](storage.md), [proxmox-import.md](proxmox-import.md),
[datacenter.md](datacenter.md) and
[../extending/gateway-protocol.md](../extending/gateway-protocol.md), which
describes `tasks.list`, `tasks.detail`, `tasks.stop` and the `tasks` topic on
the wire.
