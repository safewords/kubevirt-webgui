/** Typed wrappers over the generic `resource.*` gateway methods. */
import { gateway } from './gateway'
import type { KObject } from './types'

export interface Ref {
  apiVersion: string
  resource: string
  namespace?: string
  name?: string
  subresource?: string
}

export type PatchType = 'merge' | 'json' | 'strategic' | 'apply'

export const k8s = {
  list<T = KObject>(ref: Ref, options: { labelSelector?: string; fieldSelector?: string; limit?: number } = {}) {
    return gateway.call<{ items: T[]; metadata: any }>('resource.list', { ...ref, ...options })
  },
  get<T = KObject>(ref: Ref & { name: string }) {
    return gateway.call<T>('resource.get', ref)
  },
  create<T = KObject>(ref: Ref, body: object, options: { dryRun?: boolean } = {}) {
    return gateway.call<T>('resource.create', { ...ref, body, ...options })
  },
  replace<T = KObject>(ref: Ref & { name: string }, body: object, options: { dryRun?: boolean } = {}) {
    return gateway.call<T>('resource.replace', { ...ref, body, ...options })
  },
  patch<T = KObject>(ref: Ref & { name: string }, patch: unknown, patchType: PatchType = 'merge', options: { dryRun?: boolean; force?: boolean } = {}) {
    return gateway.call<T>('resource.patch', { ...ref, patch, patchType, ...options })
  },
  delete(ref: Ref & { name: string }, options: { propagationPolicy?: 'Background' | 'Foreground' | 'Orphan'; gracePeriodSeconds?: number } = {}) {
    return gateway.call('resource.delete', { ...ref, ...options })
  },
  subresource<T = any>(ref: Ref & { name: string; subresource: string }, method: 'GET' | 'PUT' | 'POST' | 'PATCH' = 'GET', body?: unknown, query?: Record<string, string>) {
    return gateway.call<T>('resource.subresource', { ...ref, method, body, query })
  },
  logs(namespace: string, name: string, options: { container?: string; tailLines?: number; previous?: boolean } = {}) {
    return gateway.call<string>('resource.logs', { namespace, name, ...options })
  },
}

/** The `apiVersion`+`resource` of an object's kind, for the common kinds. */
export function refFor(object: KObject): Ref | null {
  const table: Record<string, string> = {
    VirtualMachine: 'virtualmachines',
    VirtualMachineInstance: 'virtualmachineinstances',
    VirtualMachineInstanceMigration: 'virtualmachineinstancemigrations',
    VirtualMachineSnapshot: 'virtualmachinesnapshots',
    VirtualMachineRestore: 'virtualmachinerestores',
    VirtualMachineClone: 'virtualmachineclones',
    VirtualMachineExport: 'virtualmachineexports',
    VirtualMachinePool: 'virtualmachinepools',
    VirtualMachineInstancetype: 'virtualmachineinstancetypes',
    VirtualMachineClusterInstancetype: 'virtualmachineclusterinstancetypes',
    VirtualMachinePreference: 'virtualmachinepreferences',
    VirtualMachineClusterPreference: 'virtualmachineclusterpreferences',
    MigrationPolicy: 'migrationpolicies',
    KubeVirt: 'kubevirts',
    DataVolume: 'datavolumes',
    DataSource: 'datasources',
    DataImportCron: 'dataimportcrons',
    StorageProfile: 'storageprofiles',
    CDI: 'cdis',
    CDIConfig: 'cdiconfigs',
    Node: 'nodes',
    Namespace: 'namespaces',
    Pod: 'pods',
    Service: 'services',
    PersistentVolumeClaim: 'persistentvolumeclaims',
    PersistentVolume: 'persistentvolumes',
    StorageClass: 'storageclasses',
    ConfigMap: 'configmaps',
    Secret: 'secrets',
    ServiceAccount: 'serviceaccounts',
    Role: 'roles',
    RoleBinding: 'rolebindings',
    ClusterRole: 'clusterroles',
    ClusterRoleBinding: 'clusterrolebindings',
    ResourceQuota: 'resourcequotas',
    LimitRange: 'limitranges',
    NetworkPolicy: 'networkpolicies',
    NetworkAttachmentDefinition: 'network-attachment-definitions',
    UsbDevice: 'usbdevices',
    UsbDeviceClaim: 'usbdeviceclaims',
  }
  const resource = object.kind ? table[object.kind] : undefined
  if (!resource || !object.apiVersion) return null
  return { apiVersion: object.apiVersion, resource, namespace: object.metadata.namespace, name: object.metadata.name }
}

/** VM power and lifecycle, each returning `{ task }`. */
export const vmApi = {
  action(action: 'start' | 'stop' | 'shutdown' | 'restart' | 'reboot' | 'reset' | 'pause' | 'resume' | 'freeze' | 'unfreeze', namespace: string, name: string, options: { force?: boolean; paused?: boolean } = {}) {
    return gateway.call<{ task: string }>(`vm.${action}`, { namespace, name, ...options })
  },
  migrate(namespace: string, name: string, targetNode?: string) {
    return gateway.call<{ task: string }>('vm.migrate', { namespace, name, targetNode })
  },
  delete(namespace: string, name: string, deleteDisks: boolean) {
    return gateway.call<{ task: string }>('vm.delete', { namespace, name, deleteDisks })
  },
  snapshot(namespace: string, name: string, snapshot: string, description?: string, apiVersion?: string) {
    return gateway.call<{ task: string }>('vm.snapshot', { namespace, name, snapshot, description, apiVersion })
  },
  restore(namespace: string, name: string, snapshot: string, apiVersion?: string) {
    return gateway.call<{ task: string }>('vm.restore', { namespace, name, snapshot, apiVersion })
  },
  clone(namespace: string, name: string, target: string, apiVersion?: string) {
    return gateway.call<{ task: string }>('vm.clone', { namespace, name, target, apiVersion })
  },
  guest(namespace: string, name: string) {
    return gateway.call<{ os: any; users: any; filesystems: any }>('vm.guest', { namespace, name })
  },
  screenshot(namespace: string, name: string) {
    return gateway.call<{ dataUrl: string; takenAt: number }>('vm.screenshot', { namespace, name }, { timeout: 20000 })
  },
  consoleTicket(namespace: string, name: string, kind: 'vnc' | 'serial') {
    return gateway.call<{ ticket: string; path: string }>('console.ticket', { namespace, name, kind })
  },
  create(vm: object, options: { dataVolumes?: object[]; extraObjects?: object[]; start?: boolean } = {}) {
    return gateway.call<{ task: string }>('vm.create', { vm, ...options })
  },
}
