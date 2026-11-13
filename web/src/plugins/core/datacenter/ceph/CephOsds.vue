<script setup lang="ts">
/**
 * OSDs by machine: every disk Ceph stores data on, where it is, how full,
 * how busy, how fast — and the cluster flags that change how Ceph reacts
 * while machines are down.
 */
import { computed } from 'vue'
import { faServer, faCircleCheck, faCircleXmark, faCircleMinus, faFlag, faPowerOff } from '@fortawesome/free-solid-svg-icons'
import { gateway } from '@/api/gateway'
import { confirm, openDialog, run } from '@/services/dialogs'
import { useInventory } from '@/plugins/core/inventory'
import { nodeReady } from '@/util/kubevirt'
import { bytes } from '@/util/format'
import Notice from '@/components/ui/Notice.vue'
import Sparkline from './Sparkline.vue'
import CephOsdDialog from './CephOsdDialog.vue'
import { ceph, refreshCeph, latencyPoints, FLAGS, SLOW_MS, rate, ops, ms, type CephOsd } from './useCeph'

const inv = useInventory()
const o = computed(() => ceph.osds)
const manage = computed(() => !!o.value?.manage)

/** Latency comes from the prometheus figures; usage and I/O from the dashboard. */
const latency = computed(() => new Map((ceph.status?.osds ?? []).map((x) => [Number(x.id), x])))

// OSDs from the dashboard when it answers, else the prometheus view (no usage, no actions).
const osds = computed<CephOsd[]>(() => {
  if (o.value?.osds?.length) return o.value.osds
  return (ceph.status?.osds ?? []).map((x) => ({
    id: Number(x.id), host: x.host ?? '?', up: x.up, in: x.in, state: [], deviceClass: x.deviceClass ?? '', crushWeight: 0, reweight: 1, primaryAffinity: 1,
    usedBytes: 0, totalBytes: 0, pgs: 0, readOps: 0, writeOps: 0, readBytes: 0, writeBytes: 0, flags: [],
  }))
})

const hosts = computed(() => {
  const services = new Map((o.value?.hosts ?? []).map((h) => [h.name, h.services ?? []]))
  const names = [...new Set([...osds.value.map((x) => x.host), ...services.keys()])].sort()
  return names.map((name) => {
    const list = osds.value.filter((x) => x.host === name).sort((a, b) => a.id - b.id)
    const node = inv.nodes.find((n) => n.metadata.name === name)
    const total = list.reduce((n, x) => n + (x.totalBytes || 0), 0)
    const used = list.reduce((n, x) => n + (x.usedBytes || 0), 0)
    const daemons = (services.get(name) ?? []).filter((s) => !s.startsWith('osd.')).map((s) => s.split('.')[0])
    return {
      name,
      osds: list,
      total,
      used,
      daemons: [...new Set(daemons)].sort(),
      node: node ? (nodeReady(node) ? 'Ready' : 'NotReady') : null,
      down: list.length > 0 && list.every((x) => !x.up),
    }
  })
})

/** Mean fill across OSDs with a size, to show imbalance. */
const meanFill = computed(() => {
  const sized = osds.value.filter((x) => x.totalBytes)
  const t = sized.reduce((n, x) => n + x.totalBytes, 0)
  return t ? sized.reduce((n, x) => n + x.usedBytes, 0) / t : null
})
const fill = (x: CephOsd) => (x.totalBytes ? x.usedBytes / x.totalBytes : null)

const flagsSet = computed(() => new Set(o.value?.flags ?? ceph.status?.flags ?? []))

async function toggleFlag(name: string, label: string, meaning: string) {
  const enable = !flagsSet.value.has(name)
  const ok = await confirm({
    title: `${enable ? 'Set' : 'Clear'} ${name}`,
    message: `${label}. ${meaning}${enable ? '' : '\n\nClearing it lets Ceph act normally again.'}`,
    confirmText: enable ? 'Set flag' : 'Clear flag',
    danger: enable && ['norecover', 'nodown', 'noup'].includes(name),
  })
  if (!ok) return
  await run(`${enable ? 'Set' : 'Clear'} ${name}`, () => gateway.call('ceph.flag', { flag: name, enabled: enable }), { quiet: true })
  setTimeout(refreshCeph, 1500)
}

async function maintenance(host: string, list: CephOsd[]) {
  const ids = list.map((x) => x.id)
  const enable = !list.every((x) => x.flags.includes('noout'))
  const ok = await confirm({
    title: enable ? `Prepare ${host} for maintenance` : `End maintenance on ${host}`,
    message: enable
      ? `Sets noout on ${ids.map((i) => `osd.${i}`).join(', ')}: while ${host} is down for a reboot or repair, Ceph will not mark its OSDs out or start copying their data elsewhere. Data stays available from the other copies. Remember to end maintenance afterwards.`
      : `Clears noout on ${ids.map((i) => `osd.${i}`).join(', ')}, so Ceph reacts normally if ${host}'s OSDs go down again.`,
    confirmText: enable ? 'Set noout' : 'Clear noout',
  })
  if (!ok) return
  await run(enable ? `Maintenance on ${host}` : `End maintenance on ${host}`, () => gateway.call('ceph.flag', { flag: 'noout', enabled: enable, osds: ids }), { quiet: true })
  setTimeout(refreshCeph, 1500)
}

function open(x: CephOsd) {
  openDialog(CephOsdDialog, { id: x.id })
}
</script>

<template>
  <div class="space-y-4">
    <Notice v-if="!o?.available" kind="info" title="Read-only view">
      OSD usage, devices and management come from the Ceph dashboard API, which is not reachable:
      <span class="mono">{{ o?.reason ?? 'not configured' }}</span>. Health and latency still show from the prometheus figures.
    </Notice>
    <Notice v-else-if="!manage" kind="info">You can see the OSDs but not change them: managing Ceph needs permission to update nodes in Kubernetes.</Notice>

    <!-- Machines -->
    <section class="grid gap-3 2xl:grid-cols-2">
      <div v-for="h in hosts" :key="h.name" class="card" :class="h.down ? 'border-bad' : ''">
        <div class="card-header flex flex-wrap items-center gap-2">
          <Fa :icon="faServer" class="text-fg-muted" />
          <span class="whitespace-nowrap font-medium">{{ h.name }}</span>
          <span v-if="h.node" class="chip text-xs" :class="h.node === 'Ready' ? 'text-ok' : 'text-bad'">node {{ h.node }}</span>
          <span v-for="d in h.daemons" :key="d" class="chip mono text-xs" :title="`runs a Ceph ${d}`">{{ d }}</span>
          <span class="ml-auto whitespace-nowrap text-xs text-fg-muted">{{ h.total ? `${bytes(h.used)} of ${bytes(h.total)} · ${h.osds.length} OSD${h.osds.length > 1 ? 's' : ''}` : '' }}</span>
          <button
            v-if="manage && h.osds.length"
            class="btn btn-ghost btn-sm"
            :title="h.osds.every((x) => x.flags.includes('noout')) ? 'End maintenance (clear noout on its OSDs)' : 'Prepare for maintenance (noout on its OSDs)'"
            @click="maintenance(h.name, h.osds)"
          >
            <Fa :icon="faPowerOff" /> {{ h.osds.every((x) => x.flags.includes('noout')) ? 'End maintenance' : 'Maintenance' }}
          </button>
        </div>
        <p v-if="h.down" class="px-3 pt-2 text-sm text-bad">Every OSD on this machine is down — usually the machine is off. Its data is served from copies elsewhere.</p>
        <p v-if="!h.osds.length" class="p-3 text-sm text-fg-subtle">No OSDs — runs {{ h.daemons.join(', ') || 'nothing Ceph knows of' }}.</p>
        <table v-else class="w-full text-sm">
          <thead class="text-left text-xs text-fg-subtle">
            <tr>
              <th class="px-3 py-1.5 font-normal">OSD</th>
              <th class="py-1.5 font-normal">State</th>
              <th class="py-1.5 font-normal">Fill</th>
              <th class="py-1.5 text-right font-normal">PGs</th>
              <th class="py-1.5 pl-3 font-normal">Latency</th>
              <th class="py-1.5 pr-3 text-right font-normal">I/O</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="x in h.osds" :key="x.id" class="cursor-pointer border-t border-line hover:bg-surface-2" @click="open(x)">
              <td class="px-3 py-1.5 whitespace-nowrap">
                <span class="mono font-medium">osd.{{ x.id }}</span>
                <span class="chip ml-1.5 text-xs" :style="{ color: x.deviceClass === 'hdd' ? 'var(--chart-1)' : 'var(--chart-2)' }">{{ x.deviceClass || '?' }}</span>
                <span v-for="f in x.flags" :key="f" class="chip ml-1 text-xs text-warn" :title="`${f} is set on this OSD`"><Fa :icon="faFlag" /> {{ f }}</span>
              </td>
              <td class="py-1.5 pr-3 whitespace-nowrap">
                <Fa :icon="x.up && x.in ? faCircleCheck : x.up ? faCircleMinus : faCircleXmark" :class="x.up && x.in ? 'text-ok' : x.up ? 'text-warn' : 'text-bad'" />
                {{ x.up ? 'up' : 'down' }} · {{ x.in ? 'in' : 'out' }}
              </td>
              <td class="py-1.5 pr-3">
                <div v-if="fill(x) !== null" class="flex items-center gap-2 whitespace-nowrap">
                  <div class="relative h-1.5 w-28 shrink-0 rounded bg-surface-2" :title="`${bytes(x.usedBytes)} of ${bytes(x.totalBytes)}`">
                    <div class="h-full rounded" :class="fill(x)! > 0.85 ? 'bg-bad' : fill(x)! > 0.7 ? 'bg-warn' : 'bg-accent'" :style="{ width: `${fill(x)! * 100}%` }" />
                    <div v-if="meanFill !== null" class="absolute -top-0.5 h-2.5 w-px bg-fg-muted" :style="{ left: `${meanFill * 100}%` }" title="cluster average" />
                  </div>
                  <span class="text-xs text-fg-muted">{{ (fill(x)! * 100).toFixed(0) }}% of {{ bytes(x.totalBytes) }}</span>
                </div>
                <span v-else class="text-fg-subtle">—</span>
              </td>
              <td class="py-1.5 text-right">{{ x.pgs || '—' }}</td>
              <td class="py-1.5 pl-3 whitespace-nowrap">
                <template v-if="x.up">
                  <Sparkline :points="latencyPoints(ceph.status?.history, x.id)" :format="ms" :warn-above="SLOW_MS" :width="70" :height="20" :label="`osd.${x.id} latency`" />
                  <span class="ml-1.5" :class="(latency.get(x.id)?.commitLatencyMs ?? 0) >= SLOW_MS ? 'font-medium text-warn' : ''">{{ latency.get(x.id)?.commitLatencyMs ?? '—' }} ms</span>
                </template>
                <span v-else class="text-fg-subtle">—</span>
              </td>
              <td class="py-1.5 pr-3 text-right text-xs whitespace-nowrap text-fg-muted">
                <template v-if="x.up && (x.readOps || x.writeOps)">{{ ops(x.readOps + x.writeOps) }} op/s<br />{{ rate(x.readBytes + x.writeBytes) }}</template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <p class="text-xs text-fg-subtle">
      Click an OSD for its disk, SMART health and actions. The tick on each fill bar is the cluster average; an OSD far above it holds more than its share.
      Latency is how long the disk takes to commit a write; above {{ SLOW_MS }} ms guests will notice.
    </p>

    <!-- Cluster flags -->
    <section class="card">
      <div class="card-header flex items-center gap-2"><Fa :icon="faFlag" class="text-fg-muted" /> Cluster flags</div>
      <p class="px-3 pt-2 text-sm text-fg-muted">These change how Ceph reacts to OSDs going down. Most are for planned maintenance — set them before, clear them after. For one machine, prefer its Maintenance button above.</p>
      <ul class="grid gap-x-6 gap-y-2 p-3 md:grid-cols-2">
        <li v-for="f in FLAGS" :key="f.name" class="flex items-start gap-2.5">
          <button
            class="mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors"
            :class="flagsSet.has(f.name) ? 'border-warn bg-warn' : 'border-line bg-surface-2'"
            :disabled="!manage"
            role="switch"
            :aria-checked="flagsSet.has(f.name)"
            :aria-label="f.label"
            :title="manage ? '' : 'Needs permission to update nodes'"
            @click="toggleFlag(f.name, f.label, f.meaning)"
          >
            <span class="h-4 w-4 rounded-full bg-surface-1 shadow transition-transform" :class="flagsSet.has(f.name) ? 'translate-x-4' : 'translate-x-0.5'" />
          </button>
          <div>
            <div class="font-medium">{{ f.label }} <span class="mono text-xs font-normal text-fg-subtle">{{ f.name }}</span></div>
            <div class="text-xs text-fg-muted">{{ f.meaning }}</div>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
