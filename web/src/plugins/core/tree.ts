/** The resource tree views: by server, by namespace, by type, by tag. */
import { faBuilding, faServer, faDesktop, faHardDrive, faFolder, faFolderOpen, faLayerGroup, faTag, faPowerOff, faCubes } from '@fortawesome/free-solid-svg-icons'
import type { KObject } from '@/api/types'
import type { PluginApi, TreeNode } from '@/plugins/registry'
import { useInventory } from './inventory'
import { useCluster } from '@/stores/cluster'
import { nodeReady, tags, vmState, type VmState } from '@/util/kubevirt'

function badgeFor(state: VmState): TreeNode['badge'] {
  switch (state) {
    case 'running':
      return 'running'
    case 'paused':
      return 'paused'
    case 'error':
      return 'error'
    case 'migrating':
      return 'migrating'
    case 'starting':
    case 'stopping':
    case 'provisioning':
      return 'pending'
    default:
      return undefined
  }
}

function vmNode(vm: KObject, vmi: KObject | null, withNamespace = true): TreeNode {
  const state = vmState(vm, vmi)
  return {
    key: `vm/${vm.metadata.namespace}/${vm.metadata.name}`,
    label: vm.metadata.name,
    hint: withNamespace ? vm.metadata.namespace : undefined,
    icon: faDesktop,
    iconClass: state === 'running' ? 'text-fg' : state === 'error' ? 'text-bad' : 'text-fg-subtle',
    badge: badgeFor(state),
    to: { kind: 'vm', name: vm.metadata.name, namespace: vm.metadata.namespace },
    tags: tags(vm),
  }
}

function bareVmiNode(vmi: KObject): TreeNode {
  return {
    key: `vmi/${vmi.metadata.namespace}/${vmi.metadata.name}`,
    label: vmi.metadata.name,
    hint: `${vmi.metadata.namespace} · VMI`,
    icon: faDesktop,
    iconClass: 'text-fg',
    badge: vmi.status?.phase === 'Running' ? 'running' : 'pending',
    to: { kind: 'vm', name: vmi.metadata.name, namespace: vmi.metadata.namespace },
  }
}

function nodeNode(node: KObject, children: TreeNode[]): TreeNode {
  const ready = nodeReady(node)
  const cordoned = !!node.spec?.unschedulable
  return {
    key: `node/${node.metadata.name}`,
    label: node.metadata.name,
    icon: faServer,
    iconClass: ready ? (cordoned ? 'text-warn' : 'text-fg') : 'text-bad',
    badge: ready ? (cordoned ? 'warning' : undefined) : 'error',
    hint: cordoned ? 'maintenance' : undefined,
    to: { kind: 'node', name: node.metadata.name },
    children,
  }
}

function diskNode(pvc: KObject, withNamespace = true): TreeNode {
  const phase = pvc.status?.phase
  return {
    key: `disk/${pvc.metadata.namespace}/${pvc.metadata.name}`,
    label: pvc.metadata.name,
    hint: withNamespace ? pvc.metadata.namespace : pvc.spec?.resources?.requests?.storage,
    icon: faHardDrive,
    iconClass: phase === 'Bound' ? 'text-fg-muted' : 'text-warn',
    badge: phase === 'Bound' ? undefined : phase === 'Lost' ? 'error' : 'pending',
    to: { kind: 'disk', name: pvc.metadata.name, namespace: pvc.metadata.namespace },
  }
}

function datacenter(children: TreeNode[]): TreeNode[] {
  const cluster = useCluster()
  const name = cluster.discovery ? `Datacenter` : 'Datacenter'
  return [{ key: 'datacenter', label: name, icon: faBuilding, iconClass: 'text-accent', to: { kind: 'datacenter' }, children }]
}

export function registerTreeViews(api: PluginApi) {
  api.treeView({
    id: 'server',
    title: 'Server View',
    order: 10,
    build() {
      const inv = useInventory()
      const running = new Map<string, TreeNode[]>()
      const stopped: TreeNode[] = []
      for (const vm of inv.vms) {
        const vmi = inv.vmiFor(vm)
        const nodeName = vmi?.status?.nodeName
        if (nodeName) {
          const list = running.get(nodeName) ?? []
          list.push(vmNode(vm, vmi))
          running.set(nodeName, list)
        } else stopped.push(vmNode(vm, vmi))
      }
      for (const vmi of inv.bareVmis) {
        const nodeName = vmi.status?.nodeName
        if (!nodeName) continue
        const list = running.get(nodeName) ?? []
        list.push(bareVmiNode(vmi))
        running.set(nodeName, list)
      }
      const children: TreeNode[] = inv.nodes.map((n) => nodeNode(n, running.get(n.metadata.name) ?? []))
      // Guests on nodes this user cannot list still deserve a place.
      for (const [nodeName, guests] of running) {
        if (!inv.nodes.some((n) => n.metadata.name === nodeName)) {
          children.push({ key: `node/${nodeName}`, label: nodeName, icon: faServer, iconClass: 'text-fg-muted', to: { kind: 'node', name: nodeName }, children: guests })
        }
      }
      if (stopped.length) {
        children.push({ key: 'group/stopped', label: 'Not running', icon: faPowerOff, iconClass: 'text-fg-subtle', hint: String(stopped.length), children: stopped })
      }
      return datacenter(children)
    },
  })

  api.treeView({
    id: 'namespace',
    title: 'Namespace View',
    order: 20,
    build() {
      const inv = useInventory()
      const cluster = useCluster()
      const groups = new Map<string, { vms: TreeNode[]; disks: TreeNode[] }>()
      const group = (ns: string) => {
        let g = groups.get(ns)
        if (!g) groups.set(ns, (g = { vms: [], disks: [] }))
        return g
      }
      for (const vm of inv.vms) group(vm.metadata.namespace!).vms.push(vmNode(vm, inv.vmiFor(vm), false))
      for (const vmi of inv.bareVmis) group(vmi.metadata.namespace!).vms.push(bareVmiNode(vmi))
      for (const pvc of inv.pvcs) {
        // Disks that belong to VMs; other claims are not this GUI's business.
        const dv = inv.dataVolumeFor(pvc)
        const owned = dv || pvc.metadata.ownerReferences?.some((o) => o.kind === 'DataVolume') || pvc.metadata.labels?.['app'] === 'containerized-data-importer'
        if (owned) group(pvc.metadata.namespace!).disks.push(diskNode(pvc, false))
      }
      const names = new Set([...groups.keys(), ...(cluster.canListNamespaces ? [] : cluster.namespaceNames)])
      const children = [...names].sort().map<TreeNode>((ns) => {
        const g = groups.get(ns) ?? { vms: [], disks: [] }
        const kids = [...g.vms]
        if (g.disks.length) kids.push({ key: `ns/${ns}/disks`, label: 'Disks', icon: faFolderOpen, iconClass: 'text-fg-subtle', hint: String(g.disks.length), children: g.disks })
        return { key: `ns/${ns}`, label: ns, icon: faFolder, iconClass: 'text-accent/80', hint: g.vms.length ? String(g.vms.length) : undefined, to: { kind: 'namespace', name: ns }, children: kids }
      })
      return datacenter(children)
    },
  })

  api.treeView({
    id: 'type',
    title: 'Type View',
    order: 30,
    build() {
      const inv = useInventory()
      const cluster = useCluster()
      const vms = [...inv.vms.map((vm) => vmNode(vm, inv.vmiFor(vm))), ...inv.bareVmis.map(bareVmiNode)]
      const disks = inv.pvcs.filter((p) => inv.dataVolumeFor(p) || p.metadata.ownerReferences?.some((o) => o.kind === 'DataVolume')).map((p) => diskNode(p))
      return datacenter([
        { key: 'type/vms', label: 'Virtual Machines', icon: faCubes, iconClass: 'text-fg-muted', hint: String(vms.length), children: vms },
        { key: 'type/nodes', label: 'Nodes', icon: faLayerGroup, iconClass: 'text-fg-muted', hint: String(inv.nodes.length), children: inv.nodes.map((n) => nodeNode(n, [])) },
        { key: 'type/disks', label: 'Disks', icon: faHardDrive, iconClass: 'text-fg-muted', hint: String(disks.length), children: disks },
        {
          key: 'type/namespaces',
          label: 'Namespaces',
          icon: faFolder,
          iconClass: 'text-fg-muted',
          hint: String(cluster.namespaces.length),
          children: cluster.namespaces.map((ns) => ({ key: `ns/${ns.name}`, label: ns.name, icon: faFolder, iconClass: 'text-accent/80', to: { kind: 'namespace', name: ns.name } })),
        },
      ])
    },
  })

  api.treeView({
    id: 'tag',
    title: 'Tag View',
    order: 40,
    build() {
      const inv = useInventory()
      const byTag = new Map<string, TreeNode[]>()
      const untagged: TreeNode[] = []
      for (const vm of inv.vms) {
        const node = vmNode(vm, inv.vmiFor(vm))
        const t = tags(vm)
        if (!t.length) untagged.push(node)
        for (const tag of t) {
          const list = byTag.get(tag) ?? []
          list.push({ ...node, key: `${node.key}#${tag}` })
          byTag.set(tag, list)
        }
      }
      const children: TreeNode[] = [...byTag.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tag, list]) => ({ key: `tag/${tag}`, label: tag, icon: faTag, iconClass: 'text-accent/80', hint: String(list.length), children: list }))
      if (untagged.length) children.push({ key: 'tag/-', label: 'No tags', icon: faTag, iconClass: 'text-fg-subtle', hint: String(untagged.length), children: untagged })
      return datacenter(children)
    },
  })
}
