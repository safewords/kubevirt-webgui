/** Datacenter (cluster-wide) screens, grouped like Proxmox's datacenter menu. */
import {
  faGaugeHigh, faPuzzlePiece, faServer, faGears, faDatabase, faArrowRightArrowLeft, faCubes, faFolderTree, faUserShield, faScroll, faUserGear,
} from '@fortawesome/free-solid-svg-icons'
import type { PluginApi } from '@/plugins/registry'
import DatacenterSummary from './DatacenterSummary.vue'
import Extensions from './Extensions.vue'
import NodesPanel from './NodesPanel.vue'
import OptionsPanel from './OptionsPanel.vue'
import StoragePanel from './StoragePanel.vue'
import MigrationsPanel from './MigrationsPanel.vue'
import InstanceTypesPanel from './InstanceTypesPanel.vue'
import NamespacesPanel from './NamespacesPanel.vue'
import PermissionsPanel from './PermissionsPanel.vue'
import EventsPanel from './EventsPanel.vue'
import MySettings from './MySettings.vue'

export function setupDatacenter(api: PluginApi) {
  api.panel({ id: 'summary', kind: 'datacenter', title: 'Summary', icon: faGaugeHigh, order: 10, component: DatacenterSummary })

  api.panel({ id: 'nodes', kind: 'datacenter', title: 'Nodes', icon: faServer, order: 100, group: 'Cluster', component: NodesPanel })
  api.panel({ id: 'options', kind: 'datacenter', title: 'Options', icon: faGears, order: 110, group: 'Cluster', component: OptionsPanel })
  api.panel({ id: 'events', kind: 'datacenter', title: 'Events', icon: faScroll, order: 120, group: 'Cluster', component: EventsPanel })

  api.panel({ id: 'storage', kind: 'datacenter', title: 'Storage', icon: faDatabase, order: 200, group: 'Storage', component: StoragePanel })

  api.panel({ id: 'migrations', kind: 'datacenter', title: 'Migrations', icon: faArrowRightArrowLeft, order: 300, group: 'Virtualization', requires: ['kubevirt.io/v1/virtualmachineinstancemigrations'], component: MigrationsPanel })
  api.panel({ id: 'instancetypes', kind: 'datacenter', title: 'Instance Types', icon: faCubes, order: 310, group: 'Virtualization', requires: ['instancetype.kubevirt.io'], component: InstanceTypesPanel })

  api.panel({ id: 'namespaces', kind: 'datacenter', title: 'Namespaces', icon: faFolderTree, order: 400, group: 'Access', component: NamespacesPanel })
  api.panel({ id: 'permissions', kind: 'datacenter', title: 'Permissions', icon: faUserShield, order: 410, group: 'Access', component: PermissionsPanel })

  api.panel({ id: 'my-settings', kind: 'datacenter', title: 'My Settings', icon: faUserGear, order: 890, group: 'GUI', component: MySettings })
  api.panel({ id: 'extensions', kind: 'datacenter', title: 'Extensions', icon: faPuzzlePiece, order: 900, group: 'GUI', component: Extensions })
}
