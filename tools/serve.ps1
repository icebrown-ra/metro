# Tiny static file server for local testing. No installs needed.
#
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1
#   -> http://localhost:8080/
#
# Why this exists: opening index.html as file:// blocks the things that matter
# most here - voice WAV loading (fetch), the service worker, and the microphone.
# localhost counts as a secure context, so everything works exactly as it will
# once deployed.
#
# Built on TcpListener rather than HttpListener because HttpListener needs a URL
# reservation (admin) on Windows, and this must run without elevation.

param(
    [int]$Port = 8080,
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$MIME = @{
    '.html' = 'text/html; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'
    '.js' = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.webmanifest' = 'application/manifest+json; charset=utf-8'
    '.wav' = 'audio/wav'
    '.mp3' = 'audio/mpeg'
    '.m4a' = 'audio/mp4'
    '.png' = 'image/png'
    '.svg' = 'image/svg+xml'
    '.ico' = 'image/x-icon'
    '.md' = 'text/markdown; charset=utf-8'
    '.txt' = 'text/plain; charset=utf-8'
}

$Root = (Resolve-Path $Root).Path
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() }
catch { Write-Error "포트 $Port 를 열 수 없습니다: $($_.Exception.Message)"; exit 1 }

Write-Host ""
Write-Host "  서빙 중: $Root" -ForegroundColor DarkGray
Write-Host "  http://localhost:$Port/" -ForegroundColor Cyan
Write-Host "  http://localhost:$Port/diag.html   (진단)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Ctrl+C 로 종료" -ForegroundColor DarkGray
Write-Host ""

function Send-Response($stream, [int]$Code, [string]$Status, [byte[]]$Body, [string]$Type) {
    $head = "HTTP/1.1 $Code $Status`r`n" +
            "Content-Type: $Type`r`n" +
            "Content-Length: $($Body.Length)`r`n" +
            "Cache-Control: no-store`r`n" +
            "Connection: close`r`n`r`n"
    $hb = [Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($hb, 0, $hb.Length)
    if ($Body.Length) { $stream.Write($Body, 0, $Body.Length) }
    $stream.Flush()
}

while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
        $client.ReceiveTimeout = 5000
        $stream = $client.GetStream()

        # read the request line (headers are ignored - GET only)
        $sb = New-Object Text.StringBuilder
        $buf = New-Object byte[] 1
        while ($sb.Length -lt 8192) {
            $n = $stream.Read($buf, 0, 1)
            if ($n -le 0) { break }
            [void]$sb.Append([char]$buf[0])
            if ($sb.Length -ge 4 -and $sb.ToString($sb.Length - 4, 4) -eq "`r`n`r`n") { break }
        }
        $req = $sb.ToString()
        if (-not $req) { continue }

        $line = ($req -split "`r`n")[0]
        $parts = $line -split ' '
        if ($parts.Count -lt 2) { continue }
        $rawPath = $parts[1]

        $path = ($rawPath -split '\?')[0]
        $path = [Uri]::UnescapeDataString($path)
        if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }

        # keep the request inside the served folder
        $rel = $path.TrimStart('/').Replace('/', '\')
        $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))
        if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
            Send-Response $stream 403 'Forbidden' ([Text.Encoding]::UTF8.GetBytes('forbidden')) 'text/plain'
            continue
        }

        if (Test-Path $full -PathType Container) { $full = Join-Path $full 'index.html' }

        if (Test-Path $full -PathType Leaf) {
            $ext = [IO.Path]::GetExtension($full).ToLower()
            $type = $MIME[$ext]
            if (-not $type) { $type = 'application/octet-stream' }
            $bytes = [IO.File]::ReadAllBytes($full)
            Send-Response $stream 200 'OK' $bytes $type
            Write-Host ("  200  {0}  ({1:N0} B)" -f $path, $bytes.Length) -ForegroundColor DarkGray
        }
        else {
            Send-Response $stream 404 'Not Found' ([Text.Encoding]::UTF8.GetBytes('not found')) 'text/plain'
            Write-Host ("  404  {0}" -f $path) -ForegroundColor DarkYellow
        }
    }
    catch { }
    finally { try { $client.Close() } catch { } }
}
