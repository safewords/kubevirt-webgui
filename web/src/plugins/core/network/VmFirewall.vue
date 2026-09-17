<script setup lang="ts">
/** The namespace firewall, narrowed to the rules that apply to one VM. */
import type { ObjectContext } from '@/plugins/registry'
import NamespaceFirewall from '@/plugins/core/namespace/NamespaceFirewall.vue'

defineProps<{ ctx: ObjectContext }>()
</script>

<template>
  <NamespaceFirewall :ctx="ctx" :vm="ctx.name" />
</template>
