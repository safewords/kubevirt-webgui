<script setup lang="ts">
import { computed } from 'vue'
import { faHardDrive, faFileImport } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { useInventory } from '@/plugins/core/inventory'
import ConditionsTable from '@/components/common/ConditionsTable.vue'
import Gauge from '@/components/ui/Gauge.vue'
import WorkerTrouble from './WorkerTrouble.vue'
import { bytes, quantity, dateTime } from '@/util/format'
import { routeTo } from '@/util/nav'

const props = defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const pvc = computed(() => props.ctx.object)
const dv = computed(() => props.ctx.related.dataVolume)

const source = computed(() => {
  const s = dv.value?.spec?.source ?? {}
  const key = Object.keys(s)[0]
  if (!key) return dv.value?.spec?.sourceRef ? `DataSource ${dv.value.spec.sourceRef.namespace ?? ''}/${dv.value.spec.sourceRef.name}` : null
  const v = s[key] ?? {}
  return `${key}${v.url ? `: ${v.url}` : v.name ? `: ${v.namespace ?? ''}/${v.name}` : ''}`
})
const progress = computed(() => {
  const p = dv.value?.status?.progress
  if (!p || p === 'N/A') return null
  return parseFloat(p) / 100
})
const usedBy = computed(() =>
  inv.vms.filter((vm) =>
    (vm.spec?.template?.spec?.volumes ?? []).some((v: any) => v.dataVolume?.name === props.ctx.name || v.persistentVolumeClaim?.claimName === props.ctx.name) && vm.metadata.namespace === props.ctx.namespace,
  ),
)
</script>

<template>
  <div class="grid gap-3 p-3 xl:grid-cols-2">
    <WorkerTrouble :data-volume="dv" class="xl:col-span-2" />
    <div class="card">
      <div class="card-header"><Fa :icon="faHardDrive" class="text-fg-muted" /> {{ ctx.name }}</div>
      <dl class="kv p-3">
        <dt>Status</dt>
        <dd :class="pvc?.status?.phase === 'Bound' ? 'text-ok' : 'text-warn'">{{ pvc?.status?.phase ?? '—' }}</dd>
        <dt>Size</dt>
        <dd>{{ bytes(quantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage)) }}</dd>
        <dt>Storage class</dt>
        <dd>{{ pvc?.spec?.storageClassName ?? 'default' }}</dd>
        <dt>Volume mode</dt>
        <dd>{{ pvc?.spec?.volumeMode ?? 'Filesystem' }}</dd>
        <dt>Access modes</dt>
        <dd>{{ (pvc?.spec?.accessModes ?? []).join(', ') }}</dd>
        <dt>Volume</dt>
        <dd class="mono">{{ pvc?.spec?.volumeName ?? '—' }}</dd>
        <dt>Used by</dt>
        <dd>
          <span v-if="!usedBy.length" class="text-fg-subtle">no VM</span>
          <RouterLink v-for="vm in usedBy" :key="vm.metadata.uid" class="mr-2 text-accent hover:underline" :to="routeTo({ kind: 'vm', name: vm.metadata.name, namespace: vm.metadata.namespace })">{{ vm.metadata.name }}</RouterLink>
        </dd>
        <dt>Created</dt>
        <dd>{{ dateTime(pvc?.metadata.creationTimestamp) }}</dd>
      </dl>
    </div>
    <div v-if="dv" class="card">
      <div class="card-header"><Fa :icon="faFileImport" class="text-fg-muted" /> DataVolume</div>
      <div class="space-y-3 p-3">
        <Gauge v-if="progress !== null" label="Import progress" :value="progress" :detail="dv.status?.phase" />
        <dl class="kv">
          <dt>Phase</dt>
          <dd>{{ dv.status?.phase ?? '—' }}</dd>
          <dt>Source</dt>
          <dd class="mono break-all">{{ source ?? '—' }}</dd>
          <dt>Content type</dt>
          <dd>{{ dv.spec?.contentType ?? 'kubevirt' }}</dd>
          <dt>Restarts</dt>
          <dd>{{ dv.status?.restartCount ?? 0 }}</dd>
        </dl>
      </div>
    </div>
    <div class="xl:col-span-2">
      <h3 class="panel-title mb-2">Conditions</h3>
      <ConditionsTable :conditions="dv?.status?.conditions ?? pvc?.status?.conditions" />
    </div>
  </div>
</template>
