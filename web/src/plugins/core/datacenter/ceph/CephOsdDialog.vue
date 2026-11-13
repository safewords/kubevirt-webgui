<script setup lang="ts">
/** One OSD: its disk and how healthy it is, where its data sits, and what can be done to it. */
import { computed, onMounted, ref } from 'vue'
import { faHardDrive, faArrowRightFromBracket, faArrowRightToBracket, faArrowDown, faMagnifyingGlass, faScaleBalanced, faFlag } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import TimeChart from '@/components/ui/TimeChart.vue'
import { gateway, errorMessage } from '@/api/gateway'
import { confirm, run } from '@/services/dialogs'
import { bytes } from '@/util/format'
import { ceph, refreshCeph, latencyPoints, rate, ops, ms, SLOW_MS, historyWindowMs } from './useCeph'

const props = defineProps<{ id: number }>()
const emit = defineEmits<{ close: [result?: boolean] }>()

const osd = computed(() => ceph.osds?.osds?.find((o) => o.id === props.id))
const prom = computed(() => ceph.status?.osds?.find((o) => Number(o.id) === props.id))
const manage = computed(() => !!ceph.osds?.manage)
const fill = computed(() => (osd.value?.totalBytes ? osd.value.usedBytes / osd.value.totalBytes : null))

const detail = ref<any>(null)
const detailError = ref<string | null>(null)
onMounted(async () => {
  try {
    detail.value = await gateway.call('ceph.osd.detail', { id: props.id })
  } catch (e) {
    detailError.value = errorMessage(e)
  }
})
const smart = computed(() => Object.entries((detail.value?.smart ?? {}) as Record<string, any>))
const md = computed(() => detail.value?.metadata ?? {})

const latencySeries = computed(() => [{ label: `osd.${props.id} commit latency`, color: 'var(--chart-2)', points: latencyPoints(ceph.status?.history, props.id) }])

async function act(action: string, title: string, message: string, extra: Record<string, unknown> = {}, danger = false) {
  const ok = await confirm({ title, message, confirmText: title, danger })
  if (!ok) return
  await run(title, () => gateway.call('ceph.osd.action', { id: props.id, action, ...extra }), { openLog: true })
  setTimeout(refreshCeph, 1500)
}

function markOut() {
  const moving = osd.value?.usedBytes ? bytes(osd.value.usedBytes) : 'its data'
  act('out', `Mark osd.${props.id} out`, `Ceph stops placing data on osd.${props.id} and copies what it holds (${moving}) to other OSDs. Use this when the disk or its machine will not come back soon. Copying takes a while and adds load; the OSD can be marked in again later.`, {}, true)
}
function markIn() {
  act('in', `Mark osd.${props.id} in`, `Ceph places data on osd.${props.id} again and moves a share back onto it.`)
}
function markDown() {
  act('down', `Mark osd.${props.id} down`, `Tells the cluster osd.${props.id} is down. A running OSD notices and marks itself up again within seconds — this is for nudging a stuck one, not for stopping it.`)
}
function scrub(deep: boolean) {
  act(deep ? 'deep-scrub' : 'scrub', `${deep ? 'Deep-scrub' : 'Scrub'} osd.${props.id}`, deep ? 'Reads and checksums every object on this OSD against its copies. Thorough, and heavy on the disk for a while.' : 'Compares object metadata with the copies on other OSDs. Light.')
}
const weight = ref<number>(1)
function reweight() {
  const w = Math.min(1, Math.max(0, Number(weight.value)))
  act('reweight', `Reweight osd.${props.id} to ${w}`, `Ceph moves about ${((1 - w) * 100).toFixed(0)}% of this OSD's share elsewhere${w < (osd.value?.reweight ?? 1) ? '' : ' — or back onto it'}. A lower weight relieves an over-full or slow disk without taking it out.`, { weight: w })
}
async function toggleNoout() {
  const enable = !osd.value?.flags.includes('noout')
  const ok = await confirm({
    title: `${enable ? 'Set' : 'Clear'} noout on osd.${props.id}`,
    message: enable ? `If osd.${props.id} goes down, Ceph keeps it "in" and does not copy its data elsewhere. For maintenance on this one disk.` : `Ceph reacts normally if osd.${props.id} goes down.`,
    confirmText: enable ? 'Set noout' : 'Clear noout',
  })
  if (!ok) return
  await run(`noout on osd.${props.id}`, () => gateway.call('ceph.flag', { flag: 'noout', enabled: enable, osds: [props.id] }), { quiet: true })
  setTimeout(refreshCeph, 1500)
}
onMounted(() => {
  weight.value = osd.value?.reweight ?? 1
})
</script>

<template>
  <Modal :title="`osd.${id}${osd ? ` on ${osd.host}` : ''}`" :icon="faHardDrive" width="760px" @close="emit('close')">
    <div class="space-y-4">
      <!-- State -->
      <div class="grid gap-3 sm:grid-cols-4">
        <div class="card p-2.5">
          <div class="text-xs text-fg-muted">State</div>
          <div class="font-semibold" :class="osd?.up && osd?.in ? 'text-ok' : osd?.up ? 'text-warn' : 'text-bad'">{{ osd ? `${osd.up ? 'up' : 'down'} · ${osd.in ? 'in' : 'out'}` : '—' }}</div>
          <div v-if="osd?.flags.length" class="text-xs text-warn">{{ osd.flags.join(', ') }}</div>
        </div>
        <div class="card p-2.5">
          <div class="text-xs text-fg-muted">Fill</div>
          <div class="font-semibold">{{ fill === null ? '—' : `${(fill * 100).toFixed(1)}%` }}</div>
          <div class="text-xs text-fg-subtle">{{ osd ? `${bytes(osd.usedBytes)} of ${bytes(osd.totalBytes)}` : '' }}</div>
        </div>
        <div class="card p-2.5">
          <div class="text-xs text-fg-muted">Commit latency</div>
          <div class="font-semibold" :class="(prom?.commitLatencyMs ?? 0) >= SLOW_MS ? 'text-warn' : ''">{{ prom?.commitLatencyMs ?? '—' }} ms</div>
          <div class="text-xs text-fg-subtle">apply {{ prom?.applyLatencyMs ?? '—' }} ms</div>
        </div>
        <div class="card p-2.5">
          <div class="text-xs text-fg-muted">I/O now</div>
          <div class="font-semibold">{{ osd ? `${ops(osd.readOps + osd.writeOps)} op/s` : '—' }}</div>
          <div class="text-xs text-fg-subtle">{{ osd ? `r ${rate(osd.readBytes)} · w ${rate(osd.writeBytes)}` : '' }}</div>
        </div>
      </div>

      <Notice v-if="(prom?.commitLatencyMs ?? 0) >= SLOW_MS" kind="warning">
        This disk takes {{ prom?.commitLatencyMs }} ms to commit a write — the others take a few. It holds {{ osd?.pgs ?? '?' }} placement groups.
        A disk that is simply too slow for its share can be <strong>reweighted</strong> down to carry less; a failing one (see SMART below) should be replaced.
      </Notice>

      <TimeChart v-if="latencySeries[0].points.length > 1" title="Commit latency" :series="latencySeries" :format="ms" :window-ms="historyWindowMs(ceph.status?.history)" :height="110" />

      <!-- Disk -->
      <section>
        <h4 class="mb-1.5 font-medium">Disk</h4>
        <Notice v-if="detailError" kind="warning">{{ detailError }}</Notice>
        <p v-else-if="!detail" class="text-fg-subtle">Loading…</p>
        <template v-else>
          <div v-for="[dev, d] in smart" :key="dev" class="card mb-2 p-3">
            <div class="flex flex-wrap items-baseline gap-x-3">
              <span class="font-medium">{{ d.model ?? dev }}</span>
              <span class="mono text-xs text-fg-subtle">serial {{ d.serial ?? '—' }} · firmware {{ d.firmware ?? '—' }}</span>
              <span class="ml-auto font-medium" :class="d.passed === false ? 'text-bad' : d.passed ? 'text-ok' : 'text-fg-subtle'">SMART {{ d.passed === false ? 'FAILED' : d.passed ? 'passed' : 'unknown' }}</span>
            </div>
            <dl class="kv mt-2 grid-cols-2 sm:grid-cols-4">
              <dt>Type</dt><dd>{{ d.rotationRate ? `HDD, ${d.rotationRate} rpm` : 'SSD' }}</dd>
              <dt>Temperature</dt><dd :class="(d.temperatureC ?? 0) > 60 ? 'text-warn' : ''">{{ d.temperatureC != null ? `${d.temperatureC} °C` : '—' }}</dd>
              <dt>Powered on</dt><dd>{{ d.powerOnHours != null ? `${d.powerOnHours.toLocaleString()} h (${(d.powerOnHours / 8766).toFixed(1)} y)` : '—' }}</dd>
              <dt>Wear</dt><dd :class="(d.percentageUsed ?? 0) > 80 ? 'text-warn' : ''">{{ d.percentageUsed != null ? `${d.percentageUsed}% used` : '—' }}</dd>
              <dt>Reallocated</dt><dd :class="(d.reallocatedSectors ?? 0) > 0 ? 'text-warn' : ''">{{ d.reallocatedSectors ?? '—' }}</dd>
              <dt>Pending</dt><dd :class="(d.pendingSectors ?? 0) > 0 ? 'text-bad' : ''">{{ d.pendingSectors ?? '—' }}</dd>
              <dt>Uncorrectable</dt><dd :class="(d.uncorrectable ?? 0) > 0 ? 'text-bad' : ''">{{ d.uncorrectable ?? '—' }}</dd>
              <dt>Media errors</dt><dd :class="(d.mediaErrors ?? 0) > 0 ? 'text-bad' : ''">{{ d.mediaErrors ?? '—' }}</dd>
            </dl>
            <p v-if="d.error" class="mt-1 text-xs text-warn">{{ d.error }}</p>
          </div>
          <p v-if="!smart.length" class="text-sm text-fg-subtle">No SMART data — Ceph's devicehealth module has not scraped this disk.</p>
          <dl class="kv grid-cols-2 sm:grid-cols-4">
            <dt>Device</dt><dd class="mono">{{ md.devices ?? '—' }}</dd>
            <dt>Class</dt><dd>{{ md.deviceClass ?? osd?.deviceClass ?? '—' }}</dd>
            <dt>Store</dt><dd>{{ md.objectstore ?? '—' }}{{ md.dbDevice ? `, DB on ${md.dbDevice}` : '' }}</dd>
            <dt>Ceph</dt><dd>{{ md.version ?? '—' }}</dd>
            <dt>Kernel</dt><dd class="text-xs">{{ md.kernel ?? '—' }}</dd>
            <dt>OS</dt><dd class="text-xs">{{ md.distro ?? '—' }}</dd>
            <dt>Host memory</dt><dd>{{ md.memoryBytes ? bytes(md.memoryBytes) : '—' }}</dd>
          </dl>
        </template>
      </section>

      <!-- Placement -->
      <section>
        <h4 class="mb-1.5 font-medium">Placement</h4>
        <dl class="kv grid-cols-2 sm:grid-cols-4">
          <dt>Placement groups</dt><dd>{{ osd?.pgs ?? '—' }}</dd>
          <dt>CRUSH weight</dt><dd :title="'Its share by size, in TiB'">{{ osd?.crushWeight?.toFixed(3) ?? '—' }}</dd>
          <dt>Reweight</dt><dd :class="(osd?.reweight ?? 1) < 1 ? 'text-warn' : ''">{{ osd?.reweight ?? '—' }}</dd>
          <dt>Primary affinity</dt><dd>{{ osd?.primaryAffinity ?? '—' }}</dd>
        </dl>
      </section>

      <!-- Actions -->
      <section v-if="osd">
        <h4 class="mb-1.5 font-medium">Actions</h4>
        <p v-if="!manage" class="text-sm text-fg-subtle">Managing OSDs needs permission to update nodes in Kubernetes.</p>
        <div v-else class="space-y-2">
          <div class="flex flex-wrap gap-2">
            <button v-if="osd.in" class="btn" @click="markOut"><Fa :icon="faArrowRightFromBracket" /> Mark out</button>
            <button v-else class="btn" @click="markIn"><Fa :icon="faArrowRightToBracket" /> Mark in</button>
            <button class="btn" :disabled="!osd.up" @click="markDown"><Fa :icon="faArrowDown" /> Mark down</button>
            <button class="btn" :disabled="!osd.up" @click="scrub(false)"><Fa :icon="faMagnifyingGlass" /> Scrub</button>
            <button class="btn" :disabled="!osd.up" @click="scrub(true)"><Fa :icon="faMagnifyingGlass" /> Deep scrub</button>
            <button class="btn" @click="toggleNoout"><Fa :icon="faFlag" /> {{ osd.flags.includes('noout') ? 'Clear noout' : 'Set noout' }}</button>
          </div>
          <div class="flex items-center gap-2">
            <Fa :icon="faScaleBalanced" class="text-fg-muted" />
            <label class="text-sm">Reweight</label>
            <input v-model.number="weight" type="range" min="0" max="1" step="0.05" class="w-40 accent-[var(--accent)]" />
            <input v-model.number="weight" type="number" min="0" max="1" step="0.05" class="input w-20" />
            <button class="btn btn-sm" :disabled="weight === osd.reweight" @click="reweight">Apply</button>
          </div>
          <p class="text-xs text-fg-subtle">Every action asks first and runs as a task you can follow in the task log. Creating or removing OSDs needs a Ceph orchestrator (cephadm), which this cluster does not run.</p>
        </div>
      </section>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Close</button>
    </template>
  </Modal>
</template>
