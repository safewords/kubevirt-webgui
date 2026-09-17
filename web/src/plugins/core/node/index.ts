/** Node screens and maintenance actions. */
import {
  faGaugeHigh, faFileCode, faDesktop, faTags, faMicrochip, faCubes, faHeartPulse, faScroll, faBan, faCircleCheck, faPersonWalkingArrowRight,
} from '@fortawesome/free-solid-svg-icons'
import { defineComponent, h } from 'vue'
import type { ObjectContext, PluginApi } from '@/plugins/registry'
import { gateway } from '@/api/gateway'
import { confirm, run } from '@/services/dialogs'
import { useInventory } from '@/plugins/core/inventory'
import { isTrue } from '@/util/kubevirt'
import ResourceYaml from '@/components/common/ResourceYaml.vue'
import NodeSummary from './NodeSummary.vue'
import NodeGuests from './NodeGuests.vue'
import NodeLabels from './NodeLabels.vue'
import NodeCapabilities from './NodeCapabilities.vue'
import NodePods from './NodePods.vue'
import NodeConditions from './NodeConditions.vue'
import NodeEvents from './NodeEvents.vue'

const NodeYaml = defineComponent({
  props: { ctx: { type: Object as () => ObjectContext, required: true } },
  setup: (props) => () => h('div', { class: 'h-full p-3' }, [h(ResourceYaml, { object: props.ctx.object })]),
})

const cordoned = (ctx: ObjectContext) => !!ctx.object?.spec?.unschedulable
const patchNode = (ctx: ObjectContext) => ({ verb: 'patch', group: '', resource: 'nodes', name: ctx.name })

function guestsOn(node: string) {
  return useInventory().vmis.filter((v) => v.status?.nodeName === node)
}

export function setupNode(api: PluginApi) {
  api.panel({ id: 'summary', kind: 'node', title: 'Summary', icon: faGaugeHigh, order: 10, component: NodeSummary })
  api.panel({ id: 'guests', kind: 'node', title: 'Guests', icon: faDesktop, order: 20, component: NodeGuests })
  api.panel({ id: 'capabilities', kind: 'node', title: 'Capabilities', icon: faMicrochip, order: 30, component: NodeCapabilities })
  api.panel({ id: 'labels', kind: 'node', title: 'Labels & Taints', icon: faTags, order: 40, component: NodeLabels })
  api.panel({ id: 'pods', kind: 'node', title: 'Pods', icon: faCubes, order: 50, component: NodePods })
  api.panel({ id: 'conditions', kind: 'node', title: 'Conditions', icon: faHeartPulse, order: 70, component: NodeConditions })
  api.panel({ id: 'events', kind: 'node', title: 'Events', icon: faScroll, order: 80, component: NodeEvents })
  api.panel({ id: 'yaml', kind: 'node', title: 'YAML', icon: faFileCode, order: 90, component: NodeYaml })

  // Maintenance, as a split button: the main half cordons (or uncordons).
  api.action({
    id: 'cordon',
    kind: 'node',
    group: 'power',
    order: 10,
    title: 'Cordon',
    icon: faBan,
    visible: (ctx) => !cordoned(ctx),
    enabled: (ctx) => !!ctx.object,
    access: patchNode,
    run: async (ctx) => {
      const ok = await confirm({
        title: `Cordon ${ctx.name}`,
        message: `Mark ${ctx.name} unschedulable? Running VMs and pods keep running; nothing new is placed here until it is uncordoned.`,
        confirmText: 'Cordon',
      })
      if (ok) await run(`Cordon ${ctx.name}`, () => gateway.call('node.cordon', { name: ctx.name }))
    },
  })
  api.action({
    id: 'uncordon',
    kind: 'node',
    group: 'power',
    order: 11,
    title: 'Uncordon',
    icon: faCircleCheck,
    visible: cordoned,
    enabled: (ctx) => !!ctx.object,
    access: patchNode,
    run: async (ctx) => {
      await run(`Uncordon ${ctx.name}`, () => gateway.call('node.uncordon', { name: ctx.name }))
    },
  })
  api.action({
    id: 'drain',
    kind: 'node',
    group: 'power',
    order: 20,
    title: 'Drain (maintenance mode)',
    icon: faPersonWalkingArrowRight,
    danger: true,
    enabled: (ctx) => !!ctx.object,
    access: (ctx) => [patchNode(ctx), { verb: 'create', group: 'kubevirt.io', resource: 'virtualmachineinstancemigrations' }],
    run: async (ctx) => {
      const guests = guestsOn(ctx.name)
      const stuck = guests.filter((v) => !isTrue(v, 'LiveMigratable'))
      const lines = [
        `${ctx.name} is cordoned, then every live-migratable guest is migrated to another node.`,
        guests.length ? `\n${guests.length} guest(s) run here${stuck.length ? `; ${stuck.length} cannot live-migrate (${stuck.map((v) => v.metadata.name).join(', ')}) and will stay until handled` : ''}.` : '\nNo guests run here.',
      ]
      const result = await confirm({
        title: `Drain ${ctx.name}`,
        message: lines.join(''),
        confirmText: 'Drain',
        danger: true,
        options: [
          {
            key: 'evictPods',
            label: 'Also evict other pods',
            default: false,
            hint: 'Uses the Eviction API, so PodDisruptionBudgets are respected. DaemonSet and static pods stay.',
          },
        ],
      })
      if (result) await run(`Drain ${ctx.name}`, () => gateway.call('node.drain', { name: ctx.name, evictPods: result.options.evictPods }), { openLog: true })
    },
  })
}
