# 横屏转竖屏，支持偏移量参数
# 用法: .\h2v.ps1 [-Offset 0.5] file1.mp4 [file2.mp4 ...]
# 偏移量: 0.0(最左) ~ 1.0(最右)，默认0.5(居中)

param(
    [Parameter(Position=0, ValueFromRemainingArguments=$true, Mandatory=$true)]
    [string[]]$Files,
    [double]$Offset = 0.5
)

if ($Offset -lt 0 -or $Offset -gt 1) {
    Write-Error "偏移量必须在 0.0 到 1.0 之间"
    exit 1
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
