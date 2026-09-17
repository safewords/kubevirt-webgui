// An external plugin, loaded at runtime without rebuilding the GUI.
//
//   GUI_PLUGIN_DIR=examples/plugins kubevirt-webgui serve
//
// Every `*.js` file in that directory is served at `/plugins/<file>` and
// imported by the browser after sign-in. A plugin gets Vue and the GUI's API
// from `window.KubeVirtGui`, so it shares the app's reactivity, stores and
// socket instead of bundling its own copies.
//
// This one adds:
//   - a VM panel "SSH" listing the guest's addresses and ready-to-copy commands
//   - a VM action "Copy SSH command" in the More menu
//   - a datacenter panel "Guests by OS" built from a live watch

const { Vue, definePlugin, useWatch, dialogs, icon } = window.KubeVirtGui
const { h, computed, defineComponent } = Vue

// Font Awesome "terminal" (CC BY 4.0), as a plain icon definition.
const terminal = icon('ssh-terminal', 576, 512, 'M9.4 86.6C-3.1 74.1-3.1 53.9 9.4 41.4s32.8-12.5 45.3 0l192 192c12.5 12.5 12.5 32.8 0 45.3l-192 192c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L178.7 256 9.4 86.6zM256 416H544c17.7 0 32 14.3 32 32s-14.3 32-32 32H256c-17.7 0-32-14.3-32-32s14.3-32 32-32z')
// Font Awesome "chart-pie" (CC BY 4.0).
const pie = icon('os-pie', 576, 512, 'M304 240V16.6c0-9 7-16.6 16-16.6C443.7 0 544 100.3 544 224c0 9-7.6 16-16.6 16H304zM32 272C32 150.7 122.1 50.3 239 34.3c9.2-1.3 17 6.1 17 15.4V288L412.5 444.5c6.7 6.7 6.2 17.7-1.5 23.1C371.8 495.6 323.8 512 272 512C139.5 512 32 404.6 32 272zm526.4 16c9.3 0 16.6 7.8 15.4 17c-7.7 55.9-34.6 105.6-73.9 142.3c-6 5.6-15.4 5.2-21.2-.7L320 288H558.4z')

function addresses(vmi) {
  return (vmi?.status?.interfaces ?? []).flatMap((i) => i.ipAddresses ?? (i.ipAddress ? [i.ipAddress] : []))
}

const SshPanel = defineComponent({
  props: { ctx: { type: Object, required: true } },
  setup(props) {
    const ips = computed(() => addresses(props.ctx.related.vmi))
    const copy = async (text) => {
      await navigator.clipboard.writeText(text)
      dialogs.toast('success', 'Copied', text)
    }
    return () =>
      h('div', { class: 'space-y-3 p-3' }, [
        h('p', { class: 'text-fg-muted' }, 'Guest addresses reported by the guest agent. Pod-network addresses are reachable from inside the cluster; expose a Service to reach the VM from outside.'),
        ips.value.length === 0
          ? h('div', { class: 'card p-4 text-fg-subtle' }, 'The guest has not reported any addresses. Is it running with the guest agent?')
          : h('div', { class: 'card divide-y divide-line' },
              ips.value.map((ip) =>
                h('div', { class: 'flex items-center gap-3 px-3 py-2' }, [
                  h('span', { class: 'mono w-40' }, ip),
                  h('code', { class: 'mono flex-1 truncate text-fg-muted' }, `ssh fedora@${ip}`),
                  h('button', { class: 'btn btn-sm', onClick: () => copy(`ssh fedora@${ip}`) }, 'Copy'),
                ]),
              ),
            ),
        h('p', { class: 'text-xs text-fg-subtle' }, 'Loaded from /plugins/ssh-helper.js — an example of a runtime plugin.'),
      ])
  },
})

const GuestsByOs = defineComponent({
  props: { ctx: { type: Object, required: true } },
  setup() {
    const vmis = useWatch({ apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstances' })
    const rows = computed(() => {
      const counts = new Map()
      for (const vmi of vmis.items.value) {
        const os = vmi.status?.guestOSInfo?.prettyName || vmi.status?.guestOSInfo?.name || 'unknown (no guest agent)'
        counts.set(os, (counts.get(os) ?? 0) + 1)
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])
    })
    return () =>
      h('div', { class: 'p-3' }, [
        h('table', { class: 'table-dense card overflow-hidden' }, [
          h('thead', [h('tr', [h('th', 'Operating system'), h('th', { class: 'text-right' }, 'Running guests')])]),
          h('tbody', rows.value.map(([os, count]) => h('tr', [h('td', os), h('td', { class: 'text-right tabular-nums' }, count)]))),
        ]),
      ])
  },
})

export default definePlugin({
  id: 'ssh-helper',
  name: 'SSH helper (example)',
  version: '1.0.0',
  description: 'Example runtime plugin: SSH commands for guests and a guests-by-OS report.',
  requires: ['kubevirt.io/v1/virtualmachineinstances'],
  setup(api) {
    api.panel({ id: 'ssh', kind: 'vm', title: 'SSH', icon: terminal, order: 25, component: SshPanel })
    api.panel({ id: 'guests-by-os', kind: 'datacenter', title: 'Guests by OS', icon: pie, order: 15, component: GuestsByOs })
    api.action({
      id: 'copy-ssh',
      kind: 'vm',
      group: 'more',
      order: 10,
      title: 'Copy SSH command',
      icon: terminal,
      enabled: (ctx) => addresses(ctx.related.vmi).length > 0,
      run: async (ctx) => {
        const command = `ssh fedora@${addresses(ctx.related.vmi)[0]}`
        await navigator.clipboard.writeText(command)
        dialogs.toast('success', 'Copied', command)
      },
    })
  },
})
