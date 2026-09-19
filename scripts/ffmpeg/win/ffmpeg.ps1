function rip {
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$InputFile,
        [Parameter(Mandatory=$true, Position=1)]
        [string]$StartTime,
        [Parameter(Mandatory=$true, Position=2)]
        [string]$EndTime
    )
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
    $ss = if ($StartTime -eq 'start') { '0' } else { $StartTime }
    $argsList = @('-y', '-ss', $ss)
    if ($EndTime -ne 'end') { $argsList += '-to'; $argsList += $EndTime }
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

function gblur {
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$InputFile,
        [Parameter(Mandatory=$true, Position=1)]
        [double[]]$Point1,
        [Parameter(Mandatory=$true, Position=2)]
        [double[]]$Point2,
        [int]$Sigma = 20
    )

    if ($Point1.Count -ne 2 -or $Point2.Count -ne 2) {
        Write-Error "坐标点必须是 @(x, y) 百分数形式，相对视频宽高，例如: gblur video.mp4 @(20,30) @(60,50)"
        return
    }
    if (-not (Test-Path $InputFile)) {
        Write-Error "文件不存在: $InputFile"
        return
    }
    if ($Sigma -le 0) {
        Write-Error "Sigma 必须大于 0"
        return
    }

    # 读取视频分辨率（百分比换算必需）
    $size = & ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 $InputFile
    if ($size -notmatch '^(\d+)x(\d+)$') {
        Write-Error "无法读取视频分辨率: $InputFile"
        return
    }
    $vW = [int]$Matches[1]; $vH = [int]$Matches[2]

    # 百分数 -> 像素坐标（支持小数百分比；右下角可传大于 100 的大概值，自动收敛）
    $p1x = [int][Math]::Round($Point1[0] / 100 * $vW)
    $p1y = [int][Math]::Round($Point1[1] / 100 * $vH)
    $p2x = [int][Math]::Round($Point2[0] / 100 * $vW)
    $p2y = [int][Math]::Round($Point2[1] / 100 * $vH)

    # 由两个角点归一化为左上角 + 宽高（点顺序无关，负值归零，越界收敛）
    $x = [Math]::Min($p1x, $p2x); if ($x -lt 0) { $x = 0 }
    $y = [Math]::Min($p1y, $p2y); if ($y -lt 0) { $y = 0 }
    $w = [Math]::Abs($p2x - $p1x); if ($x + $w -gt $vW) { $w = $vW - $x }
    $h = [Math]::Abs($p2y - $p1y); if ($y + $h -gt $vH) { $h = $vH - $y }
    if ($w -le 0 -or $h -le 0) {
        Write-Error "区域宽高必须大于 0，请检查两个坐标点"
        return
    }
    # 部分模糊滤镜要求偶数宽高（越界裁剪后可能变奇数，需在最后修正）
    if ($w % 2 -ne 0) { $w-- }
    if ($h % 2 -ne 0) { $h-- }
    if ($w -le 0 -or $h -le 0) {
        Write-Error "区域超出视频范围，请检查坐标"
        return
    }

    # 检测原始视频编码，选择合适的编码器
    $codec = & ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 $InputFile
    $venc = switch ($codec) {
        'h264'  { 'libx264'; break }
        'hevc'  { 'libx265'; break }
        'h265'  { 'libx265'; break }
        default { 'libx264' }
    }
    $crf = if ($venc -eq 'libx264') { 23 } else { 28 }

    $item = Get-Item $InputFile
    $outputName = Join-Path $item.DirectoryName "$($item.BaseName)_blur$($item.Extension)"
    # 原画面 split 两份: 一份保留，一份全帧模糊后 crop 出区域再 overlay 回去
    $filter = "[0:v]split=2[bg][fg];[fg]gblur=sigma=$Sigma,crop=$w`:$h`:$x`:$y[blurred];[bg][blurred]overlay=$x`:$y"

    $argsList = @('-y', '-i', $InputFile, '-filter_complex', $filter, '-c:v', $venc, '-crf', $crf, '-preset', 'fast', '-c:a', 'copy', $outputName)

    Write-Host "高斯模糊: $InputFile  ($vW x $vH)"
    Write-Host "区域: $($Point1[0])%,$($Point1[1])% -> $($Point2[0])%,$($Point2[1])%  =>  ($x,$y) -> ($($x+$w),$($y+$h))  (sigma=$Sigma)"
    Write-Host "编码: $venc (crf=$crf)"
    Write-Host "输出: $outputName"
    & ffmpeg $argsList
}

function h2v {
    param(
        [Parameter(Position=0, ValueFromRemainingArguments=$true, Mandatory=$true)]
        [string[]]$Files,
        [double]$Offset = 0.5
    )

    if ($Offset -lt 0 -or $Offset -gt 1) {
        Write-Error "偏移量必须在 0.0 到 1.0 之间"
        return
    }

    foreach ($f in $Files) {
        if (-not (Test-Path $f)) {
            Write-Warning "跳过: $f (文件不存在)"
            continue
        }
        $item = Get-Item $f
        $outPath = Join-Path $item.DirectoryName "$($item.BaseName)_竖屏.mp4"
        Write-Host "处理: $($item.Name) (偏移: $Offset)"
        ffmpeg -i $item.FullName -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)*${Offset}:(in_h-1920)/2" -c:a copy $outPath
    }
}

# MP4/MKV + SRT 字幕合并。
# 用法:
#   sub video.mp4 subtitle.srt
#   sub video.mp4 subtitle.srt embed
#   sub video.mp4 subtitle.srt output.mp4 embed
function sub {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$InputFile,

        [Parameter(Mandatory=$true, Position=1)]
        [string]$SubtitleFile,

        [Parameter(Position=2)]
        [string]$OutputFile,

        [Parameter(Position=3)]
        [ValidateSet('burn', 'embed')]
        [string]$Mode = 'burn'
    )

    # 第三个位置参数也可直接指定模式，此时自动生成输出文件名。
    if ($OutputFile -in @('burn', 'embed')) {
        if ($PSBoundParameters.ContainsKey('Mode')) {
            Write-Error '模式不能同时作为第三和第四个参数传入'
            return
        }
        $Mode = $OutputFile
        $OutputFile = $null
    }

    if (-not (Test-Path -LiteralPath $InputFile -PathType Leaf)) {
        Write-Error "视频文件不存在: $InputFile"
        return
    }

    if (-not (Test-Path -LiteralPath $SubtitleFile -PathType Leaf)) {
        Write-Error "字幕文件不存在: $SubtitleFile"
        return
    }

    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        Write-Error 'ffmpeg 未安装或不在 PATH 中'
        return
    }

    $inputItem = Get-Item -LiteralPath $InputFile
    $subtitleItem = Get-Item -LiteralPath $SubtitleFile

    if ([string]::IsNullOrWhiteSpace($OutputFile)) {
        $OutputFile = Join-Path $inputItem.DirectoryName "$($inputItem.BaseName)_sub_${Mode}.mp4"
    }

    if ([System.IO.Path]::GetFullPath($inputItem.FullName) -eq [System.IO.Path]::GetFullPath($OutputFile)) {
        Write-Error '输出文件不能与输入视频相同'
        return
    }

    Write-Host "视频: $($inputItem.FullName)"
    Write-Host "字幕: $($subtitleItem.FullName)"
    Write-Host "模式: $Mode"
    Write-Host "输出: $OutputFile"

    if ($Mode -eq 'burn') {
        # FFmpeg filtergraph 使用正斜杠路径，并要求转义盘符冒号和单引号。
        $filterSubtitle = $subtitleItem.FullName.Replace('\', '/').Replace(':', '\:').Replace("'", "\'")
        $argsList = @(
            '-y', '-i', $inputItem.FullName,
            '-vf', "subtitles=filename='$filterSubtitle'",
            '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
            '-c:a', 'copy',
            $OutputFile
        )
    } else {
        $argsList = @(
            '-y', '-i', $inputItem.FullName, '-i', $subtitleItem.FullName,
            '-map', '0:v', '-map', '0:a?', '-map', '1:0',
            '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
            '-metadata:s:s:0', 'language=chi',
            $OutputFile
        )
    }

    & ffmpeg @argsList
    if ($LASTEXITCODE -ne 0) {
        Write-Error "ffmpeg 执行失败，退出码: $LASTEXITCODE"
        return
    }

    if (-not (Test-Path -LiteralPath $OutputFile -PathType Leaf)) {
        Write-Error "输出文件未生成: $OutputFile"
        return
    }

    Write-Host "完成: $OutputFile"
}

# 横屏转竖屏：保持画面方向，缩放并裁剪，将 宽×高 转为 高×宽。
# 用法: vert video.mp4 [-Offset 0.5] [-OutputFile output.mp4]
function vert {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$InputFile,

        [Parameter(Position=1)]
        [double]$Offset = 0.5,

        [Parameter(Position=2)]
        [string]$OutputFile
    )

    if (-not (Test-Path -LiteralPath $InputFile -PathType Leaf)) {
        Write-Error "视频文件不存在: $InputFile"
        return
    }

    if ($Offset -lt 0 -or $Offset -gt 1) {
        Write-Error '水平偏移必须是 0 到 1 之间的数字'
        return
    }

    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -or
        -not (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
        Write-Error 'ffmpeg/ffprobe 未安装或不在 PATH 中'
        return
    }

    $inputItem = Get-Item -LiteralPath $InputFile
    $size = & ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 $inputItem.FullName
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$size)) {
        Write-Error "无法读取视频分辨率: $InputFile"
        return
    }
    $size = ([string]$size).Trim()
    if ($size -notmatch '^(\d+)x(\d+)$') {
        Write-Error "无法读取视频分辨率: $InputFile"
        return
    }

    $width = [int]$Matches[1]
    $height = [int]$Matches[2]
    if ($width -le $height) {
        Write-Error "输入视频不是横屏: ${width}x${height}"
        return
    }

    $targetWidth = $height - ($height % 2)
    $targetHeight = $width - ($width % 2)

    if ([string]::IsNullOrWhiteSpace($OutputFile)) {
        $OutputFile = Join-Path $inputItem.DirectoryName "$($inputItem.BaseName)_vert.mp4"
    }

    if ([System.IO.Path]::GetFullPath($inputItem.FullName) -eq [System.IO.Path]::GetFullPath($OutputFile)) {
        Write-Error '输出文件不能与输入视频相同'
        return
    }

    $offsetText = $Offset.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    $filter = 'scale={0}:{1}:force_original_aspect_ratio=increase:force_divisible_by=2,crop={0}:{1}:(in_w-{0})*{2}:(in_h-{1})/2,setsar=1' -f $targetWidth, $targetHeight, $offsetText

    Write-Host "视频: $($inputItem.FullName) (${width}x${height})"
    Write-Host "输出: $OutputFile (${targetWidth}x${targetHeight})"
    Write-Host "水平偏移: $offsetText"

    $argsList = @(
        '-y', '-i', $inputItem.FullName,
        '-vf', $filter,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
        '-c:a', 'aac',
        $OutputFile
    )
    & ffmpeg @argsList

    if ($LASTEXITCODE -ne 0) {
        Write-Error "ffmpeg 执行失败，退出码: $LASTEXITCODE"
        return
    }

    if (-not (Test-Path -LiteralPath $OutputFile -PathType Leaf)) {
        Write-Error "输出文件未生成: $OutputFile"
        return
    }

    Write-Host "完成: $OutputFile"
}
