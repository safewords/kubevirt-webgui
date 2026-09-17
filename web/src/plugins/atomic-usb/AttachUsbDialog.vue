<script setup lang="ts">
/** Choose a device and a VM, and claim the one for the other. */
import { computed, ref } from 'vue'
import { faUsb } from '@fortawesome/free-brands-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import type { KObject } from '@/api/types'
import { gateway, errorMessage } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import { openTaskLog } from '@/services/dialogs'
import { isDnsLabel } from '@/util/format'
import { deviceLabel, useUsb } from './store'

const props = defineProps<{ device?: KObject | null; namespace?: string; vm?: string }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()
const usb = useUsb()

const deviceName = ref(props.device?.metadata.name ?? '')
const target = ref(props.namespace && props.vm ? `${props.namespace}/${props.vm}` : '')
const claim = ref('')
const follow = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)

const available = computed(() => usb.devices.filter((d) => !d.status?.attachedTo || d.metadata.name === deviceName.value))
const device = computed(() => usb.devices.find((d) => d.metadata.name === deviceName.value) ?? props.device ?? null)
const vms = computed(() => inv.vms.map((v) => `${v.metadata.namespace}/${v.metadata.name}`))
const canFollow = computed(() => !!device.value?.spec?.serial && String(device.value?.spec?.identity ?? '').startsWith('Serial'))
const targetVm = computed(() => {
  const [ns, name] = target.value.split('/')
  return inv.vms.find((v) => v.metadata.namespace === ns && v.metadata.name === name) ?? null
})
const vmNode = computed(() => (targetVm.value ? inv.vmiFor(targetVm.value)?.status?.nodeName : null))

async function save() {
  const [namespace, vm] = target.value.split('/')
  error.value = null
  busy.value = true
  try {
    const result = await gateway.call<{ task: string }>('usb.attach', {
      namespace,
      vm,
      device: deviceName.value,
      claim: claim.value.trim() || undefined,
      follow: follow.value && canFollow.value,
    })
    openTaskLog(result.task)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Attach USB device" :icon="faUsb" width="540px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <div>
        <label class="label">Device</label>
        <select v-model="deviceName" class="input">
          <option value="" disabled>choose a device</option>
          <option v-for="d in available" :key="d.metadata.uid" :value="d.metadata.name" :disabled="d.status?.phase !== 'Available'">
            {{ deviceLabel(d) }} — {{ d.status?.node ?? 'no node' }} {{ d.status?.portPath ? `port ${d.status.portPath}` : '' }}{{ d.status?.phase !== 'Available' ? ` (${d.status?.phase})` : '' }}
          </option>
        </select>
      </div>
      <div>
        <label class="label">Virtual machine</label>
        <select v-model="target" class="input">
          <option value="" disabled>choose a VM</option>
          <option v-for="v in vms" :key="v" :value="v">{{ v }}</option>
        </select>
      </div>
      <div>
        <label class="label">Claim name (optional)</label>
        <input v-model="claim" class="input mono" placeholder="generated from the VM and device" />
      </div>
      <label class="flex items-start gap-2" :class="canFollow ? '' : 'opacity-60'">
        <input v-model="follow" type="checkbox" class="mt-0.5 accent-[var(--accent)]" :disabled="!canFollow" />
        <span>
          Follow the device by serial number
          <span class="block text-xs text-fg-muted">{{ canFollow ? 'Re-attaches it wherever it is plugged in, on any node.' : 'This device has no usable serial; it is pinned by name.' }}</span>
        </span>
      </label>
      <Notice v-if="device && vmNode && device.status?.node && device.status.node !== vmNode" kind="info">
        The device is on {{ device.status.node }} and the VM runs on {{ vmNode }}: USB traffic is forwarded over the pod network (unencrypted).
      </Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !deviceName || !target || (!!claim.trim() && !isDnsLabel(claim.trim()))" @click="save">Attach</button>
    </template>
  </Modal>
</template>
