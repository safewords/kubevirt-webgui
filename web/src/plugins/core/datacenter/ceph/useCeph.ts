/**
 * The Ceph panel's shared state: the cluster's figures (prometheus module),
 * its OSDs (dashboard API), and what they mean in plain words.
 *
 * One poller serves every tab; it runs while any of them is mounted.
 */
import { computed, reactive } from 'vue'
import { gateway, errorMessage } from '@/api/gateway'

export interface CephHistory {
  intervalSeconds: number
  ts: number[]
  usedBytes: number[]
  totalBytes: number[]
  degradedObjects: number[]
  misplacedObjects: number[]
  objectCopies: number[]
  readOps: number[]
  writeOps: number[]
  readBytes: number[]
  writeBytes: number[]
  recoveryBytes: number[]
  health: number[]
  osdLatencyMs: Record<string, Array<number | null>>
}

export interface CephStatus {
  configured: boolean
  dashboard?: boolean
  source?: string
  error?: string
  fetchedAt?: string
  health?: { status: string; checks: Array<{ name: string; severity: string }> }
  mons?: Array<{ name: string; host?: string; address?: string; version?: string; inQuorum: boolean }>
  osds?: Array<{ id: string; host?: string; deviceClass?: string; up: boolean; in: boolean; applyLatencyMs?: number; commitLatencyMs?: number }>
  capacity?: { totalBytes?: number; usedBytes?: number }
  pools?: Array<{ id: string; name: string; type?: string; storedBytes?: number; maxAvailBytes?: number; percentUsed?: number; objects?: number; pgs?: number }>
  pgs?: { total: number; states: Record<string, number> }
  objects?: { degraded?: number; misplaced?: number; unfound?: number; copies?: number; total?: number }
  flags?: string[]
  recoveryBytesPerSec?: number
  history?: CephHistory
}

export interface CephOsd {
  id: number
  host: string
  up: boolean
  in: boolean
  state: string[]
  deviceClass: string
  crushWeight: number
  reweight: number
  primaryAffinity: number
  usedBytes: number
  totalBytes: number
  pgs: number
  readOps: number
  writeOps: number
  readBytes: number
  writeBytes: number
  flags: string[]
}

export interface CephOsds {
  available: boolean
  reason?: string
  manage?: boolean
  osds?: CephOsd[]
  flags?: string[]
  hosts?: Array<{ name: string; services: string[] }>
  pgStatuses?: Record<string, number>
  scrubStatus?: string
}

const state = reactive({
  status: null as CephStatus | null,
  osds: null as CephOsds | null,
  statusError: null as string | null,
  loading: false,
  users: 0,
})
let timer: ReturnType<typeof setInterval> | null = null

export async function refreshCeph() {
  state.loading = true
  try {
    const [status, osds] = await Promise.all([
      gateway.call<CephStatus>('ceph.status', { historyHours: 6 }),
      gateway.call<CephOsds>('ceph.osds', {}).catch((e) => ({ available: false, reason: errorMessage(e) }) as CephOsds),
    ])
    state.status = status
    state.osds = osds
    state.statusError = null
  } catch (e) {
    state.statusError = errorMessage(e)
  } finally {
    state.loading = false
  }
}

/** Start polling while a Ceph view is on screen; the returned function stops it. */
export function useCephPolling() {
  state.users++
  if (state.users === 1) {
    refreshCeph()
    timer = setInterval(refreshCeph, 15000)
  }
  return () => {
    state.users--
    if (state.users === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Read it; change it only through `refreshCeph`. */
export const ceph = state

// --- what the figures mean ---------------------------------------------------------

export type Urgency = 'now' | 'soon' | 'housekeeping'

export interface CheckHelp {
  title: string
  meaning: string
  fix: string
  urgency: Urgency
}

/** The checks a VM operator meets, in their words. Unknown ones fall back to `ceph health detail`. */
export const CHECKS: Record<string, CheckHelp> = {
  PG_AVAILABILITY: { title: 'Some data cannot be read or written', meaning: 'Placement groups are inactive: disks backed by them hang until they recover.', fix: 'Bring the down OSDs back. `ceph health detail` lists the stuck placement groups.', urgency: 'now' },
  PG_DEGRADED: { title: 'Some data has fewer copies than it should', meaning: 'Data is still readable, but one more failure in the same place could make some of it unavailable.', fix: 'Bring the missing OSD back, or mark it out so Ceph rebuilds the copies elsewhere.', urgency: 'now' },
  PG_DAMAGED: { title: 'Some data is damaged', meaning: 'Scrubbing found inconsistent copies.', fix: '`ceph health detail` names the placement groups; `ceph pg repair <pg>` repairs one.', urgency: 'now' },
  OSD_SCRUB_ERRORS: { title: 'Scrubbing found errors', meaning: 'Copies of some objects disagree.', fix: 'Repair the placement groups `ceph health detail` lists.', urgency: 'now' },
  OSD_DOWN: { title: 'An OSD is down', meaning: 'Its data is served from the other copies while it is away.', fix: 'Start it again, or mark it out if the disk or machine is gone for good.', urgency: 'now' },
  OSD_HOST_DOWN: { title: 'A whole machine’s OSDs are down', meaning: 'Usually the machine itself is off or unreachable.', fix: 'Power the machine on. Before planned maintenance, set noout so Ceph does not start moving data.', urgency: 'now' },
  SLOW_OPS: { title: 'Requests are slow', meaning: 'Some I/O is taking seconds; guests on Ceph disks will stall.', fix: 'Look for a slow or failing disk (latency below) or a saturated network.', urgency: 'now' },
  OSD_NEARFULL: { title: 'An OSD is nearly full', meaning: 'At the full ratio Ceph stops accepting writes.', fix: 'Add capacity, delete data, or reweight the full OSD down.', urgency: 'now' },
  OSD_FULL: { title: 'An OSD is full', meaning: 'Writes to the pools on it are blocked.', fix: 'Add capacity or free space at once.', urgency: 'now' },
  POOL_NEARFULL: { title: 'A pool is nearly full', meaning: 'Writes stop when it fills.', fix: 'Add capacity or free space.', urgency: 'now' },
  MON_DOWN: { title: 'A monitor is out of quorum', meaning: 'The cluster keeps working while a majority of monitors agree.', fix: 'Bring that monitor’s machine back.', urgency: 'soon' },
  MON_DISK_LOW: { title: 'A monitor’s disk is filling up', meaning: 'At the critical ratio the monitor stops.', fix: 'Free space on that machine’s root filesystem.', urgency: 'soon' },
  MON_CLOCK_SKEW: { title: 'Monitor clocks disagree', meaning: 'Skew can cost quorum.', fix: 'Check NTP on the monitor machines.', urgency: 'soon' },
  BLUESTORE_SLOW_OP_ALERT: { title: 'A disk is slow inside an OSD', meaning: 'Often a failing or overloaded device.', fix: 'Check that OSD’s latency and SMART data on the OSDs tab.', urgency: 'soon' },
  PG_NOT_SCRUBBED: { title: 'Consistency checks are overdue', meaning: 'Placement groups have not been scrubbed in time — usually held back by load or a down OSD.', fix: 'Clears by itself once the cluster is healthy and idle.', urgency: 'soon' },
  PG_NOT_DEEP_SCRUBBED: { title: 'Deep consistency checks are overdue', meaning: 'Full checksumming of objects is behind schedule.', fix: 'Clears by itself once the cluster is healthy and idle.', urgency: 'soon' },
  OSDMAP_FLAGS: { title: 'Cluster flags are set', meaning: 'Flags such as noout change how Ceph reacts to failures.', fix: 'Expected during maintenance; clear them afterwards (OSDs tab).', urgency: 'soon' },
  RECENT_CRASH: { title: 'A daemon crashed recently', meaning: 'It restarted; the crash report is kept.', fix: '`ceph crash ls` shows it; `ceph crash archive-all` clears the warning.', urgency: 'housekeeping' },
  AUTH_INSECURE_SERVICE_KEY_TYPE: { title: 'A daemon uses an old key type', meaning: 'Newer Ceph flags AES keys as insecure. On its own this raises HEALTH_ERR but does not affect data.', fix: 'Rotate that daemon’s key (`ceph auth rotate`).', urgency: 'housekeeping' },
  AUTH_INSECURE_CLIENT_KEY_TYPE: { title: 'A client uses an old key type', meaning: 'client.admin, the CSI user or another client still has an AES key.', fix: 'Rotate it, then update whatever holds the key (the CSI secret, for client.kube).', urgency: 'housekeeping' },
  AUTH_INSECURE_KEYS_ALLOWED: { title: 'Old key types are still accepted', meaning: 'Needed until every key is rotated.', fix: 'Turn it off once no old keys remain.', urgency: 'housekeeping' },
}

export const URGENCY_LABEL: Record<Urgency, string> = {
  now: 'Affects your data now',
  soon: 'Needs attention soon',
  housekeeping: 'Housekeeping',
}

export function checkHelp(name: string): CheckHelp {
  return CHECKS[name] ?? { title: name, meaning: 'Ceph raised this check.', fix: 'Run `ceph health detail` on an admin host for the affected daemons and objects.', urgency: 'soon' }
}

/** What the cluster flags do, for the toggles. `pause` is not offered. */
export const FLAGS: Array<{ name: string; label: string; meaning: string }> = [
  { name: 'noout', label: 'Don’t mark OSDs out', meaning: 'Down OSDs stay "in", so Ceph does not start copying their data elsewhere. Set it before rebooting a machine.' },
  { name: 'norebalance', label: 'Don’t rebalance', meaning: 'Ceph does not move data just to even out usage. Recovery of lost copies still runs.' },
  { name: 'norecover', label: 'Don’t recover', meaning: 'Missing copies are not rebuilt. Only for short, deliberate maintenance.' },
  { name: 'nobackfill', label: 'Don’t backfill', meaning: 'Ceph does not copy whole placement groups to new OSDs.' },
  { name: 'noscrub', label: 'Pause scrubbing', meaning: 'Light consistency checks stop — frees disk time under load.' },
  { name: 'nodeep-scrub', label: 'Pause deep scrubbing', meaning: 'Full checksumming stops — frees a lot of disk time under load.' },
  { name: 'noin', label: 'Don’t mark OSDs in', meaning: 'Returning OSDs are not given data automatically.' },
  { name: 'noup', label: 'Don’t mark OSDs up', meaning: 'Restarted OSDs are kept down.' },
  { name: 'nodown', label: 'Don’t mark OSDs down', meaning: 'Failed OSDs are not marked down — clients may hang on them. Rarely what you want.' },
]

// --- formatting ------------------------------------------------------------------------

export function rate(bytesPerSec: number | null | undefined): string {
  const v = bytesPerSec ?? 0
  if (v < 1024) return `${v.toFixed(0)} B/s`
  const units = ['KiB/s', 'MiB/s', 'GiB/s']
  let n = v / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

export function ops(v: number | null | undefined): string {
  const n = v ?? 0
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n >= 10 ? n.toFixed(0) : n.toFixed(1)
}

export function count(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString()
}

/** A history column as chart points. */
export function points(h: CephHistory | undefined, column: keyof CephHistory): Array<{ ts: number; value: number }> {
  if (!h) return []
  const values = h[column] as unknown as number[]
  return h.ts.map((ts, i) => ({ ts, value: values[i] ?? 0 }))
}

export function latencyPoints(h: CephHistory | undefined, id: string | number): Array<{ ts: number; value: number }> {
  const values = h?.osdLatencyMs?.[String(id)]
  if (!h || !values) return []
  return h.ts.flatMap((ts, i) => (values[i] == null ? [] : [{ ts, value: values[i] as number }]))
}

/** A chart window that fits the history there is: at least 15 minutes, at most 6 hours. */
export function historyWindowMs(h: CephHistory | undefined): number {
  const first = h?.ts[0]
  const span = first ? Date.now() - first : 0
  return Math.min(6 * 3600 * 1000, Math.max(15 * 60 * 1000, span * 1.1))
}

export function ms(v: number): string {
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ms`
}

/** Latency, in ms, from which an OSD counts as slow. */
export const SLOW_MS = 50

// --- the headline ---------------------------------------------------------------------

export interface Headline {
  level: 'ok' | 'warn' | 'bad' | 'unknown'
  title: string
  detail: string
}

/**
 * One sentence on whether data is safe and available — what someone opening
 * the panel wants first — built from the checks and the figures, not just the
 * HEALTH_ string (HEALTH_ERR here can be nothing worse than an old key type).
 */
export const headline = computed<Headline>(() => {
  const s = state.status
  if (!s?.health) return { level: 'unknown', title: 'Ceph’s state is not known', detail: s?.error ?? 'No figures from the cluster yet.' }
  const names = new Set(s.health.checks.map((c) => c.name))
  const degraded = s.objects?.degraded ?? 0
  const copies = s.objects?.copies ?? 0
  const pct = copies ? (degraded / copies) * 100 : 0
  const down = (s.osds ?? []).filter((o) => !o.up)
  const parts: string[] = []
  if (down.length) {
    const hosts = [...new Set(down.map((o) => o.host).filter(Boolean))]
    parts.push(`${down.length} OSD${down.length > 1 ? 's are' : ' is'} down${hosts.length ? ` (on ${hosts.join(', ')})` : ''}`)
  }
  if (degraded) parts.push(`${pct.toFixed(1)}% of data copies are missing`)
  const slow = (s.osds ?? []).filter((o) => o.up && (o.commitLatencyMs ?? 0) >= SLOW_MS)
  if (slow.length) parts.push(`${slow.map((o) => `osd.${o.id}`).join(', ')} ${slow.length > 1 ? 'are' : 'is'} slow`)

  if (names.has('PG_AVAILABILITY')) {
    return { level: 'bad', title: 'Some data is unavailable', detail: `Disks on the affected placement groups will hang. ${parts.join('; ')}.` }
  }
  if (names.has('OSD_FULL')) return { level: 'bad', title: 'Writes are blocked: an OSD is full', detail: parts.join('; ') }
  if (parts.length || names.has('PG_DEGRADED')) {
    return { level: 'warn', title: 'Data is available, with reduced redundancy', detail: `${parts.join('; ')}.` }
  }
  const others = s.health.checks.filter((c) => checkHelp(c.name).urgency !== 'housekeeping')
  if (others.length) return { level: 'warn', title: 'Data is safe; some things need attention', detail: others.map((c) => checkHelp(c.name).title).join('; ') + '.' }
  if (s.health.checks.length) return { level: 'ok', title: 'Data is safe and available', detail: 'Only housekeeping items are raised.' }
  return { level: 'ok', title: 'Ceph is healthy', detail: 'All data is fully replicated and available.' }
})
