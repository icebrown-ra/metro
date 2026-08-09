# Render the app icons as PNG using GDI+ (built into Windows, no installs).
#
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
#
# 180 = apple-touch-icon, 192/512 = web app manifest.
# The artwork is a metronome silhouette kept inside the middle 80% of the
# canvas so it survives Android's maskable crop.

param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $Root 'icons'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$bg = [System.Drawing.ColorTranslator]::FromHtml('#0b0d12')
$gold = [System.Drawing.ColorTranslator]::FromHtml('#e8b84b')

function New-Icon([int]$Size, [string]$Path) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear($bg)

    $s = [double]$Size
    function P([double]$x, [double]$y) {
        return New-Object System.Drawing.PointF([float]($x * $s), [float]($y * $s))
    }

    # metronome body
    $body = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pts = @((P 0.50 0.17), (P 0.775 0.815), (P 0.225 0.815))
    $body.AddPolygon([System.Drawing.PointF[]]$pts)
    $brush = New-Object System.Drawing.SolidBrush($gold)
    $g.FillPath($brush, $body)

    # base plate
    $baseRect = New-Object System.Drawing.RectangleF(
        [float](0.20 * $s), [float](0.795 * $s), [float](0.60 * $s), [float](0.055 * $s))
    $g.FillRectangle($brush, $baseRect)

    # Everything below is cut OUT of the body, so clip to it — otherwise the
    # rod and weight poke past the silhouette and read as a notch.
    $g.SetClip($body)

    $bgBrush = New-Object System.Drawing.SolidBrush($bg)
    $pen = New-Object System.Drawing.Pen($bg, [float](0.040 * $s))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($pen, (P 0.500 0.775), (P 0.565 0.395))

    # pendulum weight, sitting on the rod
    $w = 0.100; $h = 0.058
    $weight = New-Object System.Drawing.RectangleF(
        [float]((0.553 - $w / 2) * $s), [float]((0.470 - $h / 2) * $s),
        [float]($w * $s), [float]($h * $s))
    $g.FillRectangle($bgBrush, $weight)

    # pivot dot
    $r = 0.032
    $g.FillEllipse($bgBrush, [float]((0.50 - $r) * $s), [float]((0.775 - $r) * $s),
        [float]($r * 2 * $s), [float]($r * 2 * $s))

    $g.ResetClip()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

    $pen.Dispose(); $brush.Dispose(); $bgBrush.Dispose()
    $body.Dispose(); $g.Dispose(); $bmp.Dispose()
}

foreach ($size in 180, 192, 512) {
    $p = Join-Path $outDir ("icon-$size.png")
    New-Icon $size $p
    "{0,-16} {1,7} bytes" -f ("icon-$size.png"), (Get-Item $p).Length
}

Write-Host "done." -ForegroundColor Green
