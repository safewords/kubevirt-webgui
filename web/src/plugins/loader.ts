/**
 * Installing plugins: the built-in ones, then any the server lists in
 * `GUI_PLUGIN_URLS`.
 *
 * An external plugin is an ES module whose default export is a `Plugin`. It
 * gets Vue and the GUI's API from `window.KubeVirtGui` rather than bundling
 * its own copies, so its components share this app's reactivity and stores.
 */
import * as Vue from 'vue'
import * as registryModule from './registry'
import { install, syncPlugins, type Plugin } from './registry'
import { watch } from 'vue'
import { gateway } from '@/api/gateway'
import { k8s, vmApi } from '@/api/k8s'
import * as dialogs from '@/services/dialogs'
import { useWatch, useObject } from '@/stores/watch'
import { can } from '@/stores/access'
import { useCluster } from '@/stores/cluster'
import core from './core'
import atomicUsb from './atomic-usb'

const builtins: Plugin[] = [core, atomicUsb]

declare global {
  interface Window {
    KubeVirtGui: Record<string, unknown>
  }
}

let installed = false

/** Expose the API for external plugins. */
export function exposeApi() {
  window.KubeVirtGui = {
    Vue,
    definePlugin: registryModule.definePlugin,
    registry: registryModule.registry,
    gateway,
    k8s,
    vmApi,
    dialogs,
    useWatch,
    useObject,
    can,
    /** Capability checks: `useCluster().has('group/version/resource')`. */
    useCluster,
    /** Build a Font Awesome icon from an SVG path, for plugins without the icon packages. */
    icon: (name: string, width: number, height: number, path: string) => ({ prefix: 'fas', iconName: name, icon: [width, height, [], '', path] }),
  }
}

/** Install everything, once the cluster's capabilities are known. */
export async function loadPlugins() {
  if (installed) return
  installed = true
  const cluster = useCluster()
  if (!cluster.discovery) await cluster.load()
  const has = (spec: string) => cluster.has(spec)

  for (const plugin of builtins) install(plugin, 'builtin', has)

  // Discovery is re-read every minute; follow it, so installing (or removing)
  // an integration's CRDs shows up without a reload.
  watch(() => cluster.discovery, () => syncPlugins(has))
  cluster.startPolling()

  for (const url of gateway.hello.value?.pluginUrls ?? []) {
    try {
      const module = await import(/* @vite-ignore */ url)
      const plugin = (module.default ?? module.plugin) as Plugin
      if (!plugin?.id || typeof plugin.setup !== 'function') throw new Error('the module does not export a plugin')
      install(plugin, 'external', has)
    } catch (e) {
      console.error(`could not load plugin from ${url}`, e)
      registryModule.registry.plugins.push({
        id: url,
        name: url,
        setup() {},
        source: 'external',
        active: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
}
