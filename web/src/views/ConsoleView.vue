<script setup lang="ts">
/** A console on its own page, for pop-out windows. */
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import VncConsole from '@/components/console/VncConsole.vue'
import SerialConsole from '@/components/console/SerialConsole.vue'

const route = useRoute()
const namespace = computed(() => route.params.namespace as string)
const name = computed(() => route.params.name as string)
const kind = computed(() => (route.query.kind === 'serial' ? 'serial' : 'vnc'))

onMounted(() => (document.title = `${name.value} — ${kind.value === 'vnc' ? 'noVNC' : 'Serial console'}`))
</script>

<template>
  <div class="h-full">
    <VncConsole v-if="kind === 'vnc'" :namespace="namespace" :name="name" standalone />
    <SerialConsole v-else :namespace="namespace" :name="name" standalone />
  </div>
</template>
