<script setup lang="ts">
import { closeDialog, dialogState, dismissToast, openTaskLog, toastState } from '@/services/dialogs'
import { faCircleCheck, faCircleExclamation, faCircleInfo, faTriangleExclamation, faXmark, faListCheck } from '@fortawesome/free-solid-svg-icons'

const icons = { success: faCircleCheck, error: faCircleExclamation, info: faCircleInfo, warning: faTriangleExclamation }
const colors = { success: 'text-ok', error: 'text-bad', info: 'text-info', warning: 'text-warn' }
</script>

<template>
  <component
    :is="dialog.component"
    v-for="dialog in dialogState.stack"
    :key="dialog.id"
    v-bind="dialog.props"
    @close="(result: unknown) => closeDialog(dialog.id, result)"
  />
  <div class="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] flex-col gap-2">
    <TransitionGroup name="toast">
      <div
        v-for="t in toastState.toasts"
        :key="t.id"
        class="card pointer-events-auto flex items-start gap-2.5 p-3 shadow-xl shadow-black/30"
      >
        <Fa :icon="icons[t.kind]" :class="colors[t.kind]" class="mt-0.5" />
        <div class="min-w-0 flex-1">
          <div class="font-semibold">{{ t.title }}</div>
          <div v-if="t.message" class="break-words text-fg-muted">{{ t.message }}</div>
          <button v-if="t.taskId" class="mt-1 text-xs text-accent hover:underline" @click="openTaskLog(t.taskId); dismissToast(t.id)">
            <Fa :icon="faListCheck" /> View task log
          </button>
        </div>
        <button class="text-fg-subtle hover:text-fg" @click="dismissToast(t.id)"><Fa :icon="faXmark" /></button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
