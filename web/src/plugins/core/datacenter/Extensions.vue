<script setup lang="ts">
import { computed } from 'vue'
import { faPuzzlePiece, faCircleCheck, faCircleMinus, faArrowsRotate } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { registry } from '@/plugins/registry'
import { gateway } from '@/api/gateway'
import { useCluster } from '@/stores/cluster'

defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const backend = computed(() => gateway.hello.value?.extensions ?? [])

// Integrations switch on and off by themselves within a minute of their CRDs
// being installed or removed; this looks now.
async function rescan() {
  await cluster.load(true)
}
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <div class="mb-1 flex items-center gap-2">
        <h3 class="panel-title">Server extensions</h3>
        <button class="btn btn-sm ml-auto" :disabled="cluster.loading" @click="rescan"><Fa :icon="faArrowsRotate" :spin="cluster.loading" /> Re-scan cluster</button>
      </div>
      <p class="mb-2 text-fg-muted">Compiled into the server. Each adds gateway methods and topics; disable one with <code class="mono">GUI_DISABLED_EXTENSIONS</code>.</p>
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div v-for="ext in backend" :key="ext.id" class="card p-3">
          <div class="flex items-center gap-2">
            <Fa :icon="faPuzzlePiece" class="text-accent" />
            <span class="font-semibold">{{ ext.name }}</span>
            <span class="chip">{{ ext.version }}</span>
            <span
              class="ml-auto text-xs"
              :class="ext.requires.every((r) => cluster.has(r)) ? 'text-ok' : 'text-warn'"
            >
              <Fa :icon="ext.requires.every((r) => cluster.has(r)) ? faCircleCheck : faCircleMinus" />
              {{ ext.requires.every((r) => cluster.has(r)) ? 'available' : 'cluster lacks its APIs' }}
            </span>
          </div>
          <p class="mt-1 text-fg-muted">{{ ext.description }}</p>
          <details class="mt-2 text-xs">
            <summary class="cursor-pointer text-fg-muted">{{ ext.methods.length }} methods · {{ ext.topics.length }} topics</summary>
            <div class="mono mt-1 flex flex-wrap gap-1">
              <span v-for="m in ext.methods" :key="m" class="chip">{{ m }}</span>
              <span v-for="t in ext.topics" :key="t" class="chip bg-info/15 text-info">⇄ {{ t }}</span>
            </div>
            <div v-if="ext.requires.length" class="mt-1 text-fg-subtle">requires {{ ext.requires.join(', ') }}</div>
          </details>
        </div>
      </div>
    </section>
    <section>
      <h3 class="panel-title mb-1">Browser plugins</h3>
      <p class="mb-2 text-fg-muted">Screens, actions and tree views. Built-in plugins ship with the GUI; more load from <code class="mono">GUI_PLUGIN_URLS</code>.</p>
      <div class="overflow-auto rounded-md border border-line bg-surface-1">
        <table class="table-dense">
          <thead><tr><th>Plugin</th><th>Source</th><th>Status</th><th>Contributes</th><th>Description</th></tr></thead>
          <tbody>
            <tr v-for="p in registry.plugins" :key="p.id">
              <td class="font-medium">{{ p.name }} <span class="mono text-fg-subtle">{{ p.id }}</span></td>
              <td>{{ p.source }}</td>
              <td :class="p.active ? 'text-ok' : 'text-warn'">{{ p.active ? 'active' : p.error }}</td>
              <td class="text-fg-muted">
                {{ registry.panels.filter((x) => x.plugin === p.id).length }} panels ·
                {{ registry.actions.filter((x) => x.plugin === p.id).length }} actions ·
                {{ registry.treeViews.filter((x) => x.plugin === p.id).length }} views
              </td>
              <td class="max-w-0 truncate whitespace-normal text-fg-muted">{{ p.description }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
