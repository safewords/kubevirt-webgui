/**
 * Namespaces a form may create on submit: the VM wizard, the disk dialog and
 * the Proxmox importer let the user name a namespace that does not exist yet,
 * and create it just before what goes in it.
 */
import { k8s } from '@/api/k8s'
import { useCluster } from '@/stores/cluster'
import { isDnsLabel } from '@/util/format'

/** Whether `name` is a namespace the user can see is missing. */
export function isNewNamespace(name: string): boolean {
  const cluster = useCluster()
  return isDnsLabel(name) && cluster.canListNamespaces && !cluster.namespaceNames.includes(name)
}

/**
 * Create `name` unless it exists. Returns whether it was created. Someone who
 * cannot list namespaces cannot tell a missing one from a hidden one, so for
 * them a refusal is not an error here: the create that follows says whether
 * the namespace is really there.
 */
export async function ensureNamespace(name: string): Promise<boolean> {
  const cluster = useCluster()
  if (cluster.canListNamespaces && cluster.namespaceNames.includes(name)) return false
  try {
    await k8s.create({ apiVersion: 'v1', resource: 'namespaces' }, { apiVersion: 'v1', kind: 'Namespace', metadata: { name } })
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 409 || (status === 403 && !cluster.canListNamespaces)) return false
    throw e
  }
  await cluster.reloadNamespaces().catch(() => {})
  return true
}
