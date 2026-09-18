# Development

- [Layout](#layout)
- [Running it](#running-it)
- [Against a real cluster](#against-a-real-cluster)
- [Checks](#checks)
- [The e2e suite](#the-e2e-suite)
- [Building the image](#building-the-image)
- [Releasing](#releasing)

## Layout

```
src/                     the server
  bootstrap.rs           boots the framework, registers routes and extensions
  settings.rs            every environment variable, in one place
  auth.rs                sign-in, sealed sessions, per-user Kubernetes clients
  rpc.rs                 the call/response/subscription frames
  gateway/               the WebSocket endpoints: gateway, console, upload
  cluster/               API paths, discovery, watches
  extensions/            one module per feature area (see below)
  proxmox/               SSH, config parsing and the import pipeline
  tasks.rs               tasks, logs, progress
  spa.rs                 serves the built browser app and runtime plugins
web/                     the browser app
  src/plugins/core/      one directory per screen; this is where features live
  src/components/        shared UI
  e2e/                   end-to-end tests, driving a real cluster
charts/kubevirt-webgui/  the Helm chart
deploy/                  the same deployment as plain manifests
examples/plugins/        runtime plugin examples
docs/                    this documentation
```

The server and the browser app are separate programs that share only the
gateway protocol. A feature usually lands as one module under `src/extensions/`
and one directory under `web/src/plugins/core/`.

## Running it

Two processes: the server, and Vite with hot reload.

```sh
cp .env.example .env
cargo run -- serve                 # http://127.0.0.1:8006

cd web
npm install
npm run dev                        # http://127.0.0.1:5173, proxying to the server
```

Vite proxies `/ws`, `/api` and friends to `KVE_BACKEND` (default
`http://127.0.0.1:8006`), so the browser app talks to whichever server you
point it at:

| Variable | Default | Effect |
|---|---|---|
| `KVE_BACKEND` | `http://127.0.0.1:8006` | the server Vite proxies to |
| `KVE_HOST` | `0.0.0.0` | Vite's bind address |

A release build compiles `web/dist` into the binary (rust-embed), so `cargo
build --release` without building the app first produces a server that serves
nothing. Debug builds read `web/dist` from disk.

## Against a real cluster

The most useful loop is the browser app running locally against the server
already deployed in the cluster:

```powershell
powershell -File scripts/dev-lan.ps1     # port-forwards the pod, serves Vite on the LAN
```

It keeps the port-forward alive across rollouts (`scripts/portforward-watchdog.ps1`),
which matters because every deploy replaces the pod underneath it.

## Checks

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked

cd web && npm run typecheck && npm run build
```

CI runs exactly these, on every push and pull request. `rustfmt.toml` sets
`max_width = 120` and `use_small_heuristics = "Max"`, which is what keeps the
dense one-line style the code is written in from being exploded into a line per
field.

## The e2e suite

`web/e2e/` drives a **real cluster** — it creates VMs, uploads disks, migrates,
snapshots and deletes them. It is not run in CI for that reason: no hosted
runner has KubeVirt and CDI on it.

```sh
cd web
E2E_BASE=http://127.0.0.1:5173 npm run e2e            # everything
node --test e2e/vm-power.test.mjs                     # one suite
```

| Variable | Default | What it is |
|---|---|---|
| `E2E_BASE` | `http://127.0.0.1:5173` | the GUI under test |
| `E2E_TOKEN` | — | a cluster-admin bearer token |
| `E2E_TOKEN_FILE` | `../.dev-token` | a file holding one instead (gitignored) |
| `E2E_BROWSER` | Edge, then Chrome | a Chromium-family executable |
| `E2E_HEADED=1` | off | watch it work |
| `E2E_KEEP=1` | off | leave the test resources behind |

What each suite covers:

| Suite | Exercises |
|---|---|
| `00-smoke` | sign-in, the gateway, the tree |
| `access` | RBAC: what a limited user may see and do |
| `cluster-feature-gates`, `cluster-node` | cluster and node screens, cordon/drain |
| `disk`, `disk-snapshot` | disks, resize, snapshot and restore |
| `hotplug` | hot-plugging disks into a running VM |
| `network` | networks and NetworkPolicy |
| `proxmox-import` | the Proxmox import wizard end to end |
| `quota` | namespace quotas |
| `upload` | uploading an image through CDI |
| `usb` | USB devices via atomic-usb |
| `vm-clone-snapshot`, `vm-cloudinit`, `vm-hardware`, `vm-migrate`, `vm-options`, `vm-power`, `vm-wizard` | the VM screens, each in turn |

`web/e2e/lib/gateway.mjs` is a Node client for the same protocol the browser
speaks, which makes it a convenient way to poke the server directly:

```js
const gw = await Gateway.connect()
const { items } = await gw.call('kubevirt.vms', { namespace: 'default' })
```

## Building the image

```sh
docker build -t kubevirt-webgui .
```

The Dockerfile builds the browser app, then the server with the app embedded,
onto a distroless base. CI instead builds the binaries on native amd64 and
arm64 runners and packages them with `--target prebuilt`, which is why the
runtime base is debian13 — its glibc must be no older than the runners'.

## Releasing

Three pipelines, each on its own trigger:

| Workflow | Trigger | Publishes |
|---|---|---|
| `ci.yml` | push, pull request | nothing; checks both halves, and builds the image on PRs |
| `release.yml` | push to `main`, tags `v*` | `ghcr.io/safewords/kubevirt-webgui` — `main` and `sha-<commit>` from main, `X.Y.Z`/`X.Y`/`latest` from a tag, plus a GitHub release with binaries |
| `chart.yml` | changes under `charts/` | the chart to `oci://ghcr.io/safewords/charts/kubevirt-webgui` and to the Helm repository on `gh-pages` |

The chart is versioned independently of the application: bump `version` in
`charts/kubevirt-webgui/Chart.yaml` for a chart change, `appVersion` (and the
crate version) for an application release. To cut one:

```sh
git tag -a v0.2.0 -m "kubevirt-webgui 0.2.0"
git push origin v0.2.0
```
