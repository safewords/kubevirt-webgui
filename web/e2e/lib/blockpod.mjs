/** Reading and writing a Block volume directly, without booting a guest. */
import assert from 'node:assert/strict'
import { get, waitFor } from './k8s.mjs'

const POD = { apiVersion: 'v1', resource: 'pods' }

/**
 * Run a one-shot busybox pod against a Block claim as an unprivileged user
 * (uid 107, like CDI and KubeVirt) and return its output. The device is at
 * /dev/blk. Waits until the pod is gone, since the claim is ReadWriteOnce.
 */
export async function blockPod(gw, namespace, name, claim, script) {
  await gw.call('resource.create', {
    ...POD,
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name },
      spec: {
        restartPolicy: 'Never',
        securityContext: { runAsUser: 107, runAsGroup: 107, fsGroup: 107, runAsNonRoot: true },
        containers: [{ name: 't', image: 'busybox:1.36', command: ['sh', '-c', script], volumeDevices: [{ name: 'v', devicePath: '/dev/blk' }] }],
        volumes: [{ name: 'v', persistentVolumeClaim: { claimName: claim } }],
      },
    },
  })
  const done = await waitFor(`pod ${name} to finish`, async () => {
    const pod = await get(gw, { ...POD, namespace, name })
    return ['Succeeded', 'Failed'].includes(pod?.status?.phase) ? pod : null
  }, { timeoutMs: 5 * 60_000, intervalMs: 3000 })
  const output = await gw.call('resource.logs', { namespace, name })
  await gw.call('resource.delete', { ...POD, namespace, name, gracePeriodSeconds: 0 })
  await waitFor(`pod ${name} to be gone`, async () => (await get(gw, { ...POD, namespace, name })) === null, { timeoutMs: 2 * 60_000 })
  assert.equal(done.status.phase, 'Succeeded', output)
  // Logs come with RFC 3339 timestamps (`Z` or a `-07:00` offset, depending
  // on the node); the device may hand back NUL padding.
  return output.replace(/^\d{4}-\d\d-\d\dT\S+(?:Z|[+-]\d\d:\d\d) /gm, '').replace(/\0/g, '').trim()
}

/** Write a short marker at the start of the device. */
export const writeMarker = (gw, namespace, name, claim, marker) =>
  blockPod(gw, namespace, name, claim, `printf '%s' '${marker}' | dd of=/dev/blk bs=64 count=1 conv=notrunc 2>/dev/null && echo written`)

/** Read `length` bytes from the start of the device. */
export const readMarker = (gw, namespace, name, claim, length) =>
  blockPod(gw, namespace, name, claim, `dd if=/dev/blk bs=64 count=1 2>/dev/null | head -c ${length}; echo`)

/** A Block claim on the default ceph-rbd class. */
export function blockClaim(gw, namespace, name, size = '1Gi') {
  return gw.call('resource.create', {
    apiVersion: 'v1',
    resource: 'persistentvolumeclaims',
    namespace,
    body: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name }, spec: { storageClassName: 'ceph-rbd', volumeMode: 'Block', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: size } } } },
  })
}
