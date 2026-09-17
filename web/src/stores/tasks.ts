import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { gateway, type Subscription } from '@/api/gateway'
import type { LogLine, TaskInfo } from '@/api/types'

/** The task log, live. */
export const useTasks = defineStore('tasks', () => {
  const byId = reactive(new Map<string, TaskInfo>())
  const logs = reactive(new Map<string, LogLine[]>())
  const waiters = new Map<string, Array<(task: TaskInfo) => void>>()
  let sub: Subscription | null = null
  const connected = ref(false)

  function upsert(task: TaskInfo) {
    byId.set(task.id, task)
    if (task.status !== 'running') {
      for (const resolve of waiters.get(task.id) ?? []) resolve(task)
      waiters.delete(task.id)
    }
  }

  function start() {
    if (sub) return
    sub = gateway.subscribe('tasks', {}, (event) => {
      connected.value = true
      if (event.type === 'SYNC') {
        for (const task of event.tasks as TaskInfo[]) upsert(task)
      } else if (event.type === 'UPDATE') {
        upsert(event.task)
        if (event.line) {
          const lines = logs.get(event.task.id)
          if (lines) lines.push(event.line)
        }
      }
    }, () => {
      sub = null
      connected.value = false
    })
  }

  function stop() {
    sub?.close()
    sub = null
    byId.clear()
    logs.clear()
  }

  const list = computed(() => [...byId.values()].sort((a, b) => b.startedAt - a.startedAt))
  const running = computed(() => list.value.filter((t) => t.status === 'running'))

  /** Load a task's log and keep it updated. */
  async function loadLog(id: string): Promise<LogLine[]> {
    const detail = await gateway.call<{ task: TaskInfo; log: LogLine[] }>('tasks.detail', { id })
    upsert(detail.task)
    logs.set(id, detail.log)
    return logs.get(id)!
  }

  /** Resolve when a task finishes. */
  function wait(id: string): Promise<TaskInfo> {
    const task = byId.get(id)
    if (task && task.status !== 'running') return Promise.resolve(task)
    return new Promise((resolve) => {
      const list = waiters.get(id) ?? []
      list.push(resolve)
      waiters.set(id, list)
    })
  }

  async function stopTask(id: string) {
    await gateway.call('tasks.stop', { id })
  }

  function forTarget(kind: string, namespace: string | undefined, name: string) {
    return list.value.filter((t) => t.target.kind === kind && t.target.name === name && (t.target.namespace ?? '') === (namespace ?? ''))
  }

  return { byId, logs, list, running, connected, start, stop, loadLog, wait, stopTask, forTarget }
})
