/** Disk screens and actions — a PersistentVolumeClaim and the DataVolume that fills it. */
import {
  faGaugeHigh, faFileCode, faCamera, faScroll, faFileLines, faUpRightAndDownLeftFromCenter, faClone, faLink, faTrash,
} from '@fortawesome/free-solid-svg-icons'
import { defineComponent, h } from 'vue'
import type { ObjectContext, PluginApi } from '@/plugins/registry'
import { k8s } from '@/api/k8s'
import { confirm, openDialog, run } from '@/services/dialogs'
import { useInventory } from '@/plugins/core/inventory'
import ResourceYaml from '@/components/common/ResourceYaml.vue'
import DiskSummary from './DiskSummary.vue'
import DiskSnapshots from './DiskSnapshots.vue'
import DiskImportLog from './DiskImportLog.vue'
import DiskEvents from './DiskEvents.vue'
import ResizeDialog from './ResizeDialog.vue'
import CloneDiskDialog from './CloneDiskDialog.vue'
import AttachDiskDialog from './AttachDiskDialog.vue'
import { vmsUsing } from './helpers'

const DiskYaml = defineComponent({
  props: { ctx: { type: Object as () => ObjectContext, required: true } },
  setup: (props) => () => h('div', { class: 'h-full p-3' }, [h(ResourceYaml, { object: props.ctx.related.dataVolume ?? props.ctx.object })]),
})

const pvcAccess = (verb: string) => (ctx: ObjectContext) => ({ verb, resource: 'persistentvolumeclaims', namespace: ctx.namespace, name: ctx.name })

async function remove(ctx: ObjectContext) {
  const users = vmsUsing(ctx.namespace, ctx.name)
  const inv = useInventory()
  const running = users.filter((vm) => inv.vmiFor(vm)?.status?.phase === 'Running')
  const result = await confirm({
    title: `Destroy disk ${ctx.name}`,
    message: [
      `This permanently deletes ${ctx.namespace}/${ctx.name}${ctx.related.dataVolume ? ' and its DataVolume' : ''}, and the data on it.`,
      users.length ? `\nIt is still referenced by: ${users.map((v) => v.metadata.name).join(', ')}.${running.length ? ' A running VM keeps the volume until it stops; the VM will not start again without it.' : ' Those VMs will not start until the disk is removed from them.'}` : '',
    ].join(''),
    confirmText: 'Destroy',
    danger: true,
    typeToConfirm: ctx.name,
  })
  if (!result) return
  await run(`Destroy disk ${ctx.name}`, async () => {
    if (ctx.related.dataVolume) {
      await k8s.delete({ apiVersion: ctx.related.dataVolume.apiVersion ?? 'cdi.kubevirt.io/v1beta1', resource: 'datavolumes', namespace: ctx.namespace, name: ctx.name })
    }
    try {
      await k8s.delete({ apiVersion: 'v1', resource: 'persistentvolumeclaims', namespace: ctx.namespace, name: ctx.name })
    } catch (e: any) {
      // Deleting the DataVolume usually took the claim with it.
      if (e?.status !== 404) throw e
    }
  })
}

export function setupDisk(api: PluginApi) {
  api.panel({ id: 'summary', kind: 'disk', title: 'Summary', icon: faGaugeHigh, order: 10, component: DiskSummary })
  api.panel({ id: 'import', kind: 'disk', title: 'Import Log', icon: faFileLines, order: 20, component: DiskImportLog, when: (ctx) => !!ctx.related.dataVolume })
  api.panel({ id: 'snapshots', kind: 'disk', title: 'Snapshots', icon: faCamera, order: 30, requires: ['snapshot.storage.k8s.io'], component: DiskSnapshots })
  api.panel({ id: 'events', kind: 'disk', title: 'Events', icon: faScroll, order: 80, component: DiskEvents })
  api.panel({ id: 'yaml', kind: 'disk', title: 'YAML', icon: faFileCode, order: 90, component: DiskYaml })

  api.action({
    id: 'resize',
    kind: 'disk',
    group: 'primary',
    order: 10,
    title: 'Resize',
    icon: faUpRightAndDownLeftFromCenter,
    enabled: (ctx) => ctx.object?.status?.phase === 'Bound',
    access: pvcAccess('patch'),
    run: (ctx) => openDialog(ResizeDialog, { pvc: ctx.object }),
  })
  api.action({
    id: 'attach',
    kind: 'disk',
    group: 'primary',
    order: 20,
    title: 'Attach to VM',
    icon: faLink,
    enabled: (ctx) => !!ctx.object,
    access: (ctx) => ({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace: ctx.namespace }),
    run: (ctx) => openDialog(AttachDiskDialog, { pvc: ctx.object, dataVolume: ctx.related.dataVolume }),
  })
  api.action({
    id: 'clone',
    kind: 'disk',
    group: 'more',
    order: 10,
    title: 'Clone',
    icon: faClone,
    requires: ['cdi.kubevirt.io'],
    enabled: (ctx) => ctx.object?.status?.phase === 'Bound',
    access: (ctx) => ({ verb: 'create', group: 'cdi.kubevirt.io', resource: 'datavolumes', namespace: ctx.namespace }),
    run: (ctx) => openDialog(CloneDiskDialog, { pvc: ctx.object }),
  })
  api.action({
    id: 'remove',
    kind: 'disk',
    group: 'more',
    order: 90,
    divider: true,
    title: 'Remove',
    icon: faTrash,
    danger: true,
    visible: (ctx) => !!ctx.object,
    access: pvcAccess('delete'),
    run: remove,
  })
}
