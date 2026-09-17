/**
 * "May I?" — batched `SelfSubjectAccessReview`s, so the GUI can disable what
 * RBAC would refuse, the way Proxmox hides actions a role lacks.
 */
import { reactive } from 'vue'
import { gateway } from '@/api/gateway'

export interface AccessCheck {
  verb: string
  group?: string
  resource: string
  subresource?: string
  namespace?: string
  name?: string
}

interface CacheEntry {
  allowed: boolean
  at: number
}

const cache = reactive(new Map<string, CacheEntry>())
const inflight = new Set<string>()
const TTL = 60_000
let batch: Array<{ key: string; check: AccessCheck }> = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function keyOf(c: AccessCheck): string {
  return [c.verb, c.group ?? '', c.resource, c.subresource ?? '', c.namespace ?? '', c.name ?? ''].join('|')
}

async function flush() {
  flushTimer = null
  const current = batch
  batch = []
  for (let i = 0; i < current.length; i += 200) {
    const slice = current.slice(i, i + 200)
    try {
      const results = await gateway.call<Array<{ allowed: boolean }>>('access.review', {
        checks: slice.map((s) => ({ ...s.check, group: s.check.group ?? '' })),
      })
      slice.forEach((s, index) => cache.set(s.key, { allowed: results[index]?.allowed ?? false, at: Date.now() }))
    } catch {
      // Unknown is not denied: the API server still has the final say.
      slice.forEach((s) => cache.set(s.key, { allowed: true, at: Date.now() - TTL + 10_000 }))
    } finally {
      slice.forEach((s) => inflight.delete(s.key))
    }
  }
}

/**
 * Whether the signed-in user may do this; `undefined` while the answer is
 * being fetched. Reactive: read it inside a computed or a template.
 */
export function can(check: AccessCheck): boolean | undefined {
  const key = keyOf(check)
  const entry = cache.get(key)
  const fresh = entry !== undefined && Date.now() - entry.at < TTL
  if (!fresh && !inflight.has(key)) {
    inflight.add(key)
    batch.push({ key, check })
    if (!flushTimer) flushTimer = setTimeout(flush, 15)
  }
  return entry?.allowed
}

/** The same, awaited. */
export async function canAsync(check: AccessCheck): Promise<boolean> {
  const key = keyOf(check)
  const entry = cache.get(key)
  if (entry && Date.now() - entry.at < TTL) return entry.allowed
  const [result] = await gateway.call<Array<{ allowed: boolean }>>('access.review', { checks: [{ ...check, group: check.group ?? '' }] })
  cache.set(key, { allowed: result?.allowed ?? false, at: Date.now() })
  return result?.allowed ?? false
}

export function resetAccess() {
  cache.clear()
  inflight.clear()
}
