<script setup lang="ts">
import { computed } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import EventsTable from '@/components/common/EventsTable.vue'

const props = defineProps<{ ctx: ObjectContext }>()
const uid = computed(() => props.ctx.object?.metadata.uid)
const prefixes = computed(() => [
  `importer-${props.ctx.name}`,
  `cdi-upload-${props.ctx.name}`,
  ...(uid.value ? [`prime-${uid.value}`, `importer-prime-${uid.value}`, `tmp-pvc-${uid.value}`] : []),
])
</script>

<template>
  <div class="p-3">
    <EventsTable
      :namespace="ctx.namespace"
      :objects="[{ name: ctx.name, kind: 'PersistentVolumeClaim' }, { name: ctx.name, kind: 'DataVolume' }]"
      :prefixes="prefixes"
    />
  </div>
</template>
