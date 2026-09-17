/** Virtual machine screens and actions. */
import {
  faGaugeHigh, faTerminal, faFileCode, faPlay, faPowerOff, faStop, faRotateRight, faPause, faForward, faBolt,
  faDisplay, faTrash, faArrowRightArrowLeft, faScroll, faMicrochip, faCloud, faSliders, faCamera, faRoute, faClone,
  faHeadset, faTags, faNoteSticky,
} from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext, PluginApi } from '@/plugins/registry'
import { vmApi } from '@/api/k8s'
import { confirm, openDialog, run } from '@/services/dialogs'
import { vmState } from '@/util/kubevirt'
import VmSummary from './VmSummary.vue'
import VmConsole from './VmConsole.vue'
import VmYaml from './VmYaml.vue'
import VmEvents from './VmEvents.vue'
import VmHardware from './VmHardware.vue'
import VmCloudInit from './VmCloudInit.vue'
import VmOptions from './VmOptions.vue'
import VmSnapshots from './VmSnapshots.vue'
import VmMigrations from './VmMigrations.vue'
import VmGuestAgent from './VmGuestAgent.vue'
import MigrateDialog from './MigrateDialog.vue'
import CloneDialog from './CloneDialog.vue'
import SnapshotDialog from './SnapshotDialog.vue'
import { editNotes, editTags } from './options'

const state = (ctx: ObjectContext) => vmState(ctx.object, ctx.related.vmi)
const isRunning = (ctx: ObjectContext) => ['running', 'paused', 'migrating'].includes(state(ctx))
const subresource = (ctx: ObjectContext, resource: 'virtualmachines' | 'virtualmachineinstances', sub: string) => ({
  verb: 'update',
  group: 'subresources.kubevirt.io',
  resource,
  subresource: sub,
  namespace: ctx.namespace,
  name: ctx.name,
})

async function power(ctx: ObjectContext, action: Parameters<typeof vmApi.action>[0], label: string, options: { force?: boolean; ask?: string; danger?: boolean } = {}) {
  if (options.ask) {
    const ok = await confirm({ title: label, message: options.ask, confirmText: label, danger: options.danger })
    if (!ok) return
  }
  await run(`${label} ${ctx.name}`, () => vmApi.action(action, ctx.namespace!, ctx.name, { force: options.force }))
}

export function setupVm(api: PluginApi) {
  api.panel({ id: 'summary', kind: 'vm', title: 'Summary', icon: faGaugeHigh, order: 10, component: VmSummary })
  api.panel({ id: 'console', kind: 'vm', title: 'Console', icon: faTerminal, order: 20, component: VmConsole })
  api.panel({ id: 'hardware', kind: 'vm', title: 'Hardware', icon: faMicrochip, order: 30, component: VmHardware })
  api.panel({ id: 'cloudinit', kind: 'vm', title: 'Cloud-Init', icon: faCloud, order: 35, component: VmCloudInit, when: (ctx) => !!ctx.object })
  api.panel({ id: 'options', kind: 'vm', title: 'Options', icon: faSliders, order: 40, component: VmOptions, when: (ctx) => !!ctx.object })
  api.panel({ id: 'guest', kind: 'vm', title: 'Guest Agent', icon: faHeadset, order: 50, component: VmGuestAgent })
  api.panel({ id: 'snapshots', kind: 'vm', title: 'Snapshots', icon: faCamera, order: 60, requires: ['snapshot.kubevirt.io'], component: VmSnapshots, when: (ctx) => !!ctx.object })
  api.panel({ id: 'migrations', kind: 'vm', title: 'Migrations', icon: faRoute, order: 65, requires: ['kubevirt.io/v1/virtualmachineinstancemigrations'], component: VmMigrations })
  api.panel({ id: 'events', kind: 'vm', title: 'Events', icon: faScroll, order: 80, component: VmEvents })
  api.panel({ id: 'yaml', kind: 'vm', title: 'YAML', icon: faFileCode, order: 90, component: VmYaml })

  api.action({
    id: 'start',
    kind: 'vm',
    title: 'Start',
    icon: faPlay,
    group: 'primary',
    order: 10,
    enabled: (ctx) => !!ctx.object && ['stopped', 'error', 'unknown'].includes(state(ctx)),
    access: (ctx) => subresource(ctx, 'virtualmachines', 'start'),
    run: (ctx) => power(ctx, 'start', 'Start'),
  })

  api.action({
    id: 'shutdown',
    kind: 'vm',
    group: 'power',
    order: 10,
    title: 'Shutdown',
    icon: faPowerOff,
    enabled: isRunning,
    access: (ctx) => subresource(ctx, 'virtualmachines', 'stop'),
    run: (ctx) => power(ctx, 'shutdown', 'Shutdown', { ask: `Shut down ${ctx.namespace}/${ctx.name}? The guest is asked to power off (ACPI) and given its grace period.` }),
  })
  api.action({
    id: 'stop',
    kind: 'vm',
    group: 'power',
    order: 20,
    title: 'Stop',
    icon: faStop,
    enabled: (ctx) => isRunning(ctx) || state(ctx) === 'starting' || state(ctx) === 'stopping',
    access: (ctx) => subresource(ctx, 'virtualmachines', 'stop'),
    run: (ctx) => power(ctx, 'stop', 'Stop', { force: true, danger: true, ask: `Stop ${ctx.namespace}/${ctx.name} immediately? This is like pulling the power cable; unsaved data in the guest is lost.` }),
  })
  api.action({
    id: 'reboot',
    kind: 'vm',
    group: 'power',
    order: 30,
    title: 'Reboot',
    icon: faRotateRight,
    enabled: (ctx) => state(ctx) === 'running',
    access: (ctx) => subresource(ctx, 'virtualmachineinstances', 'softreboot'),
    run: (ctx) => power(ctx, 'reboot', 'Reboot', { ask: `Reboot ${ctx.namespace}/${ctx.name} from inside the guest (requires the guest agent or ACPI)?` }),
  })
  api.action({
    id: 'restart',
    kind: 'vm',
    group: 'power',
    order: 35,
    title: 'Restart (new instance)',
    icon: faRotateRight,
    enabled: isRunning,
    access: (ctx) => subresource(ctx, 'virtualmachines', 'restart'),
    run: (ctx) => power(ctx, 'restart', 'Restart', { ask: `Restart ${ctx.namespace}/${ctx.name}? The instance is recreated, picking up any configuration changes, and may land on another node.` }),
  })
  api.action({
    id: 'reset',
    kind: 'vm',
    group: 'power',
    order: 40,
    title: 'Reset',
    icon: faBolt,
    danger: true,
    enabled: (ctx) => state(ctx) === 'running',
    access: (ctx) => subresource(ctx, 'virtualmachineinstances', 'reset'),
    run: (ctx) => power(ctx, 'reset', 'Reset', { danger: true, ask: `Hard-reset ${ctx.namespace}/${ctx.name}? The guest restarts without shutting down.` }),
  })
  api.action({
    id: 'pause',
    kind: 'vm',
    group: 'power',
    order: 50,
    divider: true,
    title: 'Pause',
    icon: faPause,
    enabled: (ctx) => state(ctx) === 'running',
    access: (ctx) => subresource(ctx, 'virtualmachineinstances', 'pause'),
    run: (ctx) => power(ctx, 'pause', 'Pause'),
  })
  api.action({
    id: 'resume',
    kind: 'vm',
    group: 'power',
    order: 60,
    title: 'Resume',
    icon: faForward,
    enabled: (ctx) => state(ctx) === 'paused',
    access: (ctx) => subresource(ctx, 'virtualmachineinstances', 'unpause'),
    run: (ctx) => power(ctx, 'resume', 'Resume'),
  })

  const popout = (ctx: ObjectContext, kind: 'vnc' | 'serial') =>
    window.open(`/console/${encodeURIComponent(ctx.namespace!)}/${encodeURIComponent(ctx.name)}?kind=${kind}`, `${kind}-${ctx.namespace}-${ctx.name}`, kind === 'vnc' ? 'width=1100,height=760' : 'width=980,height=640')

  api.action({
    id: 'console-vnc',
    kind: 'vm',
    group: 'console',
    order: 10,
    title: 'noVNC',
    icon: faDisplay,
    enabled: (ctx) => isRunning(ctx),
    access: (ctx) => ({ verb: 'get', group: 'subresources.kubevirt.io', resource: 'virtualmachineinstances', subresource: 'vnc', namespace: ctx.namespace, name: ctx.name }),
    run: (ctx) => popout(ctx, 'vnc'),
  })
  api.action({
    id: 'console-serial',
    kind: 'vm',
    group: 'console',
    order: 20,
    title: 'xterm.js (serial)',
    icon: faTerminal,
    enabled: (ctx) => isRunning(ctx),
    access: (ctx) => ({ verb: 'get', group: 'subresources.kubevirt.io', resource: 'virtualmachineinstances', subresource: 'console', namespace: ctx.namespace, name: ctx.name }),
    run: (ctx) => popout(ctx, 'serial'),
  })

  api.action({
    id: 'migrate',
    kind: 'vm',
    group: 'primary',
    order: 30,
    title: 'Migrate',
    icon: faArrowRightArrowLeft,
    enabled: (ctx) => state(ctx) === 'running',
    access: (ctx) => ({ verb: 'create', group: 'kubevirt.io', resource: 'virtualmachineinstancemigrations', namespace: ctx.namespace }),
    run: (ctx) => openDialog(MigrateDialog, { ctx }),
  })

  api.action({
    id: 'clone',
    kind: 'vm',
    group: 'more',
    order: 10,
    title: 'Clone',
    icon: faClone,
    requires: ['clone.kubevirt.io'],
    visible: (ctx) => !!ctx.object,
    access: (ctx) => ({ verb: 'create', group: 'clone.kubevirt.io', resource: 'virtualmachineclones', namespace: ctx.namespace }),
    run: (ctx) => openDialog(CloneDialog, { ctx }),
  })
  api.action({
    id: 'snapshot',
    kind: 'vm',
    group: 'more',
    order: 20,
    title: 'Take snapshot',
    icon: faCamera,
    requires: ['snapshot.kubevirt.io'],
    visible: (ctx) => !!ctx.object,
    access: (ctx) => ({ verb: 'create', group: 'snapshot.kubevirt.io', resource: 'virtualmachinesnapshots', namespace: ctx.namespace }),
    run: (ctx) => openDialog(SnapshotDialog, { ctx }),
  })
  api.action({
    id: 'tags',
    kind: 'vm',
    group: 'more',
    order: 30,
    divider: true,
    title: 'Edit tags',
    icon: faTags,
    visible: (ctx) => !!ctx.object,
    access: (ctx) => ({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace: ctx.namespace, name: ctx.name }),
    run: editTags,
  })
  api.action({
    id: 'notes',
    kind: 'vm',
    group: 'more',
    order: 40,
    title: 'Edit notes',
    icon: faNoteSticky,
    visible: (ctx) => !!ctx.object,
    access: (ctx) => ({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace: ctx.namespace, name: ctx.name }),
    run: editNotes,
  })

  api.action({
    id: 'delete',
    kind: 'vm',
    group: 'more',
    order: 90,
    divider: true,
    title: 'Remove',
    icon: faTrash,
    danger: true,
    visible: (ctx) => !!ctx.object,
    access: (ctx) => ({ verb: 'delete', group: 'kubevirt.io', resource: 'virtualmachines', namespace: ctx.namespace, name: ctx.name }),
    run: async (ctx) => {
      const result = await confirm({
        title: `Destroy ${ctx.name}`,
        message: `This deletes the virtual machine ${ctx.namespace}/${ctx.name}${isRunning(ctx) ? ', stopping it first' : ''}.`,
        confirmText: 'Remove',
        danger: true,
        typeToConfirm: ctx.name,
        options: [{ key: 'disks', label: 'Also destroy its disks (PVCs and DataVolumes)', default: true, hint: 'Unreferenced disks are otherwise kept.' }],
      })
      if (result) await run(`Destroy ${ctx.name}`, () => vmApi.delete(ctx.namespace!, ctx.name, result.options.disks), { openLog: true })
    },
  })
}
