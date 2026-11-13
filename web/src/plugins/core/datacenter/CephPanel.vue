<script setup lang="ts">
/**
 * Ceph: one panel, four views — the overview (is data safe, what to do,
 * trends), OSDs by machine with management, pools and capacity, and what
 * Kubernetes knows (classes, CSI driver, disks).
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { faRotate, faGaugeHigh, faServer, faDatabase, faCubes } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Notice from '@/components/ui/Notice.vue'
import CephOverview from './ceph/CephOverview.vue'
import CephOsds from './ceph/CephOsds.vue'
import CephPools from './ceph/CephPools.vue'
import CephKubernetes from './ceph/CephKubernetes.vue'
import { ceph, refreshCeph, useCephPolling } from './ceph/useCeph'

defineProps<{ ctx: ObjectContext }>()
const stop = useCephPolling()
onBeforeUnmount(stop)

const TABS = [
  { id: 'overview', label: 'Overview', icon: faGaugeHigh },
  { id: 'osds', label: 'OSDs', icon: faServer },
  { id: 'pools', label: 'Pools', icon: faDatabase },
  { id: 'kubernetes', label: 'Kubernetes', icon: faCubes },
]
const KEY = 'ceph-panel-tab'
const tab = ref<string>(
  (() => {
    try {
      return localStorage.getItem(KEY) ?? 'overview'
    } catch {
      return 'overview'
    }
  })(),
)
function go(id: string) {
  tab.value = id
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* a per-viewer convenience only */
  }
}

const notConfigured = computed(() => !!ceph.status && !ceph.status.configured)
const anyDown = computed(() => (ceph.status?.osds ?? []).some((o) => !o.up))
</script>

<template>
  <div class="p-3">
    <div class="mb-3 flex items-center gap-1 border-b border-line">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm"
        :class="tab === t.id ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg'"
        @click="go(t.id)"
      >
        <Fa :icon="t.icon" /> {{ t.label }}
        <span v-if="t.id === 'osds' && anyDown" class="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-bad" title="An OSD is down" />
      </button>
      <button class="btn btn-ghost btn-sm ml-auto" :disabled="ceph.loading" @click="refreshCeph"><Fa :icon="faRotate" :spin="ceph.loading" /> Refresh</button>
    </div>

    <Notice v-if="ceph.statusError" kind="error" class="mb-3">{{ ceph.statusError }}</Notice>
    <Notice v-if="notConfigured && tab !== 'kubernetes'" kind="info" title="Cluster health is not connected" class="mb-3">
      Kubernetes reaches Ceph only through its CSI driver, which reports nothing about the cluster's health. Enable the manager's prometheus module
      (<code class="mono">ceph mgr module enable prometheus</code>) and set <code class="mono">CEPH_METRICS_URLS</code> to each manager
      (<code class="mono">http://&lt;manager&gt;:9283/metrics</code>). For OSD details and management, also set the <code class="mono">CEPH_DASHBOARD_*</code> variables — see the documentation.
    </Notice>

    <template v-if="!notConfigured || tab === 'kubernetes'">
      <CephOverview v-if="tab === 'overview'" @go="go" />
      <CephOsds v-else-if="tab === 'osds'" />
      <CephPools v-else-if="tab === 'pools'" />
      <CephKubernetes v-else />
    </template>
  </div>
</template>
