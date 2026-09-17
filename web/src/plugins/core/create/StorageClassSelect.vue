<script setup lang="ts">
import { computed, watch } from 'vue'
import { isDefaultClass, useStorageClasses, useStorageProfiles } from './helpers'

const model = defineModel<string | null>({ default: null })
const props = withDefaults(defineProps<{ showProfile?: boolean }>(), { showProfile: true })

const { classes, defaultClass } = useStorageClasses()
const { describe } = useStorageProfiles()

// Pick the default once the classes are known, so the choice is explicit.
watch(
  defaultClass,
  (value) => {
    if (!model.value && value) model.value = value
  },
  { immediate: true },
)

const profile = computed(() => (props.showProfile ? describe(model.value ?? defaultClass.value) : null))
</script>

<template>
  <div>
    <select v-model="model" class="input">
      <option :value="null">cluster default{{ defaultClass ? ` (${defaultClass})` : '' }}</option>
      <option v-for="sc in classes" :key="sc.metadata.name" :value="sc.metadata.name">
        {{ sc.metadata.name }}{{ isDefaultClass(sc) ? ' (default)' : '' }} · {{ sc.provisioner }}
      </option>
    </select>
    <p v-if="profile" class="mt-1 text-xs text-fg-subtle">CDI storage profile: {{ profile }}</p>
  </div>
</template>
