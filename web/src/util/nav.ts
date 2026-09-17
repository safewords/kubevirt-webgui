import type { RouteLocationRaw } from 'vue-router'

export interface ObjectRef {
  kind: string
  name?: string
  namespace?: string
}

/** The route that shows an object (and optionally one of its panels). */
export function routeTo(ref: ObjectRef, panel?: string): RouteLocationRaw {
  if (ref.kind === 'datacenter' || !ref.name) {
    return panel ? { name: 'datacenter', params: { panel } } : { name: 'datacenter' }
  }
  if (ref.namespace) {
    return { name: 'namespaced', params: { kind: ref.kind, namespace: ref.namespace, name: ref.name, ...(panel ? { panel } : {}) } }
  }
  return { name: 'cluster', params: { kind: ref.kind, name: ref.name, ...(panel ? { panel } : {}) } }
}

export function refKey(ref: ObjectRef): string {
  return [ref.kind, ref.namespace ?? '', ref.name ?? ''].join('/')
}
