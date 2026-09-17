/** The Kubernetes shapes the GUI reads. Deliberately loose: objects come from
 * the API server as JSON, and every field a screen touches is optional. */

export interface ObjectMeta {
  name: string
  namespace?: string
  uid: string
  resourceVersion?: string
  generation?: number
  creationTimestamp?: string
  deletionTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string; controller?: boolean }>
  finalizers?: string[]
  generateName?: string
}

export interface KObject {
  apiVersion?: string
  kind?: string
  metadata: ObjectMeta
  spec?: any
  status?: any
  [key: string]: any
}

export interface Condition {
  type: string
  status: 'True' | 'False' | 'Unknown' | string
  reason?: string
  message?: string
  lastTransitionTime?: string
  lastProbeTime?: string
}

export interface UserInfo {
  username: string
  uid: string
  groups: string[]
  homeNamespace?: string
}

export interface WatchParams {
  apiVersion: string
  resource: string
  namespace?: string
  name?: string
  labelSelector?: string
  fieldSelector?: string
}

export type TaskStatus = 'running' | 'ok' | 'warning' | 'error' | 'stopped'

export interface TaskInfo {
  id: string
  kind: string
  description: string
  target: { kind: string; namespace?: string; name: string }
  user: string
  startedAt: number
  endedAt?: number
  status: TaskStatus
  message?: string
  /** Live progress of a running task: bytes copied, memory migrated. */
  progress?: TaskProgress
}

export interface TaskProgress {
  done: number
  total?: number
  unit: 'bytes' | 'items'
  /** Units per second. */
  rate?: number
  detail?: string
}

export interface LogLine {
  ts: number
  text: string
}

export interface ApiResource {
  name: string
  kind: string
  namespaced: boolean
  verbs: string[]
  shortNames?: string[]
}

export interface Discovery {
  serverVersion: { gitVersion: string; platform?: string; [k: string]: any }
  kubevirtVersion?: { gitVersion: string; [k: string]: any } | null
  groups: Array<{ name: string; preferredVersion: string; versions: string[] }>
  resources: Record<string, ApiResource[]>
}

export interface NamespaceSummary {
  name: string
  phase?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created?: string
}

export interface MetricSample {
  ts: number
  cpu: number
  memory: number
}
