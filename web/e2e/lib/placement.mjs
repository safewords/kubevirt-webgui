/**
 * Keeping test workloads off nodes that cannot run them.
 *
 * On safewords, node `devbox` cannot open block-mode volumes (containerd
 * there lacks `device_ownership_from_security_context`), so a VM or CDI pod
 * using a ceph-rbd Block volume fails when scheduled onto it. Tests steer
 * clear with `E2E_AVOID_NODES` (default: devbox).
 */
export const avoidNodes = (process.env.E2E_AVOID_NODES ?? 'devbox').split(',').map((n) => n.trim()).filter(Boolean)

/** Add a required node affinity that keeps a VM off the avoided nodes. */
export function avoidBadNodes(vm) {
  if (!avoidNodes.length) return vm
  vm.spec.template.spec.affinity = {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'NotIn', values: avoidNodes }] }],
      },
    },
  }
  return vm
}

/** The same, for a plain pod spec. */
export function avoidBadNodesPod(pod) {
  if (!avoidNodes.length) return pod
  pod.spec.affinity = avoidBadNodes({ spec: { template: { spec: {} } } }).spec.template.spec.affinity
  return pod
}
