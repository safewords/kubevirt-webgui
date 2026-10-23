<script setup lang="ts">
/**
 * A namespace picker: the namespaces the user can reach, or "New namespace…"
 * to type one — which is also how to name a namespace the user cannot list.
 * A name that does not exist yet is created by the form on submit
 * (`ensureNamespace`), so this only says that it will be.
 */
import { computed, ref } from 'vue'
import { faList } from '@fortawesome/free-solid-svg-icons'
import { useInventory } from '@/plugins/core/inventory'
import { can } from '@/stores/access'
import { isDnsLabel } from '@/util/format'
import { isNewNamespace } from './namespaces'

const model = defineModel<string>({ required: true })
const inv = useInventory()
const known = computed(() => inv.reachableNamespaces)
const mayCreate = computed(() => can({ verb: 'create', resource: 'namespaces' }) !== false)

const NEW = '\u0000new'
const typing = ref(false)
// The current value stays selectable while the list loads, or when it is one
// the user cannot list.
const options = computed(() => (model.value && !known.value.includes(model.value) ? [model.value, ...known.value] : known.value))
const choice = computed({
  get: () => (typing.value ? NEW : model.value),
  set: (value: string) => {
    typing.value = value === NEW
    if (!typing.value) model.value = value
    else if (known.value.includes(model.value)) model.value = ''
  },
})
const creating = computed(() => isNewNamespace(model.value))
</script>

<template>
  <div>
    <div v-if="typing" class="flex gap-2">
      <input v-model.trim="model" class="input mono" placeholder="new-namespace" spellcheck="false" autofocus />
      <button type="button" class="btn" title="Choose an existing namespace" aria-label="Choose an existing namespace" @click="typing = false; model = model || (known[0] ?? '')">
        <Fa :icon="faList" />
      </button>
    </div>
    <select v-else v-model="choice" class="input">
      <option v-if="!options.length" value="" disabled>no namespaces</option>
      <option v-for="ns in options" :key="ns" :value="ns">{{ ns }}</option>
      <option :value="NEW">New namespace…</option>
    </select>
    <p v-if="model && !isDnsLabel(model)" class="mt-1 text-xs text-bad">Lowercase letters, digits and dashes; up to 63 characters.</p>
    <p v-else-if="creating && mayCreate" class="mt-1 text-xs text-fg-subtle">“{{ model }}” does not exist yet; it will be created.</p>
    <p v-else-if="creating" class="mt-1 text-xs text-bad">“{{ model }}” does not exist, and you may not create namespaces.</p>
  </div>
</template>
