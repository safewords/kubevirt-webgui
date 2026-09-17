/**
 * KubeVirt feature gates, read from the KubeVirt CR — so a screen can say
 * "switched off in this cluster" before an action is refused by an admission
 * webhook. Users who may not read the CR get `null` (unknown), and the
 * action is simply allowed to try.
 */
import { computed, type ComputedRef } from 'vue'
import { useWatch } from '@/stores/watch'
import { can } from '@/stores/access'

export function useFeatureGates(): ComputedRef<string[] | null> {
  const readable = computed(() => can({ verb: 'list', group: 'kubevirt.io', resource: 'kubevirts' }) === true)
  const kubevirts = useWatch(() => (readable.value ? { apiVersion: 'kubevirt.io/v1', resource: 'kubevirts' } : null))
  return computed(() => {
    if (!readable.value || !kubevirts.synced.value || !kubevirts.items.value.length) return null
    return kubevirts.items.value[0].spec?.configuration?.developerConfiguration?.featureGates ?? []
  })
}

/** `true`/`false` when known, `null` when this user cannot tell. */
export function useFeatureGate(name: string): ComputedRef<boolean | null> {
  const gates = useFeatureGates()
  return computed(() => (gates.value === null ? null : gates.value.includes(name)))
}

export const SNAPSHOT_GATE_OFF =
  "KubeVirt's Snapshot feature gate is not enabled in this cluster, so VM snapshots, restores and clones are refused. An administrator can enable it under Datacenter → Options → Feature gates."

/** Make an admission refusal about a disabled feature gate say what to do. */
export function explainGateError(message: string): string {
  if (/snapshot feature gate/i.test(message)) return SNAPSHOT_GATE_OFF
  return message
}
