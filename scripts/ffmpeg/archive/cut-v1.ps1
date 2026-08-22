# 📦 已封存：粗剪函数 rip-v1（历史名：cut / cut-v1，原 profile 中的 cut 函数）
#
# 历史：这是最早的 cut 实现（-c copy 流复制）。2024-08 从 profile 中封存至此，
#       profile 中的 rip 已替换为精准剪辑（重新编码，帧级精确，见 ../win/cut-function.ps1）。
#
# 行为：ffmpeg -i 文件 -ss 起点 -to 终点 -c copy —— 流复制，秒出，
#       但受关键帧间隔（GOP）限制：开头最多多出/偏移一个 GOP，非帧级精确。
#
# 适用：快速粗剪大文件、关键帧密集的源文件（如 JAV，GOP < 1s）。
#       日常精确裁剪请用 win 下的 rip（重编码）。
#
# 用法：需要时手动加载后调用（命名与精确版 rip 统一，历史名 cut-v1）：
#   . .\scripts\ffmpeg\archive\cut-v1.ps1
#   rip-v1 .\video.mp4 00:01:30 00:03:45
#
# 简单验证：ffprobe -v error -select_streams v:0 -show_entries stream=codec_name video.mp4

function rip-v1 {
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$InputFile,

        [Parameter(Mandatory=$true, Position=1)]
        [string]$StartTime,

        [Parameter(Mandatory=$true, Position=2)]
        [string]$EndTime
    )

    $outputName = "$([System.IO.Path]::GetFileNameWithoutExtension($InputFile))_cut_$($StartTime.Replace(':', ''))-$($EndTime.Replace(':', ''))$([System.IO.Path]::GetExtension($InputFile))"

    ffmpeg -i $InputFile -ss $StartTime -to $EndTime -c copy $outputName
}