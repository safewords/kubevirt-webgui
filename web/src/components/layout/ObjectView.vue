<script setup lang="ts">
/**
 * One object on screen: its heading and toolbar, the panel menu down the
 * side, and the chosen panel. Everything but the frame comes from plugins.
 */
import { computed, reactive, watch } from 'vue'
import { useRouter } from 'vue-router'
import { faCircleQuestion } from '@fortawesome/free-solid-svg-icons'
import { registry, byOrder, type ActionDef, type ObjectContext, type PanelDef } from '@/plugins/registry'
import { useCluster } from '@/stores/cluster'
import { useObject, useWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { routeTo } from '@/util/nav'
import DropdownMenu, { type MenuItem } from '@/components/ui/DropdownMenu.vue'
import Notice from '@/components/ui/Notice.vue'

const props = defineProps<{ kind: string; name?: string; namespace?: string; panel?: string }>()
const router = useRouter()
const cluster = useCluster()

const kind = computed(() => registry.kinds[props.kind])
const ref_ = computed(() => ({ name: props.name ?? '', namespace: props.namespace }))

const primary = useObject(() => (kind.value?.resource && props.name ? kind.value.resource(ref_.value) : null))

// Related objects: a fixed set of keys per kind, each its own watch.
const relatedParams = computed(() => (kind.value?.related && props.name ? kind.value.related(ref_.value) : {}))
const relatedKeys = computed(() => Object.keys(relatedParams.value))
// Up to four related watches; a kind names which keys fill them.
const slots = [0, 1, 2, 3].map((index) => useWatch(() => {
  const key = relatedKeys.value[index]
  return key ? relatedParams.value[key] : null
}))

const ctx = reactive<ObjectContext>({
  kind: props.kind,
  name: props.name ?? '',
  namespace: props.namespace,
  object: null,
  related: {},
  synced: false,
})

watch(
  () => [props.kind, props.name, props.namespace, primary.object.value, primary.synced.value, relatedKeys.value, ...slots.map((s) => s.items.value)] as const,
  () => {
    ctx.kind = props.kind
    ctx.name = props.name ?? ''
    ctx.namespace = props.namespace
    ctx.object = primary.object.value
    ctx.synced = kind.value?.resource ? primary.synced.value : true
    const related: Record<string, any> = {}
    relatedKeys.value.forEach((key, index) => (related[key] = slots[index]?.items.value[0] ?? null))
    ctx.related = related
  },
  { immediate: true },
)

function available(def: { requires?: string[]; when?: (c: ObjectContext) => boolean; visible?: (c: ObjectContext) => boolean }) {
  if (def.requires && !def.requires.every((r) => cluster.has(r))) return false
  if ('when' in def && def.when && !def.when(ctx)) return false
  if ('visible' in def && def.visible && !def.visible(ctx)) return false
  return true
}

const panels = computed<PanelDef[]>(() => registry.panels.filter((p) => p.kind === props.kind && available(p)).sort(byOrder))
const activePanel = computed(() => panels.value.find((p) => p.id === props.panel) ?? panels.value.find((p) => p.id === kind.value?.defaultPanel) ?? panels.value[0])

const groupedPanels = computed(() => {
  const groups: Array<{ group: string | null; panels: PanelDef[] }> = []
  for (const panel of panels.value) {
    const group = panel.group ?? null
    const last = groups[groups.length - 1]
    if (last && last.group === group) last.panels.push(panel)
    else groups.push({ group, panels: [panel] })
  }
  return groups
})

function allowed(action: ActionDef): boolean | undefined {
  if (!action.access) return true
  const checks = action.access(ctx)
  const list = Array.isArray(checks) ? checks : [checks]
  let result: boolean | undefined = true
  for (const check of list) {
    const r = can(check)
    if (r === false) return false
    if (r === undefined) result = undefined
  }
  return result
}

const actions = computed(() => registry.actions.filter((a) => a.kind === props.kind && available(a)).sort(byOrder))
function title(action: ActionDef) {
  return typeof action.title === 'function' ? action.title(ctx) : action.title
}
function toItem(action: ActionDef): MenuItem {
  return {
    id: action.id,
    title: title(action),
    icon: action.icon,
    danger: action.danger,
    divider: action.divider,
    disabled: (action.enabled ? !action.enabled(ctx) : false) || allowed(action) !== true,
    run: () => action.run(ctx),
  }
}
const primaryActions = computed(() => actions.value.filter((a) => (a.group ?? 'primary') === 'primary'))
const menus = computed(() =>
  (['power', 'console', 'more'] as const)
    .map((group) => ({ group, items: actions.value.filter((a) => a.group === group).map(toItem) }))
    .filter((m) => m.items.length),
)
const menuTitles: Record<string, string> = { power: 'Shutdown', console: 'Console', more: 'More' }

const heading = computed(() => (kind.value?.heading ? kind.value.heading(ctx) : `${kind.value?.title ?? props.kind} ${props.name ?? ''}`))

function openPanel(panel: PanelDef) {
  router.push(routeTo({ kind: props.kind, name: props.name, namespace: props.namespace }, panel.id))
}
</script>

<template>
  <section v-if="kind" class="flex h-full min-h-0 flex-col bg-surface-0">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
      <Fa :icon="kind.icon" class="text-accent" />
      <h1 class="truncate text-[14px] font-semibold">{{ heading }}</h1>
      <component :is="kind.status" v-if="kind.status" :ctx="ctx" />
      <div class="ml-auto flex items-center gap-1.5">
        <button
          v-for="action in primaryActions"
          :key="action.id"
          class="btn"
          :class="action.danger ? 'btn-danger' : ''"
          :disabled="(action.enabled ? !action.enabled(ctx) : false) || allowed(action) !== true"
          :title="allowed(action) === false ? 'You do not have permission for this' : title(action)"
          @click="action.run(ctx)"
        >
          <Fa :icon="action.icon" />{{ title(action) }}
        </button>
        <DropdownMenu
          v-for="menu in menus"
          :key="menu.group"
          :items="menu.items"
          :split="menu.group === 'power'"
          :title="menu.group === 'power' ? undefined : menuTitles[menu.group]"
          :icon="menu.group === 'power' ? menu.items[0]?.icon : menu.group === 'console' ? registry.actions.find((a) => a.kind === kind.id && a.group === 'console')?.icon : undefined"
          align="right"
        />
      </div>
    </div>

    <div class="flex min-h-0 flex-1">
      <nav class="w-52 shrink-0 overflow-y-auto border-r border-line bg-surface-1 py-1.5">
        <template v-for="(g, gi) in groupedPanels" :key="gi">
          <div v-if="g.group" class="px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{{ g.group }}</div>
          <button
            v-for="panel in g.panels"
            :key="panel.id"
            class="flex h-8 w-full items-center gap-2.5 px-3 text-left"
            :class="activePanel?.id === panel.id ? 'bg-selection font-medium text-fg shadow-[inset_3px_0_0_var(--accent)]' : 'text-fg-muted hover:bg-surface-3 hover:text-fg'"
            @click="openPanel(panel)"
          >
            <Fa :icon="panel.icon" class="w-4" :class="activePanel?.id === panel.id ? 'text-accent' : ''" />
            <span class="truncate">{{ panel.title }}</span>
          </button>
        </template>
      </nav>

      <main class="min-w-0 flex-1 overflow-auto">
        <div v-if="kind.resource && ctx.synced && !ctx.object" class="p-4">
          <Notice kind="warning" :title="`${kind.title} not found`">
            <template v-if="primary.error.value">{{ primary.error.value.message }}</template>
            <template v-else>{{ namespace ? `${namespace}/` : '' }}{{ name }} does not exist, or you cannot see it.</template>
          </Notice>
        </div>
        <component :is="activePanel.component" v-else-if="activePanel" :key="`${kind.id}/${namespace}/${name}/${activePanel.id}`" :ctx="ctx" />
        <div v-else class="p-4">
          <Notice kind="empty">No panels are available here.</Notice>
        </div>
      </main>
    </div>
  </section>
  <div v-else class="p-6">
    <Notice kind="warning" title="Unknown object type"><Fa :icon="faCircleQuestion" /> Nothing is registered for “{{ props.kind }}”. Is the plugin that provides it enabled?</Notice>
  </div>
</template>
