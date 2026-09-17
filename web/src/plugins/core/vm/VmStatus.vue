<script setup lang="ts">
import { computed } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import StateBadge from '@/components/ui/StateBadge.vue'
import { vmState } from '@/util/kubevirt'

const props = defineProps<{ ctx: ObjectContext }>()
const state = computed(() => vmState(props.ctx.object, props.ctx.related.vmi))
</script>

<template>
  <span v-if="ctx.object || ctx.related.vmi" class="chip ml-1 bg-surface-3">
    <StateBadge :state="state" :label="ctx.object?.status?.printableStatus?.toLowerCase()" />
  </span>
</template>
