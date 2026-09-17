<script setup lang="ts">
import { computed } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import Notice from '@/components/ui/Notice.vue'
import UsbDevicesTable from './UsbDevicesTable.vue'
import { useUsb } from './store'

const props = defineProps<{ ctx: ObjectContext }>()
const usb = useUsb()
const devices = computed(() => usb.devices.filter((d) => d.status?.node === props.ctx.name))
const claimsHere = computed(() => usb.claims.filter((c) => c.status?.connection?.node === props.ctx.name))
</script>

<template>
  <div class="space-y-3 p-3">
    <h3 class="panel-title">USB devices plugged into {{ ctx.name }}</h3>
    <Notice v-if="usb.devicesError" kind="warning">{{ usb.devicesError.message }}</Notice>
    <UsbDevicesTable v-else :devices="devices" :show-node="false" :loading="!usb.devicesSynced" />
    <p v-if="claimsHere.length" class="text-fg-muted">
      Guests on this node also receive {{ claimsHere.length }} device{{ claimsHere.length === 1 ? '' : 's' }} forwarded from other nodes:
      <span v-for="c in claimsHere" :key="c.metadata.uid" class="chip ml-1">{{ c.status?.deviceName }} → {{ c.spec?.vmName }}</span>
    </p>
  </div>
</template>
