/**
 * The create menu, and the image library.
 *
 * Disks and images are CDI DataVolumes. A URL is downloaded (and converted —
 * qcow2, VMDK, VHD/VHDX — to raw) inside the cluster by CDI; a file from the
 * browser is uploaded over the gateway's upload socket. Either way the result
 * is a PVC that VMs clone from.
 */
import { faDesktop, faHardDrive, faUpload, faCloudArrowDown, faCompactDisc } from '@fortawesome/free-solid-svg-icons'
import type { PluginApi } from '@/plugins/registry'
import { openDialog } from '@/services/dialogs'
import CreateVmWizard from './CreateVmWizard.vue'
import CreateDiskDialog from './CreateDiskDialog.vue'
import ImagesPanel from './ImagesPanel.vue'
import { imageNamespace } from './helpers'

export function setupCreate(api: PluginApi) {
  api.createItem({
    id: 'create-vm',
    title: 'Create VM',
    icon: faDesktop,
    order: 10,
    primary: true,
    requires: ['kubevirt.io/v1/virtualmachines'],
    run: () => openDialog(CreateVmWizard, {}),
  })
  api.createItem({
    id: 'create-disk',
    title: 'Create Disk',
    icon: faHardDrive,
    order: 20,
    requires: ['cdi.kubevirt.io/v1beta1/datavolumes'],
    run: () => openDialog(CreateDiskDialog, {}),
  })
  api.createItem({
    id: 'upload-image',
    title: 'Upload image',
    icon: faUpload,
    order: 30,
    requires: ['cdi.kubevirt.io/v1beta1/datavolumes'],
    run: () => openDialog(CreateDiskDialog, { source: 'upload', imageType: null, namespace: imageNamespace.value }),
  })
  api.createItem({
    id: 'download-image',
    title: 'Download image from URL',
    icon: faCloudArrowDown,
    order: 40,
    requires: ['cdi.kubevirt.io/v1beta1/datavolumes'],
    run: () => openDialog(CreateDiskDialog, { source: 'http', imageType: null, namespace: imageNamespace.value }),
  })

  api.panel({
    id: 'images',
    kind: 'datacenter',
    title: 'Images',
    icon: faCompactDisc,
    order: 210,
    group: 'Storage',
    requires: ['cdi.kubevirt.io/v1beta1/datavolumes'],
    component: ImagesPanel,
  })
}
