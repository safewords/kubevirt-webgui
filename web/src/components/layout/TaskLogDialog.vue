<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { faListCheck, faStop } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import TaskProgress from '@/components/common/TaskProgress.vue'
import { useTasks } from '@/stores/tasks'
import { dateTime, duration, time } from '@/util/format'
import { errorMessage } from '@/api/gateway'

const props = defineProps<{ id: string }>()
const emit = defineEmits<{ close: [] }>()
const tasks = useTasks()
const error = ref<string | null>(null)
const tab = ref<'output' | 'status'>('output')
const scroller = ref<HTMLElement | null>(null)

const task = computed(() => tasks.byId.get(props.id))
const log = computed(() => tasks.logs.get(props.id) ?? [])

onMounted(async () => {
  try {
    await tasks.loadLog(props.id)
  } catch (e) {
    error.value = errorMessage(e)
  }
})

watch(
  () => log.value.length,
  async () => {
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  },
)
</script>

<template>
  <Modal :title="`Task viewer: ${task?.description ?? id}`" :icon="faListCheck" width="860px" @close="emit('close')">
    <div class="mb-3 flex items-center gap-2">
      <button class="btn btn-sm" :class="tab === 'output' ? 'bg-surface-3' : 'btn-ghost'" @click="tab = 'output'">Output</button>
      <button class="btn btn-sm" :class="tab === 'status' ? 'bg-surface-3' : 'btn-ghost'" @click="tab = 'status'">Status</button>
      <button v-if="task?.status === 'running'" class="btn btn-sm btn-danger ml-auto" @click="tasks.stopTask(id)"><Fa :icon="faStop" /> Stop</button>
    </div>
    <TaskProgress v-if="task?.status === 'running' && task.progress" :progress="task.progress" class="mb-3" />
    <Notice v-if="error" kind="error">{{ error }}</Notice>
    <div v-else-if="tab === 'output'" ref="scroller" class="h-[52vh] overflow-auto rounded-md border border-line bg-surface-0 p-3 font-mono text-[12px] leading-relaxed">
      <div v-for="(line, i) in log" :key="i" class="whitespace-pre-wrap">
        <span class="text-fg-subtle">{{ time(line.ts) }}</span>
        <span :class="line.text.startsWith('TASK ERROR') ? 'text-bad' : line.text.startsWith('TASK OK') ? 'text-ok' : ''"> {{ line.text }}</span>
      </div>
      <div v-if="task?.status === 'running'" class="mt-1 animate-pulse text-fg-subtle">…</div>
    </div>
    <dl v-else-if="task" class="kv">
      <dt>Status</dt>
      <dd>{{ task.status }}{{ task.message ? ` — ${task.message}` : '' }}</dd>
      <dt>Type</dt>
      <dd class="mono">{{ task.kind }}</dd>
      <dt>Target</dt>
      <dd>{{ task.target.kind }} {{ task.target.namespace ? `${task.target.namespace}/` : '' }}{{ task.target.name }}</dd>
      <dt>User</dt>
      <dd class="mono">{{ task.user }}</dd>
      <dt>Started</dt>
      <dd>{{ dateTime(task.startedAt) }}</dd>
      <dt>Duration</dt>
      <dd>{{ duration((task.endedAt ?? Date.now()) - task.startedAt) }}</dd>
      <dt>Unique task ID</dt>
      <dd class="mono break-all">{{ task.id }}</dd>
    </dl>
  </Modal>
</template>
