<script setup lang="ts">
/** Boot order across disks and network devices, reordered by hand. */
import { ref } from 'vue'
import { faListOl, faArrowUp, faArrowDown, faHardDrive, faCompactDisc, faNetworkWired } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { errorMessage } from '@/api/gateway'
import { copy, diskBus, diskType, disksOf, interfacesOf } from './spec'
import { updateTemplate } from './update'

const props = defineProps<{ ctx: ObjectContext }>()
const emit = defineEmits<{ close: [result?: boolean] }>()

interface Entry {
  kind: 'disk' | 'nic'
  name: string
  label: string
  enabled: boolean
  order: number
}

const spec = props.ctx.object?.spec?.template?.spec ?? {}
const entries = ref<Entry[]>(
  [
    ...disksOf(spec).map((d) => ({ kind: 'disk' as const, name: d.name, label: `${diskType(d) === 'cdrom' ? 'CD/DVD' : 'Disk'} ${d.name} (${diskBus(d)})`, enabled: !!d.bootOrder, order: d.bootOrder ?? 1000 })),
    ...interfacesOf(spec).map((i) => ({ kind: 'nic' as const, name: i.name, label: `Network ${i.name} (PXE)`, enabled: !!i.bootOrder, order: i.bootOrder ?? 1000 })),
  ].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.order - b.order),
)
const busy = ref(false)
const error = ref<string | null>(null)

function move(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= entries.value.length) return
  const list = [...entries.value]
  ;[list[index], list[target]] = [list[target], list[index]]
  entries.value = list
}

async function save() {
  busy.value = true
  error.value = null
  try {
    await updateTemplate(props.ctx, (current) => {
      const disks = copy(disksOf(current))
      const interfaces = copy(interfacesOf(current))
      let order = 1
      for (const entry of entries.value) {
        const item = (entry.kind === 'disk' ? disks : interfaces).find((x: any) => x.name === entry.name)
        if (!item) continue
        if (entry.enabled) item.bootOrder = order++
        else delete item.bootOrder
      }
      const patch: Record<string, any> = { domain: { devices: { disks } } }
      if (interfaces.length) patch.domain.devices.interfaces = interfaces
      return patch
    })
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Boot order" :icon="faListOl" width="500px" @close="emit('close')">
    <p class="mb-3 text-fg-muted">Tick the devices to boot from and arrange them; the first bootable device wins. With none ticked, the firmware's default order is used.</p>
    <div class="overflow-hidden rounded-md border border-line">
      <div v-for="(entry, index) in entries" :key="`${entry.kind}/${entry.name}`" class="flex h-9 items-center gap-2.5 border-b border-line/60 px-2.5 last:border-b-0">
        <input v-model="entry.enabled" type="checkbox" class="accent-[var(--accent)]" />
        <span class="w-5 text-right text-fg-subtle tabular-nums">{{ entry.enabled ? entries.filter((e, i) => e.enabled && i <= index).length : '' }}</span>
        <Fa :icon="entry.kind === 'nic' ? faNetworkWired : entry.label.startsWith('CD') ? faCompactDisc : faHardDrive" class="w-4 text-fg-muted" />
        <span class="flex-1" :class="entry.enabled ? '' : 'text-fg-subtle'">{{ entry.label }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="index === 0" aria-label="Move up" @click="move(index, -1)"><Fa :icon="faArrowUp" /></button>
        <button class="btn btn-ghost btn-sm" :disabled="index === entries.length - 1" aria-label="Move down" @click="move(index, 1)"><Fa :icon="faArrowDown" /></button>
      </div>
      <div v-if="!entries.length" class="p-3 text-center text-fg-subtle">No disks or network devices</div>
    </div>
    <Notice v-if="error" kind="error" class="mt-3">{{ error }}</Notice>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'OK' }}</button>
    </template>
  </Modal>
</template>
