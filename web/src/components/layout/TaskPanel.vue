<script setup lang="ts">
/** The task log and cluster log along the bottom — as in Proxmox. */
import { computed, ref } from 'vue'
import { faChevronDown, faChevronUp, faListCheck, faScroll, faSpinner, faCircleCheck, faCircleXmark, faCircleStop, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { useTasks } from '@/stores/tasks'
import { useUi } from '@/stores/ui'
import { useMultiWatch } from '@/stores/watch'
import { useCluster } from '@/stores/cluster'
import { openTaskLog } from '@/services/dialogs'
import { dateTime, duration } from '@/util/format'
import type { KObject } from '@/api/types'

const tasks = useTasks()
const ui = useUi()
const cluster = useCluster()
const tab = ref<'tasks' | 'log'>('tasks')

const statusIcon = {
  running: { icon: faSpinner, class: 'text-info', spin: true },
  ok: { icon: faCircleCheck, class: 'text-ok', spin: false },
  warning: { icon: faTriangleExclamation, class: 'text-warn', spin: false },
  error: { icon: faCircleXmark, class: 'text-bad', spin: false },
  stopped: { icon: faCircleStop, class: 'text-fg-subtle', spin: false },
}

// The cluster log: Kubernetes events about virtualization objects.
const eventNamespaces = computed(() => (cluster.canListNamespaces ? null : cluster.namespaceNames))
const events = useMultiWatch(
  () => (tab.value === 'log' && ui.taskPanelOpen ? { apiVersion: 'v1', resource: 'events' } : null),
  eventNamespaces,
)
const VIRT_KINDS = new Set(['VirtualMachine', 'VirtualMachineInstance', 'VirtualMachineInstanceMigration', 'DataVolume', 'VirtualMachineSnapshot', 'VirtualMachineRestore', 'VirtualMachineClone', 'Node', 'PersistentVolumeClaim', 'KubeVirt', 'VirtualMachineExport', 'UsbDeviceClaim'])
const eventRows = computed(() =>
  events.items.value
    .filter((e: KObject) => VIRT_KINDS.has(e.involvedObject?.kind) || e.involvedObject?.name?.startsWith('virt-launcher-'))
    .map((e: KObject) => ({ e, ts: Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? '') || 0 }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 300),
)

let dragStart = 0
let heightStart = 0
function startDrag(event: MouseEvent) {
  dragStart = event.clientY
  heightStart = ui.taskPanelHeight
  const move = (e: MouseEvent) => (ui.taskPanelHeight = Math.max(90, Math.min(window.innerHeight * 0.7, heightStart + dragStart - e.clientY)))
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <section class="flex shrink-0 flex-col border-t border-line bg-surface-1" :style="ui.taskPanelOpen ? { height: `${ui.taskPanelHeight}px` } : {}">
    <div v-if="ui.taskPanelOpen" class="-mt-1 h-1.5 shrink-0 cursor-row-resize" @mousedown.prevent="startDrag" />
    <div class="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
      <button class="btn btn-ghost btn-sm" :class="tab === 'tasks' ? 'bg-surface-3 text-fg' : 'text-fg-muted'" @click="tab = 'tasks'; ui.taskPanelOpen = true">
        <Fa :icon="faListCheck" /> Tasks
        <span v-if="tasks.running.length" class="chip bg-info/20 text-info">{{ tasks.running.length }} running</span>
      </button>
      <button class="btn btn-ghost btn-sm" :class="tab === 'log' ? 'bg-surface-3 text-fg' : 'text-fg-muted'" @click="tab = 'log'; ui.taskPanelOpen = true">
        <Fa :icon="faScroll" /> Cluster log
      </button>
      <button class="btn btn-ghost btn-sm ml-auto" :title="ui.taskPanelOpen ? 'Collapse' : 'Expand'" @click="ui.taskPanelOpen = !ui.taskPanelOpen">
        <Fa :icon="ui.taskPanelOpen ? faChevronDown : faChevronUp" />
      </button>
    </div>
    <div v-if="ui.taskPanelOpen" class="min-h-0 flex-1 overflow-auto">
      <table v-if="tab === 'tasks'" class="table-dense">
        <thead>
          <tr>
            <th class="w-40">Start time</th>
            <th class="w-40">End time</th>
            <th class="w-56">Target</th>
            <th class="w-48">User</th>
            <th>Description</th>
            <th class="w-64">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in tasks.list" :key="task.id" class="cursor-pointer" @dblclick="openTaskLog(task.id)">
            <td class="tabular-nums">{{ dateTime(task.startedAt) }}</td>
            <td class="tabular-nums">{{ task.endedAt ? dateTime(task.endedAt) : '' }}</td>
            <td class="truncate">{{ task.target.namespace ? `${task.target.namespace}/` : '' }}{{ task.target.name }}</td>
            <td class="truncate text-fg-muted">{{ task.user.replace(/^system:serviceaccount:([^:]+):(.+)$/, '$2@$1') }}</td>
            <td class="truncate">{{ task.description }}</td>
            <td class="truncate">
              <span class="inline-flex items-center gap-1.5" :class="statusIcon[task.status].class">
                <Fa :icon="statusIcon[task.status].icon" :spin="statusIcon[task.status].spin" />
                <span v-if="task.status === 'running'">running {{ duration(Date.now() - task.startedAt) }}</span>
                <span v-else-if="task.status === 'ok'">OK</span>
                <span v-else class="truncate" :title="task.message">{{ task.message ?? task.status }}</span>
              </span>
            </td>
          </tr>
          <tr v-if="!tasks.list.length">
            <td colspan="6" class="h-14 text-center text-fg-subtle">No tasks yet in this session. Actions you take appear here, with their logs.</td>
          </tr>
        </tbody>
      </table>
      <table v-else class="table-dense">
        <thead>
          <tr>
            <th class="w-40">Time</th>
            <th class="w-24">Type</th>
            <th class="w-72">Object</th>
            <th class="w-44">Reason</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="{ e, ts } in eventRows" :key="e.metadata.uid">
            <td class="tabular-nums">{{ dateTime(ts) }}</td>
            <td :class="e.type === 'Warning' ? 'text-warn' : 'text-fg-muted'">{{ e.type }}</td>
            <td class="truncate">{{ e.involvedObject?.kind }} {{ e.involvedObject?.namespace ? `${e.involvedObject.namespace}/` : '' }}{{ e.involvedObject?.name }}</td>
            <td class="truncate">{{ e.reason }}</td>
            <td class="max-w-0 truncate" :title="e.message">{{ e.message }}</td>
          </tr>
          <tr v-if="!eventRows.length">
            <td colspan="5" class="h-14 text-center text-fg-subtle">{{ events.synced.value ? 'No recent events' : 'Loading…' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
