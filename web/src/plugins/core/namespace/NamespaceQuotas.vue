<script setup lang="ts">
import { computed } from 'vue'
import { faPlus, faPenToSquare, faTrash } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { useWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { confirm, openDialog, run } from '@/services/dialogs'
import { quantity, bytes } from '@/util/format'
import Notice from '@/components/ui/Notice.vue'
import QuotaDialog from './QuotaDialog.vue'

const props = defineProps<{ ctx: ObjectContext }>()
const quotas = useWatch(() => ({ apiVersion: 'v1', resource: 'resourcequotas', namespace: props.ctx.name }))
const limits = useWatch(() => ({ apiVersion: 'v1', resource: 'limitranges', namespace: props.ctx.name }))

const canCreate = computed(() => can({ verb: 'create', resource: 'resourcequotas', namespace: props.ctx.name }) === true)
const canUpdate = computed(() => can({ verb: 'patch', resource: 'resourcequotas', namespace: props.ctx.name }) === true)
const canDelete = computed(() => can({ verb: 'delete', resource: 'resourcequotas', namespace: props.ctx.name }) === true)

const isBytes = (key: string) => /memory|storage/.test(key)
function show(key: string, value: string | undefined) {
  if (value === undefined) return '—'
  return isBytes(key) ? bytes(quantity(value)) : value
}

function rows(quota: KObject) {
  const hard = quota.status?.hard ?? quota.spec?.hard ?? {}
  const used = quota.status?.used ?? {}
  return Object.keys(hard)
    .sort()
    .map((key) => {
      const h = quantity(hard[key])
      const u = quantity(used[key] ?? '0')
      return { key, hard: hard[key], used: used[key], ratio: h > 0 ? u / h : null }
    })
}

function add() {
  openDialog(QuotaDialog, { namespace: props.ctx.name })
}
function edit(quota: KObject) {
  openDialog(QuotaDialog, { namespace: props.ctx.name, quota })
}
async function remove(quota: KObject) {
  const ok = await confirm({ title: 'Remove quota', message: `Remove the quota ${quota.metadata.name} from ${props.ctx.name}? Nothing in the namespace will be limited by it any more.`, confirmText: 'Remove', danger: true })
  if (ok) await run('Remove quota', () => k8s.delete({ apiVersion: 'v1', resource: 'resourcequotas', namespace: props.ctx.name, name: quota.metadata.name }))
}

function limitRows(range: KObject) {
  return (range.spec?.limits ?? []) as Array<Record<string, any>>
}
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="panel-title">Resource quotas</h3>
        <button class="btn btn-sm ml-auto" :disabled="!canCreate" @click="add"><Fa :icon="faPlus" /> Add quota</button>
      </div>
      <Notice v-if="quotas.error.value" kind="warning">{{ quotas.error.value.message }}</Notice>
      <Notice v-else-if="quotas.synced.value && !quotas.items.value.length" kind="empty">No quotas: this namespace may use as much of the cluster as it can schedule.</Notice>
      <div v-for="quota in quotas.items.value" :key="quota.metadata.uid" class="card mb-3">
        <div class="card-header">
          <span>{{ quota.metadata.name }}</span>
          <span v-if="quota.spec?.scopes?.length" class="chip">scopes: {{ quota.spec.scopes.join(', ') }}</span>
          <span class="ml-auto flex gap-1.5">
            <button class="btn btn-sm" :disabled="!canUpdate" @click="edit(quota)"><Fa :icon="faPenToSquare" /> Edit</button>
            <button class="btn btn-sm btn-danger" :disabled="!canDelete" @click="remove(quota)"><Fa :icon="faTrash" /></button>
          </span>
        </div>
        <table class="table-dense">
          <thead>
            <tr><th class="w-80">Resource</th><th class="w-32 text-right">Used</th><th class="w-32 text-right">Limit</th><th>Usage</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in rows(quota)" :key="row.key">
              <td class="mono">{{ row.key }}</td>
              <td class="text-right tabular-nums">{{ show(row.key, row.used ?? '0') }}</td>
              <td class="text-right tabular-nums">{{ show(row.key, row.hard) }}</td>
              <td>
                <div v-if="row.ratio !== null" class="flex items-center gap-2">
                  <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <div class="h-full rounded-full" :class="row.ratio > 0.9 ? 'bg-bad' : row.ratio > 0.75 ? 'bg-warn' : 'bg-accent'" :style="{ width: `${Math.min(1, row.ratio) * 100}%` }" />
                  </div>
                  <span class="w-14 text-right tabular-nums text-fg-muted">{{ (row.ratio * 100).toFixed(0) }}%</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h3 class="panel-title mb-2">Limit ranges</h3>
      <Notice v-if="limits.error.value" kind="warning">{{ limits.error.value.message }}</Notice>
      <Notice v-else-if="limits.synced.value && !limits.items.value.length" kind="empty">No limit ranges: pods and claims get no defaults or bounds from the namespace.</Notice>
      <div v-for="range in limits.items.value" :key="range.metadata.uid" class="card mb-3">
        <div class="card-header">{{ range.metadata.name }}</div>
        <table class="table-dense">
          <thead>
            <tr><th class="w-40">Type</th><th>Resource</th><th>Min</th><th>Max</th><th>Default request</th><th>Default limit</th><th>Max limit/request ratio</th></tr>
          </thead>
          <tbody>
            <template v-for="(limit, i) in limitRows(range)" :key="i">
              <tr v-for="resource in [...new Set([...Object.keys(limit.min ?? {}), ...Object.keys(limit.max ?? {}), ...Object.keys(limit.defaultRequest ?? {}), ...Object.keys(limit.default ?? {}), ...Object.keys(limit.maxLimitRequestRatio ?? {})])]" :key="`${i}-${resource}`">
                <td>{{ limit.type }}</td>
                <td class="mono">{{ resource }}</td>
                <td>{{ limit.min?.[resource] ?? '—' }}</td>
                <td>{{ limit.max?.[resource] ?? '—' }}</td>
                <td>{{ limit.defaultRequest?.[resource] ?? '—' }}</td>
                <td>{{ limit.default?.[resource] ?? '—' }}</td>
                <td>{{ limit.maxLimitRequestRatio?.[resource] ?? '—' }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
