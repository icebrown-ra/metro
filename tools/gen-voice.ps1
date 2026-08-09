# Generate voice-count WAV packs using the Windows built-in SAPI voices.
# No installs required.
#
#   powershell -ExecutionPolicy Bypass -File tools\gen-voice.ps1
#
# Leading/trailing silence is trimmed and levels are normalised here.
# That step matters more than it looks: if silence is left at the front of a
# file, the syllable is heard LATE relative to the beat.
#
# This file is deliberately pure ASCII. Windows PowerShell 5.1 decodes .ps1
# files as ANSI unless they carry a UTF-8 BOM, so the spoken text lives in
# tools\voice-text.json (read explicitly as UTF-8) instead of in here.

param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [double]$ThresholdDb = -42,    # below this counts as silence
    [double]$TargetDb = -3,        # normalisation peak target
    [int]$PadMs = 5,               # margin kept around the trimmed region
    [int]$RateOverride = -99       # override the per-pack rate from the json
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$SYLLABLES = @('1', '2', '3', '4', '5', '6', '7', '8', 'cha', 'a', 'and', 'slow', 'quick')

function Read-Wav([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $pos = 12
    $channels = 1; $rate = 22050; $bits = 16
    $dataOff = -1; $dataSize = 0
    while ($pos -lt ($bytes.Length - 8)) {
        $id = [System.Text.Encoding]::ASCII.GetString($bytes, $pos, 4)
        $size = [int][System.BitConverter]::ToUInt32($bytes, $pos + 4)
        if ($id -eq 'fmt ') {
            $channels = [int][System.BitConverter]::ToUInt16($bytes, $pos + 10)
            $rate = [int][System.BitConverter]::ToUInt32($bytes, $pos + 12)
            $bits = [int][System.BitConverter]::ToUInt16($bytes, $pos + 22)
        }
        elseif ($id -eq 'data') {
            $dataOff = $pos + 8
            $dataSize = $size
            break
        }
        $pos += 8 + $size + ($size % 2)
    }
    if ($dataOff -lt 0) { throw "no data chunk: $Path" }
    if ($bits -ne 16) { throw "not 16-bit PCM ($bits bit): $Path" }

    $n = [int]($dataSize / 2)
    $samples = New-Object 'System.Int16[]' $n
    [System.Buffer]::BlockCopy($bytes, $dataOff, $samples, 0, $n * 2)

    return @{ Channels = $channels; Rate = $rate; Samples = $samples }
}

function Write-Wav([string]$Path, [int]$Channels, [int]$Rate, [System.Int16[]]$Samples) {
    $dataBytes = New-Object 'byte[]' ($Samples.Length * 2)
    [System.Buffer]::BlockCopy($Samples, 0, $dataBytes, 0, $dataBytes.Length)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $ascii = [System.Text.Encoding]::ASCII
    $bw.Write($ascii.GetBytes('RIFF'))
    $bw.Write([uint32](36 + $dataBytes.Length))
    $bw.Write($ascii.GetBytes('WAVE'))
    $bw.Write($ascii.GetBytes('fmt '))
    $bw.Write([uint32]16)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$Channels)
    $bw.Write([uint32]$Rate)
    $bw.Write([uint32]($Rate * $Channels * 2))
    $bw.Write([uint16]($Channels * 2))
    $bw.Write([uint16]16)
    $bw.Write($ascii.GetBytes('data'))
    $bw.Write([uint32]$dataBytes.Length)
    $bw.Write($dataBytes)
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($Path, $ms.ToArray())
    $bw.Dispose(); $ms.Dispose()
}

function Get-Trimmed($wav) {
    $s = $wav.Samples
    $ch = $wav.Channels
    $th = 32768.0 * [Math]::Pow(10, $ThresholdDb / 20)

    $first = -1; $last = -1
    for ($i = 0; $i -lt $s.Length; $i++) {
        if ([Math]::Abs([int]$s[$i]) -gt $th) { $first = $i; break }
    }
    if ($first -lt 0) { return $null }
    for ($i = $s.Length - 1; $i -ge 0; $i--) {
        if ([Math]::Abs([int]$s[$i]) -gt $th) { $last = $i; break }
    }

    $pad = [int]($PadMs / 1000.0 * $wav.Rate) * $ch
    $first = [Math]::Max(0, $first - $pad)
    $last = [Math]::Min($s.Length - 1, $last + $pad)
    $first = $first - ($first % $ch)          # keep frame alignment
    $count = $last - $first + 1
    $count = $count - ($count % $ch)

    $out = New-Object 'System.Int16[]' $count
    [System.Array]::Copy($s, $first, $out, 0, $count)

    $peak = 0
    for ($i = 0; $i -lt $out.Length; $i++) {
        $v = [Math]::Abs([int]$out[$i])
        if ($v -gt $peak) { $peak = $v }
    }
    if ($peak -gt 0) {
        $target = 32767.0 * [Math]::Pow(10, $TargetDb / 20)
        $gain = $target / $peak
        for ($i = 0; $i -lt $out.Length; $i++) {
            $v = [int][Math]::Round($out[$i] * $gain)
            if ($v -gt 32767) { $v = 32767 }
            if ($v -lt -32768) { $v = -32768 }
            $out[$i] = [int16]$v
        }
    }

    return @{ Channels = $ch; Rate = $wav.Rate; Samples = $out }
}

$jsonPath = Join-Path $PSScriptRoot 'voice-text.json'
$cfg = (Get-Content -Raw -Encoding UTF8 $jsonPath) | ConvertFrom-Json

$installed = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
    ForEach-Object { $_.VoiceInfo.Name }

foreach ($pack in $cfg.packs) {
    if ($installed -notcontains $pack.voice) {
        Write-Warning ("voice not installed, skipping: " + $pack.voice)
        continue
    }

    $outDir = Join-Path $Root ('audio\voices\' + $pack.id)
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

    Write-Host ""
    Write-Host ("=== " + $pack.id + "  (" + $pack.voice + ") ===") -ForegroundColor Cyan

    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.SelectVoice($pack.voice)
    if ($RateOverride -ne -99) { $synth.Rate = $RateOverride } else { $synth.Rate = [int]$pack.rate }

    $tmp = Join-Path $env:TEMP ("dsm-voice-" + [guid]::NewGuid().ToString('N') + ".wav")

    foreach ($key in $SYLLABLES) {
        $text = $pack.text.$key
        if (-not $text) { Write-Warning ("no text for key: " + $key); continue }

        $synth.SetOutputToWaveFile($tmp)
        $synth.Speak($text)
        $synth.SetOutputToNull()

        $clean = Get-Trimmed (Read-Wav $tmp)
        if ($null -eq $clean) { Write-Warning ("silent output: " + $key); continue }

        $dest = Join-Path $outDir ($key + '.wav')
        Write-Wav $dest $clean.Channels $clean.Rate $clean.Samples

        $ms2 = [Math]::Round(1000.0 * $clean.Samples.Length / $clean.Channels / $clean.Rate)
        Write-Host ("{0,-6} {1,5} ms  {2,6} bytes  @{3} Hz" -f $key, $ms2, (Get-Item $dest).Length, $clean.Rate)
    }

    $synth.Dispose()
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
}

Write-Host ""
Write-Host "done." -ForegroundColor Green
