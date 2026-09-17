<script setup lang="ts">
import { computed } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import ConditionsTable from '@/components/common/ConditionsTable.vue'
import { dateTime } from '@/util/format'

const props = defineProps<{ ctx: ObjectContext }>()
const node = computed(() => props.ctx.object)
const info = computed(() => node.value?.status?.nodeInfo ?? {})
const images = computed(() => node.value?.status?.images?.length ?? 0)
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <h3 class="panel-title mb-2">Conditions</h3>
      <ConditionsTable :conditions="node?.status?.conditions" :good-when-false="['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable', 'KernelDeadlock', 'ReadonlyFilesystem']" />
    </section>
    <section class="card">
      <div class="card-header">System</div>
      <dl class="kv p-3">
        <dt>Machine ID</dt>
        <dd class="mono">{{ info.machineID }}</dd>
        <dt>System UUID</dt>
        <dd class="mono">{{ info.systemUUID }}</dd>
        <dt>Boot ID</dt>
        <dd class="mono">{{ info.bootID }}</dd>
        <dt>Architecture</dt>
        <dd>{{ info.architecture }} · {{ info.operatingSystem }}</dd>
        <dt>Container runtime</dt>
        <dd>{{ info.containerRuntimeVersion }}</dd>
        <dt>Kube-proxy</dt>
        <dd>{{ info.kubeProxyVersion || '—' }}</dd>
        <dt>Pod CIDRs</dt>
        <dd class="mono">{{ (node?.spec?.podCIDRs ?? [node?.spec?.podCIDR]).filter(Boolean).join(', ') || '—' }}</dd>
        <dt>Cached images</dt>
        <dd>{{ images }}</dd>
        <dt>Created</dt>
        <dd>{{ dateTime(node?.metadata.creationTimestamp) }}</dd>
        <dt>Schedulable</dt>
        <dd :class="node?.spec?.unschedulable ? 'text-warn' : 'text-ok'">{{ node?.spec?.unschedulable ? 'no — cordoned for maintenance' : 'yes' }}</dd>
      </dl>
    </section>
  </div>
</template>
