<script setup lang="ts">
/** Datacenter options: the KubeVirt CR's configuration, and CDI's. */
import { computed, reactive, ref, watch } from 'vue'
import { faFloppyDisk, faRotateLeft, faFileCode, faPlus, faXmark, faGears, faFileImport, faCodeBranch } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { useWatch } from '@/stores/watch'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { openDialog, toast } from '@/services/dialogs'
import Notice from '@/components/ui/Notice.vue'
import ConditionsTable from '@/components/common/ConditionsTable.vue'
import YamlDialog from './YamlDialog.vue'

defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()

const kubevirts = useWatch(() => (cluster.has('kubevirt.io/v1/kubevirts') ? { apiVersion: 'kubevirt.io/v1', resource: 'kubevirts' } : null))
const kv = computed<KObject | null>(() => kubevirts.items.value[0] ?? null)

const cdiVersion = computed(() => cluster.versionFor('cdi.kubevirt.io', 'cdiconfigs'))
const cdiConfigs = useWatch(() => (cdiVersion.value ? { apiVersion: cdiVersion.value, resource: 'cdiconfigs' } : null))
const cdiConfig = computed(() => cdiConfigs.items.value[0] ?? null)
const cdis = useWatch(() => (cluster.versionFor('cdi.kubevirt.io', 'cdis') ? { apiVersion: cluster.versionFor('cdi.kubevirt.io', 'cdis')!, resource: 'cdis' } : null))
const cdi = computed(() => cdis.items.value[0] ?? null)

const GATES: Array<{ name: string; hint: string }> = [
  { name: 'Snapshot', hint: 'VirtualMachineSnapshot and restore' },
  { name: 'VMExport', hint: 'Export VM disks over HTTP' },
  { name: 'HotplugVolumes', hint: 'Attach disks to running VMs' },
  { name: 'DeclarativeHotplugVolumes', hint: 'Hotplug by editing the VM spec' },
  { name: 'ExpandDisks', hint: 'Grow disks when their PVC grows' },
  { name: 'VMLiveUpdateFeatures', hint: 'CPU/memory hotplug via LiveUpdate rollout' },
  { name: 'VMPersistentState', hint: 'Persistent TPM and EFI variables' },
  { name: 'CPUManager', hint: 'Dedicated CPU placement' },
  { name: 'NUMA', hint: 'Guest NUMA topology passthrough' },
  { name: 'AlignCPUs', hint: 'Align emulator threads with vCPUs' },
  { name: 'GPU', hint: 'GPU passthrough (device plugins)' },
  { name: 'HostDevices', hint: 'PCI and mediated device passthrough' },
  { name: 'GPUsWithDRA', hint: 'GPUs via Dynamic Resource Allocation' },
  { name: 'HostDevicesWithDRA', hint: 'Host devices via DRA' },
  { name: 'DisableMDEVConfiguration', hint: 'Do not manage mediated devices' },
  { name: 'Sidecar', hint: 'Hook sidecars in virt-launcher' },
  { name: 'DownwardMetrics', hint: 'Expose host metrics to guests' },
  { name: 'HostDisk', hint: 'Disks backed by host paths' },
  { name: 'PersistentReservation', hint: 'SCSI persistent reservations' },
  { name: 'VSOCK', hint: 'virtio-vsock devices' },
  { name: 'WorkloadEncryptionSEV', hint: 'AMD SEV confidential VMs' },
  { name: 'SecureExecution', hint: 'IBM Secure Execution' },
  { name: 'KubevirtSeccompProfile', hint: 'Custom seccomp profile' },
  { name: 'Root', hint: 'Run virt-launcher as root' },
  { name: 'MultiArchitecture', hint: 'Mixed-architecture clusters' },
  { name: 'AutoResourceLimitsGate', hint: 'Automatic limits from namespace quotas' },
  { name: 'DecentralizedLiveMigration', hint: 'Cross-cluster live migration' },
  { name: 'ImageVolume', hint: 'Container disks as image volumes' },
  { name: 'VideoConfig', hint: 'Choose the video device type' },
  { name: 'PanicDevices', hint: 'Guest panic notifier devices' },
  { name: 'PasstIPStackMigration', hint: 'Migrate passt network state' },
  { name: 'ObjectGraph', hint: 'The objectgraph subresource' },
  { name: 'IncrementalBackup', hint: 'Changed-block-tracking backups' },
  { name: 'VirtIOFSStorageVolumes', hint: 'Share PVCs with virtiofs' },
  { name: 'VirtIOFSConfigVolumes', hint: 'Share config maps/secrets with virtiofs' },
  { name: 'ClusterProfiler', hint: 'Profiling endpoints' },
]

interface Form {
  featureGates: string[]
  parallelMigrationsPerCluster: string
  parallelOutboundMigrationsPerNode: string
  bandwidthPerMigration: string
  completionTimeoutPerGiB: string
  progressTimeout: string
  allowPostCopy: '' | 'true' | 'false'
  allowAutoConverge: '' | 'true' | 'false'
  migrationNetwork: string
  evictionStrategy: string
  vmRolloutStrategy: string
  machineType: string
  memoryOvercommit: string
  cpuAllocationRatio: string
  vmStateStorageClass: string
  workloadUpdateMethods: string[]
  batchEvictionSize: string
  batchEvictionInterval: string
}

function fromObject(object: KObject | null): Form {
  const c = object?.spec?.configuration ?? {}
  const lm = c.migrations ?? {}
  const dev = c.developerConfiguration ?? {}
  const w = object?.spec?.workloadUpdateStrategy ?? {}
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))
  const tri = (v: unknown): '' | 'true' | 'false' => (v === true ? 'true' : v === false ? 'false' : '')
  return {
    featureGates: [...(dev.featureGates ?? [])],
    parallelMigrationsPerCluster: str(lm.parallelMigrationsPerCluster),
    parallelOutboundMigrationsPerNode: str(lm.parallelOutboundMigrationsPerNode),
    bandwidthPerMigration: str(lm.bandwidthPerMigration),
    completionTimeoutPerGiB: str(lm.completionTimeoutPerGiB),
    progressTimeout: str(lm.progressTimeout),
    allowPostCopy: tri(lm.allowPostCopy),
    allowAutoConverge: tri(lm.allowAutoConverge),
    migrationNetwork: str(lm.network),
    evictionStrategy: str(c.evictionStrategy),
    vmRolloutStrategy: str(c.vmRolloutStrategy),
    machineType: str(c.architectureConfiguration?.amd64?.machineType ?? c.machineType),
    memoryOvercommit: str(dev.memoryOvercommit),
    cpuAllocationRatio: str(dev.cpuAllocationRatio),
    vmStateStorageClass: str(c.vmStateStorageClass),
    workloadUpdateMethods: [...(w.workloadUpdateMethods ?? [])],
    batchEvictionSize: str(w.batchEvictionSize),
    batchEvictionInterval: str(w.batchEvictionInterval),
  }
}

const form = reactive<Form>(fromObject(null))
const original = ref(JSON.stringify(fromObject(null)))
const dirty = computed(() => JSON.stringify(form) !== original.value)
const busy = ref(false)
const error = ref<string | null>(null)
const customGate = ref('')

watch(
  kv,
  (object) => {
    if (!object || dirty.value) return
    const next = fromObject(object)
    Object.assign(form, next)
    original.value = JSON.stringify(next)
  },
  { immediate: true },
)

const staleWhileEditing = computed(() => dirty.value && kv.value && JSON.stringify(fromObject(kv.value)) !== original.value)
const allowed = computed(() => (kv.value ? can({ verb: 'patch', group: 'kubevirt.io', resource: 'kubevirts', namespace: kv.value.metadata.namespace, name: kv.value.metadata.name }) : false))
const extraGates = computed(() => form.featureGates.filter((g) => !GATES.some((k) => k.name === g)))

function toggleGate(name: string) {
  const i = form.featureGates.indexOf(name)
  if (i === -1) form.featureGates.push(name)
  else form.featureGates.splice(i, 1)
}
function addCustomGate() {
  const name = customGate.value.trim()
  if (name && !form.featureGates.includes(name)) form.featureGates.push(name)
  customGate.value = ''
}
function toggleMethod(name: string) {
  const i = form.workloadUpdateMethods.indexOf(name)
  if (i === -1) form.workloadUpdateMethods.push(name)
  else form.workloadUpdateMethods.splice(i, 1)
}

function reset() {
  const next = fromObject(kv.value)
  Object.assign(form, next)
  original.value = JSON.stringify(next)
  error.value = null
}

const num = (v: string) => (v.trim() === '' ? null : Number(v))
const text = (v: string) => (v.trim() === '' ? null : v.trim())
const bool = (v: '' | 'true' | 'false') => (v === '' ? null : v === 'true')

/**
 * Reduce a merge patch to what changes `current`. A `null` for a field that is
 * not set would otherwise leave an empty object behind (`migrations: {}`), and
 * an unchanged value is noise that makes the CR drift from how it was
 * installed (Helm, GitOps).
 */
function prune(patch: unknown, current: unknown): unknown {
  if (patch === null) return current === undefined || current === null ? undefined : null
  if (Array.isArray(patch)) return JSON.stringify(patch) === JSON.stringify(current ?? []) ? undefined : patch
  if (typeof patch !== 'object') return patch === current ? undefined : patch
  const base = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const reduced = prune(value, base[key])
    if (reduced !== undefined) out[key] = reduced
  }
  return Object.keys(out).length ? out : undefined
}

async function save() {
  if (!kv.value) return
  error.value = null
  for (const [label, value] of [
    ['Parallel migrations per cluster', form.parallelMigrationsPerCluster],
    ['Parallel outbound migrations per node', form.parallelOutboundMigrationsPerNode],
    ['Completion timeout per GiB', form.completionTimeoutPerGiB],
    ['Progress timeout', form.progressTimeout],
    ['Memory overcommit', form.memoryOvercommit],
    ['CPU allocation ratio', form.cpuAllocationRatio],
    ['Batch eviction size', form.batchEvictionSize],
  ] as const) {
    if (value.trim() !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      error.value = `${label} must be a non-negative number`
      return
    }
  }
  const patch = {
    spec: {
      configuration: {
        developerConfiguration: {
          // An empty list is removed rather than written, as KubeVirt was installed without one.
          featureGates: form.featureGates.length ? form.featureGates : null,
          memoryOvercommit: num(form.memoryOvercommit),
          cpuAllocationRatio: num(form.cpuAllocationRatio),
        },
        migrations: {
          parallelMigrationsPerCluster: num(form.parallelMigrationsPerCluster),
          parallelOutboundMigrationsPerNode: num(form.parallelOutboundMigrationsPerNode),
          bandwidthPerMigration: text(form.bandwidthPerMigration),
          completionTimeoutPerGiB: num(form.completionTimeoutPerGiB),
          progressTimeout: num(form.progressTimeout),
          allowPostCopy: bool(form.allowPostCopy),
          allowAutoConverge: bool(form.allowAutoConverge),
          network: text(form.migrationNetwork),
        },
        evictionStrategy: text(form.evictionStrategy),
        vmRolloutStrategy: text(form.vmRolloutStrategy),
        vmStateStorageClass: text(form.vmStateStorageClass),
        architectureConfiguration: { amd64: { machineType: text(form.machineType) } },
      },
      workloadUpdateStrategy: {
        workloadUpdateMethods: form.workloadUpdateMethods.length ? form.workloadUpdateMethods : null,
        batchEvictionSize: num(form.batchEvictionSize),
        batchEvictionInterval: text(form.batchEvictionInterval),
      },
    },
  }
  busy.value = true
  try {
    const ref = { apiVersion: 'kubevirt.io/v1', resource: 'kubevirts', namespace: kv.value.metadata.namespace, name: kv.value.metadata.name }
    const minimal = prune(patch, kv.value) ?? {}
    await k8s.patch(ref, minimal, 'merge', { dryRun: true })
    const saved = await k8s.patch(ref, minimal, 'merge')
    const next = fromObject(saved)
    Object.assign(form, next)
    original.value = JSON.stringify(next)
    toast('success', 'KubeVirt configuration saved', 'virt-operator rolls the change out to its components.')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

function yaml(object: KObject | null, title: string) {
  if (object) openDialog(YamlDialog, { title, mode: 'view', object })
}
</script>

<template>
  <div class="space-y-3 p-3">
    <Notice v-if="!cluster.has('kubevirt.io/v1/kubevirts')" kind="warning" title="KubeVirt is not installed">This cluster does not serve kubevirt.io/v1 KubeVirt resources.</Notice>
    <Notice v-else-if="kubevirts.error.value" kind="warning" title="Cannot read the KubeVirt configuration">{{ kubevirts.error.value.message }}</Notice>
    <Notice v-else-if="kubevirts.synced.value && !kv" kind="warning">No KubeVirt resource was found.</Notice>

    <template v-if="kv">
      <div class="card">
        <div class="card-header">
          <Fa :icon="faGears" class="text-fg-muted" /> KubeVirt {{ kv.metadata.namespace }}/{{ kv.metadata.name }}
          <button class="btn btn-sm btn-ghost ml-auto" @click="yaml(kv, 'KubeVirt')"><Fa :icon="faFileCode" /> YAML</button>
        </div>
        <dl class="kv p-3">
          <dt>Phase</dt>
          <dd :class="kv.status?.phase === 'Deployed' ? 'text-ok' : 'text-warn'">{{ kv.status?.phase ?? '—' }}</dd>
          <dt>Version</dt>
          <dd>{{ kv.status?.observedKubeVirtVersion ?? '—' }} <span class="text-fg-muted">(operator {{ kv.status?.operatorVersion ?? '—' }}, target {{ kv.status?.targetKubeVirtVersion ?? '—' }})</span></dd>
          <dt>Registry</dt>
          <dd class="mono">{{ kv.status?.observedKubeVirtRegistry ?? '—' }}</dd>
          <dt>Default architecture</dt>
          <dd>{{ kv.status?.defaultArchitecture ?? '—' }}</dd>
        </dl>
        <div class="px-3 pb-3"><ConditionsTable :conditions="kv.status?.conditions" :good-when-false="['Degraded', 'Progressing']" /></div>
      </div>

      <Notice v-if="allowed === false" kind="info">You can view this configuration but not change it.</Notice>
      <Notice v-if="staleWhileEditing" kind="warning">The configuration changed on the server while you were editing. Reset to load it, or save to overwrite those fields.</Notice>
      <Notice v-if="error" kind="error">{{ error }}</Notice>

      <fieldset class="grid gap-3 xl:grid-cols-2" :disabled="allowed !== true || busy">
        <div class="card xl:col-span-2">
          <div class="card-header">Feature gates <span class="chip">{{ form.featureGates.length }} enabled</span></div>
          <div class="grid gap-x-4 gap-y-1.5 p-3 sm:grid-cols-2 xl:grid-cols-3">
            <label v-for="gate in GATES" :key="gate.name" class="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
              <input type="checkbox" class="mt-1 accent-[var(--accent)]" :checked="form.featureGates.includes(gate.name)" @change="toggleGate(gate.name)" />
              <span>
                <span class="mono block">{{ gate.name }}</span>
                <span class="block text-xs text-fg-muted">{{ gate.hint }}</span>
              </span>
            </label>
          </div>
          <div class="flex flex-wrap items-center gap-2 border-t border-line p-3">
            <span class="text-fg-muted">Other gates:</span>
            <span v-for="gate in extraGates" :key="gate" class="chip mono bg-accent-soft text-accent">
              {{ gate }}
              <button type="button" class="hover:text-bad" :aria-label="`Remove ${gate}`" @click="toggleGate(gate)"><Fa :icon="faXmark" /></button>
            </span>
            <input v-model="customGate" class="input mono w-56" placeholder="FeatureGateName" @keydown.enter.prevent="addCustomGate" />
            <button type="button" class="btn btn-sm" :disabled="!customGate.trim()" @click="addCustomGate"><Fa :icon="faPlus" /> Add</button>
          </div>
        </div>

        <div class="card">
          <div class="card-header">Live migration</div>
          <div class="grid grid-cols-2 gap-3 p-3">
            <div><label class="label">Parallel migrations (cluster)</label><input v-model="form.parallelMigrationsPerCluster" class="input" inputmode="numeric" placeholder="5" /></div>
            <div><label class="label">Parallel outbound per node</label><input v-model="form.parallelOutboundMigrationsPerNode" class="input" inputmode="numeric" placeholder="2" /></div>
            <div><label class="label">Bandwidth per migration</label><input v-model="form.bandwidthPerMigration" class="input" placeholder="unlimited, e.g. 64Mi" /></div>
            <div><label class="label">Completion timeout per GiB (s)</label><input v-model="form.completionTimeoutPerGiB" class="input" inputmode="numeric" placeholder="150" /></div>
            <div><label class="label">Progress timeout (s)</label><input v-model="form.progressTimeout" class="input" inputmode="numeric" placeholder="150" /></div>
            <div><label class="label">Dedicated migration network</label><input v-model="form.migrationNetwork" class="input" placeholder="NetworkAttachmentDefinition name" /></div>
            <div>
              <label class="label">Post-copy</label>
              <select v-model="form.allowPostCopy" class="input"><option value="">default (off)</option><option value="true">allow</option><option value="false">disallow</option></select>
            </div>
            <div>
              <label class="label">Auto-converge</label>
              <select v-model="form.allowAutoConverge" class="input"><option value="">default (off)</option><option value="true">allow</option><option value="false">disallow</option></select>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">Virtual machines</div>
          <div class="grid grid-cols-2 gap-3 p-3">
            <div>
              <label class="label">Eviction strategy (node drain)</label>
              <select v-model="form.evictionStrategy" class="input">
                <option value="">default (None)</option>
                <option value="None">None — VMs are shut down</option>
                <option value="LiveMigrate">LiveMigrate — block drain until migrated</option>
                <option value="LiveMigrateIfPossible">LiveMigrateIfPossible</option>
                <option value="External">External — handled by another controller</option>
              </select>
            </div>
            <div>
              <label class="label">VM rollout strategy</label>
              <select v-model="form.vmRolloutStrategy" class="input">
                <option value="">default (Stage)</option>
                <option value="Stage">Stage — changes apply on restart</option>
                <option value="LiveUpdate">LiveUpdate — hotplug where possible</option>
              </select>
            </div>
            <div><label class="label">Default machine type (amd64)</label><input v-model="form.machineType" class="input mono" placeholder="q35" /></div>
            <div><label class="label">Memory overcommit (%)</label><input v-model="form.memoryOvercommit" class="input" inputmode="numeric" placeholder="100" /></div>
            <div><label class="label">CPU allocation ratio</label><input v-model="form.cpuAllocationRatio" class="input" inputmode="numeric" placeholder="10" /></div>
            <div><label class="label">Persistent state storage class</label><input v-model="form.vmStateStorageClass" class="input" placeholder="for TPM/EFI state" /></div>
          </div>
        </div>

        <div class="card xl:col-span-2">
          <div class="card-header">Workload updates <span class="text-xs font-normal text-fg-muted">— how running VMs move to a new KubeVirt version</span></div>
          <div class="grid gap-3 p-3 sm:grid-cols-3">
            <div>
              <span class="label">Methods</span>
              <label class="mr-4 inline-flex items-center gap-1.5"><input type="checkbox" class="accent-[var(--accent)]" :checked="form.workloadUpdateMethods.includes('LiveMigrate')" @change="toggleMethod('LiveMigrate')" /> LiveMigrate</label>
              <label class="inline-flex items-center gap-1.5"><input type="checkbox" class="accent-[var(--accent)]" :checked="form.workloadUpdateMethods.includes('Evict')" @change="toggleMethod('Evict')" /> Evict</label>
            </div>
            <div><label class="label">Batch eviction size</label><input v-model="form.batchEvictionSize" class="input" inputmode="numeric" placeholder="10" /></div>
            <div><label class="label">Batch eviction interval</label><input v-model="form.batchEvictionInterval" class="input" placeholder="1m0s" /></div>
          </div>
        </div>
      </fieldset>

      <div class="sticky bottom-0 flex items-center justify-end gap-2 rounded-md border border-line bg-surface-1/95 p-2 backdrop-blur">
        <span v-if="dirty" class="mr-auto text-warn">Unsaved changes</span>
        <button class="btn" :disabled="!dirty || busy" @click="reset"><Fa :icon="faRotateLeft" /> Reset</button>
        <button class="btn btn-primary" :disabled="!dirty || busy || allowed !== true" @click="save"><Fa :icon="faFloppyDisk" /> {{ busy ? 'Saving…' : 'Save' }}</button>
      </div>
    </template>

    <div v-if="cdiVersion" class="card">
      <div class="card-header">
        <Fa :icon="faFileImport" class="text-fg-muted" /> Containerized Data Importer
        <span class="chip">read-only</span>
        <button v-if="cdiConfig" class="btn btn-sm btn-ghost ml-auto" @click="yaml(cdiConfig, 'CDIConfig')"><Fa :icon="faFileCode" /> YAML</button>
      </div>
      <Notice v-if="cdiConfigs.error.value" kind="warning" class="m-3">{{ cdiConfigs.error.value.message }}</Notice>
      <dl v-else class="kv p-3">
        <dt>Phase</dt>
        <dd :class="cdi?.status?.phase === 'Deployed' ? 'text-ok' : 'text-fg-muted'">{{ cdi?.status?.phase ?? '—' }} <span v-if="cdi?.status?.observedVersion" class="text-fg-muted">({{ cdi.status.observedVersion }})</span></dd>
        <dt>Upload proxy URL</dt>
        <dd class="mono">{{ cdiConfig?.status?.uploadProxyURL ?? cdiConfig?.spec?.uploadProxyURLOverride ?? 'in-cluster service only' }}</dd>
        <dt>Scratch space class</dt>
        <dd>{{ cdiConfig?.status?.scratchSpaceStorageClass || 'cluster default' }}</dd>
        <dt>Filesystem overhead</dt>
        <dd>{{ cdiConfig?.status?.filesystemOverhead?.global ? `${(Number(cdiConfig.status.filesystemOverhead.global) * 100).toFixed(1)}%` : '—' }}</dd>
        <dt>Feature gates</dt>
        <dd>
          <span v-if="!(cdiConfig?.spec?.featureGates ?? []).length" class="text-fg-subtle">none</span>
          <span v-for="g in cdiConfig?.spec?.featureGates ?? []" :key="g" class="chip mono mr-1">{{ g }}</span>
        </dd>
        <dt>Import proxy</dt>
        <dd class="mono">{{ cdiConfig?.status?.importProxy?.HTTPSProxy || cdiConfig?.status?.importProxy?.HTTPProxy || 'none' }}</dd>
        <dt>Importer pod resources</dt>
        <dd class="mono text-fg-muted">
          <template v-if="cdiConfig?.status?.defaultPodResourceRequirements">
            requests {{ cdiConfig.status.defaultPodResourceRequirements.requests?.cpu }}/{{ cdiConfig.status.defaultPodResourceRequirements.requests?.memory }},
            limits {{ cdiConfig.status.defaultPodResourceRequirements.limits?.cpu }}/{{ cdiConfig.status.defaultPodResourceRequirements.limits?.memory }}
          </template>
          <template v-else>—</template>
        </dd>
      </dl>
    </div>
    <p class="text-xs text-fg-subtle"><Fa :icon="faCodeBranch" /> Changes are applied as a merge patch; empty fields are removed so KubeVirt's defaults apply.</p>
  </div>
</template>
