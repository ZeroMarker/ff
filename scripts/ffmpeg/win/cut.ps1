# 视频裁剪工具
# 用法: .\cut.ps1 <输入文件> <开始时间> <结束时间>
# 示例: .\cut.ps1 video.mp4 00:01:30 00:03:45

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$InputFile,

    [Parameter(Mandatory=$true, Position=1)]
    [string]$StartTime,

    [Parameter(Mandatory=$true, Position=2)]
    [string]$EndTime
)

if (-not (Test-Path $InputFile)) {
    Write-Error "文件不存在: $InputFile"
    exit 1
}

$dir = [System.IO.Path]::GetDirectoryName($InputFile)
$name = [System.IO.Path]::GetFileNameWithoutExtension($InputFile)
$ext = [System.IO.Path]::GetExtension($InputFile)
$startClean = $StartTime.Replace(':', '')
$endClean = $EndTime.Replace(':', '')

$outputName = if ($dir) { "$dir\${name}_cut_${startClean}-${endClean}${ext}" } else { "${name}_cut_${startClean}-${endClean}${ext}" }

function To-Sec($t) {
    $parts = $t -split ':'
    [int]$parts[0] * 3600 + [int]$parts[1] * 60 + [int]$parts[2]
}

$durationSec = (To-Sec $EndTime) - (To-Sec $StartTime)
$duration = "{0:D2}:{1:D2}:{2:D2}" -f ([math]::Floor($durationSec/3600)), ([math]::Floor(($durationSec%3600)/60)), ($durationSec%60)

Write-Host "裁剪: $InputFile"
Write-Host "时间: $StartTime -> $EndTime (时长: $duration)"
Write-Host "输出: $outputName"

ffmpeg -y -ss $StartTime -i $InputFile -t $duration -c copy $outputName
