<script setup lang="ts">
/** xterm.js on the VM's serial console. */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { faPlug, faRotateRight, faUpRightFromSquare, faExpand } from '@fortawesome/free-solid-svg-icons'
import { gateway, errorMessage } from '@/api/gateway'
import { vmApi } from '@/api/k8s'

const props = withDefaults(defineProps<{ namespace: string; name: string; standalone?: boolean }>(), { standalone: false })

const host = ref<HTMLElement | null>(null)
const wrapper = ref<HTMLElement | null>(null)
const status = ref<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
const message = ref('')
let term: Terminal | null = null
let fit: FitAddon | null = null
let socket: WebSocket | null = null
let resize: ResizeObserver | null = null

async function connect() {
  socket?.close()
  status.value = 'connecting'
  message.value = ''
  try {
    const { path } = await vmApi.consoleTicket(props.namespace, props.name, 'serial')
    const ws = new WebSocket(gateway.url(path))
    ws.binaryType = 'arraybuffer'
    socket = ws
    ws.onopen = () => {
      status.value = 'connected'
      term?.writeln(`\x1b[90m— connected to ${props.namespace}/${props.name} serial console; press Enter if the prompt is not shown —\x1b[0m`)
      term?.focus()
    }
    ws.onmessage = (event) => term?.write(new Uint8Array(event.data as ArrayBuffer))
    ws.onclose = (event) => {
      if (socket !== ws) return
      status.value = event.code === 1000 ? 'disconnected' : 'error'
      message.value = event.reason || 'The console closed.'
      term?.writeln(`\r\n\x1b[90m— ${message.value} —\x1b[0m`)
    }
  } catch (e) {
    status.value = 'error'
    message.value = errorMessage(e)
  }
}

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else wrapper.value?.requestFullscreen()
}

function popout() {
  window.open(`/console/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.name)}?kind=serial`, `serial-${props.namespace}-${props.name}`, 'width=980,height=640')
}

onMounted(() => {
  term = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    theme: { background: '#121417', foreground: '#e3e7ec', cursor: '#f28a1f' },
    scrollback: 5000,
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value!)
  fit.fit()
  const encoder = new TextEncoder()
  term.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data))
  })
  resize = new ResizeObserver(() => fit?.fit())
  resize.observe(host.value!)
  connect()
})

onBeforeUnmount(() => {
  resize?.disconnect()
  const s = socket
  socket = null
  s?.close()
  term?.dispose()
})
</script>

<template>
  <div ref="wrapper" class="flex h-full min-h-0 flex-col bg-[#121417]">
    <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-surface-1 px-2">
      <span class="mr-2 flex items-center gap-1.5 text-xs">
        <span class="size-2 rounded-full" :class="{ 'bg-ok': status === 'connected', 'bg-info animate-pulse': status === 'connecting', 'bg-fg-subtle': status === 'disconnected', 'bg-bad': status === 'error' }" />
        <span class="text-fg-muted">xterm.js serial · {{ status }}</span>
      </span>
      <div class="ml-auto flex items-center gap-1.5">
        <button class="btn btn-sm" @click="connect"><Fa :icon="status === 'connected' ? faRotateRight : faPlug" /> {{ status === 'connected' ? 'Reconnect' : 'Connect' }}</button>
        <button v-if="!standalone" class="btn btn-sm" title="Open in a new window" @click="popout"><Fa :icon="faUpRightFromSquare" /></button>
        <button class="btn btn-sm" title="Full screen" @click="fullscreen"><Fa :icon="faExpand" /></button>
      </div>
    </div>
    <div ref="host" class="min-h-0 flex-1 p-1.5" />
  </div>
</template>
