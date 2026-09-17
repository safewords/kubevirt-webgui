/** Networking screens: services that expose VMs, network devices, secondary networks, firewall. */
import { faNetworkWired, faTowerBroadcast, faShieldHalved, faDiagramProject } from '@fortawesome/free-solid-svg-icons'
import type { PluginApi } from '@/plugins/registry'
import VmServices from './VmServices.vue'
import VmNetwork from './VmNetwork.vue'
import VmFirewall from './VmFirewall.vue'
import DatacenterNetworks from './DatacenterNetworks.vue'

export function setupNetwork(api: PluginApi) {
  api.panel({ id: 'network', kind: 'vm', title: 'Network', icon: faNetworkWired, order: 44, component: VmNetwork })
  api.panel({ id: 'services', kind: 'vm', title: 'Services', icon: faTowerBroadcast, order: 46, component: VmServices })
  api.panel({ id: 'firewall', kind: 'vm', title: 'Firewall', icon: faShieldHalved, order: 47, requires: ['networking.k8s.io/v1/networkpolicies'], component: VmFirewall })
  api.panel({ id: 'networks', kind: 'datacenter', title: 'Networks', icon: faDiagramProject, order: 250, group: 'Network', component: DatacenterNetworks })
}
