# PowerShell 自动计算时长分割 TS 文件
# 使用方法: .\this.ps1 [-InputFile] "input.ts" [-c "00:00:30,00:01:00"]

param(
    [Parameter(Mandatory = $false, Position = 0, HelpMessage = "输入视频文件路径")]
    [string]$InputFile = "input.ts",
    
    [Alias("c")]
    [Parameter(Mandatory = $false, HelpMessage = "截断点时间戳（逗号分隔）")]
    [string]$CutPoints = "00:00:30,00:01:00"
)

# ==================== 配置 ====================
# 截断点时间戳（格式 HH:MM:SS 或秒数），用逗号分隔
$cutPointArray = $CutPoints -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }

# ==================== 主程序 ====================

# 验证输入文件
if (-not (Test-Path $InputFile)) {
    Write-Error "错误: 找不到输入文件 '$InputFile'"
    Write-Host "使用示例: .\$($MyInvocation.MyCommand.Name) 'video.ts' -c '30,60,120'"
    exit 1
}

# 生成输出前缀（原文件名 + _clip）
$baseName = [System.IO.Path]::GetFileNameWithoutExtension($InputFile)
$outputPrefix = "${baseName}_clip"

# 获取视频总时长（秒）
Write-Host "正在分析视频文件: $InputFile" -ForegroundColor Cyan
$durationCmd = "& ffmpeg -i '$InputFile' 2>&1"
$durationOutput = Invoke-Expression $durationCmd
$durationLine = $durationOutput | Select-String "Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})"

if ($durationLine) {
    $hours = [int]$durationLine.Matches.Groups[1].Value
    $minutes = [int]$durationLine.Matches.Groups[2].Value
    $seconds = [int]$durationLine.Matches.Groups[3].Value
    $totalSeconds = $hours * 3600 + $minutes * 60 + $seconds
    Write-Host "视频总时长: $hours`:$minutes`:$seconds ($totalSeconds 秒)" -ForegroundColor Green
} else {
    Write-Host "警告: 无法获取视频时长，最后一个片段可能不准确" -ForegroundColor Yellow
    $totalSeconds = 86400  # 默认24小时
}

# 转换时间戳为秒数
function Convert-ToSeconds {
    param($timeStr)
    if ($timeStr -match "^\d+$") {
        return [int]$timeStr
    }
    $parts = $timeStr -split ":"
    if ($parts.Length -eq 3) {
        return [int]$parts[0] * 3600 + [int]$parts[1] * 60 + [int]$parts[2]
    } elseif ($parts.Length -eq 2) {
        return [int]$parts[0] * 60 + [int]$parts[1]
    }
    return [int]$timeStr
}

# 构建分段数组 - 使用更健壮的方式初始化
$cutPointsInSeconds = $cutPointArray | ForEach-Object { Convert-ToSeconds $_ }

# 如果没有任何截断点，添加一个默认的
if ($cutPointsInSeconds.Count -eq 0) {
    $cutPointsInSeconds = @(30)  # 默认30秒处截断
}

# 使用数组列表避免拼接问题
$segmentStarts = New-Object System.Collections.ArrayList
$segmentStarts.Add(0) | Out-Null
foreach ($point in $cutPointsInSeconds) {
    $segmentStarts.Add($point) | Out-Null
}

$segmentEnds = New-Object System.Collections.ArrayList
foreach ($point in $cutPointsInSeconds) {
    $segmentEnds.Add($point) | Out-Null
}
$segmentEnds.Add($totalSeconds) | Out-Null

# 处理每个片段
for ($i = 0; $i -lt $segmentStarts.Count; $i++) {
    $startSeconds = $segmentStarts[$i]
    $endSeconds = $segmentEnds[$i]
    $duration = $endSeconds - $startSeconds
    
    # 跳过无效片段
    if ($duration -le 0) {
        Write-Host "警告: 第 $($i+1) 片段时长无效，跳过" -ForegroundColor Yellow
        continue
    }
    
    $outputFile = "{0}{1:D3}.mp4" -f $outputPrefix, ($i + 1)
    
    Write-Host "`n[$($i+1)/$($segmentStarts.Count)] 分割: $outputFile" -ForegroundColor Yellow
    Write-Host "  开始: $([timespan]::FromSeconds($startSeconds).ToString('hh\:mm\:ss'))" -ForegroundColor Gray
    Write-Host "  结束: $([timespan]::FromSeconds($endSeconds).ToString('hh\:mm\:ss'))" -ForegroundColor Gray
    Write-Host "  时长: ${duration}秒" -ForegroundColor Gray
    
    # 执行 ffmpeg
    & ffmpeg -i $InputFile `
        -ss $startSeconds `
        -t $duration `
        -c:v libx264 `
        -c:a aac `
        -preset medium `
        -avoid_negative_ts make_zero `
        $outputFile 2>&1 | Out-Null
    
    if (Test-Path $outputFile) {
        $size = [math]::Round((Get-Item $outputFile).Length / 1MB, 2)
        Write-Host "  ✓ 完成: $size MB" -ForegroundColor Green
    } else {
        Write-Host "  ✗ 失败" -ForegroundColor Red
    }
}

Write-Host "`n✅ 全部分割完成！" -ForegroundColor Cyan