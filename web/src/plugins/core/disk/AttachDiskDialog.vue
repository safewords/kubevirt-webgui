<script setup lang="ts">
/**
 * Add a disk to a VM: hot-plugged into a running guest, or written into the
 * definition of a stopped one.
 */
import { computed, ref, watch } from 'vue'
import { faLink } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import type { KObject } from '@/api/types'
import { gateway, errorMessage } from '@/api/gateway'
import { k8s } from '@/api/k8s'
import { useInventory } from '@/plugins/core/inventory'
import { isDnsLabel, toDnsLabel } from '@/util/format'
import { openTaskLog, toast } from '@/services/dialogs'
import { vmsUsing } from './helpers'

const props = defineProps<{ pvc: KObject; dataVolume?: KObject | null; vm?: string }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()

const namespace = props.pvc.metadata.namespace!
const vms = computed(() => inv.vms.filter((v) => v.metadata.namespace === namespace))
const vmName = ref(props.vm ?? '')
const vm = computed(() => vms.value.find((v) => v.metadata.name === vmName.value) ?? null)
const running = computed(() => (vm.value ? inv.vmiFor(vm.value)?.status?.phase === 'Running' : false))
const volume = ref(toDnsLabel(props.pvc.metadata.name))
const bus = ref('virtio')
const cdrom = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

watch(running, (r) => {
  if (r) {
    bus.value = 'scsi'
    cdrom.value = false
  }
})

const usedBy = computed(() => vmsUsing(namespace, props.pvc.metadata.name))
const nameTaken = computed(() => (vm.value?.spec?.template?.spec?.volumes ?? []).some((v: any) => v.name === volume.value))
const accessModes = computed<string[]>(() => props.pvc.spec?.accessModes ?? [])

async function save() {
  if (!vm.value) return
  error.value = null
  busy.value = true
  try {
    if (running.value) {
      const result = await gateway.call<{ task: string }>('vm.volume.add', {
        namespace,
        name: vm.value.metadata.name,
        volume: volume.value,
        claim: props.pvc.metadata.name,
        bus: 'scsi',
        dataVolume: !!props.dataVolume,
      })
      openTaskLog(result.task)
    } else {
      const spec = vm.value.spec?.template?.spec ?? {}
      const volumes = [...(spec.volumes ?? [])]
      const disks = [...(spec.domain?.devices?.disks ?? [])]
      volumes.push(props.dataVolume ? { name: volume.value, dataVolume: { name: props.pvc.metadata.name } } : { name: volume.value, persistentVolumeClaim: { claimName: props.pvc.metadata.name } })
      disks.push(cdrom.value ? { name: volume.value, cdrom: { bus: bus.value === 'virtio' ? 'sata' : bus.value } } : { name: volume.value, disk: { bus: bus.value } })
      await k8s.patch(
        { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', namespace, name: vm.value.metadata.name },
        {
          // The resource version makes this fail rather than drop a concurrent change.
          metadata: { resourceVersion: vm.value.metadata.resourceVersion },
          spec: { template: { spec: { volumes, domain: { devices: { disks } } } } },
        },
      )
      toast('success', 'Disk attached', `${props.pvc.metadata.name} → ${vm.value.metadata.name} as ${volume.value}`)
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
  <Modal :title="`Attach ${pvc.metadata.name} to a VM`" :icon="faLink" width="520px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <div>
        <label class="label">Virtual machine in {{ namespace }}</label>
        <select v-model="vmName" class="input">
          <option value="" disabled>choose a VM</option>
          <option v-for="v in vms" :key="v.metadata.uid" :value="v.metadata.name">{{ v.metadata.name }}{{ inv.vmiFor(v)?.status?.phase === 'Running' ? ' (running)' : '' }}</option>
        </select>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">Device name</label>
          <input v-model="volume" class="input mono" />
        </div>
        <div>
          <label class="label">Bus</label>
          <select v-model="bus" class="input" :disabled="running">
            <option value="virtio">VirtIO</option>
            <option value="scsi">SCSI</option>
            <option value="sata">SATA</option>
          </select>
        </div>
      </div>
      <label v-if="!running" class="flex items-center gap-2"><input v-model="cdrom" type="checkbox" class="accent-[var(--accent)]" /> Attach as CD/DVD drive (for ISO images)</label>
      <Notice v-if="running" kind="info">The VM is running: the disk is hot-plugged on the SCSI bus and kept in the VM's definition.</Notice>
      <Notice v-if="nameTaken" kind="warning">The VM already has a device called {{ volume }}.</Notice>
      <Notice v-if="usedBy.length && !accessModes.includes('ReadWriteMany')" kind="warning">
        Already used by {{ usedBy.map((v) => v.metadata.name).join(', ') }}, and the claim is not ReadWriteMany: two VMs cannot run with it at the same time.
      </Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !vm || !isDnsLabel(volume) || nameTaken" @click="save">{{ running ? 'Hotplug' : 'Attach' }}</button>
    </template>
  </Modal>
</template>
