<script setup lang="ts">
import { computed, ref } from 'vue'
import { faPenToSquare } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { can } from '@/stores/access'
import Notice from '@/components/ui/Notice.vue'
import { optionRows } from './options'

const props = defineProps<{ ctx: ObjectContext }>()

const rows = computed(() => (props.ctx.object ? optionRows(props.ctx) : []))
const selectedId = ref<string | null>(null)
const selected = computed(() => rows.value.find((r) => r.id === selectedId.value) ?? null)
const mayEdit = computed(() => can({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace: props.ctx.namespace, name: props.ctx.name }) === true)

function edit(id: string | null) {
  const row = rows.value.find((r) => r.id === id)
  if (row && mayEdit.value) row.edit(props.ctx)
}
</script>

<template>
  <div class="space-y-3 p-3">
    <Notice v-if="!ctx.object" kind="info">Options belong to a VirtualMachine; a standalone instance has none.</Notice>
    <template v-else>
      <div class="flex items-center gap-1.5">
        <button class="btn" :disabled="!mayEdit || !selected" @click="edit(selectedId)"><Fa :icon="faPenToSquare" /> Edit</button>
        <span v-if="!mayEdit" class="ml-2 text-xs text-fg-subtle">Read-only: you may not change this VM.</span>
      </div>
      <div class="overflow-auto rounded-md border border-line bg-surface-1">
        <table class="table-dense">
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.id"
              class="cursor-pointer"
              :class="{ selected: row.id === selectedId }"
              @click="selectedId = row.id"
              @dblclick="edit(row.id)"
            >
              <td class="w-72">
                <span class="flex items-center gap-2.5">
                  <Fa :icon="row.icon" class="w-4 text-fg-muted" />
                  <span class="font-medium">{{ row.label }}</span>
                </span>
              </td>
              <td class="max-w-0 truncate" :title="row.value">{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-fg-subtle">Double-click a row to edit it. Scheduling changes apply the next time the VM starts.</p>
    </template>
  </div>
</template>
