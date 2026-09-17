/**
 * The built-in plugin. Each area registers itself from its own module, so
 * the areas can grow independently:
 *
 *   datacenter/  cluster-wide screens      node/       a node
 *   vm/          a virtual machine         namespace/  a namespace (Proxmox's pools)
 *   disk/        a disk (PVC/DataVolume)   create/     the create menu and wizards
 *   network/     services, network policies, attachments
 */
import { faBuilding, faServer, faDesktop, faFolder, faHardDrive } from '@fortawesome/free-solid-svg-icons'
import { definePlugin } from '@/plugins/registry'
import { useCluster } from '@/stores/cluster'
import { registerTreeViews } from './tree'
import VmStatus from './vm/VmStatus.vue'
import { setupDatacenter } from './datacenter'
import { setupNode } from './node'
import { setupVm } from './vm'
import { setupNamespace } from './namespace'
import { setupDisk } from './disk'
import { setupCreate } from './create'
import { setupProxmoxImport } from './proxmox'
import { setupNetwork } from './network'

export default definePlugin({
  id: 'core',
  name: 'Core',
  description: 'Datacenter, nodes, virtual machines, namespaces and disks.',
  setup(api) {
    api.kind({ id: 'datacenter', title: 'Datacenter', icon: faBuilding, scope: 'none', heading: () => 'Datacenter', defaultPanel: 'summary' })
    api.kind({
      id: 'node',
      title: 'Node',
      icon: faServer,
      scope: 'cluster',
      resource: ({ name }) => ({ apiVersion: 'v1', resource: 'nodes', name }),
      heading: (ctx) => `Node '${ctx.name}'`,
      defaultPanel: 'summary',
    })
    api.kind({
      id: 'vm',
      title: 'Virtual Machine',
      icon: faDesktop,
      scope: 'namespaced',
      resource: ({ name, namespace }) => ({ apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', name, namespace }),
      related: ({ name, namespace }) => ({ vmi: { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstances', name, namespace } }),
      heading: (ctx) => {
        const node = ctx.related.vmi?.status?.nodeName
        return `Virtual Machine ${ctx.name} (${ctx.namespace})${node ? ` on node '${node}'` : ''}`
      },
      status: VmStatus,
      defaultPanel: 'summary',
    })
    api.kind({
      id: 'namespace',
      title: 'Namespace',
      icon: faFolder,
      scope: 'cluster',
      resource: ({ name }) => ({ apiVersion: 'v1', resource: 'namespaces', name }),
      heading: (ctx) => `Namespace '${ctx.name}'`,
      defaultPanel: 'summary',
    })
    api.kind({
      id: 'disk',
      title: 'Disk',
      icon: faHardDrive,
      scope: 'namespaced',
      resource: ({ name, namespace }) => ({ apiVersion: 'v1', resource: 'persistentvolumeclaims', name, namespace }),
      // CDI is optional: without it a disk is just its claim.
      related: ({ name, namespace }) => ({
        dataVolume: useCluster().has('cdi.kubevirt.io/v1beta1/datavolumes') ? { apiVersion: 'cdi.kubevirt.io/v1beta1', resource: 'datavolumes', name, namespace } : null,
      }),
      heading: (ctx) => `Disk ${ctx.name} (${ctx.namespace})`,
      defaultPanel: 'summary',
    })

    registerTreeViews(api)
    setupDatacenter(api)
    setupNode(api)
    setupVm(api)
    setupNamespace(api)
    setupDisk(api)
    setupCreate(api)
    setupProxmoxImport(api)
    setupNetwork(api)
  },
})
