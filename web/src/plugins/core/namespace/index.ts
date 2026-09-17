/** Namespace screens — Proxmox's resource pools. */
import { faGaugeHigh, faFileCode, faScaleBalanced, faUserShield, faShieldHalved, faScroll } from '@fortawesome/free-solid-svg-icons'
import { defineComponent, h } from 'vue'
import type { ObjectContext, PluginApi } from '@/plugins/registry'
import ResourceYaml from '@/components/common/ResourceYaml.vue'
import NamespaceSummary from './NamespaceSummary.vue'
import NamespaceQuotas from './NamespaceQuotas.vue'
import NamespacePermissions from './NamespacePermissions.vue'
import NamespaceFirewall from './NamespaceFirewall.vue'
import NamespaceEvents from './NamespaceEvents.vue'

const NamespaceYaml = defineComponent({
  props: { ctx: { type: Object as () => ObjectContext, required: true } },
  setup: (props) => () => h('div', { class: 'h-full p-3' }, [h(ResourceYaml, { object: props.ctx.object })]),
})

export function setupNamespace(api: PluginApi) {
  api.panel({ id: 'summary', kind: 'namespace', title: 'Summary', icon: faGaugeHigh, order: 10, component: NamespaceSummary })
  api.panel({ id: 'quotas', kind: 'namespace', title: 'Quotas', icon: faScaleBalanced, order: 20, component: NamespaceQuotas })
  api.panel({ id: 'permissions', kind: 'namespace', title: 'Permissions', icon: faUserShield, order: 30, component: NamespacePermissions })
  api.panel({ id: 'firewall', kind: 'namespace', title: 'Firewall', icon: faShieldHalved, order: 40, requires: ['networking.k8s.io/v1/networkpolicies'], component: NamespaceFirewall })
  api.panel({ id: 'events', kind: 'namespace', title: 'Events', icon: faScroll, order: 80, component: NamespaceEvents })
  api.panel({ id: 'yaml', kind: 'namespace', title: 'YAML', icon: faFileCode, order: 90, component: NamespaceYaml })
}
