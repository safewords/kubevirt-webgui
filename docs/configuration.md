# Configuration

Everything is configured by environment variable. The Helm chart is a thin
wrapper over these, and `.env.example` in the repository root is the same list
for local runs.

- [Application](#application)
- [HTTP server](#http-server)
- [Kubernetes](#kubernetes)
- [Authentication](#authentication)
- [The GUI](#the-gui)
- [Proxmox import](#proxmox-import)
- [Helm values](#helm-values)

## Application

| Variable | Default | What it does |
|---|---|---|
| `APP_ENV` | `local` | `production` turns off developer conveniences. The image sets it. |
| `APP_KEY` | *(generated)* | Base64 of exactly 32 bytes, optionally prefixed `base64:`. Seals sign-in tickets and console tickets. **Without it a temporary key is minted at start-up and every restart signs everybody out.** Generate one with `kubevirt-webgui key:generate` or `head -c 32 /dev/urandom \| base64`. |
| `APP_PREVIOUS_KEYS` | — | Comma-separated retired keys, still accepted for decryption. This is how you rotate `APP_KEY` without signing everyone out: move the old value here, set a new `APP_KEY`, and drop it later. |
| `RUST_LOG` | `info` | Log filter, e.g. `info,kubevirt_webgui=debug`. |
| `LOG_FORMAT` | `text` | `json` for structured logs. |

`APP_KEY` is not a cluster credential and cannot become one. Users' Kubernetes
tokens are sealed with it and handed back to the browser; the server keeps no
copy. Losing the key invalidates open sessions and nothing else.

## HTTP server

| Variable | Default | What it does |
|---|---|---|
| `SERVER_HOST` | `127.0.0.1` | Bind address. The image sets `0.0.0.0`. |
| `SERVER_PORT` | `8006` | Bind port. Proxmox VE's port, deliberately. |
| `SERVER_REQUEST_TIMEOUT` | framework default | Ordinary HTTP requests only. WebSockets are not subject to it. |
| `SERVER_MAX_BODY` | framework default | Largest HTTP body. Uploads do not go through it — they stream over `/ws/upload/{ticket}`. |

`/healthz` answers as soon as the HTTP server is listening. It deliberately
does not check the Kubernetes API: an API outage should not restart the GUI you
are using to look at the outage.

## Kubernetes

| Variable | Default | What it does |
|---|---|---|
| `KUBE_CONTEXT` | — | Which kubeconfig context to manage. Unset means in-cluster config first, then the current context. |
| `KUBE_API_SERVER` | — | Override the API server URL. Rarely needed; useful when the in-cluster address is not reachable from where the browser's console traffic is proxied. |

The server needs an API server address and a CA to trust — that is all it takes
from its own environment. Credentials come from whoever signed in.

## Authentication

| Variable | Default | What it does |
|---|---|---|
| `AUTH_ALLOW_SERVER_IDENTITY` | `false` | Offers "sign in as the server identity". **Anybody who can open the page then acts as the pod's ServiceAccount.** For single-user desktop installs only. |
| `AUTH_SESSION_TTL` | `28800` (8 h) | Session lifetime in seconds, minimum 300. The sealed credential expires with it. |
| `CONSOLE_TICKET_TTL` | `60` | Seconds a console or upload ticket may be redeemed for, minimum 5. Tickets travel in a URL, so they are short-lived and single-use. |

## The GUI

| Variable | Default | What it does |
|---|---|---|
| `GUI_PRODUCT_NAME` | `kubevirt-webgui` | Name in the tab title and the top-left corner. |
| `GUI_ALLOWED_ORIGINS` | *(same-origin)* | Comma-separated origins allowed to open the WebSocket, e.g. `https://virt.example.com`. Empty means same-origin only. |
| `GUI_PLUGIN_URLS` | — | Comma-separated URLs of browser plugins to load at runtime. See [browser plugins](extending/browser-plugins.md). |
| `GUI_PLUGIN_DIR` | — | A directory on the server whose files are served under `/plugins/`. Paths are checked; a plugin cannot escape the directory. |
| `GUI_DISABLED_EXTENSIONS` | — | Comma-separated built-in extensions to switch off by name. Extensions already hide themselves when their APIs are missing — this is for hiding one whose APIs are present. |
| `GUI_MAX_FRAME_BYTES` | `16777216` | Largest WebSocket frame accepted, minimum 65536. |

## Uploads and CDI

Uploads go to CDI's upload proxy, which the server finds by itself in a cluster
and has to be told about from outside one.

| Variable | Default | What it does |
|---|---|---|
| `CDI_NAMESPACE` | `cdi` | Where CDI is installed. Used to find the upload proxy and its CA. |
| `CDI_UPLOAD_PROXY_URL` | in-cluster: `https://cdi-uploadproxy.<ns>.svc:443` | The upload proxy's address. Outside the cluster the server falls back to reaching it through the API server's service proxy, so this is only needed when that route is blocked. |
| `CDI_UPLOAD_PROXY_CA_FILE` | — | A CA bundle file for the proxy's certificate. By default the server reads CDI's own `cdi-uploadproxy-signer-bundle`. |
| `CDI_UPLOAD_PROXY_VERIFY` | lenient | `strict` requires the proxy's certificate to verify against that CA. The default tolerates CDI's self-signed certificate, which is what a stock install has. |

## Proxmox import

| Variable | Default | What it does |
|---|---|---|
| `PROXMOX_ALLOWED_HOSTS` | — | Comma-separated Proxmox VE hosts the importer may reach: names, addresses, CIDR ranges, or `*`. **Empty switches importing off entirely.** |

This list is a boundary, not a convenience: the importer opens SSH connections
to whatever a signed-in user names, so the allow-list decides where the server
can be pointed. `*` means anywhere the pod's network reaches, including
services that are not Proxmox. See [importing from Proxmox](features/proxmox-import.md#the-allow-list).

## Helm values

The chart maps one-to-one onto the variables above. The full list with comments
is in [`charts/kubevirt-webgui/values.yaml`](../charts/kubevirt-webgui/values.yaml);
these are the ones most installs touch.

| Value | Default | Variable |
|---|---|---|
| `image.repository` / `image.tag` | `ghcr.io/safewords/kubevirt-webgui` / chart `appVersion` | — |
| `replicaCount` | `1` | — |
| `appKey.generate` | `true` | `APP_KEY`, generated once and reread on upgrade |
| `appKey.existingSecret` | `""` | `APP_KEY` from your own Secret (key `APP_KEY`) |
| `settings.productName` | `kubevirt-webgui` | `GUI_PRODUCT_NAME` |
| `settings.allowServerIdentity` | `false` | `AUTH_ALLOW_SERVER_IDENTITY` |
| `settings.sessionTtl` | `28800` | `AUTH_SESSION_TTL` |
| `settings.consoleTicketTtl` | `60` | `CONSOLE_TICKET_TTL` |
| `settings.allowedOrigins` | `[]` | `GUI_ALLOWED_ORIGINS` |
| `settings.disabledExtensions` | `[]` | `GUI_DISABLED_EXTENSIONS` |
| `settings.maxFrameBytes` | `16777216` | `GUI_MAX_FRAME_BYTES` |
| `settings.kubeContext` / `settings.kubeApiServer` | `""` | `KUBE_CONTEXT` / `KUBE_API_SERVER` |
| `plugins.urls` / `plugins.directory` | `[]` / `""` | `GUI_PLUGIN_URLS` / `GUI_PLUGIN_DIR` |
| `proxmox.allowedHosts` | `[]` | `PROXMOX_ALLOWED_HOSTS` |
| `extraEnv` | `[]` | anything else, including `RUST_LOG` |

A value the chart does **not** offer is a ClusterRoleBinding for its
ServiceAccount. That is deliberate: the server does not act as itself, and
giving it permissions would only matter to an install that has
`allowServerIdentity` on — where it would hand those permissions to every
visitor.
