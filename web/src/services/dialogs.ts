/** Dialogs, confirmations, toasts, and running an action with feedback. */
import { markRaw, reactive, type Component } from 'vue'
import { errorMessage } from '@/api/gateway'

interface OpenDialog {
  id: number
  component: Component
  props: Record<string, unknown>
  resolve: (value: any) => void
}

let nextId = 1

export const dialogState = reactive({ stack: [] as OpenDialog[] })

/**
 * Open a dialog component. It closes itself by emitting `close` with an
 * optional result, which this promise resolves to.
 */
export function openDialog<T = unknown>(component: Component, props: Record<string, unknown> = {}): Promise<T | undefined> {
  return new Promise((resolve) => {
    dialogState.stack.push({ id: nextId++, component: markRaw(component), props, resolve })
  })
}

export function closeDialog(id: number, result?: unknown) {
  const index = dialogState.stack.findIndex((d) => d.id === id)
  if (index === -1) return
  const [dialog] = dialogState.stack.splice(index, 1)
  dialog.resolve(result)
}

export interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  /** Require typing this text to confirm — for destroying things. */
  typeToConfirm?: string
  /** Optional checkboxes, returned by key. */
  options?: Array<{ key: string; label: string; default?: boolean; hint?: string }>
}

export type ConfirmResult = false | { options: Record<string, boolean> }

let confirmComponent: Component | null = null
export function registerConfirmComponent(component: Component) {
  confirmComponent = markRaw(component)
}

export async function confirm(options: ConfirmOptions): Promise<ConfirmResult> {
  if (!confirmComponent) return window.confirm(options.message) ? { options: {} } : false
  const result = await openDialog<{ options: Record<string, boolean> }>(confirmComponent, { ...options })
  return result ?? false
}

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  message?: string
  taskId?: string
}

export const toastState = reactive({ toasts: [] as Toast[] })

export function toast(kind: ToastKind, title: string, message?: string, taskId?: string, timeout = kind === 'error' ? 9000 : 4500) {
  const id = nextId++
  toastState.toasts.push({ id, kind, title, message, taskId })
  setTimeout(() => dismissToast(id), timeout)
}

export function dismissToast(id: number) {
  const index = toastState.toasts.findIndex((t) => t.id === id)
  if (index !== -1) toastState.toasts.splice(index, 1)
}

let taskLogOpener: ((id: string) => void) | null = null
export function registerTaskLogOpener(open: (id: string) => void) {
  taskLogOpener = open
}

export function openTaskLog(id: string) {
  taskLogOpener?.(id)
}

/**
 * Run an action and report the outcome. When the backend started a task,
 * the toast links to its log (and `openLog` opens it straight away, the way
 * Proxmox opens a task viewer for long operations).
 */
export async function run<T>(title: string, action: () => Promise<T>, options: { openLog?: boolean; quiet?: boolean } = {}): Promise<T | undefined> {
  try {
    const result = await action()
    const taskId = (result as any)?.task as string | undefined
    if (taskId) {
      if (options.openLog) openTaskLog(taskId)
      else if (!options.quiet) toast('info', title, 'Task started', taskId, 3500)
    } else if (!options.quiet) {
      toast('success', title)
    }
    return result
  } catch (e) {
    toast('error', title, errorMessage(e))
    return undefined
  }
}
