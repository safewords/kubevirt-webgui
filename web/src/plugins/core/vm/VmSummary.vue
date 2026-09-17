<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { faMicrochip, faMemory, faNetworkWired, faDisplay, faCircleInfo, faTerminal, faRotate } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { MetricSample } from '@/api/types'
import { gateway, type Subscription } from '@/api/gateway'
import { vmApi } from '@/api/k8s'
import Gauge from '@/components/ui/Gauge.vue'
import TimeChart from '@/components/ui/TimeChart.vue'
import StateBadge from '@/components/ui/StateBadge.vue'
import Notice from '@/components/ui/Notice.vue'
import { addresses, condition, instancetypeName, isTrue, memoryBytes, osName, preferenceName, runStrategy, templateSpec, vcpus, vmState, tags, NOTES_ANNOTATION } from '@/util/kubevirt'
import { age, bytes, cores, dateTime } from '@/util/format'
import { routeTo } from '@/util/nav'

const props = defineProps<{ ctx: ObjectContext }>()
const router = useRouter()

const vm = computed(() => props.ctx.object)
const vmi = computed(() => props.ctx.related.vmi)
const state = computed(() => vmState(vm.value, vmi.value))
const spec = computed(() => (vmi.value ? vmi.value.spec : templateSpec(vm.value)))
const cpuCount = computed(() => vcpus(spec.value))
const memory = computed(() => memoryBytes(spec.value) || Number(vmi.value?.status?.memory?.guestCurrent ? 0 : 0))
const ips = computed(() => addresses(vmi.value))

const samples = ref<MetricSample[]>([])
let sub: Subscription | null = null

function subscribe() {
  sub?.close()
  samples.value = []
  if (!vmi.value) return
  sub = gateway.subscribe('metrics.vmi', { namespace: props.ctx.namespace, name: props.ctx.name }, (event) => {
    if (event.type === 'history') samples.value = event.samples
    else if (event.type === 'sample') {
      const last = samples.value[samples.value.length - 1]
      if (!last || last.ts !== event.sample.ts) samples.value = [...samples.value.slice(-719), event.sample]
    }
  })
}
watch(() => vmi.value?.metadata.uid, subscribe, { immediate: true })
onBeforeUnmount(() => sub?.close())

const latest = computed(() => samples.value[samples.value.length - 1] ?? null)
const cpuSeries = computed(() => [{ label: 'CPU usage', color: 'var(--chart-1)', points: samples.value.map((s) => ({ ts: s.ts, value: s.cpu })) }])
const memSeries = computed(() => [{ label: 'Host memory (QEMU)', color: 'var(--chart-2)', points: samples.value.map((s) => ({ ts: s.ts, value: s.memory })) }])

const screenshot = ref<string | null>(null)
const screenshotError = ref<string | null>(null)
let shotTimer: ReturnType<typeof setInterval> | null = null
async function refreshShot() {
  if (state.value !== 'running' && state.value !== 'paused') {
    screenshot.value = null
    return
  }
  try {
    screenshot.value = (await vmApi.screenshot(props.ctx.namespace!, props.ctx.name)).dataUrl
    screenshotError.value = null
  } catch (e: any) {
    screenshotError.value = e?.message ?? String(e)
  }
}
watch(state, refreshShot, { immediate: true })
shotTimer = setInterval(refreshShot, 15000)
onBeforeUnmount(() => shotTimer && clearInterval(shotTimer))

const notes = computed(() => vm.value?.metadata.annotations?.[NOTES_ANNOTATION] ?? '')
const agent = computed(() => condition(vmi.value, 'AgentConnected'))
const volumes = computed(() => spec.value?.volumes ?? [])
const nics = computed(() => spec.value?.domain?.devices?.interfaces ?? [])
</script>

<template>
  <div class="grid gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div class="card">
      <div class="card-header"><Fa :icon="faCircleInfo" class="text-fg-muted" /> {{ ctx.name }}</div>
      <div class="grid gap-4 p-3 sm:grid-cols-[1fr_220px]">
        <dl class="kv">
          <dt>Status</dt>
          <dd><StateBadge :state="state" :label="vm?.status?.printableStatus ?? vmi?.status?.phase" /></dd>
          <dt>Node</dt>
          <dd>
            <RouterLink v-if="vmi?.status?.nodeName" class="text-accent hover:underline" :to="routeTo({ kind: 'node', name: vmi.status.nodeName })">{{ vmi.status.nodeName }}</RouterLink>
            <span v-else class="text-fg-subtle">—</span>
          </dd>
          <dt>Uptime</dt>
          <dd>{{ vmi && state === 'running' ? age(condition(vmi, 'Ready')?.lastTransitionTime ?? vmi.metadata.creationTimestamp) : '—' }}</dd>
          <dt>Operating system</dt>
          <dd>{{ osName(vm, vmi) ?? '—' }}</dd>
          <dt>Guest agent</dt>
          <dd :class="agent?.status === 'True' ? 'text-ok' : 'text-fg-subtle'">{{ agent?.status === 'True' ? 'connected' : vmi ? 'not connected' : '—' }}</dd>
          <dt>IP addresses</dt>
          <dd>
            <span v-if="!ips.length" class="text-fg-subtle">—</span>
            <span v-for="ip in ips" :key="ip" class="mono mr-2">{{ ip }}</span>
          </dd>
          <dt>Run strategy</dt>
          <dd>{{ runStrategy(vm) }}</dd>
          <dt>Instance type</dt>
          <dd>{{ instancetypeName(vm) ?? 'custom' }}{{ preferenceName(vm) ? ` · preference ${preferenceName(vm)}` : '' }}</dd>
          <dt>Live migratable</dt>
          <dd>
            <span v-if="!vmi" class="text-fg-subtle">—</span>
            <span v-else-if="isTrue(vmi, 'LiveMigratable')" class="text-ok">yes</span>
            <span v-else class="text-warn" :title="condition(vmi, 'LiveMigratable')?.message">no — {{ condition(vmi, 'LiveMigratable')?.reason }}</span>
          </dd>
          <dt>Created</dt>
          <dd>{{ dateTime(vm?.metadata.creationTimestamp ?? vmi?.metadata.creationTimestamp) }}</dd>
          <dt>Tags</dt>
          <dd>
            <span v-if="!tags(vm).length" class="text-fg-subtle">none</span>
            <span v-for="t in tags(vm)" :key="t" class="chip mr-1 bg-accent-soft text-accent">{{ t }}</span>
          </dd>
        </dl>
        <div class="flex flex-col gap-2">
          <button
            class="group relative aspect-[4/3] overflow-hidden rounded-md border border-line bg-[#121417]"
            :disabled="!screenshot"
            title="Open the console"
            @click="router.push(routeTo({ kind: 'vm', name: ctx.name, namespace: ctx.namespace }, 'console'))"
          >
            <img v-if="screenshot" :src="screenshot" class="size-full object-contain" alt="Console screenshot" />
            <div v-else class="flex size-full flex-col items-center justify-center gap-1 text-fg-subtle">
              <Fa :icon="faDisplay" class="text-2xl" />
              <span class="text-xs">{{ state === 'running' ? 'No display' : 'Not running' }}</span>
            </div>
            <span v-if="screenshot" class="absolute inset-x-0 bottom-0 bg-black/60 py-1 text-xs text-white opacity-0 transition group-hover:opacity-100"><Fa :icon="faTerminal" /> Open console</span>
          </button>
          <button v-if="screenshot" class="btn btn-sm btn-ghost self-end" @click="refreshShot"><Fa :icon="faRotate" /> Refresh</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><Fa :icon="faMicrochip" class="text-fg-muted" /> Resources</div>
      <div class="space-y-4 p-3">
        <Gauge
          label="CPU usage"
          :value="latest && cpuCount ? latest.cpu / cpuCount : null"
          :detail="latest ? `${cores(latest.cpu)} of ${cpuCount} vCPU` : `${cpuCount} vCPU`"
        />
        <Gauge
          label="Memory (host, incl. overhead)"
          :value="latest && memory ? latest.memory / memory : null"
          :detail="latest ? `${bytes(latest.memory)} of ${bytes(memory)}` : bytes(memory)"
        />
        <dl class="kv">
          <dt><Fa :icon="faMicrochip" class="mr-1" /> Processors</dt>
          <dd>
            {{ cpuCount }} vCPU
            <span class="text-fg-muted">
              ({{ spec?.domain?.cpu?.sockets ?? 1 }} sockets, {{ spec?.domain?.cpu?.cores ?? 1 }} cores, {{ spec?.domain?.cpu?.threads ?? 1 }} threads{{ spec?.domain?.cpu?.model ? `, ${spec.domain.cpu.model}` : '' }})
            </span>
          </dd>
          <dt><Fa :icon="faMemory" class="mr-1" /> Memory</dt>
          <dd>{{ bytes(memory) }}</dd>
          <dt>Disks</dt>
          <dd>{{ volumes.length }}</dd>
          <dt><Fa :icon="faNetworkWired" class="mr-1" /> Network</dt>
          <dd>{{ nics.length }} interface{{ nics.length === 1 ? '' : 's' }}</dd>
        </dl>
      </div>
    </div>

    <TimeChart title="CPU usage" :series="cpuSeries" :format="(v) => cores(v)" :max="cpuCount" />
    <TimeChart title="Memory usage" :series="memSeries" :format="(v) => bytes(v, 0)" :max="memory * 1.15" />

    <div v-if="notes" class="card xl:col-span-2">
      <div class="card-header">Notes</div>
      <div class="p-3 whitespace-pre-wrap">{{ notes }}</div>
    </div>
    <Notice v-if="vm?.status?.stateChangeRequests?.length" kind="info" class="xl:col-span-2">A state change is pending: {{ vm.status.stateChangeRequests.map((r: any) => r.action).join(', ') }}</Notice>
  </div>
</template>
