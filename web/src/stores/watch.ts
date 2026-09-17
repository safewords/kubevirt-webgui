/**
 * Shared, reference-counted watches.
 *
 * Ten components asking for "all VMs" open one subscription, not ten. Objects
 * are kept raw (not deeply reactive) and replaced wholesale on change, which
 * keeps a cluster with thousands of objects cheap to render.
 */
import { computed, effectScope, markRaw, onScopeDispose, ref, shallowRef, toValue, triggerRef, watch, type MaybeRefOrGetter, type Ref, type ShallowRef } from 'vue'
import { gateway, type RpcError, type Subscription } from '@/api/gateway'
import type { KObject, WatchParams } from '@/api/types'

interface Entry {
  key: string
  params: WatchParams
  objects: ShallowRef<Map<string, KObject>>
  synced: Ref<boolean>
  error: Ref<RpcError | null>
  refs: number
  sub: Subscription | null
  releaseTimer: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()
const LINGER_MS = 30_000

function keyOf(params: WatchParams): string {
  return JSON.stringify([params.apiVersion, params.resource, params.namespace ?? '', params.name ?? '', params.labelSelector ?? '', params.fieldSelector ?? ''])
}

function uidOf(object: KObject): string {
  return object.metadata?.uid || `${object.metadata?.namespace ?? ''}/${object.metadata?.name}`
}

function open(entry: Entry) {
  entry.sub = gateway.subscribe(
    'watch',
    entry.params,
    (event) => {
      const map = entry.objects.value
      switch (event.type) {
        case 'SYNC': {
          map.clear()
          for (const item of event.items as KObject[]) map.set(uidOf(item), markRaw(item))
          entry.synced.value = true
          entry.error.value = null
          break
        }
        case 'ADDED':
        case 'MODIFIED':
          map.set(uidOf(event.object), markRaw(event.object))
          break
        case 'DELETED':
          map.delete(uidOf(event.object))
          break
        case 'ERROR':
          entry.error.value = event.error
          return
      }
      triggerRef(entry.objects)
    },
    (error) => {
      entry.sub = null
      if (error) {
        entry.error.value = error
        entry.synced.value = true
      }
    },
  )
}

function acquire(params: WatchParams): Entry {
  const key = keyOf(params)
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      key,
      params,
      objects: shallowRef(new Map()),
      synced: ref(false),
      error: ref(null),
      refs: 0,
      sub: null,
      releaseTimer: null,
    }
    entries.set(key, entry)
  }
  if (entry.releaseTimer) {
    clearTimeout(entry.releaseTimer)
    entry.releaseTimer = null
  }
  entry.refs++
  if (!entry.sub && !entry.error.value) open(entry)
  return entry
}

function release(entry: Entry) {
  entry.refs--
  if (entry.refs > 0) return
  entry.releaseTimer = setTimeout(() => {
    if (entry.refs > 0) return
    entry.sub?.close()
    entry.sub = null
    entries.delete(entry.key)
  }, LINGER_MS)
}

/** Drop every cached watch — after signing out, or as another user. */
export function resetWatches() {
  for (const entry of entries.values()) {
    entry.sub?.close()
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer)
  }
  entries.clear()
}

export interface WatchResult {
  items: Readonly<Ref<KObject[]>>
  synced: Readonly<Ref<boolean>>
  error: Readonly<Ref<RpcError | null>>
  /** Retry a watch that failed (after permissions changed, say). */
  retry(): void
}

/** Watch a collection. `null` params watch nothing. */
export function useWatch(params: MaybeRefOrGetter<WatchParams | null | undefined>): WatchResult {
  const current = shallowRef<Entry | null>(null)

  watch(
    () => {
      const value = toValue(params)
      return value ? keyOf(value) : ''
    },
    () => {
      const value = toValue(params)
      const previous = current.value
      current.value = value ? acquire({ ...value }) : null
      if (previous) release(previous)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    if (current.value) release(current.value)
    current.value = null
  })

  const items = computed(() => {
    const entry = current.value
    if (!entry) return []
    return [...entry.objects.value.values()]
  })

  return {
    items,
    synced: computed(() => current.value?.synced.value ?? false),
    error: computed(() => current.value?.error.value ?? null),
    retry() {
      const entry = current.value
      if (!entry) return
      entry.error.value = null
      entry.synced.value = false
      entry.sub?.close()
      open(entry)
    },
  }
}

/** Watch one object by name. */
export function useObject(params: MaybeRefOrGetter<WatchParams | null | undefined>) {
  const result = useWatch(params)
  return {
    object: computed<KObject | null>(() => result.items.value[0] ?? null),
    synced: result.synced,
    error: result.error,
    retry: result.retry,
  }
}

/**
 * Watch across several namespaces, or cluster-wide when `namespaces` is
 * `null`. For users who may not list cluster-wide.
 */
export function useMultiWatch(base: MaybeRefOrGetter<Omit<WatchParams, 'namespace'> | null>, namespaces: MaybeRefOrGetter<string[] | null>) {
  const results = shallowRef<WatchResult[]>([])
  let scopes: Array<{ stop(): void }> = []

  function rebuild() {
    for (const scope of scopes) scope.stop()
    scopes = []
    const b = toValue(base)
    if (!b) {
      results.value = []
      return
    }
    const ns = toValue(namespaces)
    const list: WatchResult[] = []
    const targets = ns === null ? [undefined] : ns
    for (const namespace of targets) {
      // Each watch gets its own effect scope so it can be released alone.
      const scope = effectScope(true)
      scope.run(() => list.push(useWatch({ ...b, namespace })))
      scopes.push(scope)
    }
    results.value = list
  }

  watch(() => JSON.stringify([toValue(base), toValue(namespaces)]), rebuild, { immediate: true })
  onScopeDispose(() => {
    for (const scope of scopes) scope.stop()
  })

  return {
    items: computed(() => results.value.flatMap((r) => r.items.value)),
    synced: computed(() => results.value.every((r) => r.synced.value)),
    error: computed(() => results.value.find((r) => r.error.value)?.error.value ?? null),
  }
}
