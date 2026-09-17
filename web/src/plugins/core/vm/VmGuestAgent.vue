<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { faRotate, faCircleInfo, faUsers, faHardDrive, faNetworkWired, faSnowflake } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { errorMessage } from '@/api/gateway'
import { vmApi } from '@/api/k8s'
import { condition } from '@/util/kubevirt'
import { bytes, dateTime } from '@/util/format'
import Notice from '@/components/ui/Notice.vue'
import Gauge from '@/components/ui/Gauge.vue'

const props = defineProps<{ ctx: ObjectContext }>()

const vmi = computed(() => props.ctx.related.vmi)
const running = computed(() => vmi.value?.status?.phase === 'Running')
const connected = computed(() => condition(vmi.value, 'AgentConnected')?.status === 'True')
const unsupported = computed(() => condition(vmi.value, 'UnsupportedAgent'))

const data = ref<{ os: any; users: any; filesystems: any } | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const loadedAt = ref<number | null>(null)

async function refresh() {
  if (!running.value || !connected.value) return
  loading.value = true
  try {
    data.value = await vmApi.guest(props.ctx.namespace!, props.ctx.name)
    loadedAt.value = Date.now()
    error.value = null
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
watch(connected, refresh, { immediate: true })
const timer = setInterval(refresh, 30000)
onBeforeUnmount(() => clearInterval(timer))

const os = computed(() => (data.value?.os?.ok ? data.value.os.data : null))
const users = computed(() => (data.value?.users?.ok ? (data.value.users.data?.items ?? []) : []))
const filesystems = computed(() => (data.value?.filesystems?.ok ? (data.value.filesystems.data?.items ?? []) : []))
const interfaces = computed(() => vmi.value?.status?.interfaces ?? [])

function loginTime(value: number | undefined) {
  // The agent reports seconds, sometimes with a fractional part.
  return value ? dateTime(value * 1000) : '—'
}
</script>

<template>
  <div class="space-y-3 p-3">
    <Notice v-if="!running" kind="info" title="The VM is not running">Guest information is available while the VM runs.</Notice>
    <Notice v-else-if="!connected" kind="warning" title="The guest agent is not connected">
      Install and start <span class="mono">qemu-guest-agent</span> in the guest for its OS details, logged-in users, filesystems and addresses — and for consistent snapshots and soft reboot.
    </Notice>
    <template v-else>
      <div class="flex items-center gap-2">
        <button class="btn" :disabled="loading" @click="refresh"><Fa :icon="faRotate" :spin="loading" /> Refresh</button>
        <span v-if="loadedAt" class="text-xs text-fg-subtle">Updated {{ dateTime(loadedAt) }}</span>
      </div>
      <Notice v-if="unsupported?.status === 'True'" kind="warning">{{ unsupported.message ?? 'This guest agent version is not supported.' }}</Notice>
      <Notice v-if="error" kind="error">{{ error }}</Notice>

      <div class="grid gap-3 xl:grid-cols-2">
        <div class="card">
          <div class="card-header"><Fa :icon="faCircleInfo" class="text-fg-muted" /> Operating system</div>
          <dl v-if="os" class="kv p-3">
            <dt>Name</dt>
            <dd>{{ os.os?.prettyName ?? os.os?.name ?? '—' }}</dd>
            <dt>Version</dt>
            <dd>{{ os.os?.version ?? os.os?.versionId ?? '—' }}</dd>
            <dt>Kernel</dt>
            <dd class="mono">{{ os.os?.kernelRelease ?? '—' }}</dd>
            <dt>Architecture</dt>
            <dd>{{ os.os?.machine ?? '—' }}</dd>
            <dt>Hostname</dt>
            <dd class="mono">{{ os.hostname ?? '—' }}</dd>
            <dt>Timezone</dt>
            <dd>{{ os.timezone ?? '—' }}</dd>
            <dt>Agent version</dt>
            <dd>{{ os.guestAgentVersion ?? '—' }}</dd>
            <dt><Fa :icon="faSnowflake" class="mr-1" /> Filesystems</dt>
            <dd :class="os.fsFreezeStatus === 'frozen' ? 'text-warn' : ''">{{ os.fsFreezeStatus ?? 'thawed' }}</dd>
          </dl>
          <div v-else class="p-3 text-fg-subtle">{{ data?.os?.error ?? (loading ? 'Loading…' : 'No OS information') }}</div>
        </div>

        <div class="card">
          <div class="card-header"><Fa :icon="faUsers" class="text-fg-muted" /> Logged-in users</div>
          <table class="table-dense">
            <thead><tr><th>User</th><th>Domain</th><th>Since</th></tr></thead>
            <tbody>
              <tr v-for="(u, i) in users" :key="i">
                <td>{{ u.userName }}</td>
                <td class="text-fg-muted">{{ u.domain ?? '' }}</td>
                <td>{{ loginTime(u.loginTime) }}</td>
              </tr>
              <tr v-if="!users.length"><td colspan="3" class="h-12 text-center text-fg-subtle">{{ data?.users?.error ?? 'Nobody is logged in' }}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card xl:col-span-2">
          <div class="card-header"><Fa :icon="faHardDrive" class="text-fg-muted" /> Filesystems</div>
          <table class="table-dense">
            <thead><tr><th>Mount point</th><th>Device</th><th>Type</th><th class="w-80">Usage</th></tr></thead>
            <tbody>
              <tr v-for="fs in filesystems" :key="`${fs.diskName}-${fs.mountPoint}`">
                <td class="mono">{{ fs.mountPoint }}</td>
                <td class="mono text-fg-muted">{{ fs.diskName }}{{ fs.disk?.[0]?.serial ? ` (${fs.disk[0].serial})` : '' }}</td>
                <td>{{ fs.fileSystemType }}</td>
                <td class="py-1">
                  <Gauge v-if="fs.totalBytes" label="" :value="fs.usedBytes / fs.totalBytes" :detail="`${bytes(fs.usedBytes)} of ${bytes(fs.totalBytes)}`" />
                  <span v-else class="text-fg-subtle">—</span>
                </td>
              </tr>
              <tr v-if="!filesystems.length"><td colspan="4" class="h-12 text-center text-fg-subtle">{{ data?.filesystems?.error ?? 'No filesystems reported' }}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <div v-if="running" class="card">
      <div class="card-header"><Fa :icon="faNetworkWired" class="text-fg-muted" /> Network interfaces</div>
      <table class="table-dense">
        <thead><tr><th>Name</th><th>Guest device</th><th>MAC</th><th>Addresses</th><th>Link</th><th>Reported by</th></tr></thead>
        <tbody>
          <tr v-for="(iface, i) in interfaces" :key="i">
            <td>{{ iface.name ?? '—' }}</td>
            <td class="mono">{{ iface.interfaceName ?? '—' }}</td>
            <td class="mono">{{ iface.mac ?? '—' }}</td>
            <td class="mono whitespace-normal">{{ (iface.ipAddresses ?? (iface.ipAddress ? [iface.ipAddress] : [])).join(', ') || '—' }}</td>
            <td :class="iface.linkState === 'down' ? 'text-warn' : ''">{{ iface.linkState ?? '—' }}</td>
            <td class="text-fg-muted">{{ iface.infoSource ?? '—' }}</td>
          </tr>
          <tr v-if="!interfaces.length"><td colspan="6" class="h-12 text-center text-fg-subtle">No interfaces reported</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
