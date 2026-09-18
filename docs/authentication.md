# Authentication and permissions

There is no user database, no roles to define here, and no "admin" account.
People sign in with a credential the API server already accepts, and from then
on every request the server makes to Kubernetes is made **as them**. Cluster
RBAC is the only authorisation there is.

- [How signing in works](#how-signing-in-works)
- [What the browser holds](#what-the-browser-holds)
- [How the GUI knows what you may do](#how-the-gui-knows-what-you-may-do)
- [Handing out access](#handing-out-access)
- [Signing in as the server](#signing-in-as-the-server)
- [What the server itself can do](#what-the-server-itself-can-do)
- [Sessions, expiry and sign-out](#sessions-expiry-and-sign-out)

## How signing in works

The sign-in screen takes a **bearer token**: a ServiceAccount token, or an OIDC
id token from whatever identity provider the cluster trusts. Not a kubeconfig —
the server has no business parsing one, and everything a kubeconfig would add
(cluster address, CA) it already has.

1. `auth.login` is called with the token (`src/extensions/core.rs`).
2. The server asks the API server who that is, with a `SelfSubjectReview`. On
   an older API server that does not serve it, it falls back to
   `SelfSubjectRulesReview`, which any authenticated request can make — the
   point is only to confirm the credential is accepted and learn the username.
3. It seals the credential and the identity into a **ticket** and returns it.

From then on the server holds the token only for as long as the connection
lives, and uses it for every call it makes on that user's behalf.

## What the browser holds

The ticket, not the token. It is the credential and identity encrypted with
`APP_KEY` — Proxmox's `PVEAuthCookie` in spirit — and it:

- survives a reconnect and a page reload (`auth.resume`),
- survives a server restart, provided `APP_KEY` is stable,
- expires on its own after `AUTH_SESSION_TTL` (8 hours by default),
- is useless to another deployment, because it is sealed with this one's key.

Rotating `APP_KEY` invalidates every open ticket and nothing else. To rotate
without signing everybody out, move the old value to `APP_PREVIOUS_KEYS` and
set a new `APP_KEY` — see [configuration](configuration.md#application).

## How the GUI knows what you may do

Actions you are not allowed are greyed out rather than offered and refused. The
browser asks in batches with `access.review` (many `SelfSubjectAccessReview`s
in one call) and `access.rules`, and the answers come from the API server, not
from a local guess.

That makes the greying-out advisory in the safe direction: the real check is
still the API server refusing the request. If the two ever disagree — a
webhook, a quota, an admission controller — the request fails with the API
server's own message, which is the one worth reading.

```jsonc
→ { "op": "call", "method": "access.review", "params": { "checks": [
     { "verb": "create", "group": "kubevirt.io", "resource": "virtualmachines", "namespace": "prod" },
     { "verb": "delete", "group": "kubevirt.io", "resource": "virtualmachines", "namespace": "prod" } ] } }
```

## Handing out access

Exactly as you would for `kubectl`. KubeVirt ships the roles most people want:

| Role | What it allows |
|---|---|
| `kubevirt.io:view` | see VMs and their instances |
| `kubevirt.io:edit` | start, stop, migrate, edit VMs |
| `kubevirt.io:admin` | the above, plus RBAC within the namespace |

```sh
kubectl create serviceaccount alice -n team-a
kubectl create rolebinding alice-vms -n team-a \
  --clusterrole=kubevirt.io:admin --serviceaccount=team-a:alice
kubectl create token alice -n team-a --duration=8h
```

The same thing can be done from the GUI: **Datacenter → Permissions**, and
per namespace under **Namespace → Permissions**, which also issues tokens
through `serviceaccount.token` (a `TokenRequest`, so the token is short-lived
and never stored anywhere).

A person bound only in `team-a` sees `team-a`. The tree, the panels and the
create menu are built from what the cluster says they may see, so a limited
user gets a smaller GUI rather than a full one that errors.

## Signing in as the server

`AUTH_ALLOW_SERVER_IDENTITY=true` adds a second button: sign in as the
server's own kubeconfig or in-cluster identity, with no credential at all.

**Anybody who can open the page can press it.** It exists for the single-user
case — the GUI running on your own machine against your own kubeconfig, where
the server's identity is yours. On a shared deployment it converts "the server
has no privileges" into "every visitor has the server's privileges", which is
the one thing this design is built to avoid.

The chart defaults it to `false`, and the ServiceAccount it creates is bound to
nothing, so even turning it on grants nothing until somebody binds a role to
that ServiceAccount.

## What the server itself can do

Nothing, deliberately. Its ServiceAccount has no RoleBinding and no
ClusterRoleBinding. The token mounted into the pod is used for exactly two
things: finding the API server's address and trusting its CA.

Consequences worth knowing:

- A compromise of the GUI is not a compromise of the cluster. There is no
  privileged credential in the pod to steal, and no stored user tokens to dump
  — the only tokens present are those of people currently connected, in memory.
- The server cannot show you anything you cannot see yourself, which is also
  why "it works for me" and "it does not work for them" is nearly always RBAC.
- Adding privileges to the ServiceAccount does not make the GUI more capable.
  It only matters if `AUTH_ALLOW_SERVER_IDENTITY` is on, where it makes every
  visitor that capable.

## Sessions, expiry and sign-out

| Setting | Default | Effect |
|---|---|---|
| `AUTH_SESSION_TTL` | 28800 (8 h) | how long a ticket stays valid, minimum 300 |
| `CONSOLE_TICKET_TTL` | 60 | how long a console or upload ticket may be redeemed, minimum 5 |

When a session expires the server sends an unsolicited
`{"op":"session","state":"expired"}` frame and refuses further calls, so the
GUI can ask for a new sign-in rather than silently failing. `auth.renew`
extends a live session; it re-validates the credential with the API server
rather than trusting the ticket, so a token revoked in the meantime stops
working.

`auth.logout` ends the session and cancels every subscription that belonged to
it. Closing the browser does the same for that connection.
