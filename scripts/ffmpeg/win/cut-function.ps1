function rip {
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$InputFile,

        [Parameter(Mandatory=$true, Position=1)]
        [string]$StartTime,

        [Parameter(Mandatory=$true, Position=2)]
        [string]$EndTime
    )

    if (-not (Test-Path -LiteralPath $InputFile -PathType Leaf)) {
        Write-Error "文件不存在: $InputFile"
        return
    }
    foreach ($tool in @('ffmpeg', 'ffprobe')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            Write-Error "$tool 未安装或不在 PATH 中"
            return
        }
    }

    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    $durationText = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $InputFile
    $probeExitCode = $LASTEXITCODE
    $duration = 0.0
    if ($probeExitCode -ne 0 -or "$durationText" -notmatch '^[0-9]+(\.[0-9]+)?$' -or
        -not [double]::TryParse("$durationText", [System.Globalization.NumberStyles]::AllowDecimalPoint, $culture, [ref]$duration) -or
        [double]::IsInfinity($duration) -or $duration -le 0) {
        Write-Error "无法读取有效的素材时长: $InputFile"
        return
    }

    # 秒数、MM:SS、HH:MM:SS；别名只允许 start 用于起点、end 用于终点。
    $parseTime = {
        param([string]$Value)
        $parts = $Value.Split(':')
        if ($parts.Count -gt 3) { return $null }
        $seconds = 0.0
        for ($i = 0; $i -lt $parts.Count; $i++) {
            $pattern = if ($i -eq $parts.Count - 1) { '^[0-9]+(\.[0-9]+)?$' } else { '^[0-9]+$' }
            if ($parts[$i] -notmatch $pattern) { return $null }
            $part = 0.0
            if (-not [double]::TryParse($parts[$i], [System.Globalization.NumberStyles]::AllowDecimalPoint, $culture, [ref]$part)) { return $null }
            if ($i -gt 0 -and $part -ge 60) { return $null }
            $seconds = $seconds * 60 + $part
        }
        if ([double]::IsInfinity($seconds)) { return $null }
        return $seconds
    }
    $startSeconds = if ($StartTime -eq 'start') { 0.0 } else { & $parseTime $StartTime }
    $endSeconds = if ($EndTime -eq 'end') { $duration } else { & $parseTime $EndTime }
    if ($null -eq $startSeconds -or $null -eq $endSeconds) {
        Write-Error '时间须为非负秒数、MM:SS 或 HH:MM:SS（支持小数秒）'
        return
    }
    if ($startSeconds -ge $endSeconds) {
        Write-Error '开始时间必须小于结束时间'
        return
    }
    if ($startSeconds -ge $duration -or $endSeconds -gt $duration) {
        Write-Error "时间范围超出素材时长（$durationText 秒），须满足 0 ≤ 开始 < 结束 ≤ 时长"
        return
    }

    # 文件名中用 start/end 替代时间码
    $ssLabel = if ($StartTime -eq 'start') { 'start' } else { $StartTime.Replace(':', '') }
    $toLabel = if ($EndTime -eq 'end') { 'end' } else { $EndTime.Replace(':', '') }
    $outputName = "$([System.IO.Path]::GetFileNameWithoutExtension($InputFile))_cut_${ssLabel}-${toLabel}$([System.IO.Path]::GetExtension($InputFile))"

    # 检测原始视频编码，选择合适的编码器
    $codec = & ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 $InputFile
    $venc = switch ($codec) {
        'h264'  { 'libx264'; break }
        'hevc'  { 'libx265'; break }
        'h265'  { 'libx265'; break }
        default { 'libx264' }
    }
    $crf = if ($venc -eq 'libx264') { 23 } else { 28 }

    # 拼接 ffmpeg 参数
    # 注意: -to 必须与 -ss 一起放在 -i 之前（输入选项，按原始时间戳算终点）。
    #       若 -to 放在 -i 之后（输出选项），`-ss` 输入定位平移时间戳后，-to 按平移后的位置计算，终点会翻倍。
    $ss = $startSeconds.ToString('0.#########', $culture)
    $argsList = @('-y', '-ss', $ss)
    if ($EndTime -ne 'end') { $argsList += '-to'; $argsList += $endSeconds.ToString('0.#########', $culture) }
    $argsList += '-i'; $argsList += $InputFile
    $argsList += '-c:v'; $argsList += $venc
    $argsList += '-crf'; $argsList += $crf
    $argsList += '-preset'; $argsList += 'fast'
    $argsList += '-c:a'; $argsList += 'aac'
    $argsList += $outputName

    Write-Host "裁剪: $InputFile"
    Write-Host "时间: $StartTime -> $EndTime"
    Write-Host "编码: $venc (crf=$crf)"
    Write-Host "输出: $outputName"

    & ffmpeg $argsList
}
