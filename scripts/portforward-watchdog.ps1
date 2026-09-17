# Kills a wedged `kubectl port-forward` so its restart loop brings up a fresh one.
#
# kubectl can stay alive while every new stream fails ("error creating error
# stream … Timeout occurred"); the loop in dev-lan.ps1 only restarts it when it
# exits. This probes the forwarded backend and ends the process after two
# consecutive failed health checks.

param(
    [int]$Port = 18006,
    [int]$IntervalSeconds = 10
)

$log = Join-Path $env:TEMP 'kubevirt-webgui-watchdog.log'
$failures = 0
while ($true) {
    Start-Sleep -Seconds $IntervalSeconds
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 5 -UseBasicParsing
        if ($response.StatusCode -eq 200) { $failures = 0; continue }
        $failures++
    } catch {
        $failures++
    }
    if ($failures -lt 2) { continue }

    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    $process = if ($owner) { Get-Process -Id $owner -ErrorAction SilentlyContinue }
    if ($process -and $process.ProcessName -eq 'kubectl') {
        "$(Get-Date -Format s) port $Port unhealthy twice; killing kubectl $owner" | Out-File -Append -FilePath $log
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    }
    $failures = 0
}
