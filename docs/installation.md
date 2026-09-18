# Installation

The server is one binary and one container image. It stores nothing, needs no
database, and holds no Kubernetes privileges — so installing it cannot give
anybody access they did not already have.

- [What the cluster needs](#what-the-cluster-needs)
- [Helm](#helm)
- [Plain manifests](#plain-manifests)
- [Running it outside the cluster](#running-it-outside-the-cluster)
- [Getting in](#getting-in)
- [Putting it behind an Ingress](#putting-it-behind-an-ingress)
- [Upgrading](#upgrading)

## What the cluster needs

| Needed for | Requirement | Without it |
|---|---|---|
| Anything | Kubernetes 1.28+ and a user credential | nothing to show |
| Virtual machines | [KubeVirt](https://kubevirt.io) (`kubevirt.io/v1`) | the GUI runs, and every VM screen is empty |
| Disks, images, imports | [CDI](https://github.com/kubevirt/containerized-data-importer) (`cdi.kubevirt.io`) | no uploads, no URL imports, no Proxmox import, no disk creation from images |
| Snapshots and clones | a default `VolumeSnapshotClass` for your CSI driver, plus KubeVirt's `Snapshot` feature gate | KubeVirt reports "No VolumeSnapshotClass" and leaves every disk out of a snapshot |
| Live migration | `ReadWriteMany` storage, or migratable disks | migration is offered and fails at the first non-migratable volume |
| USB passthrough | [atomic-usb](https://github.com/safewords/kubevirt-atomic-usb) | the USB screens hide themselves |
| Importing from Proxmox | SSH reachability and `PROXMOX_ALLOWED_HOSTS` | the import wizard refuses every host |

Nothing in that list is checked at start-up and then held against you. The
server asks the API server what exists (`APIGroupList`/`APIResourceList`) and
hides the extensions whose APIs are missing, so a cluster without CDI simply
has no Images screen rather than a screen full of errors. See
[extensions](extending/server-extensions.md#requirements-and-discovery).

## Helm

The chart is published two ways from the same pipeline — an OCI artifact on
GHCR, and a classic Helm repository on the `gh-pages` branch.

```sh
# OCI (no `helm repo add` needed)
helm install kubevirt-webgui oci://ghcr.io/safewords/charts/kubevirt-webgui \
  --namespace kubevirt-webgui --create-namespace

# or the Helm repository
helm repo add kubevirt-webgui https://raw.githubusercontent.com/safewords/kubevirt-webgui/gh-pages
helm repo update
helm install kubevirt-webgui kubevirt-webgui/kubevirt-webgui \
  --namespace kubevirt-webgui --create-namespace
```

A real install usually wants at least:

```sh
helm install kubevirt-webgui oci://ghcr.io/safewords/charts/kubevirt-webgui \
  --namespace kubevirt-webgui --create-namespace \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=virt.example.com \
  --set-json 'settings.allowedOrigins=["https://virt.example.com"]' \
  --set-json 'proxmox.allowedHosts=["10.0.0.0/24"]'
```

Every value is documented in [configuration](configuration.md#helm-values) and
in the chart's own `values.yaml`, which is written to be read.

The chart generates the key that seals sign-in tickets on first install and
reads it back on upgrade, so redeploying does not sign everyone out. Bring your
own with `appKey.existingSecret`.

## Plain manifests

`deploy/kubevirt-webgui.yaml` is the same deployment without Helm: a namespace,
a ServiceAccount bound to nothing, a Deployment, and a Service. Create the key
first — the server starts without one, but it then mints a temporary key at
every start-up, which signs everybody out on every restart and warns in the log:

```sh
kubectl create namespace kubevirt-webgui
kubectl -n kubevirt-webgui create secret generic kubevirt-webgui-key \
  --from-literal=APP_KEY="base64:$(head -c 32 /dev/urandom | base64)"
kubectl apply -f https://raw.githubusercontent.com/safewords/kubevirt-webgui/main/deploy/kubevirt-webgui.yaml
```

Then reach it however you reach anything else:

```sh
kubectl -n kubevirt-webgui port-forward svc/kubevirt-webgui 8006:8006
```

## Running it outside the cluster

The server is equally happy on a laptop, talking to the cluster with your
kubeconfig. This is the fastest way to try it, and the only way to use it
against a cluster you cannot deploy into.

```sh
cp .env.example .env            # APP_KEY= can stay empty; one is generated
cargo run -- serve              # http://127.0.0.1:8006
```

Point it at a specific context with `KUBE_CONTEXT`. Everything else is in
[configuration](configuration.md).

Container images are published for amd64 and arm64:

```sh
docker run --rm -p 8006:8006 \
  -e APP_KEY="base64:$(head -c 32 /dev/urandom | base64)" \
  -e KUBECONFIG=/kube/config \
  -v "$HOME/.kube/config:/kube/config:ro" \
  ghcr.io/safewords/kubevirt-webgui:latest
```

The image runs as uid 65532, whose home is `/home/nonroot`; a kubeconfig
mounted at `/home/nonroot/.kube/config` is found without `KUBECONFIG` at all.
Either way, a kubeconfig whose credential comes from an `exec` plugin (EKS,
GKE, `kubelogin`) will not work inside the container — the plugin binary is not
in there. Sign in through the GUI with a token instead.

Without a cluster to talk to, the server refuses to start and says which two
places it looked:

```text
kubevirt-webgui could not start: failed to infer config: in-cluster: (…),
kubeconfig: (failed to read kubeconfig from "/home/nonroot/.kube/config": …)
```

## Getting in

There is no user database. You sign in with a Kubernetes credential and the
server acts as you for every request — see
[authentication](authentication.md).

```sh
# a token for yourself, if your cluster issues them
kubectl create token my-service-account -n my-namespace --duration=8h
```

Paste it into the sign-in screen. The credential is a **bearer token** — a
ServiceAccount token or an OIDC id token — not a kubeconfig; what the server
accepts is what the API server already accepts. What you can see and do
afterwards is decided by RBAC, not by this application.

`AUTH_ALLOW_SERVER_IDENTITY=true` adds a "sign in as the server" button that
skips all of that and hands the visitor the pod's ServiceAccount. It exists for
single-user desktop installs. **Leave it off on anything more than one person
can reach**, and note that the ServiceAccount this chart creates is bound to
nothing, so the button grants nothing until somebody binds a role to it.

## Putting it behind an Ingress

Two things to get right:

1. **WebSocket timeouts.** The browser holds one socket open for the whole
   session, and consoles stream over their own. Controllers that time idle
   connections out will cut consoles mid-session. For ingress-nginx:
   `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` and
   `proxy-send-timeout`. Traefik needs no annotation for WebSockets but does
   need its `respondingTimeouts` left generous.
2. **Origins.** Set `settings.allowedOrigins` to the URL people will actually
   type. Empty means same-origin only, which is right when the GUI is served
   from the same host it is reached on, and wrong as soon as it is not.

TLS is the Ingress's job. The server speaks plain HTTP and expects to be
terminated in front of.

## Upgrading

`helm upgrade` with the same values. The application keeps no state — no
database, no cache on disk, no leader election — so a rollout is a restart:
open consoles reconnect, running tasks are lost from the task log (the
Kubernetes work they started carries on), and sign-ins survive because the key
is reused.

Rolling back is `helm rollback`. There is no schema to migrate in either
direction.
