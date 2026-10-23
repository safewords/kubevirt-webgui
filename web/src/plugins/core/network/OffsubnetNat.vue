<script setup lang="ts">
/**
 * Network → Off-subnet client NAT: per bridged interface, which client
 * ranges the node agent rewrites to a LAN address so a guest that trusts only
 * its own subnet answers them, and what the agent reports it did.
 */
import { computed, reactive, ref, watch } from 'vue'
import { faFloppyDisk, faRotate, faTrash, faVial } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Notice from '@/components/ui/Notice.vue'
import { k8s } from '@/api/k8s'
import { can } from '@/stores/access'
import { run, toast } from '@/services/dialogs'
import { age } from '@/util/format'
import { templateSpec } from '@/util/kubevirt'
import { updateVm } from '@/plugins/core/vm/update'
import {
  SPEC_ANNOTATION, isIpv4, loadPresets, problems, readEntries, readStatus, savePresets, splitRanges, writeEntries,
  type NatEntry, type NatInterfaceStatus, type RangePreset,
} from './offsubnet'

const props = defineProps<{ ctx: ObjectContext }>()

const vmi = computed(() => props.ctx.related.vmi)
const mayEdit = computed(() => can({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace: props.ctx.namespace, name: props.ctx.name }) === true)

/** Bridged interfaces on a Multus network: the only ones this applies to. */
const bridged = computed(() => {
  const spec = templateSpec(props.ctx.object ?? vmi.value)
  const networks: any[] = spec?.networks ?? []
  return ((spec?.domain?.devices?.interfaces ?? []) as any[])
    .filter((i) => i.bridge !== undefined && networks.find((n) => n.name === i.name)?.multus)
    .map((i) => i.name as string)
})

/** The guest's IPv4 address on an interface, from the guest agent. */
function detectedIp(name: string): string {
  const live = (vmi.value?.status?.interfaces ?? []).find((s: any) => s.name === name)
  return [live?.ipAddress, ...(live?.ipAddresses ?? [])].find((a) => a && isIpv4(a)) ?? ''
}

interface Row {
  interface: string
  on: boolean
  enabled: boolean
  ranges: string
  guestIP: string
  snatTo: string
  gatewayMAC: string
}

const saved = computed(() => readEntries(props.ctx.object))
const rows = reactive<Row[]>([])
const dirty = ref(false)

function reset() {
  rows.splice(0, rows.length, ...bridged.value.map((name) => {
    const e = saved.value.find((s) => s.interface === name)
    return {
      interface: name,
      on: !!e,
      enabled: e?.enabled !== false,
      ranges: (e?.clients ?? []).join(', '),
      guestIP: e?.guestIP && e.guestIP !== 'auto' ? e.guestIP : '',
      snatTo: e?.snatTo ?? '',
      gatewayMAC: e?.gatewayMAC && e.gatewayMAC !== 'auto' ? e.gatewayMAC : '',
    }
  }))
  dirty.value = false
}
// Follow the VM until the user starts editing.
watch([saved, bridged], () => { if (!dirty.value) reset() }, { immediate: true, deep: true })

const entries = computed<NatEntry[]>(() =>
  rows.filter((r) => r.on).map((r) => ({
    interface: r.interface,
    clients: splitRanges(r.ranges),
    guestIP: r.guestIP.trim() || 'auto',
    snatTo: r.snatTo.trim(),
    gatewayMAC: r.gatewayMAC.trim().toLowerCase() || 'auto',
    enabled: r.enabled,
  })),
)
const errors = computed(() => entries.value.flatMap((e) => problems(e).map((p) => `${e.interface}: ${p}`)))
const unmanagedInterfaces = computed(() => saved.value.filter((e) => !bridged.value.includes(e.interface)).map((e) => e.interface))

// --- presets ------------------------------------------------------------------------------

const presets = ref<RangePreset[]>(loadPresets())
function usePreset(row: Row, event: Event) {
  const name = (event.target as HTMLSelectElement).value
  const preset = presets.value.find((p) => p.name === name)
  if (preset) {
    row.ranges = preset.clients.join(', ')
    dirty.value = true
  }
  ;(event.target as HTMLSelectElement).value = ''
}
function savePreset(row: Row) {
  const name = window.prompt('Name these client ranges (for example "VPN"):', 'VPN')?.trim()
  if (!name) return
  presets.value = [...presets.value.filter((p) => p.name !== name), { name, clients: splitRanges(row.ranges) }]
  savePresets(presets.value)
  toast('success', 'Preset saved', `${name}: ${splitRanges(row.ranges).join(', ')}`)
}

// --- saving -------------------------------------------------------------------------------

const busy = ref(false)
async function save() {
  if (errors.value.length) return
  const text = writeEntries(entries.value)
  busy.value = true
  const ok = await run(text ? 'Set off-subnet client NAT' : 'Remove off-subnet client NAT', async () => {
    // The template, so every future VMI carries it…
    await updateVm(props.ctx, () => ({ spec: { template: { metadata: { annotations: { [SPEC_ANNOTATION]: text } } } } }))
    // …and the running one, so it applies now rather than at the next start.
    if (vmi.value) {
      await k8s.patch(
        { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstances', namespace: props.ctx.namespace, name: props.ctx.name },
        { metadata: { annotations: { [SPEC_ANNOTATION]: text } } },
      )
    }
    return true
  }, { quiet: true })
  busy.value = false
  if (ok) {
    dirty.value = false
    toast('success', text ? 'Off-subnet client NAT saved' : 'Off-subnet client NAT removed', vmi.value ? 'The node agent applies it within a few seconds.' : 'It applies when the VM starts.')
  }
}

// --- status -------------------------------------------------------------------------------

const status = computed(() => readStatus(vmi.value))
function statusFor(name: string): NatInterfaceStatus | undefined {
  return status.value?.interfaces.find((i) => i.interface === name)
}
const liveSpec = computed(() => vmi.value?.metadata?.annotations?.[SPEC_ANNOTATION] ?? null)
const waitingForAgent = computed(() => !!vmi.value && !!liveSpec.value && !status.value)
const stateClass = (state?: string) =>
  state === 'Applied' ? 'text-ok' : state === 'Failed' ? 'text-bad' : state === 'Pending' ? 'text-warn' : 'text-fg-subtle'

/**
 * Test: there is no way to send traffic *from* a client range inside the
 * cluster — replies go to the gateway, not back — so this re-reads the
 * agent's counters and says whether connections from the ranges arrived
 * since the last look.
 */
const lastCount = ref<Record<string, number>>({})
const testResult = ref<Record<string, string>>({})
async function test(name: string) {
  const fresh = await k8s.get({ apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstances', namespace: props.ctx.namespace!, name: props.ctx.name })
  const row = readStatus(fresh)?.interfaces.find((i) => i.interface === name)
  if (!row) {
    testResult.value[name] = 'No report from the node agent yet.'
    return
  }
  if (row.state !== 'Applied') {
    testResult.value[name] = `Not applied: ${row.message || row.state}.`
    return
  }
  const now = row.packets ?? 0
  const before = lastCount.value[name]
  lastCount.value[name] = now
  testResult.value[name] =
    before === undefined
      ? `Applied on ${row.bridge}; ${now} connection(s) translated so far. Connect from a client in ${(row.clients ?? []).join(', ')}, then Test again.`
      : now > before
        ? `Working: ${now - before} new connection(s) from the client ranges were translated.`
        : 'No new connections from the client ranges since the last test (counters refresh about once a minute).'
}
</script>

<template>
  <div class="card">
    <div class="card-header flex items-center justify-between">
      <span>Off-subnet client NAT <span class="font-normal text-fg-muted">— let clients from other subnets (a VPN) reach a guest that only trusts its LAN</span></span>
      <span v-if="status" class="text-xs" :class="stateClass(status.state)">{{ status.state }}<span v-if="status.updated" class="text-fg-subtle"> · {{ age(status.updated) }} ago on {{ status.node }}</span></span>
    </div>
    <div class="space-y-3 p-3">
      <p v-if="!bridged.length" class="text-fg-subtle">This VM has no bridged interface on a Multus network; off-subnet client NAT only applies to those.</p>
      <template v-else>
        <p class="text-fg-muted">
          Inside this VM's launcher pod, traffic from the client ranges to the guest is rewritten to come from <em>Translate to</em> — usually the LAN gateway — so the guest answers it; replies are kept on the bridge. The node agent re-applies it on every start and migration. The guest then sees every such client as that one address.
        </p>
        <div v-for="row in rows" :key="row.interface" class="rounded-md border border-line p-3">
          <div class="flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-2 font-medium"><input v-model="row.on" type="checkbox" class="accent-[var(--accent)]" :disabled="!mayEdit" @change="dirty = true" /> {{ row.interface }}</label>
            <label v-if="row.on" class="flex items-center gap-2 text-fg-muted"><input v-model="row.enabled" type="checkbox" class="accent-[var(--accent)]" :disabled="!mayEdit" @change="dirty = true" /> enabled</label>
            <span v-if="statusFor(row.interface)" class="text-xs" :class="stateClass(statusFor(row.interface)!.state)">
              {{ statusFor(row.interface)!.state }}{{ statusFor(row.interface)!.message ? `: ${statusFor(row.interface)!.message}` : '' }}
            </span>
          </div>
          <div v-if="row.on" class="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-[140px_minmax(0,1fr)]">
            <label class="pt-1.5 text-fg-muted">Client ranges</label>
            <div class="flex gap-2">
              <input v-model="row.ranges" class="input mono" placeholder="10.1.0.0/24, 10.2.0.0/24" spellcheck="false" :disabled="!mayEdit" @input="dirty = true" />
              <select v-if="presets.length" class="input w-32" :disabled="!mayEdit" @change="usePreset(row, $event)">
                <option value="">Presets…</option>
                <option v-for="p in presets" :key="p.name" :value="p.name">{{ p.name }}</option>
              </select>
              <button type="button" class="btn" :disabled="!splitRanges(row.ranges).length" title="Save these ranges as a preset in this browser" @click="savePreset(row)">Save preset</button>
            </div>
            <label class="pt-1.5 text-fg-muted">Guest address</label>
            <input v-model="row.guestIP" class="input mono" :placeholder="detectedIp(row.interface) ? `auto (${detectedIp(row.interface)}, from the guest agent)` : 'auto (from the guest agent)'" spellcheck="false" :disabled="!mayEdit" @input="dirty = true" />
            <label class="pt-1.5 text-fg-muted">Translate to</label>
            <input v-model="row.snatTo" class="input mono" placeholder="the LAN gateway, e.g. 10.0.0.1" spellcheck="false" :disabled="!mayEdit" @input="dirty = true" />
            <label class="pt-1.5 text-fg-muted">Gateway MAC</label>
            <input v-model="row.gatewayMAC" class="input mono" :placeholder="statusFor(row.interface)?.gatewayMAC ? `auto (${statusFor(row.interface)!.gatewayMAC}, from the node's ARP table)` : 'auto (from the node\'s ARP table)'" spellcheck="false" :disabled="!mayEdit" @input="dirty = true" />
          </div>
          <div v-if="row.on && statusFor(row.interface)?.state === 'Applied'" class="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
            <span>bridge <span class="mono">{{ statusFor(row.interface)!.bridge }}</span></span>
            <span>{{ statusFor(row.interface)!.packets ?? 0 }} connection(s) translated</span>
            <button type="button" class="btn btn-sm" @click="test(row.interface)"><Fa :icon="faVial" /> Test</button>
            <span v-if="testResult[row.interface]">{{ testResult[row.interface] }}</span>
          </div>
        </div>
        <Notice v-if="errors.length" kind="warning"><div v-for="e in errors" :key="e">{{ e }}</div></Notice>
        <Notice v-if="unmanagedInterfaces.length" kind="warning">The setting names {{ unmanagedInterfaces.join(', ') }}, which this VM has no bridged Multus interface for; saving drops it.</Notice>
        <Notice v-if="waitingForAgent" kind="info">Waiting for the node agent. If nothing appears within a minute, it may not be installed — see <span class="mono">netagent</span> in the chart, or <span class="mono">deploy/netagent.yaml</span>.</Notice>
        <div v-if="mayEdit" class="flex justify-end gap-2">
          <button type="button" class="btn" :disabled="!dirty || busy" @click="reset"><Fa :icon="faRotate" /> Revert</button>
          <button v-if="saved.length && !rows.some((r) => r.on)" type="button" class="btn btn-danger" :disabled="busy" @click="save"><Fa :icon="faTrash" /> Remove</button>
          <button v-else type="button" class="btn btn-primary" :disabled="!dirty || busy || !!errors.length" @click="save"><Fa :icon="faFloppyDisk" /> Save</button>
        </div>
      </template>
    </div>
  </div>
</template>
