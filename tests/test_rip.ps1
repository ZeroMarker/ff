# Run: pwsh -NoProfile -File tests/test_rip.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $temp
$oldLocation = Get-Location
$oldCulture = [System.Threading.Thread]::CurrentThread.CurrentCulture
try {
    Set-Location $temp
    # Ensure decimal input/output remains valid under a comma-decimal locale.
    [System.Threading.Thread]::CurrentThread.CurrentCulture = [cultureinfo]'de-DE'
    & ffmpeg -v error -f lavfi -i 'color=c=black:s=64x64:r=10:d=2' -c:v libx264 'sample video.mp4'
    if ($LASTEXITCODE -ne 0) { throw 'Fixture generation failed' }
    foreach ($script in @('cut-function.ps1', 'ffmpeg.ps1')) {
        . (Join-Path $repo "scripts/ffmpeg/win/$script")
        foreach ($pair in @(
            @('-1', '1'), @('nope', '1'), @('0', '00:60'), @('0', '00:60:00'),
            @('0', '1:2:3:4'), @('0', '1.'), @('1', '1'), @('1.5', '1'),
            @('2', '3'), @('0', '2.001'), @('01:39:26', '01:40:10'), @('end', 'start')
        )) {
            $rejected = $false
            try { rip 'sample video.mp4' $pair[0] $pair[1] } catch { $rejected = $true }
            if (-not $rejected) { throw "Invalid range accepted: $script $pair" }
            if (Get-ChildItem '*_cut_*') { throw 'Invalid input generated an output' }
        }
        foreach ($pair in @(@('0', '2'), @('00:00.5', '00:01.5'), @('00:00:00.5', '00:00:01.5'), @('start', 'end'))) {
            rip 'sample video.mp4' $pair[0] $pair[1]
            if ($LASTEXITCODE -ne 0) { throw "Valid range failed: $script $pair" }
            $output = Get-ChildItem '*_cut_*'
            if ($output.Count -ne 1) { throw 'Expected exactly one output' }
            $durationText = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $output.FullName
            $duration = [double]::Parse($durationText, [cultureinfo]::InvariantCulture)
            $expected = if ($pair[0] -in @('0', 'start')) { 2 } else { 1 }
            if ([math]::Abs($duration - $expected) -gt 0.01) { throw "Wrong output duration: $durationText" }
            Remove-Item -LiteralPath $output.FullName
        }
        foreach ($extension in @('mkv', 'mov')) {
            $source = "sample video.$extension"
            & ffmpeg -y -v error -i 'sample video.mp4' -c copy $source
            if ($LASTEXITCODE -ne 0) { throw 'Non-MP4 fixture generation failed' }
            rip $source 0 1
            if ($LASTEXITCODE -ne 0) { throw "Non-MP4 input failed: $script $extension" }
            $output = Get-ChildItem '*_cut_*'
            if ($output.Count -ne 1 -or $output.Name -ne 'sample video_cut_0-1.mp4') { throw 'Expected exactly one MP4 output' }
            $formatName = & ffprobe -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 $output.FullName
            if ($LASTEXITCODE -ne 0 -or 'mp4' -notin $formatName.Split(',')) { throw 'Output is not an MP4 container' }
            Remove-Item -LiteralPath $output.FullName
        }
        Set-Content 'bad.mp4' 'not a video'
        $rejected = $false
        try { rip 'bad.mp4' 0 1 } catch { $rejected = $true }
        if (-not $rejected -or (Get-ChildItem '*_cut_*')) { throw 'Unreadable media accepted' }
        foreach ($probeCase in @(@('N/A', 0), @('0', 0), @('NaN', 0), @('2', 1))) {
            $mockDuration = $probeCase[0]
            $mockExitCode = $probeCase[1]
            $encoderStarted = $false
            function ffprobe { $global:LASTEXITCODE = $mockExitCode; $mockDuration }
            function ffmpeg { $script:encoderStarted = $true }
            try {
                $rejected = $false
                try { rip 'sample video.mp4' 0 1 } catch { $rejected = $true }
                if (-not $rejected -or $encoderStarted) { throw 'Invalid duration reached encoding' }
            } finally {
                Remove-Item Function:ffprobe
                Remove-Item Function:ffmpeg
            }
        }
        Write-Host "PASS: $script"
    }
} finally {
    [System.Threading.Thread]::CurrentThread.CurrentCulture = $oldCulture
    Set-Location $oldLocation
    Remove-Item -LiteralPath $temp -Recurse -Force
}
