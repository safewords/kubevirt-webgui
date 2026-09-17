/**
 * A Node client for the `/ws` gateway — the same protocol the browser speaks.
 * Used to arrange and assert what the UI tests do, and to test the server
 * directly.
 */
import { token as adminToken, wsBase } from './env.mjs'

export class Gateway {
  constructor(url = `${wsBase}/ws`) {
    this.url = url
    this.seq = 0
    this.pending = new Map()
    this.subs = new Map()
    this.taskWaiters = new Map()
    this.taskLogs = new Map()
    /** Every progress report seen per task, in order. */
    this.taskProgress = new Map()
    this.tasks = new Map()
  }

  static async connect(token = adminToken) {
    const gw = new Gateway()
    // A port-forward drops the odd stream under load; a real client retries too.
    for (let attempt = 1; ; attempt++) {
      try {
        await gw.open()
        break
      } catch (e) {
        if (attempt >= 5) throw e
        await new Promise((r) => setTimeout(r, 2000 * attempt))
      }
    }
    gw.token = token
    if (token) gw.user = (await gw.call('auth.login', { token })).user
    gw.subscribe('tasks', {}, (event) => gw.#onTask(event))
    return gw
  }

  /**
   * Open a fresh socket after the old one died (or wedged): sign in again and
   * re-establish every subscription, the way the browser client does.
   */
  async reconnect() {
    if (this.reconnecting) return this.reconnecting
    this.reconnecting = (async () => {
      try {
        this.ws?.close()
      } catch {
        /* already gone */
      }
      for (let attempt = 1; ; attempt++) {
        try {
          await this.open()
          break
        } catch (e) {
          if (attempt >= 8) throw e
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
      }
      if (this.token) await this.#send('call', { method: 'auth.login', params: { token: this.token } }, 60_000)
      for (const [id, sub] of this.subs) this.ws.send(JSON.stringify({ id, op: 'subscribe', topic: sub.topic, params: sub.params }))
    })().finally(() => (this.reconnecting = null))
    return this.reconnecting
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onerror = (e) => reject(new Error(`cannot open ${this.url}: ${e.message ?? 'socket error'}`))
      ws.onclose = () => {
        if (this.ws !== ws) return
        this.ws = null
        for (const [id, pending] of this.pending) {
          this.pending.delete(id)
          pending.reject(Object.assign(new Error('the gateway connection closed'), { code: 'Disconnected' }))
        }
      }
      ws.onmessage = (event) => {
        const frame = JSON.parse(event.data)
        if (frame.op === 'hello') {
          this.hello = frame
          resolve(this)
        } else if (frame.op === 'result' || frame.op === 'error') {
          const pending = this.pending.get(frame.id)
          if (!pending) return
          this.pending.delete(frame.id)
          if (frame.op === 'result') pending.resolve(frame.result)
          else pending.reject(Object.assign(new Error(`${frame.error.code}: ${frame.error.message}`), frame.error))
        } else if (frame.op === 'event') {
          this.subs.get(frame.id)?.onEvent(frame.data)
        } else if (frame.op === 'end') {
          const sub = this.subs.get(frame.id)
          this.subs.delete(frame.id)
          sub?.onEnd?.(frame.error)
        }
      }
    })
  }

  #send(op, frame, timeoutMs) {
    const id = `c${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A socket that stops answering is as good as closed: drop it, so the
        // next call opens a fresh one.
        try {
          this.ws?.close()
        } catch {
          /* already gone */
        }
        reject(new Error(`${frame.method ?? op}: no answer after ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      this.ws.send(JSON.stringify({ id, op, ...frame }))
    })
  }

  async call(method, params = {}, timeoutMs = 60_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.reconnect()
    return this.#send('call', { method, params }, timeoutMs)
  }

  subscribe(topic, params, onEvent, onEnd) {
    const id = `s${++this.seq}`
    this.subs.set(id, { topic, params, onEvent, onEnd })
    this.ws?.send(JSON.stringify({ id, op: 'subscribe', topic, params }))
    return { close: () => (this.subs.delete(id), this.ws?.send(JSON.stringify({ id, op: 'unsubscribe' }))) }
  }

  #onTask(event) {
    const updates = event.type === 'SYNC' ? event.tasks : [event.task]
    for (const task of updates) {
      this.tasks.set(task.id, task)
      if (task.progress) {
        const seen = this.taskProgress.get(task.id) ?? []
        seen.push(task.progress)
        this.taskProgress.set(task.id, seen)
      }
      if (event.line) {
        const lines = this.taskLogs.get(task.id) ?? []
        lines.push(event.line.text)
        this.taskLogs.set(task.id, lines)
      }
      if (task.status !== 'running') {
        for (const resolve of this.taskWaiters.get(task.id) ?? []) resolve(task)
        this.taskWaiters.delete(task.id)
      }
    }
  }

  /** Resolve with the finished task and its log. */
  async waitTask(id, timeoutMs = 15 * 60_000) {
    const known = this.tasks.get(id)
    const task =
      known && known.status !== 'running'
        ? known
        : await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`task ${id} still running after ${timeoutMs / 1000}s`)), timeoutMs)
            const list = this.taskWaiters.get(id) ?? []
            list.push((t) => (clearTimeout(timer), resolve(t)))
            this.taskWaiters.set(id, list)
          })
    const detail = await this.call('tasks.detail', { id })
    return { ...task, log: detail.log.map((l) => l.text) }
  }

  /** Call a method that starts a task, and wait for it. Throws when the task fails. */
  async runTask(method, params, timeoutMs) {
    const { task } = await this.call(method, params)
    const done = await this.waitTask(task, timeoutMs)
    if (done.status !== 'ok') {
      throw Object.assign(new Error(`${method} task ${done.status}: ${done.message}\n  ${done.log.join('\n  ')}`), { task: done })
    }
    return done
  }

  close() {
    this.ws?.close()
  }
}
