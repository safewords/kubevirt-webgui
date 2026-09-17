<script setup lang="ts">
/**
 * Create: Disk — a DataVolume from nothing, a URL, a registry, another disk,
 * or a file from this computer. Also used for the image library's "Download
 * from URL" and "Upload" (with `imageType` set and the source fixed).
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { faHardDrive, faCloudArrowDown, faUpload, faCheck } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { gateway, errorMessage } from '@/api/gateway'
import { run } from '@/services/dialogs'
import { useInventory } from '@/plugins/core/inventory'
import { bytes, isDnsLabel } from '@/util/format'
import { routeTo } from '@/util/nav'
import FormRow from './FormRow.vue'
import NamespaceSelect from './NamespaceSelect.vue'
import StorageClassSelect from './StorageClassSelect.vue'
import { claimGibFor, dataVolume, formatHint, imageNamespace, nameFromUrl, pvcGib, type ImageType } from './helpers'
import { startUpload } from './uploads'

type Source = 'blank' | 'http' | 'registry' | 'pvc' | 'upload'

const props = defineProps<{
  /** Fix the source, as the image library's buttons do. */
  source?: Source
  /** Label the disk for the image library. */
  imageType?: ImageType | null
  namespace?: string
}>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const router = useRouter()
const inv = useInventory()

const library = computed(() => props.imageType !== undefined)
const source = ref<Source>(props.source ?? 'blank')
const namespace = ref(props.namespace ?? (library.value ? imageNamespace.value : inv.reachableNamespaces.includes('default') ? 'default' : (inv.reachableNamespaces[0] ?? 'default')))
const name = ref('')
const nameTouched = ref(false)
const sizeGib = ref(10)
const sizeTouched = ref(false)
const storageClass = ref<string | null>(null)
const url = ref('')
const registry = ref('')
const clone = ref('')
const file = ref<File | null>(null)
const imageType = ref<ImageType | ''>(props.imageType ?? '')
const busy = ref(false)
const error = ref<string | null>(null)

const title = computed(() =>
  library.value ? (source.value === 'upload' ? 'Upload image' : 'Download image from URL') : 'Create: Disk',
)
const icon = computed(() => (source.value === 'upload' ? faUpload : source.value === 'http' ? faCloudArrowDown : faHardDrive))

// Suggest a name and type from what is being imported, until the person edits them.
watch(url, (value) => {
  if (!nameTouched.value) name.value = nameFromUrl(value)
  if (library.value && !props.imageType) imageType.value = /\.iso(\.(xz|gz))?([?#]|$)/i.test(value) ? 'iso' : 'disk'
})
watch(file, (value) => {
  if (!value) return
  if (!nameTouched.value) name.value = nameFromUrl(value.name)
  if (/\.iso$/i.test(value.name)) imageType.value = 'iso'
  if (!sizeTouched.value) sizeGib.value = claimGibFor(value.size)
})
watch(clone, (value) => {
  const [ns, n] = value.split('/')
  const pvc = inv.pvcs.find((p) => p.metadata.namespace === ns && p.metadata.name === n)
  const gibs = pvcGib(pvc)
  if (gibs && sizeGib.value < gibs) sizeGib.value = gibs
})

const selectedFormat = computed(() => (source.value === 'http' ? formatHint(url.value) : source.value === 'upload' && file.value ? formatHint(file.value.name) : null))
const compressedOrConverted = computed(() => {
  const n = (source.value === 'upload' ? file.value?.name : url.value)?.toLowerCase() ?? ''
  return /\.(qcow2|vmdk|vhdx?)(\.(xz|gz))?$/.test(n.split(/[?#]/)[0]) || /\.(xz|gz)$/.test(n.split(/[?#]/)[0])
})

const errors = computed(() => {
  const e: string[] = []
  if (!isDnsLabel(namespace.value)) e.push('Choose a valid namespace')
  if (!name.value) e.push('A name is required')
  else if (!isDnsLabel(name.value)) e.push('The name must be lowercase letters, digits and dashes')
  else if (inv.pvcs.some((p) => p.metadata.namespace === namespace.value && p.metadata.name === name.value)) e.push(`A disk named ${name.value} already exists in ${namespace.value}`)
  if (!(sizeGib.value > 0)) e.push('The size must be positive')
  if (source.value === 'http' && !/^https?:\/\/\S+$/.test(url.value.trim())) e.push('Enter an http(s) URL')
  if (source.value === 'registry' && !registry.value.trim()) e.push('Enter a container image')
  if (source.value === 'pvc' && !clone.value) e.push('Choose a disk to clone')
  if (source.value === 'upload' && !file.value) e.push('Choose a file')
  if (source.value === 'upload' && file.value && sizeGib.value * 1024 ** 3 < file.value.size) e.push(`The disk must be at least as large as the file (${bytes(file.value.size)})`)
  if (library.value && !imageType.value) e.push('Choose whether this is an ISO or a disk image')
  return e
})

function pickFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function submit() {
  if (errors.value.length) return
  error.value = null
  busy.value = true
  const type = (imageType.value || null) as ImageType | null
  if (library.value) imageNamespace.value = namespace.value
  try {
    if (source.value === 'upload') {
      await startUpload(file.value!, { namespace: namespace.value, name: name.value, imageType: type ?? 'disk', storageClass: storageClass.value, diskSize: `${sizeGib.value}Gi` })
      emit('close', { upload: true })
      if (library.value) router.push({ name: 'datacenter', params: { panel: 'images' } })
      return
    }
    const [cloneNs, cloneName] = clone.value.split('/')
    const body = dataVolume({
      name: name.value,
      namespace: namespace.value,
      sizeGib: sizeGib.value,
      storageClass: storageClass.value,
      imageType: type,
      source:
        source.value === 'http'
          ? { type: 'http', url: url.value }
          : source.value === 'registry'
            ? { type: 'registry', url: registry.value }
            : source.value === 'pvc'
              ? { type: 'pvc', namespace: cloneNs, name: cloneName }
              : { type: 'blank' },
    })
    const result = await run(`${title.value} ${name.value}`, () => gateway.call('datavolume.create', { body }), { openLog: true })
    if (result) {
      emit('close', result)
      router.push(library.value ? { name: 'datacenter', params: { panel: 'images' } } : routeTo({ kind: 'disk', name: name.value, namespace: namespace.value }))
    }
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="title" :icon="icon" width="640px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <FormRow v-if="!props.source" label="Source">
        <select v-model="source" class="input">
          <option value="blank">Empty disk</option>
          <option value="http">Import from a URL (qcow2, raw, VMDK, VHD/VHDX, ISO; xz/gz)</option>
          <option value="registry">Import from a container registry (container disk)</option>
          <option value="pvc">Clone an existing disk</option>
          <option value="upload">Upload a file from this computer</option>
        </select>
      </FormRow>

      <FormRow v-if="source === 'http'" label="URL" required :hint="selectedFormat ?? 'CDI downloads the file inside the cluster; nothing passes through your browser.'">
        <input v-model.trim="url" class="input mono" placeholder="https://releases.ubuntu.com/24.04/ubuntu-24.04-live-server-amd64.iso" spellcheck="false" autofocus />
      </FormRow>
      <FormRow v-if="source === 'registry'" label="Image" required hint="A container disk: an image with the disk under /disk.">
        <input v-model.trim="registry" class="input mono" placeholder="quay.io/containerdisks/fedora:latest" spellcheck="false" />
      </FormRow>
      <FormRow v-if="source === 'pvc'" label="Disk to clone" required hint="Cloning from another namespace needs permission to clone from it.">
        <select v-model="clone" class="input">
          <option value="">— choose —</option>
          <option v-for="p in inv.pvcs.filter((p) => p.status?.phase === 'Bound')" :key="p.metadata.uid" :value="`${p.metadata.namespace}/${p.metadata.name}`">
            {{ p.metadata.namespace }}/{{ p.metadata.name }} ({{ p.status?.capacity?.storage }})
          </option>
        </select>
      </FormRow>
      <FormRow v-if="source === 'upload'" label="File" required :hint="file ? `${bytes(file.size)}${selectedFormat ? ` · ${selectedFormat}` : ''} — sent over the WebSocket in acknowledged chunks.` : 'ISO, qcow2, raw, VMDK, VHD/VHDX, optionally xz/gz compressed.'">
        <input type="file" class="input h-auto py-1" accept=".iso,.img,.qcow2,.raw,.vmdk,.vhd,.vhdx,.xz,.gz" @change="pickFile" />
      </FormRow>

      <FormRow v-if="library" label="Content" required>
        <div class="flex gap-4 pt-1.5">
          <label class="flex items-center gap-2"><input v-model="imageType" type="radio" value="iso" class="accent-[var(--accent)]" /> ISO image (installer, attached as CD/DVD)</label>
          <label class="flex items-center gap-2"><input v-model="imageType" type="radio" value="disk" class="accent-[var(--accent)]" /> Disk image (template to clone)</label>
        </div>
      </FormRow>
      <FormRow v-else label="Image library">
        <select v-model="imageType" class="input">
          <option value="">Don't add to the library</option>
          <option value="iso">Add as an ISO image</option>
          <option value="disk">Add as a disk template</option>
        </select>
      </FormRow>

      <FormRow label="Namespace" required :hint="library ? 'Images are shared from here; VMs in other namespaces clone them.' : null">
        <NamespaceSelect v-model="namespace" />
      </FormRow>
      <FormRow label="Name" required>
        <input v-model.trim="name" class="input" spellcheck="false" @input="nameTouched = true" />
      </FormRow>
      <FormRow
        label="Size (GiB)"
        required
        :hint="compressedOrConverted ? 'Compressed and qcow2/VMDK/VHD images expand: size this for the image\'s virtual disk, not the file.' : source === 'http' || source === 'registry' ? 'Large enough for the image once written out raw.' : null"
      >
        <input v-model.number="sizeGib" type="number" min="1" class="input" @input="sizeTouched = true" />
      </FormRow>
      <FormRow label="Storage">
        <StorageClassSelect v-model="storageClass" />
      </FormRow>

      <Notice v-if="errors.length && (name || url || file || registry || clone)" kind="warning">
        <div v-for="e in errors" :key="e">{{ e }}</div>
      </Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !!errors.length" @click="submit">
        <Fa :icon="source === 'upload' ? faUpload : source === 'http' ? faCloudArrowDown : faCheck" />
        {{ source === 'upload' ? 'Upload' : source === 'http' ? 'Download' : 'Create' }}
      </button>
    </template>
  </Modal>
</template>
