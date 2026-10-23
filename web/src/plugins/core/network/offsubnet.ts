/**
 * Off-subnet client NAT: the per-VM setting the node agent
 * (`kubevirt-webgui netagent`) applies inside the launcher pod, and the
 * status it reports back. The agent is the authority on what the annotation
 * means — src/netagent/plan.rs — and this mirrors its rules.
 */
import { dump, load } from 'js-yaml'
import type { KObject } from '@/api/types'

/** On the VM's `spec.template.metadata`, so every VMI carries it. */
export const SPEC_ANNOTATION = 'kubevirt-webgui/offsubnet-nat'
/** Written by the agent on the VMI. */
export const STATUS_ANNOTATION = 'kubevirt-webgui/offsubnet-nat-status'

export interface NatEntry {
  interface: string
  clients: string[]
  /** Empty or `auto`: from the guest agent. */
  guestIP?: string
  snatTo: string
  /** Empty or `auto`: from the node's ARP table. */
  gatewayMAC?: string
  enabled?: boolean
}

export interface NatInterfaceStatus {
  interface: string
  state: 'Applied' | 'Pending' | 'Failed' | 'Disabled'
  message?: string
  bridge?: string
  guestIP?: string
  snatTo?: string
  gatewayMAC?: string
  clients?: string[]
  packets?: number
}

export interface NatStatus {
  state: 'Applied' | 'Pending' | 'Failed' | 'Disabled'
  message?: string
  node?: string
  updated?: string
  interfaces: NatInterfaceStatus[]
}

export function readEntries(vm: KObject | null | undefined): NatEntry[] {
  const text = vm?.spec?.template?.metadata?.annotations?.[SPEC_ANNOTATION]
  if (!text) return []
  try {
    const parsed = load(text)
    return Array.isArray(parsed) ? (parsed as NatEntry[]) : []
  } catch {
    return []
  }
}

export function readStatus(vmi: KObject | null | undefined): NatStatus | null {
  const text = vmi?.metadata?.annotations?.[STATUS_ANNOTATION]
  if (!text) return null
  try {
    return JSON.parse(text) as NatStatus
  } catch {
    return null
  }
}

/** The annotation's text — YAML, as the feature's documentation shows it. */
export function writeEntries(entries: NatEntry[]): string | null {
  if (!entries.length) return null
  const clean = entries.map((e) => {
    const out: Record<string, unknown> = { interface: e.interface, clients: e.clients, guestIP: e.guestIP || 'auto', snatTo: e.snatTo, gatewayMAC: e.gatewayMAC || 'auto' }
    if (e.enabled === false) out.enabled = false
    return out
  })
  return dump(clean, { flowLevel: 2, lineWidth: -1 })
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

export function isIpv4(text: string): boolean {
  return IPV4.test(text.trim())
}

export function isCidr(text: string): boolean {
  const [addr, len, extra] = text.trim().split('/')
  return extra === undefined && isIpv4(addr) && (len === undefined || (/^\d{1,2}$/.test(len) && Number(len) <= 32))
}

export function isMac(text: string): boolean {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(text.trim())
}

/** Split "10.1.0.0/24, 10.2.0.0/24" (commas, spaces, newlines). */
export function splitRanges(text: string): string[] {
  return text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
}

export function problems(e: NatEntry): string[] {
  const out: string[] = []
  if (!e.clients.length) out.push('Add at least one client range')
  for (const c of e.clients) if (!isCidr(c)) out.push(`${c} is not an IPv4 range`)
  if (!isIpv4(e.snatTo)) out.push('Translate to must be an IPv4 address on the LAN')
  if (e.guestIP && e.guestIP !== 'auto' && !isIpv4(e.guestIP)) out.push('Guest address must be an IPv4 address')
  if (e.gatewayMAC && e.gatewayMAC !== 'auto' && !isMac(e.gatewayMAC)) out.push('Gateway MAC must look like aa:bb:cc:dd:ee:ff')
  return out
}

// --- presets: named client ranges, per browser ------------------------------------------

const PRESETS_KEY = 'kve.offsubnet.presets'

export interface RangePreset {
  name: string
  clients: string[]
}

export function loadPresets(): RangePreset[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function savePresets(presets: RangePreset[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets))
  } catch {
    /* a convenience only */
  }
}
