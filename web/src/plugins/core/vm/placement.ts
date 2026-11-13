/**
 * Soft node placement: a VM whose every disk lives on Ceph can be reached
 * from any node, so a hostname pin is a preference rather than a law. With
 * soft placement on, the scheduler still puts the VM on its pinned node when
 * that node can take it, and on any other node its remaining rules allow when
 * not — a pinned node that is off, gone, or full no longer keeps it down.
 *
 * Only hostname pins are softened. Every other rule (labels such as
 * `safewords.com/always-on`, `NotIn` exclusions, tolerations) stays required.
 *
 * The strict placement is the source of truth: it is kept in an annotation
 * while soft placement is on, so turning it off restores exactly what was
 * there, and editing the pin while soft edits the strict copy and re-softens.
 */
import type { KObject } from '@/api/types'

export const HOST = 'kubernetes.io/hostname'
export const SOFT_ANNOTATION = 'kubevirt-webgui/soft-placement'
/** The strict placement, as JSON, while soft placement is on. */
export const STRICT_ANNOTATION = 'kubevirt-webgui/strict-placement'
/** Weight of the preferred terms soft placement adds: as strong as a preference goes. */
const WEIGHT = 100

export interface Placement {
  nodeSelector: Record<string, string> | null
  nodeAffinity: any | null
}

const clone = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)))

export function isSoft(vm: KObject | null | undefined): boolean {
  return vm?.metadata?.annotations?.[SOFT_ANNOTATION] === 'true'
}

/** The VM's placement with hostname pins required, whether or not soft placement is on. */
export function strictPlacement(vm: KObject | null | undefined): Placement {
  const saved = vm?.metadata?.annotations?.[STRICT_ANNOTATION]
  if (isSoft(vm) && saved) {
    try {
      const parsed = JSON.parse(saved)
      return { nodeSelector: parsed.nodeSelector ?? null, nodeAffinity: parsed.nodeAffinity ?? null }
    } catch {
      /* a hand-mangled annotation: fall back to what the spec says */
    }
  }
  const spec = vm?.spec?.template?.spec ?? {}
  return { nodeSelector: clone(spec.nodeSelector) ?? null, nodeAffinity: clone(spec.affinity?.nodeAffinity) ?? null }
}

/** The same placement with its hostname pins turned into preferences. */
export function soften(strict: Placement): Placement {
  const nodeSelector = { ...(strict.nodeSelector ?? {}) }
  const nodeAffinity = clone(strict.nodeAffinity) ?? {}
  const preferred: any[] = [...(nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution ?? [])]

  if (nodeSelector[HOST]) {
    preferred.push({ weight: WEIGHT, preference: { matchExpressions: [{ key: HOST, operator: 'In', values: [nodeSelector[HOST]] }] } })
    delete nodeSelector[HOST]
  }

  const required = nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
  if (required?.nodeSelectorTerms?.length) {
    const terms: any[] = []
    let unconstrained = false
    for (const term of required.nodeSelectorTerms) {
      const exprs: any[] = term.matchExpressions ?? []
      const pins = exprs.filter((e) => e.key === HOST && e.operator === 'In')
      const rest = exprs.filter((e) => !(e.key === HOST && e.operator === 'In'))
      if (pins.length) preferred.push({ weight: WEIGHT, preference: { matchExpressions: pins } })
      // An empty term matches no node, so a term that was only a pin is
      // dropped; terms are ORed, so dropping it frees the VM entirely.
      if (rest.length || term.matchFields?.length) terms.push({ ...term, matchExpressions: rest })
      else unconstrained = true
    }
    if (unconstrained || !terms.length) delete nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
    else nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution = { ...required, nodeSelectorTerms: terms }
  }

  if (preferred.length) nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution = preferred
  return {
    nodeSelector: Object.keys(nodeSelector).length ? nodeSelector : null,
    nodeAffinity: Object.keys(nodeAffinity).length ? nodeAffinity : null,
  }
}

/** Whether the strict placement pins hostnames at all — without a pin there is nothing to soften. */
export function hasHostPin(strict: Placement): boolean {
  if (strict.nodeSelector?.[HOST]) return true
  const terms: any[] = strict.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? []
  return terms.some((t) => (t.matchExpressions ?? []).some((e: any) => e.key === HOST && e.operator === 'In'))
}

/**
 * The merge patch that gives `vm` the strict placement `strict`, softened or
 * not. Removed selector keys and affinity fields are nulled, since a merge
 * patch would otherwise keep them; pod (anti-)affinity is left alone.
 */
export function placementPatch(vm: KObject, strict: Placement, soft: boolean): Record<string, any> {
  const target = soft ? soften(strict) : strict
  const spec = vm.spec?.template?.spec ?? {}
  const selector: Record<string, string | null> = {}
  for (const key of Object.keys(spec.nodeSelector ?? {})) if (!target.nodeSelector || !(key in target.nodeSelector)) selector[key] = null
  Object.assign(selector, target.nodeSelector ?? {})

  const affinityFields = ['requiredDuringSchedulingIgnoredDuringExecution', 'preferredDuringSchedulingIgnoredDuringExecution']
  const nodeAffinity: Record<string, any> = {}
  for (const field of affinityFields) nodeAffinity[field] = target.nodeAffinity?.[field] ?? null

  return {
    metadata: {
      annotations: soft
        ? { [SOFT_ANNOTATION]: 'true', [STRICT_ANNOTATION]: JSON.stringify(strict) }
        : { [SOFT_ANNOTATION]: null, [STRICT_ANNOTATION]: null },
    },
    spec: {
      template: {
        spec: {
          nodeSelector: Object.keys(selector).length ? selector : null,
          affinity: { nodeAffinity },
        },
      },
    },
  }
}

const NODE_AGNOSTIC = ['containerDisk', 'cloudInitNoCloud', 'cloudInitConfigDrive', 'configMap', 'secret', 'serviceAccount', 'downwardAPI', 'downwardMetrics', 'sysprep', 'emptyDisk', 'ephemeral', 'memoryDump']

export function isCephProvisioner(provisioner: string | undefined): boolean {
  return !!provisioner && /(^|\.)(rbd|cephfs)\.csi\.ceph\.com$|^ceph\.rook\.io\//.test(provisioner)
}

/**
 * Whether every disk the VM has can be opened from any node — that is, sits
 * on a Ceph storage class. Returns the reason when not, for the UI to show.
 */
export function cephOnly(vm: KObject | null | undefined, pvcs: KObject[], storageClasses: KObject[]): { ok: true } | { ok: false; reason: string } {
  const spec = vm?.spec?.template?.spec ?? {}
  const ns = vm?.metadata?.namespace
  const provisioner = new Map(storageClasses.map((sc) => [sc.metadata.name, (sc as any).provisioner as string]))
  const templates = new Map<string, any>((vm?.spec?.dataVolumeTemplates ?? []).map((t: any) => [t.metadata?.name, t]))
  const volumes: any[] = spec.volumes ?? []
  if (!volumes.length) return { ok: false, reason: 'the VM has no disks to check' }

  for (const v of volumes) {
    if (NODE_AGNOSTIC.some((k) => k in v)) continue
    const claim = v.persistentVolumeClaim?.claimName ?? v.dataVolume?.name
    if (!claim) return { ok: false, reason: `disk ${v.name} is not on a volume claim (${Object.keys(v).filter((k) => k !== 'name').join(', ')})` }
    const pvc = pvcs.find((p) => p.metadata.namespace === ns && p.metadata.name === claim)
    const dvt = templates.get(claim)
    const className = pvc?.spec?.storageClassName ?? dvt?.spec?.storage?.storageClassName ?? dvt?.spec?.pvc?.storageClassName
    if (!className) return { ok: false, reason: `the storage class of disk ${v.name} (${claim}) is not known yet` }
    const prov = provisioner.get(className)
    if (!isCephProvisioner(prov)) return { ok: false, reason: `disk ${v.name} is on ${className}${prov ? ` (${prov})` : ''}, which only some nodes can reach` }
  }

  // A persistent TPM or EFI keeps its state on a claim of its own, outside
  // spec.volumes, labelled with the VM's name. It pins the VM just the same.
  for (const pvc of pvcs) {
    if (pvc.metadata.namespace !== ns || pvc.metadata.labels?.['persistent-state-for'] !== vm?.metadata?.name) continue
    const className = pvc.spec?.storageClassName
    const prov = className ? provisioner.get(className) : undefined
    if (!isCephProvisioner(prov)) {
      return { ok: false, reason: `its persistent TPM/EFI state (${pvc.metadata.name}) is on ${className ?? 'an unknown class'}${prov ? ` (${prov})` : ''}, which only some nodes can reach` }
    }
  }
  return { ok: true }
}
