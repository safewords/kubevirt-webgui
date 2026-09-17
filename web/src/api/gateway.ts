/**
 * The browser end of `/ws` — every action the GUI takes goes through here.
 *
 * - `call(method, params)` sends one request and resolves with its result.
 * - `subscribe(topic, params, onEvent)` streams events until closed.
 *
 * The socket reconnects on its own. After a reconnect the session is resumed
 * from the stored ticket and every live subscription is re-established, so a
 * screen never needs to know the connection dropped.
 */
import { ref, shallowRef } from 'vue'

export interface RpcError {
  code: string
  status: number
  message: string
}

export interface ExtensionManifest {
  id: string
  name: string
  version: string
  description: string
  requires: string[]
  methods: string[]
  topics: string[]
}

export interface Hello {
  server: { name: string; version: string; product: string; cluster: string }
  auth: { methods: string[] }
  extensions: ExtensionManifest[]
  pluginUrls: string[]
}

export type ConnectionState = 'connecting' | 'open' | 'closed'

interface Pending {
  resolve: (value: any) => void
  reject: (error: RpcError) => void
  timer: ReturnType<typeof setTimeout>
}

interface Sub {
  id: string
  topic: string
  params: unknown
  onEvent: (data: any) => void
  onEnd?: (error?: RpcError) => void
  closed: boolean
}

export interface Subscription {
  readonly id: string
  close(): void
}

export function isRpcError(e: unknown): e is RpcError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e
}

export function errorMessage(e: unknown): string {
  if (isRpcError(e)) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

class Gateway {
  readonly state = ref<ConnectionState>('closed')
  readonly hello = shallowRef<Hello | null>(null)
  readonly latency = ref<number | null>(null)

  private socket: WebSocket | null = null
  private seq = 0
  private pending = new Map<string, Pending>()
  private subs = new Map<string, Sub>()
  private queue: string[] = []
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private helloWaiters: Array<(hello: Hello) => void> = []

  /** Runs after every (re)connection, before queued frames are flushed. */
  onOpen: ((hello: Hello, reconnect: boolean) => Promise<void>) | null = null
  /** The server reports the session has expired. */
  onSessionExpired: (() => void) | null = null

  private everOpened = false
  private ready = false

  url(path = '/ws'): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}${path}`
  }

  connect() {
    if (this.socket && this.state.value !== 'closed') return
    this.state.value = 'connecting'
    this.ready = false
    const socket = new WebSocket(this.url())
    this.socket = socket

    socket.onmessage = (event) => this.receive(event.data)
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.ready = false
      this.state.value = 'closed'
      if (this.pingTimer) clearInterval(this.pingTimer)
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject({ code: 'Disconnected', status: 0, message: 'the connection to the server was lost' })
        this.pending.delete(id)
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.attempts, 5))
    this.attempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** Resolves once the server has said hello. */
  whenHello(): Promise<Hello> {
    if (this.hello.value && this.state.value === 'open') return Promise.resolve(this.hello.value)
    return new Promise((resolve) => this.helloWaiters.push(resolve))
  }

  private async receive(raw: string) {
    let frame: any
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }

    switch (frame.op) {
      case 'hello': {
        const reconnect = this.everOpened
        this.everOpened = true
        this.attempts = 0
        this.hello.value = frame as Hello
        this.state.value = 'open'
        // Sign-in is resumed before anything else is sent, so a subscription
        // restored after a reconnect does not race its own authentication.
        try {
          await this.onOpen?.(frame as Hello, reconnect)
        } catch {
          /* the session store reports its own failures */
        }
        this.ready = true
        for (const queued of this.queue.splice(0)) this.socket?.send(queued)
        for (const sub of this.subs.values()) if (!sub.closed) this.sendSubscribe(sub)
        for (const waiter of this.helloWaiters.splice(0)) waiter(frame as Hello)
        this.startPing()
        break
      }
      case 'result':
      case 'error': {
        const pending = this.pending.get(frame.id)
        if (!pending) {
          if (frame.op === 'error') console.warn('gateway error', frame.error)
          return
        }
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.op === 'result') pending.resolve(frame.result)
        else pending.reject(frame.error)
        break
      }
      case 'event': {
        const sub = this.subs.get(frame.id)
        if (sub && !sub.closed) sub.onEvent(frame.data)
        break
      }
      case 'end': {
        const sub = this.subs.get(frame.id)
        if (sub && !sub.closed) {
          this.subs.delete(frame.id)
          sub.closed = true
          sub.onEnd?.(frame.error)
        }
        break
      }
      case 'pong': {
        const pending = this.pending.get(frame.id)
        if (pending) {
          this.pending.delete(frame.id)
          clearTimeout(pending.timer)
          pending.resolve(frame)
        }
        break
      }
      case 'session': {
        if (frame.state === 'expired') this.onSessionExpired?.()
        break
      }
    }
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(async () => {
      const started = performance.now()
      try {
        await this.raw('ping', {}, 10000)
        this.latency.value = Math.round(performance.now() - started)
      } catch {
        this.latency.value = null
      }
    }, 20000)
  }

  private send(frame: object, immediate = false) {
    const text = JSON.stringify(frame)
    if (this.socket && this.state.value === 'open' && (this.ready || immediate)) this.socket.send(text)
    else this.queue.push(text)
  }

  private raw(op: string, extra: object, timeout: number, immediate = false): Promise<any> {
    const id = `c${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject({ code: 'Timeout', status: 0, message: `no answer from the server after ${timeout / 1000}s` })
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, op, ...extra }, immediate)
    })
  }

  /** Call a method. */
  call<T = any>(method: string, params: object = {}, options: { timeout?: number; immediate?: boolean } = {}): Promise<T> {
    if (!this.socket && this.state.value === 'closed') this.connect()
    return this.raw('call', { method, params }, options.timeout ?? 60000, options.immediate)
  }

  private sendSubscribe(sub: Sub) {
    this.send({ id: sub.id, op: 'subscribe', topic: sub.topic, params: sub.params })
  }

  /** Subscribe to a topic. The subscription survives reconnects. */
  subscribe(topic: string, params: object, onEvent: (data: any) => void, onEnd?: (error?: RpcError) => void): Subscription {
    const sub: Sub = { id: `s${++this.seq}`, topic, params, onEvent, onEnd, closed: false }
    this.subs.set(sub.id, sub)
    if (this.state.value === 'open' && this.ready) this.sendSubscribe(sub)
    else if (this.state.value === 'closed' && !this.socket) this.connect()
    return {
      id: sub.id,
      close: () => {
        if (sub.closed) return
        sub.closed = true
        this.subs.delete(sub.id)
        if (this.socket && this.state.value === 'open') this.send({ id: sub.id, op: 'unsubscribe' })
      },
    }
  }

  /** Drop every subscription (on sign-out). */
  closeAllSubscriptions() {
    for (const sub of [...this.subs.values()]) {
      sub.closed = true
      this.subs.delete(sub.id)
      if (this.socket && this.state.value === 'open') this.send({ id: sub.id, op: 'unsubscribe' })
    }
  }
}

export const gateway = new Gateway()
