/**
 * atomic-usb: USB devices from any node, attached to VMs on any other.
 *
 * An optional integration, shipped with the GUI but written exactly as a
 * third-party plugin would be. It activates when the cluster serves
 * `atomicusb.safewords.io`, and removes itself again if the CRDs are
 * uninstalled — no reload either way. The server side
 * (`src/extensions/atomic_usb.rs`) likewise refuses its methods with a clear
 * "not available" while the CRDs are absent.
 */
import { faUsb } from '@fortawesome/free-brands-svg-icons'
import { definePlugin } from '@/plugins/registry'
import { openDialog } from '@/services/dialogs'
import VmUsb from './VmUsb.vue'
import DatacenterUsb from './DatacenterUsb.vue'
import NodeUsb from './NodeUsb.vue'
import AttachUsbDialog from './AttachUsbDialog.vue'
import { usbTreeView } from './tree'
import { API, disposeUsbStore } from './store'

export default definePlugin({
  id: 'atomic-usb',
  name: 'atomic-usb',
  description: 'Attach USB devices plugged into any node to VMs running on any other node.',
  requires: [`${API}/usbdeviceclaims`],
  setup(api) {
    api.panel({ id: 'usb', kind: 'vm', title: 'USB Devices', icon: faUsb, order: 45, component: VmUsb })
    api.panel({ id: 'usb', kind: 'datacenter', title: 'USB Devices', icon: faUsb, order: 350, group: 'Hardware', requires: [`${API}/usbdevices`], component: DatacenterUsb })
    api.panel({ id: 'usb', kind: 'node', title: 'USB', icon: faUsb, order: 60, requires: [`${API}/usbdevices`], component: NodeUsb })
    api.treeView({ ...usbTreeView, requires: [`${API}/usbdevices`] })
    api.action({
      id: 'attach-usb',
      kind: 'vm',
      group: 'more',
      order: 50,
      title: 'Attach USB device…',
      icon: faUsb,
      visible: (ctx) => !!ctx.object,
      access: (ctx) => ({ verb: 'create', group: 'atomicusb.safewords.io', resource: 'usbdeviceclaims', namespace: ctx.namespace }),
      run: (ctx) => openDialog(AttachUsbDialog, { namespace: ctx.namespace, vm: ctx.name }),
    })
  },
  teardown() {
    // Stop the device and claim watches, which would otherwise keep asking
    // the API server for resources that no longer exist.
    disposeUsbStore()
  },
})
