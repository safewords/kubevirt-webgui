<script setup lang="ts">
import { faCircleCheck, faCircleXmark, faCircleQuestion } from '@fortawesome/free-solid-svg-icons'
import type { Condition } from '@/api/types'
import { age } from '@/util/format'

defineProps<{ conditions: Condition[] | undefined; goodWhenFalse?: string[] }>()
</script>

<template>
  <div class="overflow-auto rounded-md border border-line bg-surface-1">
    <table class="table-dense">
      <thead>
        <tr>
          <th class="w-56">Condition</th>
          <th class="w-24">Status</th>
          <th class="w-48">Reason</th>
          <th>Message</th>
          <th class="w-28">Changed</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in conditions ?? []" :key="c.type">
          <td class="font-medium">{{ c.type }}</td>
          <td>
            <span
              :class="
                c.status === 'Unknown'
                  ? 'text-fg-subtle'
                  : (c.status === 'True') !== (goodWhenFalse ?? []).includes(c.type)
                    ? 'text-ok'
                    : 'text-warn'
              "
            >
              <Fa :icon="c.status === 'True' ? faCircleCheck : c.status === 'False' ? faCircleXmark : faCircleQuestion" /> {{ c.status }}
            </span>
          </td>
          <td class="truncate">{{ c.reason }}</td>
          <td class="max-w-0 truncate" :title="c.message">{{ c.message }}</td>
          <td class="text-fg-muted">{{ c.lastTransitionTime ? `${age(c.lastTransitionTime)} ago` : '—' }}</td>
        </tr>
        <tr v-if="!(conditions ?? []).length">
          <td colspan="5" class="h-12 text-center text-fg-subtle">No conditions reported</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
