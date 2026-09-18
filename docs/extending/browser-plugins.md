# Browser plugins

Every screen you see is a plugin. The Datacenter, Node, Namespace, VM and Disk
screens are registered through exactly the API below
(`web/src/plugins/core/`), so a plugin of your own can do anything they do —
there is no privileged path they take that you cannot.

- [A plugin](#a-plugin)
- [The extension points](#the-extension-points)
- [Object context](#object-context)
- [Requirements](#requirements)
- [Permissions](#permissions)
- [Talking to the cluster](#talking-to-the-cluster)
- [Built-in or runtime](#built-in-or-runtime)
- [Runtime plugins](#runtime-plugins)
- [Lifecycle](#lifecycle)

## A plugin

```ts
import { definePlugin } from '@/plugins/registry'

export default definePlugin({
  id: 'backups',
  name: 'Backups',
  version: '1.0.0',
  description: 'Scheduled VM backups.',
  requires: ['backup.kubevirt.io/v1alpha1/virtualmachinebackups'],
  setup(api) {
    api.panel({ id: 'backups', kind: 'vm', title: 'Backup', icon: faBoxArchive, order: 70,
                component: BackupPanel })

    api.action({
      id: 'backup-now', kind: 'vm', group: 'more', title: 'Back up now', icon: faBoxArchive,
      access: (ctx) => ({ verb: 'create', group: 'backup.kubevirt.io',
                          resource: 'virtualmachinebackups', namespace: ctx.namespace }),
      run: (ctx) => gateway.call('backup.now', { namespace: ctx.namespace, name: ctx.name }),
    })
  },
  teardown() { /* stop timers and stores started in setup */ },
})
```

Built-in plugins are listed in `web/src/plugins/loader.ts`; runtime ones need
no rebuild at all (below).

## The extension points

`PluginApi` (`web/src/plugins/registry.ts`) has six:

| Call | Adds | Key fields |
|---|---|---|
| `api.kind(def)` | a new object type with its own screen and route | `id`, `title`, `icon`, `scope`, `resource()`, `related()`, `heading()`, `status`, `defaultPanel` |
| `api.panel(def)` | a tab on an object's screen | `kind`, `title`, `icon`, `order`, `group`, `component`, `requires`, `when(ctx)` |
| `api.action(def)` | a button or menu entry | `kind`, `title`, `icon`, `group`, `danger`, `visible(ctx)`, `enabled(ctx)`, `access(ctx)`, `run(ctx)` |
| `api.treeView(def)` | an entry in the view selector, with its own tree | `title`, `order`, `requires`, `build()`, `setup()` |
| `api.createItem(def)` | an entry in the **Create** menu | `title`, `icon`, `order`, `primary`, `run()` |
| `api.settings(def)` | a section in **My Settings** | `title`, `icon`, `order`, `component` |

Actions fall into four groups — `primary`, `power`, `console`, `more` — which
is what decides whether one appears as a button or inside the menu. `order`
sorts within a group; the built-ins leave gaps (10, 20, 30) so a plugin can
land between them.

A tree node carries a `badge` (`running`, `paused`, `stopped`, `error`,
`migrating`, `warning`, `pending`) and an `iconClass`, which is how state shows
at a glance without opening anything.

## Object context

Panels, actions and `when`/`visible`/`enabled` receive an `ObjectContext`:

```ts
{ kind: 'vm', name: 'db', namespace: 'prod',
  object: { /* the VirtualMachine, live */ },
  related: { vmi: { /* the VirtualMachineInstance, live */ } },
  synced: true }
```

`object` and `related` are **live**: they come from watches the kind declared,
so a panel re-renders when the cluster changes without polling anything.
`synced` is false while the first `SYNC` is still on its way — that is what to
render a skeleton on, rather than on `object === null`, which also means "this
kind has no primary object".

## Requirements

`requires` on the plugin, a panel, an action or a tree view lists API resources
as `group/version/resource`, or just a group. Anything whose requirements the
cluster does not serve is not registered, so there is never a screen that can
only fail.

This is re-evaluated while the GUI runs (discovery is re-read every minute). A
plugin whose CRD is installed appears without a reload; one whose CRD is
removed has its panels, actions and views withdrawn and `teardown()` called.

## Permissions

`access(ctx)` returns one `AccessCheck` or several. The result greys the button
out when the user lacks the permission, using batched
`SelfSubjectAccessReview`s — the same mechanism the built-in actions use, and
the same answers `kubectl auth can-i` would give.

```ts
access: (ctx) => [
  { verb: 'create', group: 'backup.kubevirt.io', resource: 'virtualmachinebackups', namespace: ctx.namespace },
  { verb: 'get', group: 'kubevirt.io', resource: 'virtualmachines', namespace: ctx.namespace },
]
```

Greying out is a courtesy, not the enforcement: the API server still refuses
the request, and its message is what the user sees if the two disagree.

## Talking to the cluster

| Helper | For |
|---|---|
| `gateway.call(method, params)` | any gateway method, including your extension's |
| `k8s.list/get/create/replace/patch/delete` | the generic `resource.*` methods, typed |
| `vmApi` | the VM-specific calls (power, migrate, snapshot, …) |
| `useWatch(params)` | a live list, backed by the `watch` topic |
| `useObject(params)` | a single live object |
| `can(check)` | a permission check |
| `useCluster().has('group/version/resource')` | is this API served |
| `dialogs` | the confirm/prompt/form dialogs the built-ins use |

A plugin that only reads and writes Kubernetes objects needs **no server
extension at all** — `resource.*` and `watch` reach any resource with the
user's RBAC.

## Built-in or runtime

| | Built-in | Runtime |
|---|---|---|
| Lives in | `web/src/plugins/` | a `.js` file the server serves |
| Needs a rebuild | yes | no |
| Imports | normal ES imports, bundled | `window.KubeVirtGui` |
| Typical use | features shipped with the GUI | site-specific additions |

## Runtime plugins

An ES module whose default export is a plugin. Point the server at it:

```sh
GUI_PLUGIN_DIR=/plugins            # every *.js in the directory
GUI_PLUGIN_URLS=/plugins/ssh.js    # or an explicit list
```

The directory is served under `/plugins/`, and paths are validated so a request
cannot escape it. Because the Content-Security-Policy is `script-src 'self'`,
plugins must be served from the same origin — that is what `GUI_PLUGIN_DIR` is
for. A URL on another host will be refused by the browser.

The module gets the app's own Vue and API rather than bundling copies:

```js
const { Vue, definePlugin, useWatch, gateway, k8s, dialogs, can, useCluster, icon } = window.KubeVirtGui
const { h, computed, defineComponent } = Vue

export default definePlugin({
  id: 'ssh-helper',
  name: 'SSH helper',
  setup(api) {
    api.panel({ id: 'ssh', kind: 'vm', title: 'SSH', icon: terminal, order: 55, component: SshPanel })
  },
})
```

`icon(name, width, height, path)` builds a Font Awesome icon definition from an
SVG path, so a runtime plugin needs no icon packages.

[`examples/plugins/ssh-helper.js`](../../examples/plugins/ssh-helper.js) is a
complete one: a VM panel listing the guest's addresses with ready-to-copy
commands, a **Copy SSH command** action, and a datacenter panel built from a
live watch.

## Lifecycle

1. The app signs in and reads the cluster's capabilities.
2. Built-in plugins install, then external ones from `GUI_PLUGIN_URLS` and the
   plugin directory.
3. A plugin whose `requires` are unmet is skipped, and shown as such under
   **Datacenter → Extensions** with the reason.
4. Discovery is re-read every minute; plugins are installed or withdrawn as the
   cluster changes. **Re-scan cluster** on that screen does it immediately.
5. `teardown()` runs when a plugin is withdrawn. The registry removes its
   panels, actions, views and create items itself — `teardown` is for what
   `setup` started outside the registry, such as a store subscription or a
   timer.
