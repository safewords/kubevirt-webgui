/**
 * Import from Proxmox VE — a Create menu entry opening the import wizard.
 * The server does the copying; see the `proxmox` backend extension.
 */
import { faFileImport } from '@fortawesome/free-solid-svg-icons'
import type { PluginApi } from '@/plugins/registry'
import { openDialog } from '@/services/dialogs'
import ProxmoxImportWizard from './ProxmoxImportWizard.vue'

export function setupProxmoxImport(api: PluginApi) {
  api.createItem({
    id: 'import-proxmox',
    title: 'Import from Proxmox',
    icon: faFileImport,
    order: 15,
    primary: true,
    requires: ['kubevirt.io/v1/virtualmachines', 'cdi.kubevirt.io/v1beta1/datavolumes'],
    run: () => openDialog(ProxmoxImportWizard, {}),
  })
}
