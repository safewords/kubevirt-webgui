<script setup lang="ts">
/**
 * Add a hard disk or CD/DVD drive.
 *
 * A new disk becomes a DataVolume template of the VM, so it is created with
 * the VM's definition and destroyed with it — the way a Proxmox disk belongs
 * to its guest. Into a running VM it is hot-plugged instead: a standalone
 * DataVolume attached with `addvolume`.
 */
import { computed, reactive, ref } from 'vue'
import { faHardDrive, faCompactDisc } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { gateway, errorMessage } from '@/api/gateway'
import { k8s } from '@/api/k8s'
import { useWatch } from '@/stores/watch'
import { useInventory } from '@/plugins/core/inventory'
import { openTaskLog } from '@/services/dialogs'
import { bytes, quantity } from '@/util/format'
import { copy, disksOf, nextName, validName, validQuantity, volumeInfo, volumesOf } from './spec'
import { updateVm } from './update'

const props = defineProps<{ ctx: ObjectContext; cdrom?: boolean }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()

const spec = computed(() => props.ctx.object?.spec?.template?.spec ?? {})
const running = computed(() => props.ctx.related.vmi?.status?.phase === 'Running')

const storageClasses = useWatch({ apiVersion: 'storage.k8s.io/v1', resource: 'storageclasses' })
const defaultClass = computed(
  () => storageClasses.items.value.find((sc) => sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true')?.metadata.name ?? '',
)

const form = reactive({
  source: props.cdrom ? 'existing' : 'blank',
  name: nextName(props.cdrom ? 'cdrom' : 'disk', disksOf(spec.value).map((d) => d.name)),
  size: '20Gi',
  storageClass: '',
  claim: '',
  bus: props.cdrom ? 'sata' : 'virtio',
  bootOrder: '' as number | '',
  hotplug: running.value && !props.cdrom,
})

/** Claims in the namespace no volume of this VM already uses. */
const claims = computed(() => {
  const used = new Set(volumesOf(spec.value).map((v) => volumeInfo(v).claim).filter(Boolean))
  return inv.pvcs.filter((p) => p.metadata.namespace === props.ctx.namespace && !used.has(p.metadata.name))
})

const dvName = computed(() => `${props.ctx.name}-${form.name}`.slice(0, 63))

const busy = ref(false)
const error = ref<string | null>(null)
const touched = ref(false)

const problems = computed(() => {
  const out: string[] = []
  const nameProblem = validName(form.name)
  if (nameProblem) out.push(`Name: ${nameProblem}`)
  if (disksOf(spec.value).some((d) => d.name === form.name) || volumesOf(spec.value).some((v) => v.name === form.name)) out.push('Name: already used by this VM')
  if (form.source === 'blank') {
    const sizeProblem = validQuantity(form.size)
    if (sizeProblem) out.push(`Size: ${sizeProblem}`)
    if (inv.pvcs.some((p) => p.metadata.namespace === props.ctx.namespace && p.metadata.name === dvName.value)) out.push(`A disk named ${dvName.value} already exists; choose another name`)
  } else if (!form.claim) {
    out.push('Choose an existing disk')
  }
  return out
})

const hotplugging = computed(() => running.value && form.hotplug && !props.cdrom)

async function save() {
  touched.value = true
  if (problems.value.length) return
  busy.value = true
  error.value = null
  try {
    const storage: Record<string, any> = { resources: { requests: { storage: form.size.trim() } } }
    if (form.storageClass) storage.storageClassName = form.storageClass

    if (hotplugging.value) {
      let claim = form.claim
      let dataVolume = false
      if (form.source === 'blank') {
        await k8s.create(
          { apiVersion: 'cdi.kubevirt.io/v1beta1', resource: 'datavolumes', namespace: props.ctx.namespace },
          { apiVersion: 'cdi.kubevirt.io/v1beta1', kind: 'DataVolume', metadata: { name: dvName.value, namespace: props.ctx.namespace }, spec: { source: { blank: {} }, storage } },
        )
        claim = dvName.value
        dataVolume = true
      }
      const result = await gateway.call<{ task: string }>('vm.volume.add', {
        namespace: props.ctx.namespace,
        name: props.ctx.name,
        volume: form.name,
        claim,
        dataVolume,
        bus: 'scsi',
      })
      openTaskLog(result.task)
    } else {
      await updateVm(props.ctx, (vm) => {
        const current = vm.spec?.template?.spec ?? {}
        const disks = copy(disksOf(current))
        const volumes = copy(volumesOf(current))
        const disk: Record<string, any> = { name: form.name, [props.cdrom ? 'cdrom' : 'disk']: { bus: form.bus, ...(props.cdrom ? { readonly: true } : {}) } }
        if (form.bootOrder !== '') disk.bootOrder = Number(form.bootOrder)
        disks.push(disk)
        const patch: Record<string, any> = { spec: { template: { spec: { domain: { devices: { disks } }, volumes } } } }
        if (form.source === 'blank') {
          volumes.push({ name: form.name, dataVolume: { name: dvName.value } })
          patch.spec.dataVolumeTemplates = [
            ...copy(vm.spec?.dataVolumeTemplates ?? []),
            { metadata: { name: dvName.value }, spec: { source: { blank: {} }, storage } },
          ]
        } else {
          volumes.push({ name: form.name, persistentVolumeClaim: { claimName: form.claim } })
        }
        return patch
      })
    }
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="cdrom ? 'Add CD/DVD drive' : 'Add hard disk'" :icon="cdrom ? faCompactDisc : faHardDrive" width="560px" @close="emit('close')">
    <div class="space-y-3">
      <div v-if="!cdrom" class="flex gap-1">
        <button class="btn btn-sm" :class="form.source === 'blank' ? 'bg-surface-3' : 'btn-ghost'" @click="form.source = 'blank'">New blank disk</button>
        <button class="btn btn-sm" :class="form.source === 'existing' ? 'bg-surface-3' : 'btn-ghost'" @click="form.source = 'existing'">Existing disk</button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label">Device name</label>
          <input v-model="form.name" class="input mono" />
        </div>
        <div>
          <label class="label">Bus</label>
          <select v-model="form.bus" class="input" :disabled="hotplugging">
            <template v-if="cdrom">
              <option value="sata">SATA</option>
              <option value="scsi">SCSI</option>
            </template>
            <template v-else>
              <option value="virtio">VirtIO Block</option>
              <option value="scsi">SCSI</option>
              <option value="sata">SATA</option>
              <option value="usb">USB</option>
            </template>
          </select>
          <p v-if="hotplugging" class="mt-1 text-xs text-fg-muted">Hot-plugged disks use the SCSI bus.</p>
        </div>
        <template v-if="form.source === 'blank'">
          <div>
            <label class="label">Size</label>
            <input v-model="form.size" class="input" placeholder="20Gi" />
          </div>
          <div>
            <label class="label">Storage class</label>
            <select v-model="form.storageClass" class="input">
              <option value="">Default{{ defaultClass ? ` (${defaultClass})` : '' }}</option>
              <option v-for="sc in storageClasses.items.value" :key="sc.metadata.uid" :value="sc.metadata.name">{{ sc.metadata.name }} — {{ sc.provisioner }}</option>
            </select>
          </div>
        </template>
        <div v-else class="col-span-2">
          <label class="label">{{ cdrom ? 'Image (an ISO imported into a disk)' : 'Disk' }}</label>
          <select v-model="form.claim" class="input">
            <option value="" disabled>Choose…</option>
            <option v-for="pvc in claims" :key="pvc.metadata.uid" :value="pvc.metadata.name">
              {{ pvc.metadata.name }} — {{ bytes(quantity(pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage)) }}{{ pvc.status?.phase !== 'Bound' ? ` (${pvc.status?.phase})` : '' }}
            </option>
          </select>
          <p v-if="!claims.length" class="mt-1 text-xs text-fg-muted">No unused disks in {{ ctx.namespace }}. Import an ISO or image as a disk first.</p>
        </div>
        <div v-if="!hotplugging">
          <label class="label">Boot order</label>
          <input v-model.number="form.bootOrder" type="number" min="1" class="input" placeholder="not bootable" />
        </div>
      </div>
      <label v-if="running && !cdrom" class="flex items-start gap-2">
        <input v-model="form.hotplug" type="checkbox" class="mt-0.5 accent-[var(--accent)]" />
        <span>
          <span class="block">Hot-plug into the running VM</span>
          <span class="block text-xs text-fg-muted">Needs volume hotplug enabled in KubeVirt. Otherwise the disk is added to the definition and appears after a restart.</span>
        </span>
      </label>
      <Notice v-else-if="running" kind="info">The VM is running: the drive appears after its next restart.</Notice>
      <p v-if="form.source === 'blank'" class="text-xs text-fg-muted">
        Creates DataVolume <span class="mono">{{ dvName }}</span>{{ hotplugging ? '' : ', owned by the VM and removed with it' }}.
      </p>
      <Notice v-if="touched && problems.length" kind="warning">
        <div v-for="p in problems" :key="p">{{ p }}</div>
      </Notice>
      <Notice v-if="error" kind="error">{{ error }}</Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">{{ busy ? 'Adding…' : 'Add' }}</button>
    </template>
  </Modal>
</template>
