/** Formatting helpers shared by every screen. */

const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

export function bytes(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  let v = Math.abs(value)
  let unit = 0
  while (v >= 1024 && unit < BINARY.length - 1) {
    v /= 1024
    unit++
  }
  return `${value < 0 ? '-' : ''}${v.toFixed(unit === 0 ? 0 : digits)} ${BINARY[unit]}`
}

/** A Kubernetes quantity as a number: `250m` → 0.25, `2Gi` → 2147483648. */
export function quantity(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  const v = value.trim()
  const match = v.match(/^([+-]?[0-9.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/)
  if (!match) return 0
  const n = parseFloat(match[1])
  const factors: Record<string, number> = {
    '': 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  }
  return n * (factors[match[2]] ?? 1)
}

export function cores(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value < 1) return `${(value * 1000).toFixed(0)}m`
  return `${value.toFixed(value < 10 ? 2 : 1)}`
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function age(timestamp: string | number | null | undefined, now = Date.now()): string {
  if (!timestamp) return '—'
  const t = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)
  if (!Number.isFinite(t)) return '—'
  return duration(Math.max(0, now - t))
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
}

export function dateTime(timestamp: string | number | null | undefined): string {
  if (!timestamp) return '—'
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function time(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A DNS-1123 label: what Kubernetes accepts for most names. */
export function isDnsLabel(value: string): boolean {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) && value.length <= 63
}

export function toDnsLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

export function randomSuffix(length = 5): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  const values = crypto.getRandomValues(new Uint8Array(length))
  for (const v of values) out += alphabet[v % alphabet.length]
  return out
}
