# Frontend development against the in-cluster backend, reachable from the LAN.
#
#   powershell -File scripts/dev-lan.ps1            # run in this window
#   Start-Process powershell -WindowStyle Hidden -ArgumentList '-File','scripts/dev-lan.ps1'
#
# Port-forwards the deployed server to 127.0.0.1:18006 (reconnecting after each
# rollout) and serves Vite on 0.0.0.0:5173 with hot reload. Logs go to
# %TEMP%\kubevirt-webgui-portforward.log and %TEMP%\kubevirt-webgui-vite.log.

param(
    [string]$Context = 'safewords',
    [int]$BackendPort = 18006
)

$root = Split-Path -Parent $PSScriptRoot
$forwardLog = Join-Path $env:TEMP 'kubevirt-webgui-portforward.log'
$viteLog = Join-Path $env:TEMP 'kubevirt-webgui-vite.log'

# The port-forward dies whenever the pod is replaced; keep bringing it back.
$forward = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-Command',
    "while (`$true) { kubectl --context $Context -n kubevirt-webgui port-forward svc/kubevirt-webgui ${BackendPort}:8006 *>> '$forwardLog'; Start-Sleep -Seconds 2 }"
)

$watchdog = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-File', (Join-Path $PSScriptRoot 'portforward-watchdog.ps1'), '-Port', $BackendPort
)

$env:KVE_BACKEND = "http://127.0.0.1:$BackendPort"
$vite = Start-Process powershell -WindowStyle Hidden -PassThru -WorkingDirectory (Join-Path $root 'web') -ArgumentList @(
    '-NoProfile', '-Command', "npx vite --port 5173 *>> '$viteLog'"
)

"port-forward loop pid $($forward.Id), watchdog pid $($watchdog.Id), vite pid $($vite.Id)"
"stop with: Stop-Process -Id $($forward.Id),$($watchdog.Id),$($vite.Id); then end the kubectl and node processes listening on $BackendPort and 5173"
