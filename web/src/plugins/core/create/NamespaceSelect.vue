<script setup lang="ts">
/** A namespace picker that still accepts a namespace the user cannot list. */
import { computed } from 'vue'
import { useInventory } from '@/plugins/core/inventory'

const model = defineModel<string>({ required: true })
const inv = useInventory()
const listId = `ns-${Math.random().toString(36).slice(2)}`
const known = computed(() => inv.reachableNamespaces)
</script>

<template>
  <div>
    <input v-model.trim="model" class="input" :list="listId" placeholder="namespace" spellcheck="false" />
    <datalist :id="listId">
      <option v-for="ns in known" :key="ns" :value="ns" />
    </datalist>
  </div>
</template>
