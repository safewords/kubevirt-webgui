/**
 * The plugin API.
 *
 * Everything on screen past the frame — every tab of every object, every
 * toolbar button, every entry in the resource tree and the create menu — is
 * contributed by a plugin. The built-in screens are plugins too, registered
 * the same way a third-party one is, so anything they can do an extension can.
 *
 * ```ts
 * export default definePlugin({
 *   id: 'backups',
 *   name: 'Backups',
 *   requires: ['backup.kubevirt.io/v1alpha1/virtualmachinebackups'],
 *   setup(api) {
 *     api.panel({ id: 'backups', kind: 'vm', title: 'Backup', icon: faBoxArchive, component: BackupPanel })
 *     api.action({ id: 'backup-now', kind: 'vm', group: 'more', title: 'Backup now', icon: faBoxArchive,
 *                  run: ({ object }) => api.call('backup.create', { … }) })
 *   },
 * })
 * ```
 */
import { markRaw, reactive, type Component } from 'vue'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { KObject, WatchParams } from '@/api/types'
import type { AccessCheck } from '@/stores/access'

/** An object on screen: what panels and actions receive. */
export interface ObjectContext {
  kind: string
  name: string
  namespace?: string
  /** The primary object, live. `null` for kinds without one (the datacenter) or while loading. */
  object: KObject | null
  /** Related objects the kind declared, live — for a VM, its `vmi`. */
  related: Record<string, KObject | null>
  synced: boolean
}

export interface KindDef {
  /** `vm`, `node`, `namespace`, … — also the route segment. */
  id: string
  title: string
  icon: IconDefinition
  scope: 'none' | 'cluster' | 'namespaced'
  /** The object this kind shows, by name. */
  resource?: (ref: { name: string; namespace?: string }) => WatchParams | null
  /** Other live objects the panels want, by key. */
  related?: (ref: { name: string; namespace?: string }) => Record<string, WatchParams | null>
  /** The heading shown above the panels. */
  heading?: (ctx: ObjectContext) => string
  /** A small status component shown beside the heading. */
  status?: Component
  defaultPanel?: string
}

export interface PanelDef {
  id: string
  kind: string
  title: string
  icon: IconDefinition
  order?: number
  /** Panels sharing a group are shown under one heading in the side menu. */
  group?: string
  component: Component
  /** API resources that must exist (`group/version/resource`, or a group). */
  requires?: string[]
  when?: (ctx: ObjectContext) => boolean
}

export type ActionGroup = 'primary' | 'power' | 'console' | 'more'

export interface ActionDef {
  id: string
  kind: string
  title: string | ((ctx: ObjectContext) => string)
  icon: IconDefinition
  group?: ActionGroup
  order?: number
  danger?: boolean
  requires?: string[]
  /** Hide the action entirely. */
  visible?: (ctx: ObjectContext) => boolean
  /** Show it, but greyed out. */
  enabled?: (ctx: ObjectContext) => boolean
  /** RBAC the action needs; the button is disabled when the user lacks it. */
  access?: (ctx: ObjectContext) => AccessCheck | AccessCheck[]
  run: (ctx: ObjectContext) => unknown | Promise<unknown>
  /** Ends up as a separator before this action in its menu. */
  divider?: boolean
}

export interface TreeNode {
  key: string
  label: string
  /** Secondary text, dimmed. */
  hint?: string
  icon: IconDefinition
  /** A Tailwind text colour class for the icon — status at a glance. */
  iconClass?: string
  /** A small overlay: `running`, `paused`, `stopped`, `error`, `migrating`, `locked`. */
  badge?: 'running' | 'paused' | 'stopped' | 'error' | 'migrating' | 'warning' | 'pending'
  /** Where the node leads; `panel` opens a specific panel of that object. */
  to?: { kind: string; name?: string; namespace?: string; panel?: string }
  children?: TreeNode[]
  tags?: string[]
}

export interface TreeViewDef {
  id: string
  title: string
  order?: number
  /** API resources that must exist for the view to be offered. */
  requires?: string[]
  /** Build the tree. Runs inside a computed: read live data freely. */
  build: () => TreeNode[]
  /** Set up whatever live data `build` reads. Called once, in a component scope. */
  setup?: () => void
}

export interface CreateItemDef {
  id: string
  title: string
  icon: IconDefinition
  order?: number
  requires?: string[]
  primary?: boolean
  run: () => unknown
}

export interface SettingsSectionDef {
  id: string
  title: string
  icon: IconDefinition
  order?: number
  component: Component
}

export interface PluginApi {
  kind(def: KindDef): void
  panel(def: PanelDef): void
  action(def: ActionDef): void
  treeView(def: TreeViewDef): void
  createItem(def: CreateItemDef): void
  settings(def: SettingsSectionDef): void
}

export interface Plugin {
  id: string
  name: string
  version?: string
  description?: string
  /** The plugin is skipped when the cluster lacks any of these. */
  requires?: string[]
  setup(api: PluginApi): void
  /**
   * Undo anything `setup` started outside the registry: stores, timers.
   * Called when the cluster stops serving what the plugin requires; its
   * panels, actions and views are removed automatically.
   */
  teardown?(): void
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}

/** Every contribution, reactive so a plugin loaded late appears at once. */
export const registry = reactive({
  plugins: [] as Array<Plugin & { source: 'builtin' | 'external'; active: boolean; error?: string }>,
  kinds: {} as Record<string, KindDef & { plugin?: string }>,
  panels: [] as Array<PanelDef & { plugin: string }>,
  actions: [] as Array<ActionDef & { plugin: string }>,
  treeViews: [] as Array<TreeViewDef & { plugin: string }>,
  createItems: [] as Array<CreateItemDef & { plugin: string }>,
  settings: [] as Array<SettingsSectionDef & { plugin: string }>,
})

function apiFor(pluginId: string): PluginApi {
  const raw = <T extends { component?: Component }>(def: T): T => (def.component ? { ...def, component: markRaw(def.component) } : def)
  return {
    kind(def) {
      registry.kinds[def.id] = { ...def, status: def.status ? markRaw(def.status) : undefined, plugin: pluginId }
    },
    panel(def) {
      registry.panels = registry.panels.filter((p) => !(p.kind === def.kind && p.id === def.id))
      registry.panels.push({ ...raw(def), plugin: pluginId })
    },
    action(def) {
      registry.actions = registry.actions.filter((a) => !(a.kind === def.kind && a.id === def.id))
      registry.actions.push({ ...def, plugin: pluginId })
    },
    treeView(def) {
      registry.treeViews = registry.treeViews.filter((t) => t.id !== def.id)
      registry.treeViews.push({ ...def, plugin: pluginId })
    },
    createItem(def) {
      registry.createItems = registry.createItems.filter((c) => c.id !== def.id)
      registry.createItems.push({ ...def, plugin: pluginId })
    },
    settings(def) {
      registry.settings = registry.settings.filter((s) => s.id !== def.id)
      registry.settings.push({ ...raw(def), plugin: pluginId })
    },
  }
}

type PluginEntry = Plugin & { source: 'builtin' | 'external'; active: boolean; error?: string }

/** Remove everything a plugin contributed. */
function withdraw(pluginId: string) {
  registry.panels = registry.panels.filter((p) => p.plugin !== pluginId)
  registry.actions = registry.actions.filter((a) => a.plugin !== pluginId)
  registry.treeViews = registry.treeViews.filter((t) => t.plugin !== pluginId)
  registry.createItems = registry.createItems.filter((c) => c.plugin !== pluginId)
  registry.settings = registry.settings.filter((c) => c.plugin !== pluginId)
  for (const [id, kind] of Object.entries(registry.kinds)) {
    if (kind.plugin === pluginId) delete registry.kinds[id]
  }
}

function activate(entry: PluginEntry, has: (spec: string) => boolean) {
  const missing = (entry.requires ?? []).filter((r) => !has(r))
  if (missing.length) {
    entry.active = false
    entry.error = `cluster lacks ${missing.join(', ')}`
    return
  }
  try {
    entry.setup(apiFor(entry.id))
    entry.active = true
    entry.error = undefined
  } catch (e) {
    withdraw(entry.id)
    entry.active = false
    entry.error = e instanceof Error ? e.message : String(e)
    console.error(`plugin ${entry.id} failed to set up`, e)
  }
}

function deactivate(entry: PluginEntry, reason: string) {
  withdraw(entry.id)
  try {
    entry.teardown?.()
  } catch (e) {
    console.error(`plugin ${entry.id} failed to tear down`, e)
  }
  entry.active = false
  entry.error = reason
}

/** Install a plugin. `has` answers whether the cluster serves a resource. */
export function install(plugin: Plugin, source: 'builtin' | 'external', has: (spec: string) => boolean) {
  const existing = registry.plugins.find((p) => p.id === plugin.id)
  if (existing?.active) return
  registry.plugins = [...registry.plugins.filter((p) => p.id !== plugin.id), { ...plugin, source, active: false }]
  // Work on the reactive copy so the Extensions screen follows along.
  activate(registry.plugins.find((p) => p.id === plugin.id)!, has)
}

/**
 * Bring plugins in line with what the cluster serves now: a plugin whose
 * CRDs were just installed comes alive, one whose CRDs were removed goes
 * away, without a reload. Integrations are optional by construction.
 */
export function syncPlugins(has: (spec: string) => boolean) {
  for (const entry of registry.plugins) {
    const missing = (entry.requires ?? []).filter((r) => !has(r))
    if (entry.active && missing.length) {
      deactivate(entry, `cluster lacks ${missing.join(', ')}`)
      console.info(`plugin ${entry.id} deactivated: ${entry.error}`)
    } else if (!entry.active && !missing.length && entry.error?.startsWith('cluster lacks')) {
      activate(entry, has)
      if (entry.active) console.info(`plugin ${entry.id} activated`)
    }
  }
}

export function byOrder<T extends { order?: number; title?: unknown }>(a: T, b: T): number {
  return (a.order ?? 100) - (b.order ?? 100)
}
