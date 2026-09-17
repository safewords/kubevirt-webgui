<script setup lang="ts">
/** A labelled form control, Proxmox-style: label on the left, control on the right. */
defineProps<{ label: string; hint?: string | null; error?: string | null; required?: boolean; wide?: boolean }>()
</script>

<template>
  <div class="grid items-start gap-x-3 gap-y-1" :class="wide ? 'grid-cols-1' : 'sm:grid-cols-[150px_minmax(0,1fr)]'">
    <label class="pt-1.5 text-fg-muted">
      {{ label }}<span v-if="required" class="text-accent">*</span>
    </label>
    <div class="min-w-0">
      <slot />
      <p v-if="error" class="mt-1 text-xs text-bad">{{ error }}</p>
      <p v-else-if="hint" class="mt-1 text-xs text-fg-subtle">{{ hint }}</p>
    </div>
  </div>
</template>
