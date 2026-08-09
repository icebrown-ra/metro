# Minimal Chrome DevTools Protocol client for PowerShell 5.1.
#
# Headless Chrome's --dump-dom fires at load and --virtual-time-budget freezes
# real async audio work (decodeAudioData never settles), so neither can drive a
# page that needs real time. This connects over CDP instead, evaluates JS in the
# page with awaitPromise, and returns the result as an object.
#
#   $r = & tools\cdp.ps1 -Url https://example.com/diag.html `
#          -Expression "window.__done" -WaitFor "window.__ready === true"
#
# -WaitFor is polled until truthy (or timeout) before -Expression is evaluated.

param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Expression,
    [string]$WaitFor = "",
    [int]$TimeoutSec = 120,
    [int]$Port = 0,
    [string]$WindowSize = "390,844",   # iPhone 정도 — 레이아웃 검사가 실기기와 어긋나지 않게
    [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'

function Find-Chrome {
    $c = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($p in $c) { if (Test-Path $p) { return $p } }
    throw "Chrome/Edge not found"
}

if ($Port -eq 0) { $Port = Get-Random -Minimum 9300 -Maximum 9899 }
$profileDir = Join-Path $env:TEMP ("cdp-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

$chrome = Find-Chrome
$args = @(
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files',
    '--mute-audio',
    "--window-size=$WindowSize",
    '--force-device-scale-factor=1',      # 없으면 윈도우 배율 때문에 뷰포트가 어긋난다
    "--remote-debugging-port=$Port",
    "--user-data-dir=$profileDir",
    '--no-first-run', '--no-default-browser-check',
    $Url
)
$proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru -WindowStyle Hidden

$ws = $null
try {
    # wait for the debugging endpoint
    $target = $null
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        try {
            $list = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3
            $target = $list | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
            if ($target) { break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $target) { throw "CDP endpoint not reachable on port $Port" }

    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ct = [Threading.CancellationToken]::None
    $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $ct).Wait(15000) | Out-Null
    if ($ws.State -ne 'Open') { throw "WebSocket not open: $($ws.State)" }

    $script:msgId = 0
    function Send-Cdp([string]$Method, $Params) {
        $script:msgId++
        $payload = @{ id = $script:msgId; method = $Method; params = $Params } | ConvertTo-Json -Depth 10 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
        $seg = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $bytes)
        $ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait(15000) | Out-Null

        # read until we see the reply with our id (events interleave)
        $stop = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $stop) {
            $sb = New-Object Text.StringBuilder
            do {
                $buf = New-Object byte[] 262144
                $rseg = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $buf)
                $task = $ws.ReceiveAsync($rseg, $ct)
                if (-not $task.Wait(60000)) { throw "CDP receive timeout" }
                $res = $task.Result
                [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
            } while (-not $res.EndOfMessage)

            $obj = $sb.ToString() | ConvertFrom-Json
            if ($obj.id -eq $script:msgId) { return $obj }
        }
        throw "no CDP reply for $Method"
    }

    function Eval([string]$Js, [bool]$Await = $false) {
        $r = Send-Cdp 'Runtime.evaluate' @{
            expression    = $Js
            returnByValue = $true
            awaitPromise  = $Await
        }
        if ($r.error) { throw ("CDP error: " + ($r.error | ConvertTo-Json -Compress)) }
        if ($r.result.exceptionDetails) {
            $ex = $r.result.exceptionDetails
            $msg = if ($ex.exception -and $ex.exception.description) { $ex.exception.description } else { $ex.text }
            throw ("page exception: " + $msg)
        }
        return $r.result.result.value
    }

    if ($WaitFor) {
        $stop = (Get-Date).AddSeconds($TimeoutSec)
        $ready = $false
        while ((Get-Date) -lt $stop) {
            try { if (Eval "!!($WaitFor)" $false) { $ready = $true; break } } catch { }
            Start-Sleep -Milliseconds 300
        }
        if (-not $ready) { throw "WaitFor never became true within ${TimeoutSec}s: $WaitFor" }
    }

    Eval $Expression $true
}
finally {
    if ($ws) { try { $ws.Dispose() } catch { } }
    if (-not $KeepOpen -and $proc -and -not $proc.HasExited) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Milliseconds 300
    try { Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
