#!/bin/bash
# 视频裁剪工具（精准剪辑，函数封装）
#
# 命名: 统一为 rip（避免与 Linux 系统自带 /usr/bin/cut 命令冲突；
#       与 Windows 版 rip 函数跨平台一致）
#
# 两种用法：
#   1) source 方式（推荐，可反复调用）:
#        . scripts/ffmpeg/linux/cut.sh
#        rip video.mp4 00:01:30 00:03:45            # 可选第4参数=目标视频码率
#        rip video.mp4 00:01:30 00:03:45 2M         # 固定为 2Mbps 输出
#   2) 直接执行:
#        bash scripts/ffmpeg/linux/cut.sh video.mp4 00:01:30 00:03:45 2M
#
# 说明: 旧粗剪版（-c copy 流复制）已封存至 scripts/ffmpeg/archive/cut-rough.sh
#       Windows 对应实现: scripts/ffmpeg/win/cut-function.ps1

function rip {
    local INPUT_FILE="$1"
    local START_TIME="$2"
    local END_TIME="$3"
    local BITRATE="${4:-}"   # 可选: 目标视频码率，如 2M / 2000k

    if [ $# -lt 3 ]; then
        echo "用法: rip <输入文件> <开始时间> <结束时间> [码率]" >&2
        echo "      码率=目标视频码率(如 2M / 2000k)，省略时用 CRF 恒定画质" >&2
        return 1
    fi

    if [ ! -f "$INPUT_FILE" ]; then
        echo "错误: 文件不存在: $INPUT_FILE" >&2
        return 1
    fi

    if ! command -v ffmpeg &> /dev/null; then
        echo "错误: ffmpeg 未安装或不在 PATH 中" >&2
        return 1
    fi

    local DIR NAME EXT START_CLEAN END_CLEAN OUTPUT CODEC VENC CRF rc RATE_LABEL
    DIR=$(dirname "$INPUT_FILE")
    NAME=$(basename "$INPUT_FILE" | sed 's/\.[^.]*$//')
    EXT="${INPUT_FILE##*.}"
    START_CLEAN=$(echo "$START_TIME" | tr -d ':')
    END_CLEAN=$(echo "$END_TIME" | tr -d ':')

    # 文件名附带目标码率(若有)，避免同一区段不同码率互相覆盖
    RATE_LABEL=""
    if [ -n "$BITRATE" ]; then RATE_LABEL="_${BITRATE}"; fi

    if [ "$DIR" = "." ]; then
        OUTPUT="${NAME}_cut_${START_CLEAN}-${END_CLEAN}${RATE_LABEL}.${EXT}"
    else
        OUTPUT="${DIR}/${NAME}_cut_${START_CLEAN}-${END_CLEAN}${RATE_LABEL}.${EXT}"
    fi

    # 检测原始视频编码，选择合适的编码器（与 win/cut-function.ps1 保持一致）
    CODEC=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE" 2>/dev/null)
    case "$(echo "$CODEC" | tr 'A-Z' 'a-z')" in
        h264)       VENC="libx264" ;;
        hevc|h265)  VENC="libx265" ;;
        *)          VENC="libx264" ;;
    esac
    if [ "$VENC" = "libx264" ]; then CRF=23; else CRF=28; fi

    # 指定目标码率(ABR)优先，否则退回 CRF 恒定画质
    local -a RATE=()
    if [ -n "$BITRATE" ]; then
        RATE=(-b:v "$BITRATE")
        echo "编码: $VENC (bitrate=$BITRATE)"
    else
        RATE=(-crf "$CRF")
        echo "编码: $VENC (crf=$CRF)"
    fi

    echo "裁剪: $INPUT_FILE"
    echo "时间: $START_TIME -> $END_TIME"
    echo "输出: $OUTPUT"

    # 注意: -ss 与 -to 都是输入选项，必须放在 -i 之前，按原始时间戳计算终点。
    #       若把 -to 放在 -i 之后（输出选项），`-ss` 输入定位会平移输出时间戳，
    #       终点按平移后的位置计算，实际产出 [start, start+end]（终点翻倍）。
    ffmpeg -y -ss "$START_TIME" -to "$END_TIME" -i "$INPUT_FILE" \
           -c:v "$VENC" "${RATE[@]}" -preset fast -c:a aac "$OUTPUT"
    rc=$?
    if [ $rc -ne 0 ]; then
        echo "错误: ffmpeg 执行失败" >&2
        return 1
    fi

    if [ ! -f "$OUTPUT" ]; then
        echo "错误: 输出文件未生成: $OUTPUT" >&2
        return 1
    fi

    echo "完成: $OUTPUT"
}

# 直接执行模式（bash cut.sh ...）: 调用函数并透传退出码
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    rip "$@"
    exit $?
fi
