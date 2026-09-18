# Server extensions

Everything the gateway serves is registered by an extension — the core
included. Adding a capability is a new module under `src/extensions/` and one
line in `builtin()`; there is no other registration point and no privileged
path the built-ins take that yours cannot.

- [The shape of one](#the-shape-of-one)
- [Requirements and discovery](#requirements-and-discovery)
- [Methods](#methods)
- [Topics](#topics)
- [Tasks](#tasks)
- [Acting as the user](#acting-as-the-user)
- [Building paths safely](#building-paths-safely)
- [Switching one off](#switching-one-off)
- [When you need no server code at all](#when-you-need-no-server-code-at-all)

## The shape of one

```rust
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcResult, params};

pub struct Backups;

impl Extension for Backups {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "backups".into(),
            name: "Backups".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Scheduled VM backups.".into(),
            requires: vec!["backup.kubevirt.io/v1alpha1/virtualmachinebackups".into()],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.method("backup.now", backup_now);
        r.topic("backup.progress", backup_progress);
    }
}
```

Then add `Box::new(backups::Backups)` to `extensions::builtin()` in
`src/extensions/mod.rs`. The manifest travels to the browser in the `hello`
frame, so a plugin can decide what to offer before calling anything.

## Requirements and discovery

`requires` lists API resources as `group/version/resource` (or just a group).
It is not documentation — the server enforces it.

A method belonging to an extension whose requirements the cluster does not
serve fails with `ExtensionUnavailable` and a message naming what is missing:

```text
atomic-usb is not available: this cluster does not serve
atomicusb.safewords.io/v1alpha1/usbdeviceclaims
```

Discovery is rescanned before refusing, so a CRD installed a minute ago is
picked up without a restart. The browser uses the same list to hide screens —
see [browser plugins](browser-plugins.md) and
[architecture](../architecture.md#discovery-drives-the-gui).

## Methods

A method takes a `Ctx` and JSON parameters, and returns JSON.

```rust
async fn backup_now(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P { namespace: String, name: String }
    let p: P = params(p)?;

    let kube = ctx.kube()?;                    // acts as the signed-in user
    let created = kube.post(&path, &body).await?;
    Ok(created)
}
```

| Registration | Meaning |
|---|---|
| `r.method(name, handler)` | requires a signed-in session; `Unauthorized` without one |
| `r.public_method(name, handler)` | no session needed — only `auth.login` and `auth.resume` use it |

Errors are `RpcError`: `bad_request`, `unauthorized`, `not_found`, `internal`,
or anything converted from a Kubernetes `ApiError`, which keeps the API
server's own status and message so the browser shows what `kubectl` would.

## Topics

A topic is a subscription. It receives a `Sink` and keeps emitting until the
browser unsubscribes or the socket closes — at which point the task is aborted,
so cleanup belongs in `Drop` rather than after the loop.

```rust
async fn backup_progress(ctx: Ctx, p: Value, sink: Sink) -> RpcResult<()> {
    loop {
        if !sink.emit(json!({ "done": done, "total": total })) {
            return Ok(());                     // the browser has gone
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
```

The generic `watch` topic already covers "tell me when this resource changes"
for any resource, so write a topic only when the data is not a Kubernetes
object — metrics, progress sampled from somewhere else, and so on.

## Tasks

Anything slower than a request should be a task: it returns immediately, and
the work reports into the task log every browser the user has open is already
watching.

```rust
let target = TaskTarget { kind: "VirtualMachine".into(), namespace: Some(namespace.clone()), name: name.clone() };

ctx.task("backup.now", target, format!("Back up {namespace}/{name}"), move |task| async move {
    task.log("snapshotting…");
    task.progress(Progress { done, total: Some(total), unit: "bytes".into(), rate: Some(rate), detail: None });
    Ok(Some("backup complete".into()))
})
```

The closure's `Ok(Some(message))` ends the task `OK` with that message; an
`Err` ends it in error with the message logged. Progress is throttled inside
`TaskHandle::progress`, so calling it per chunk is fine. See
[tasks](../features/tasks.md).

## Acting as the user

`ctx.kube()` is a Kubernetes client carrying the signed-in user's credential.
There is no other client to reach for — the server has no privileged one — so
an extension cannot accidentally do something on the user's behalf that the
user could not do themselves.

`ctx.user()` is who the API server said they are, which is what tasks are
attributed to.

## Building paths safely

Build every request path with `ResourceRef`, never by formatting strings:

```rust
use crate::cluster::paths::ResourceRef;

let path = ResourceRef::new("kubevirt.io/v1", "virtualmachines")
    .ns(&namespace)
    .named(&name)
    .subresource("start")
    .path()?;
```

`path()` validates each segment. A name containing `/`, `?` or `..` is rejected
before any request is made, which is what stops a resource name from becoming a
way to reach a different endpoint. `segment("name", &name)?` does the same
check on its own when you need one early.

## Switching one off

`GUI_DISABLED_EXTENSIONS=backups,proxmox` removes them from the registry at
start-up: their methods and topics are not registered and their manifests are
not advertised, so the browser never offers the screens. `core` cannot be
disabled — there would be no way to sign in.

## When you need no server code at all

Most ideas do not need an extension. The core already exposes
`resource.list/get/create/replace/patch/delete/subresource`, `resource.logs`
and the `watch` topic, each with the user's RBAC applied by the API server. A
browser plugin can create and watch its own CRDs with those alone.

Write a server extension when you need something the API server cannot do for
you: talking to another system (as the Proxmox importer does over SSH),
long-running work that must survive the browser navigating away, or sampling
something like virt-handler's migration metrics and reshaping it.
