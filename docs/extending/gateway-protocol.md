# The gateway protocol

Everything the browser does travels over one WebSocket at `/ws`: calls, live
watches, task logs, metrics. There is no REST API for the browser to fall back
to, which is deliberate — one connection, one authentication, one place where
authorisation is applied.

- [Frames](#frames)
- [The hello frame](#the-hello-frame)
- [Signing in](#signing-in)
- [Calls](#calls)
- [Subscriptions](#subscriptions)
- [Errors](#errors)
- [Method and topic catalogue](#method-and-topic-catalogue)
- [Consoles and uploads](#consoles-and-uploads)
- [Talking to it yourself](#talking-to-it-yourself)

## Frames

JSON objects, each with an `op`. Client frames carry an `id` that the server
echoes, so answers can arrive in any order.

| `op` | Direction | Meaning |
|---|---|---|
| `hello` | server | sent on connect, before anything is asked of it |
| `call` | client | invoke a method, expect one answer |
| `result` | server | the answer to a `call` |
| `error` | server | that call failed |
| `subscribe` | client | start a topic |
| `event` | server | one event of a subscription |
| `unsubscribe` | client | stop a subscription |
| `end` | server | the subscription is over, with `error` if it ended badly |
| `ping` / `pong` | client / server | liveness, `pong` carries `ts` in milliseconds |
| `session` | server | unsolicited, `{"state":"expired"}` when the session runs out |

Calls are dispatched as independent tasks, so a `vm.migrate` that takes minutes
never holds up a `resource.get` sent after it (`src/gateway/mod.rs`).

A frame larger than `GUI_MAX_FRAME_BYTES` (16 MiB by default) is refused with
`BadRequest: frame too large` rather than allocated.

## The hello frame

```jsonc
{
  "op": "hello",
  "server": { "name": "kubevirt-webgui", "version": "0.1.0", "product": "kubevirt-webgui",
              "cluster": "https://10.43.0.1/" },
  "auth": { "methods": ["token"] },          // ["token","server"] if server identity is allowed
  "extensions": [ { "id": "kubevirt", "name": "KubeVirt", "requires": ["kubevirt.io/v1/virtualmachines"], … } ],
  "pluginUrls": ["/plugins/ssh-helper.js"]
}
```

`extensions` is every server extension's manifest, which is how the browser
knows what this server can do before asking it anything. `auth.methods` tells
the sign-in screen which buttons to show.

## Signing in

`auth.login` and `auth.resume` are the only methods that work without a
session — everything else answers `Unauthorized` until one exists.

```jsonc
→ { "id": "1", "op": "call", "method": "auth.login",
    "params": { "credential": { "kind": "token", "token": "eyJ…" } } }
← { "id": "1", "op": "result", "result": { "ticket": "…", "user": { … }, "expires": 1789590000 } }
```

The ticket is the credential and identity sealed with `APP_KEY`. The browser
stores the ticket, never the token, and replays it with `auth.resume` after a
reconnect or a page reload. `auth.renew` extends a session, `auth.whoami`
reports who the server thinks you are, `auth.logout` ends it.

See [authentication](../authentication.md) for what the server does with the
credential (in short: it makes every Kubernetes request as you, and keeps no
copy).

## Calls

```jsonc
→ { "id": "7", "op": "call", "method": "vm.start", "params": { "namespace": "prod", "name": "db" } }
← { "id": "7", "op": "result", "result": { "task": "UPID:alice:18A…:vm.start:prod/db" } }
```

Anything long-running answers immediately with a task id and does its work in
the background, reporting through the `tasks` topic — see
[tasks](../features/tasks.md).

## Subscriptions

```jsonc
→ { "id": "8", "op": "subscribe", "topic": "watch",
    "params": { "apiVersion": "kubevirt.io/v1", "resource": "virtualmachines", "namespace": "prod" } }
← { "id": "8", "op": "event", "data": { "type": "SYNC", "items": [ … ] } }
← { "id": "8", "op": "event", "data": { "type": "MODIFIED", "object": { … } } }
→ { "id": "8", "op": "unsubscribe" }
← { "id": "8", "op": "end" }
```

The first event of a `watch` is a `SYNC` holding the current list, so a client
never has to list and watch separately and cannot miss what happened in
between. Subscribing again with an `id` already in use cancels the previous
one. Everything is cancelled when the socket closes or the user signs out.

## Errors

```jsonc
← { "id": "7", "op": "error", "error": { "code": "Forbidden", "status": 403,
      "message": "virtualmachines.kubevirt.io \"db\" is forbidden: …" } }
```

`code` and `status` come from Kubernetes when the API server is the one
refusing, so a permission problem reads exactly as `kubectl` would report it.
Codes raised by the server itself are `BadRequest`, `Unauthorized`,
`NotFound`, `Conflict`, `InternalError` and `ExtensionUnavailable` — the last
meaning the method belongs to an extension whose APIs this cluster does not
serve (see [server extensions](server-extensions.md#requirements-and-discovery)).

## Method and topic catalogue

Every method below is namespaced by the extension that registers it. Parameters
are documented at the registration site in `src/extensions/`.

| Extension | Methods |
|---|---|
| `core` | `auth.login`, `auth.resume`, `auth.renew`, `auth.logout`, `auth.whoami`, `cluster.discovery`, `cluster.namespaces`, `access.review`, `access.rules`, `serviceaccount.token`, `resource.list`, `resource.get`, `resource.create`, `resource.replace`, `resource.patch`, `resource.delete`, `resource.subresource`, `resource.logs`, `tasks.list`, `tasks.detail`, `tasks.stop` |
| `kubevirt` | `vm.start`, `vm.stop`, `vm.shutdown`, `vm.restart`, `vm.reboot`, `vm.reset`, `vm.pause`, `vm.resume`, `vm.freeze`, `vm.unfreeze`, `vm.migrate`, `vm.migrate.cancel`, `vm.create`, `vm.delete`, `vm.clone`, `vm.snapshot`, `vm.restore`, `vm.guest`, `vm.screenshot`, `vm.expandSpec`, `vm.objectGraph`, `vm.volume.add`, `vm.volume.remove`, `console.ticket`, `datavolume.create` |
| `storage` | `upload.begin`, `datavolume.diagnose` |
| `nodes` | `node.cordon`, `node.uncordon`, `node.drain` |
| `proxmox` | `proxmox.hostKey`, `proxmox.connect`, `proxmox.disconnect`, `proxmox.status`, `proxmox.vms`, `proxmox.vm`, `proxmox.import` |
| `atomic-usb` | `usb.attach`, `usb.detach` |

| Topic | Emits |
|---|---|
| `watch` | `SYNC` then `ADDED`/`MODIFIED`/`DELETED` for any resource the user may watch |
| `tasks` | task creation, log lines, progress and completion |
| `migration.progress` | live migration figures sampled from virt-handler |
| `metrics.node`, `metrics.nodes`, `metrics.vmi` | usage from metrics-server |

The generic `resource.*` methods reach **any** Kubernetes resource with the
user's RBAC, which is why many plugins need no server code at all.

## Consoles and uploads

Two endpoints exist outside the gateway because they carry bytes rather than
JSON, and both are opened with a ticket rather than a session:

| Endpoint | Ticket from | Carries |
|---|---|---|
| `/ws/console/{ticket}` | `console.ticket` | a raw byte pipe to KubeVirt's `vnc` or `console` subresource |
| `/ws/upload/{ticket}` | `upload.begin` | a chunked upload with acknowledgements, forwarded to CDI's upload proxy |

Tickets are random 256-bit values, single-use, and expire after
`CONSOLE_TICKET_TTL` seconds (60 by default) — they travel in a URL, where
they can end up in a log.

## Talking to it yourself

`web/e2e/lib/gateway.mjs` is a small Node client for this protocol and the
easiest way to drive the server from a script:

```js
import { Gateway } from './web/e2e/lib/gateway.mjs'

const gw = await Gateway.connect(process.env.TOKEN)
const vms = await gw.call('resource.list', { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines' })
const { task } = await gw.call('vm.start', { namespace: 'prod', name: 'db' })
await gw.waitTask(task)                       // or gw.runTask('vm.start', { … })
gw.close()
```

It is the same protocol the browser speaks, so anything the GUI can do is
scriptable without a browser.
