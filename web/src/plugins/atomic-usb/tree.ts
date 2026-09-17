/** "USB View": Datacenter → nodes → the devices plugged into each. */
import { faBuilding, faServer, faPlug } from '@fortawesome/free-solid-svg-icons'
import { faUsb } from '@fortawesome/free-brands-svg-icons'
import type { TreeNode, TreeViewDef } from '@/plugins/registry'
import { useInventory } from '@/plugins/core/inventory'
import { deviceLabel, useUsb } from './store'

export const usbTreeView: TreeViewDef = {
  id: 'usb',
  title: 'USB View',
  order: 60,
  setup() {
    useUsb()
  },
  build() {
    const usb = useUsb()
    const inv = useInventory()
    const byNode = new Map<string, TreeNode[]>()
    for (const device of usb.devices) {
      const node = device.status?.node ?? '(unplugged)'
      const attached = device.status?.attachedTo
      const leaf: TreeNode = {
        key: `usb/${device.metadata.name}`,
        label: device.spec?.product ?? device.spec?.manufacturer ?? `${device.spec?.vendorId}:${device.spec?.productId}`,
        hint: attached ? `→ ${attached.vmName}` : device.status?.portPath,
        icon: attached ? faPlug : faUsb,
        iconClass: device.status?.phase === 'Available' ? (attached ? 'text-accent' : 'text-fg') : 'text-fg-subtle',
        badge: device.status?.phase === 'Lost' ? 'error' : device.status?.phase === 'Unplugged' ? 'warning' : attached ? 'running' : undefined,
        // Attached devices open their VM; free ones the node they are plugged into.
        to: attached ? { kind: 'vm', name: attached.vmName, namespace: attached.namespace, panel: 'usb' } : device.status?.node ? { kind: 'node', name: device.status.node, panel: 'usb' } : undefined,
        tags: [deviceLabel(device), device.spec?.serial ?? ''].filter(Boolean),
      }
      const list = byNode.get(node) ?? []
      list.push(leaf)
      byNode.set(node, list)
    }
    const nodeNames = new Set([...inv.nodes.map((n) => n.metadata.name), ...byNode.keys()])
    const children: TreeNode[] = [...nodeNames]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .filter((name) => byNode.has(name))
      .map((name) => ({
        key: `usb-node/${name}`,
        label: name,
        hint: String(byNode.get(name)!.length),
        icon: faServer,
        iconClass: 'text-fg',
        to: name.startsWith('(') ? undefined : { kind: 'node', name, panel: 'usb' },
        children: byNode.get(name),
      }))
    return [{ key: 'datacenter', label: 'Datacenter', icon: faBuilding, iconClass: 'text-accent', to: { kind: 'datacenter' }, children }]
  },
}
