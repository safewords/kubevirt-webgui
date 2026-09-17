<script setup lang="ts">
/**
 * noVNC over the console proxy. The ticket is fetched over the gateway, then
 * redeemed once by the byte socket — the Proxmox vncproxy/vncwebsocket dance.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import RFB from '@novnc/novnc'
import {
  faKeyboard, faExpand, faPlug, faRotateRight, faClipboard, faUpRightFromSquare, faArrowsLeftRight, faCompress,
} from '@fortawesome/free-solid-svg-icons'
import { gateway, errorMessage } from '@/api/gateway'
import { vmApi } from '@/api/k8s'
import DropdownMenu, { type MenuItem } from '@/components/ui/DropdownMenu.vue'
import { readText } from '@/util/clipboard'

const props = withDefaults(defineProps<{ namespace: string; name: string; standalone?: boolean }>(), { standalone: false })

const screen = ref<HTMLElement | null>(null)
const wrapper = ref<HTMLElement | null>(null)
const status = ref<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
const message = ref('')
const scale = ref(true)
let rfb: RFB | null = null

async function connect() {
  disconnect()
  status.value = 'connecting'
  message.value = ''
  try {
    const { path } = await vmApi.consoleTicket(props.namespace, props.name, 'vnc')
    rfb = new RFB(screen.value!, gateway.url(path), { shared: true, wsProtocols: [] })
    rfb.scaleViewport = scale.value
    rfb.resizeSession = false
    rfb.background = 'rgb(18, 20, 23)'
    rfb.focusOnClick = true
    rfb.addEventListener('connect', () => {
      status.value = 'connected'
      rfb?.focus()
    })
    rfb.addEventListener('disconnect', (event: any) => {
      status.value = event.detail?.clean ? 'disconnected' : 'error'
      message.value = event.detail?.clean ? 'The console closed.' : 'The console connection failed or was lost.'
      rfb = null
    })
  } catch (e) {
    status.value = 'error'
    message.value = errorMessage(e)
  }
}

function disconnect() {
  if (rfb) {
    try {
      rfb.disconnect()
    } catch {
      /* already gone */
    }
    rfb = null
  }
}

function toggleScale() {
  scale.value = !scale.value
  if (rfb) rfb.scaleViewport = scale.value
}

async function paste() {
  try {
    // Over plain HTTP the clipboard is off limits; ask for the text instead.
    const text = (await readText()) ?? window.prompt('Text to type into the guest:') ?? ''
    // Type it: guests rarely run a clipboard agent, but they always read keys.
    for (const ch of text) {
      const code = ch.codePointAt(0)!
      const keysym = ch === '\n' ? 0xff0d : code < 0x100 ? code : 0x01000000 + code
      rfb?.sendKey(keysym, null)
    }
  } catch (e) {
    message.value = errorMessage(e)
  }
}

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else wrapper.value?.requestFullscreen()
}

function popout() {
  window.open(`/console/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.name)}?kind=vnc`, `vnc-${props.namespace}-${props.name}`, 'width=1100,height=760')
}

const keys: MenuItem[] = [
  { id: 'cad', title: 'Ctrl+Alt+Del', run: () => rfb?.sendCtrlAltDel() },
  { id: 'caf1', title: 'Ctrl+Alt+F1', run: () => combo([0xffe3, 0xffe9, 0xffbe]) },
  { id: 'caf2', title: 'Ctrl+Alt+F2', run: () => combo([0xffe3, 0xffe9, 0xffbf]) },
  { id: 'caf7', title: 'Ctrl+Alt+F7', run: () => combo([0xffe3, 0xffe9, 0xffc4]) },
  { id: 'cabs', title: 'Ctrl+Alt+Backspace', run: () => combo([0xffe3, 0xffe9, 0xff08]) },
  { id: 'tab', title: 'Alt+Tab', run: () => combo([0xffe9, 0xff09]) },
  { id: 'win', title: 'Super (Windows key)', run: () => combo([0xffeb]) },
  { id: 'esc', title: 'Escape', run: () => combo([0xff1b]) },
]

function combo(keysyms: number[]) {
  if (!rfb) return
  for (const k of keysyms) rfb.sendKey(k, null, true)
  for (const k of [...keysyms].reverse()) rfb.sendKey(k, null, false)
}

onMounted(connect)
onBeforeUnmount(disconnect)
</script>

<template>
  <div ref="wrapper" class="flex h-full min-h-0 flex-col bg-[#121417]">
    <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-surface-1 px-2">
      <span class="mr-2 flex items-center gap-1.5 text-xs">
        <span class="size-2 rounded-full" :class="{ 'bg-ok': status === 'connected', 'bg-info animate-pulse': status === 'connecting', 'bg-fg-subtle': status === 'disconnected', 'bg-bad': status === 'error' }" />
        <span class="text-fg-muted">noVNC · {{ status }}</span>
      </span>
      <DropdownMenu :items="keys" :icon="faKeyboard" title="Keys" :disabled="status !== 'connected'" button-class="btn-sm" />
      <button class="btn btn-sm" :disabled="status !== 'connected'" title="Type the clipboard into the guest" @click="paste"><Fa :icon="faClipboard" /> Paste</button>
      <button class="btn btn-sm" @click="toggleScale" :title="scale ? 'Show at native size' : 'Scale to fit'"><Fa :icon="scale ? faArrowsLeftRight : faCompress" /> {{ scale ? 'Scaled' : '1:1' }}</button>
      <div class="ml-auto flex items-center gap-1.5">
        <button class="btn btn-sm" @click="connect"><Fa :icon="status === 'connected' ? faRotateRight : faPlug" /> {{ status === 'connected' ? 'Reconnect' : 'Connect' }}</button>
        <button v-if="!standalone" class="btn btn-sm" title="Open in a new window" @click="popout"><Fa :icon="faUpRightFromSquare" /></button>
        <button class="btn btn-sm" title="Full screen" @click="fullscreen"><Fa :icon="faExpand" /></button>
      </div>
    </div>
    <div class="relative min-h-0 flex-1">
      <div ref="screen" class="absolute inset-0" />
      <div v-if="status !== 'connected'" class="absolute inset-0 flex items-center justify-center">
        <div class="text-center text-fg-muted">
          <div v-if="status === 'connecting'" class="animate-pulse">Connecting to {{ namespace }}/{{ name }}…</div>
          <template v-else>
            <div class="mb-3">{{ message }}</div>
            <button class="btn btn-primary" @click="connect"><Fa :icon="faPlug" /> Connect</button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
