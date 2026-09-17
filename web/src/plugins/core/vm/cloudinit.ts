/** Reading and writing cloud-init user data and network config. */
import { dump } from 'js-yaml'
import { loadYaml } from './yaml'

export type CloudInitKind = 'cloudInitNoCloud' | 'cloudInitConfigDrive'

export interface CloudInitVolume {
  name: string
  kind: CloudInitKind
  source: any
}

export function findCloudInit(spec: any): CloudInitVolume | null {
  for (const volume of spec?.volumes ?? []) {
    if (volume.cloudInitNoCloud) return { name: volume.name, kind: 'cloudInitNoCloud', source: volume.cloudInitNoCloud }
    if (volume.cloudInitConfigDrive) return { name: volume.name, kind: 'cloudInitConfigDrive', source: volume.cloudInitConfigDrive }
  }
  return null
}

function decode(base64: string | undefined): string | undefined {
  if (!base64) return undefined
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}

export function userData(source: any): string {
  return source?.userData ?? decode(source?.userDataBase64) ?? ''
}

export function networkData(source: any): string {
  return source?.networkData ?? decode(source?.networkDataBase64) ?? ''
}

/** The Proxmox-style fields, as far as the user data can be read as them. */
export interface Structured {
  user: string
  password: string
  sshKeys: string
  hostname: string
  upgrade: boolean
  ipMode: 'dhcp' | 'static' | 'unset'
  address: string
  gateway: string
  dns: string
}

export function toStructured(user: string, network: string): { fields: Structured; parsed: boolean } {
  const fields: Structured = { user: '', password: '', sshKeys: '', hostname: '', upgrade: false, ipMode: 'unset', address: '', gateway: '', dns: '' }
  let parsed = true
  try {
    const doc = (loadYaml(user) ?? {}) as Record<string, any>
    if (doc && typeof doc === 'object') {
      fields.user = typeof doc.user === 'string' ? doc.user : (doc.user?.name ?? '')
      fields.password = typeof doc.password === 'string' ? doc.password : ''
      fields.sshKeys = (doc.ssh_authorized_keys ?? []).join('\n')
      fields.hostname = doc.fqdn ?? doc.hostname ?? ''
      fields.upgrade = !!doc.package_upgrade
    }
  } catch {
    parsed = false
  }
  try {
    const net = loadYaml(network) as Record<string, any> | null
    const eths = net?.ethernets ?? net?.network?.ethernets
    const first = eths ? (Object.values(eths)[0] as any) : null
    if (first) {
      if (first.dhcp4) fields.ipMode = 'dhcp'
      else if (first.addresses?.length) {
        fields.ipMode = 'static'
        fields.address = first.addresses[0]
        fields.gateway = first.gateway4 ?? first.routes?.find((r: any) => r.to === 'default' || r.to === '0.0.0.0/0')?.via ?? ''
        fields.dns = (first.nameservers?.addresses ?? []).join(' ')
      }
    }
  } catch {
    parsed = false
  }
  return { fields, parsed }
}

/**
 * cloud-config keys for a guest hostname. `hostname` alone loses on Fedora and
 * RHEL-family images: they prefer the FQDN, which cloud-init otherwise takes from
 * the meta-data KubeVirt writes (`local-hostname`, the VM name). Setting `fqdn`
 * as well makes the chosen name stick everywhere.
 */
export function hostnameKeys(name: string): { hostname: string; fqdn: string } {
  const fqdn = name.trim()
  return { hostname: fqdn.split('.')[0], fqdn }
}

/** Merge the structured fields into existing user data, keeping everything else in it. */
export function applyStructured(user: string, fields: Structured): { userData: string; networkData: string | null } {
  let doc: Record<string, any> = {}
  try {
    const parsed = loadYaml(user) ?? {}
    if (parsed && typeof parsed === 'object') doc = parsed as Record<string, any>
  } catch {
    doc = {}
  }
  const set = (key: string, value: unknown) => {
    if (value === '' || value === false || value === undefined || (Array.isArray(value) && !value.length)) delete doc[key]
    else doc[key] = value
  }
  set('user', fields.user.trim())
  set('password', fields.password)
  if (fields.password) doc.chpasswd = { ...(doc.chpasswd ?? {}), expire: false }
  set('ssh_authorized_keys', fields.sshKeys.split('\n').map((k) => k.trim()).filter(Boolean))
  for (const [key, value] of Object.entries(hostnameKeys(fields.hostname))) set(key, value)
  set('package_upgrade', fields.upgrade)
  const userData = `#cloud-config\n${Object.keys(doc).length ? dump(doc, { lineWidth: 200, noRefs: true }) : ''}`

  let networkData: string | null = null
  if (fields.ipMode === 'dhcp') {
    networkData = dump({ version: 2, ethernets: { eth0: { match: { name: 'e*' }, dhcp4: true } } })
  } else if (fields.ipMode === 'static') {
    const eth: Record<string, any> = { match: { name: 'e*' }, addresses: [fields.address.trim()] }
    if (fields.gateway.trim()) eth.routes = [{ to: 'default', via: fields.gateway.trim() }]
    const dns = fields.dns.split(/[\s,]+/).filter(Boolean)
    if (dns.length) eth.nameservers = { addresses: dns }
    networkData = dump({ version: 2, ethernets: { eth0: eth } })
  }
  return { userData, networkData }
}

/** The volume source, rewritten with new data; base64 variants are replaced by plain text. */
export function withData(source: any, user: string, network: string | null): any {
  const next = { ...(source ?? {}) }
  delete next.userDataBase64
  delete next.networkDataBase64
  if (!next.secretRef && !next.userDataSecretRef) next.userData = user
  if (!next.networkDataSecretRef) {
    if (network && network.trim()) next.networkData = network
    else delete next.networkData
  }
  return next
}
