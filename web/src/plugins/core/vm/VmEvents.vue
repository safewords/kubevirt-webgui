<script setup lang="ts">
import { computed } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import EventsTable from '@/components/common/EventsTable.vue'
import { useTasks } from '@/stores/tasks'
import { openTaskLog } from '@/services/dialogs'
import { dateTime } from '@/util/format'

const props = defineProps<{ ctx: ObjectContext }>()
const tasks = useTasks()
const history = computed(() => tasks.forTarget('VirtualMachine', props.ctx.namespace, props.ctx.name))
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <h3 class="panel-title mb-2">Task history</h3>
      <div class="overflow-auto rounded-md border border-line bg-surface-1">
        <table class="table-dense">
          <thead>
            <tr><th class="w-44">Start time</th><th class="w-44">End time</th><th>Description</th><th class="w-56">User</th><th class="w-40">Status</th></tr>
          </thead>
          <tbody>
            <tr v-for="t in history" :key="t.id" class="cursor-pointer" @dblclick="openTaskLog(t.id)">
              <td>{{ dateTime(t.startedAt) }}</td>
              <td>{{ t.endedAt ? dateTime(t.endedAt) : '' }}</td>
              <td>{{ t.description }}</td>
              <td class="truncate text-fg-muted">{{ t.user }}</td>
              <td :class="t.status === 'ok' ? 'text-ok' : t.status === 'error' ? 'text-bad' : 'text-fg-muted'">{{ t.status === 'ok' ? 'OK' : (t.message ?? t.status) }}</td>
            </tr>
            <tr v-if="!history.length"><td colspan="5" class="h-12 text-center text-fg-subtle">No tasks for this VM in this server's memory</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <section>
      <h3 class="panel-title mb-2">Kubernetes events</h3>
      <EventsTable
        :namespace="ctx.namespace"
        :objects="[{ name: ctx.name }]"
        :prefixes="[`virt-launcher-${ctx.name}-`, `${ctx.name}-`]"
      />
    </section>
  </div>
</template>
