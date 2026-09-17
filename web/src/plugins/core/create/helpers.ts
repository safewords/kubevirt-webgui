/**
 * Shared pieces for creating VMs, disks and images: storage classes, the
 * image library's namespace, and DataVolume builders.
 *
 * Every disk the GUI creates is a CDI DataVolume. CDI fills the claim from
 * the source — downloading and converting URLs (qcow2, VMDK, VHD/VHDX, raw,
 * ISO, compressed with xz/gz), pulling container disks, cloning claims, or
 * receiving an upload — so the browser never handles the image bytes except
 * when it is the source.
 */
import { computed, ref, watch } from 'vue'
import type { KObject } from '@/api/types'
import { useWatch, useMultiWatch } from '@/stores/watch'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { useInventory } from '@/plugins/core/inventory'
import { quantity } from '@/util/format'

export const IMAGE_TYPE_LABEL = 'kubevirt-webgui/image-type'
export const IMAGE_SOURCE_ANNOTATION = 'kubevirt-webgui/source'
export const IMAGE_FILE_ANNOTATION = 'kubevirt-webgui/file-name'
export type ImageType = 'iso' | 'disk'

const GIB = 1024 ** 3

// --- the image library namespace ----------------------------------------------------

const NAMESPACE_KEY = 'kve.images.namespace'

function readNamespace(): string {
  try {
    return localStorage.getItem(NAMESPACE_KEY) || 'kubevirt-images'
  } catch {
    return 'kubevirt-images'
  }
}

/** Where new images go, per browser. */
export const imageNamespace = ref(readNamespace())
watch(imageNamespace, (value) => {
  try {
    localStorage.setItem(NAMESPACE_KEY, value)
  } catch {
    /* a convenience only */
  }
})

// --- storage ------------------------------------------------------------------------

export function isDefaultClass(sc: KObject): boolean {
  const a = sc.metadata.annotations ?? {}
  return a['storageclass.kubernetes.io/is-default-class'] === 'true' || a['storageclass.beta.kubernetes.io/is-default-class'] === 'true'
}

/** Storage classes, the default first. */
export function useStorageClasses() {
  const classes = useWatch(() => ({ apiVersion: 'storage.k8s.io/v1', resource: 'storageclasses' }))
  const sorted = computed(() =>
    [...classes.items.value].sort((a, b) => Number(isDefaultClass(b)) - Number(isDefaultClass(a)) || a.metadata.name.localeCompare(b.metadata.name)),
  )
  const defaultClass = computed(() => sorted.value.find(isDefaultClass)?.metadata.name ?? null)
  return { classes: sorted, defaultClass, synced: classes.synced, error: classes.error }
}

/** CDI's StorageProfiles, which say what access and volume modes each class supports. */
export function useStorageProfiles() {
  const cluster = useCluster()
  const profiles = useWatch(() => {
    const version = cluster.versionFor('cdi.kubevirt.io', 'storageprofiles')
    return version ? { apiVersion: version, resource: 'storageprofiles' } : null
  })
  function describe(storageClass: string | null | undefined): string | null {
    if (!storageClass) return null
    const profile = profiles.items.value.find((p) => p.metadata.name === storageClass)
    const sets = profile?.status?.claimPropertySets as Array<{ accessModes: string[]; volumeMode: string }> | undefined
    if (!sets?.length) return null
    const best = sets[0]
    return `${best.volumeMode} · ${best.accessModes.join(', ')}${best.accessModes.includes('ReadWriteMany') ? ' (live-migratable)' : ''}`
  }
  return { profiles: profiles.items, describe }
}

// --- sizes --------------------------------------------------------------------------

/** GiB as a Kubernetes quantity. Fractions become MiB. */
export function gib(value: number): string {
  if (Number.isInteger(value)) return `${value}Gi`
  return `${Math.ceil(value * 1024)}Mi`
}

/** The claim to hold an image file: a tenth extra, rounded up to whole GiB. */
export function claimGibFor(bytes: number): number {
  return Math.max(1, Math.ceil((bytes * 1.1) / GIB))
}

export function pvcGib(pvc: KObject | null | undefined): number {
  const q = quantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage ?? 0)
  return q ? Math.max(1, Math.ceil(q / GIB)) : 0
}

// --- DataVolumes ----------------------------------------------------------------------

export type DiskSource =
  | { type: 'blank' }
  | { type: 'http'; url: string }
  | { type: 'registry'; url: string }
  | { type: 'pvc'; namespace: string; name: string }
  | { type: 'datasource'; namespace: string; name: string }
  | { type: 'upload' }

export interface DataVolumeOptions {
  name: string
  namespace?: string
  sizeGib: number
  storageClass?: string | null
  source: DiskSource
  imageType?: ImageType | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
  accessMode?: string | null
  volumeMode?: string | null
}

/** The `spec` of a DataVolume (or a VM's DataVolume template). */
export function dataVolumeSpec(o: DataVolumeOptions): Record<string, any> {
  const storage: Record<string, any> = { resources: { requests: { storage: gib(o.sizeGib) } } }
  if (o.storageClass) storage.storageClassName = o.storageClass
  if (o.accessMode) storage.accessModes = [o.accessMode]
  if (o.volumeMode) storage.volumeMode = o.volumeMode

  const spec: Record<string, any> = { storage }
  switch (o.source.type) {
    case 'blank':
      spec.source = { blank: {} }
      break
    case 'http':
      spec.source = { http: { url: o.source.url.trim() } }
      break
    case 'registry':
      spec.source = { registry: { url: registryUrl(o.source.url) } }
      break
    case 'pvc':
      spec.source = { pvc: { namespace: o.source.namespace, name: o.source.name } }
      break
    case 'datasource':
      spec.sourceRef = { kind: 'DataSource', namespace: o.source.namespace, name: o.source.name }
      break
    case 'upload':
      spec.source = { upload: {} }
      break
  }
  return spec
}

/** A standalone DataVolume. */
export function dataVolume(o: DataVolumeOptions): KObject {
  const labels = { ...(o.labels ?? {}) }
  if (o.imageType) labels[IMAGE_TYPE_LABEL] = o.imageType
  const annotations: Record<string, string> = { ...(o.annotations ?? {}), [IMAGE_SOURCE_ANNOTATION]: o.source.type }
  return {
    apiVersion: 'cdi.kubevirt.io/v1beta1',
    kind: 'DataVolume',
    metadata: { name: o.name, namespace: o.namespace, labels, annotations } as any,
    spec: dataVolumeSpec(o),
  }
}

/** CDI wants `docker://` on registry URLs. */
export function registryUrl(image: string): string {
  const trimmed = image.trim()
  return /^[a-z]+:\/\//.test(trimmed) ? trimmed : `docker://${trimmed}`
}

/** A best guess at an image's format from its URL, for the hint beside it. */
export function formatHint(url: string): string | null {
  const clean = url.split(/[?#]/)[0].toLowerCase()
  const compressed = clean.endsWith('.xz') ? ' (xz-compressed)' : clean.endsWith('.gz') ? ' (gzip-compressed)' : ''
  const base = clean.replace(/\.(xz|gz)$/, '')
  if (base.endsWith('.iso')) return `ISO image${compressed} — attach it as a CD/DVD drive`
  if (base.endsWith('.vmdk')) return `VMware VMDK${compressed} — CDI converts it to raw with qemu-img`
  if (base.endsWith('.qcow2') || base.endsWith('.img')) return `QEMU image${compressed}`
  if (base.endsWith('.vhd') || base.endsWith('.vhdx')) return `Hyper-V ${base.endsWith('.vhdx') ? 'VHDX' : 'VHD'}${compressed} — converted by CDI`
  if (base.endsWith('.raw')) return `raw disk${compressed}`
  if (base.endsWith('.ova')) return 'OVA archives are not imported directly: extract the VMDK and import that'
  return compressed ? `compressed image${compressed}` : null
}

/** The file name from a URL, as a DNS-safe object name. */
export function nameFromUrl(url: string): string {
  const last = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? ''
  return last
    .replace(/\.(xz|gz)$/i, '')
    .replace(/\.(iso|qcow2|img|raw|vmdk|vhdx?|ova)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

// --- the image library --------------------------------------------------------------

/** Scope a watch cluster-wide when allowed, otherwise to reachable namespaces. */
export function useScoped(group: string, resource: string) {
  const inv = useInventory()
  return computed<string[] | null | undefined>(() => {
    const allowed = can({ verb: 'list', group, resource })
    if (allowed === undefined) return undefined
    return allowed ? null : inv.reachableNamespaces
  })
}

/** Images in the library: labelled DataVolumes, anywhere the user can see. */
export function useImages() {
  const cluster = useCluster()
  const scope = useScoped('cdi.kubevirt.io', 'datavolumes')
  const dvs = useMultiWatch(
    () => {
      const version = cluster.versionFor('cdi.kubevirt.io', 'datavolumes')
      return version && scope.value !== undefined ? { apiVersion: version, resource: 'datavolumes', labelSelector: IMAGE_TYPE_LABEL } : null
    },
    () => (scope.value === undefined ? [] : scope.value),
  )
  const images = computed(() => [...dvs.items.value].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)))
  const isos = computed(() => images.value.filter((d) => d.metadata.labels?.[IMAGE_TYPE_LABEL] === 'iso'))
  const disks = computed(() => images.value.filter((d) => d.metadata.labels?.[IMAGE_TYPE_LABEL] !== 'iso'))
  return { images, isos, disks, synced: dvs.synced, error: dvs.error }
}

/** CDI DataSources — golden images a VM can clone from. */
export function useDataSources() {
  const cluster = useCluster()
  const scope = useScoped('cdi.kubevirt.io', 'datasources')
  const sources = useMultiWatch(
    () => {
      const version = cluster.versionFor('cdi.kubevirt.io', 'datasources')
      return version && scope.value !== undefined ? { apiVersion: version, resource: 'datasources' } : null
    },
    () => (scope.value === undefined ? [] : scope.value),
  )
  return { sources: sources.items, synced: sources.synced }
}

/** The claim size behind a DataVolume, from its PVC (or its request). */
export function imageGib(dv: KObject): number {
  const inv = useInventory()
  const pvc = inv.pvcs.find((p) => p.metadata.namespace === dv.metadata.namespace && p.metadata.name === dv.metadata.name)
  return pvcGib(pvc) || Math.ceil(quantity(dv.spec?.storage?.resources?.requests?.storage ?? dv.spec?.pvc?.resources?.requests?.storage ?? 0) / GIB)
}

/** Import progress, 0..1, or null when CDI does not report one. */
export function progressOf(dv: KObject): number | null {
  const p = dv.status?.progress
  if (!p || p === 'N/A') return dv.status?.phase === 'Succeeded' ? 1 : null
  const n = parseFloat(p)
  return Number.isFinite(n) ? n / 100 : null
}
