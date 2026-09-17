<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { faCloud, faFloppyDisk, faRotateLeft, faPlus, faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { errorMessage } from '@/api/gateway'
import { can } from '@/stores/access'
import { toast } from '@/services/dialogs'
import Notice from '@/components/ui/Notice.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { applyStructured, findCloudInit, networkData, toStructured, userData, withData, type Structured } from './cloudinit'
import { copy, disksOf, volumesOf } from './spec'
import { updateTemplate } from './update'

const props = defineProps<{ ctx: ObjectContext }>()

const spec = computed(() => props.ctx.object?.spec?.template?.spec ?? {})
const volume = computed(() => findCloudInit(spec.value))
const secretBacked = computed(() => !!(volume.value?.source?.secretRef || volume.value?.source?.userDataSecretRef))
const mayEdit = computed(() => can({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace: props.ctx.namespace, name: props.ctx.name }) === true)

const mode = ref<'structured' | 'raw'>('structured')
const rawUser = ref('')
const rawNetwork = ref('')
const fields = reactive<Structured>({ user: '', password: '', sshKeys: '', hostname: '', upgrade: false, ipMode: 'unset', address: '', gateway: '', dns: '' })
const parsedOk = ref(true)
const dirty = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const showPassword = ref(false)

function load() {
  const source = volume.value?.source
  rawUser.value = userData(source)
  rawNetwork.value = networkData(source)
  const s = toStructured(rawUser.value, rawNetwork.value)
  Object.assign(fields, s.fields)
  parsedOk.value = s.parsed
  if (!s.parsed) mode.value = 'raw'
  dirty.value = false
  error.value = null
}

// Reload from the server unless there are unsaved edits.
watch(() => props.ctx.object?.metadata.resourceVersion, () => !dirty.value && load(), { immediate: true })
watch([fields, rawUser, rawNetwork], () => (dirty.value = true), { deep: true, flush: 'sync' })

async function save() {
  if (!volume.value) return
  busy.value = true
  error.value = null
  try {
    let user = rawUser.value
    let network: string | null = rawNetwork.value
    if (mode.value === 'structured') {
      const applied = applyStructured(rawUser.value, fields)
      user = applied.userData
      network = fields.ipMode === 'unset' ? rawNetwork.value : applied.networkData
    }
    const name = volume.value.name
    const kind = volume.value.kind
    await updateTemplate(props.ctx, (current) => {
      const volumes = copy(volumesOf(current)).map((v: any) => (v.name === name ? { name, [kind]: withData(v[kind], user, network) } : v))
      return { volumes }
    })
    dirty.value = false
    toast('success', 'Cloud-init saved', props.ctx.related.vmi ? 'The guest sees it after the VM restarts.' : undefined)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function addDrive() {
  busy.value = true
  error.value = null
  try {
    await updateTemplate(props.ctx, (current) => {
      const volumes = copy(volumesOf(current))
      const disks = copy(disksOf(current))
      volumes.push({ name: 'cloudinitdisk', cloudInitNoCloud: { userData: '#cloud-config\n' } })
      disks.push({ name: 'cloudinitdisk', disk: { bus: 'virtio' } })
      return { volumes, domain: { devices: { disks } } }
    })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex h-full flex-col gap-3 p-3">
    <Notice v-if="!ctx.object" kind="info">Cloud-init belongs to a VirtualMachine definition.</Notice>
    <template v-else-if="!volume">
      <Notice kind="info" title="No cloud-init drive">
        Cloud-init configures users, SSH keys and networking on first boot of most cloud images.
        <div class="mt-2">
          <button class="btn btn-primary" :disabled="!mayEdit || busy" @click="addDrive"><Fa :icon="faPlus" /> Add a cloud-init drive</button>
        </div>
      </Notice>
    </template>
    <template v-else>
      <div class="flex items-center gap-2">
        <Fa :icon="faCloud" class="text-fg-muted" />
        <span class="font-medium">{{ volume.kind === 'cloudInitNoCloud' ? 'NoCloud' : 'ConfigDrive' }} drive “{{ volume.name }}”</span>
        <div class="ml-4 flex gap-1">
          <button class="btn btn-sm" :class="mode === 'structured' ? 'bg-surface-3' : 'btn-ghost'" :disabled="!parsedOk" @click="mode = 'structured'">Settings</button>
          <button class="btn btn-sm" :class="mode === 'raw' ? 'bg-surface-3' : 'btn-ghost'" @click="mode = 'raw'">Raw user data &amp; network config</button>
        </div>
        <div class="ml-auto flex gap-1.5">
          <button class="btn" :disabled="!dirty || busy" @click="load"><Fa :icon="faRotateLeft" /> Revert</button>
          <button class="btn btn-primary" :disabled="!dirty || busy || !mayEdit || secretBacked" @click="save"><Fa :icon="faFloppyDisk" /> {{ busy ? 'Saving…' : 'Save' }}</button>
        </div>
      </div>
      <Notice v-if="secretBacked" kind="info">
        User data comes from Secret <span class="mono">{{ volume.source.secretRef?.name ?? volume.source.userDataSecretRef?.name }}</span>; edit the Secret to change it.
      </Notice>
      <Notice v-if="!parsedOk" kind="warning">The user data is not plain cloud-config YAML, so it can only be edited raw.</Notice>
      <Notice v-if="ctx.related.vmi" kind="info">Changes reach the guest after the VM restarts; per-instance modules only run again if the instance ID changes.</Notice>
      <Notice v-if="error" kind="error">{{ error }}</Notice>

      <div v-if="mode === 'structured'" class="grid max-w-4xl gap-4 lg:grid-cols-2">
        <div class="card space-y-3 p-3">
          <h3 class="panel-title">User</h3>
          <div>
            <label class="label">User</label>
            <input v-model="fields.user" class="input" placeholder="image default (e.g. fedora, ubuntu)" :disabled="secretBacked" />
          </div>
          <div>
            <label class="label">Password</label>
            <div class="relative">
              <input v-model="fields.password" :type="showPassword ? 'text' : 'password'" class="input pr-8" placeholder="none — SSH keys only" autocomplete="new-password" :disabled="secretBacked" />
              <button type="button" class="absolute top-1/2 right-2 -translate-y-1/2 text-fg-subtle hover:text-fg" @click="showPassword = !showPassword"><Fa :icon="showPassword ? faEyeSlash : faEye" /></button>
            </div>
            <p class="mt-1 text-xs text-fg-muted">Stored in plain text in the VM definition, readable by anyone who can read the VM.</p>
          </div>
          <div>
            <label class="label">SSH public keys</label>
            <textarea v-model="fields.sshKeys" class="input mono h-28" placeholder="ssh-ed25519 AAAA… user@host (one per line)" spellcheck="false" :disabled="secretBacked" />
          </div>
          <div>
            <label class="label">Hostname</label>
            <input v-model="fields.hostname" class="input" :placeholder="ctx.name" :disabled="secretBacked" />
          </div>
          <label class="flex items-center gap-2"><input v-model="fields.upgrade" type="checkbox" class="accent-[var(--accent)]" :disabled="secretBacked" /> Upgrade packages on first boot</label>
        </div>
        <div class="card space-y-3 p-3">
          <h3 class="panel-title">Network (first interface)</h3>
          <div>
            <label class="label">IP configuration</label>
            <select v-model="fields.ipMode" class="input">
              <option value="unset">Leave as is{{ rawNetwork ? ' (custom network config)' : ' (image default, usually DHCP)' }}</option>
              <option value="dhcp">DHCP</option>
              <option value="static">Static</option>
            </select>
          </div>
          <template v-if="fields.ipMode === 'static'">
            <div>
              <label class="label">Address (CIDR)</label>
              <input v-model="fields.address" class="input mono" placeholder="192.168.10.20/24" />
            </div>
            <div>
              <label class="label">Gateway</label>
              <input v-model="fields.gateway" class="input mono" placeholder="192.168.10.1" />
            </div>
            <div>
              <label class="label">DNS servers</label>
              <input v-model="fields.dns" class="input mono" placeholder="1.1.1.1 9.9.9.9" />
            </div>
          </template>
          <p class="text-xs text-fg-muted">On the pod network with masquerade, KubeVirt runs DHCP for the guest; static addresses are for bridged or Multus networks.</p>
        </div>
      </div>

      <div v-else class="grid min-h-[420px] flex-1 gap-3 xl:grid-cols-2">
        <div class="flex min-h-0 flex-col">
          <label class="label">User data</label>
          <div class="min-h-[360px] flex-1"><YamlEditor v-model="rawUser" :readonly="secretBacked" /></div>
        </div>
        <div class="flex min-h-0 flex-col">
          <label class="label">Network config (optional)</label>
          <div class="min-h-[360px] flex-1"><YamlEditor v-model="rawNetwork" /></div>
        </div>
      </div>
    </template>
  </div>
</template>
