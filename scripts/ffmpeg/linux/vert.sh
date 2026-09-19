#!/bin/bash
# 横屏转竖屏：保持画面方向，缩放并裁剪，将 宽×高 转为 高×宽。
#
# 用法：
#   source scripts/ffmpeg/linux/vert.sh
#   vert video.mp4 [水平偏移] [输出.mp4]
#
# 水平偏移：0=取最左侧，0.5=居中（默认），1=取最右侧。

function vert {
    if [ $# -lt 1 ] || [ $# -gt 3 ]; then
        echo "用法: vert <输入视频> [水平偏移0~1] [输出.mp4]" >&2
        return 1
    fi

    local INPUT_FILE="$1"
    local OFFSET="${2:-0.5}"
    local OUTPUT_FILE="${3:-}"

    if [ ! -f "$INPUT_FILE" ]; then
        echo "错误: 视频文件不存在: $INPUT_FILE" >&2
        return 1
    fi

    if ! command -v ffmpeg &> /dev/null || ! command -v ffprobe &> /dev/null; then
        echo "错误: ffmpeg/ffprobe 未安装或不在 PATH 中" >&2
        return 1
    fi

    if [[ ! "$OFFSET" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] || \
       ! awk -v value="$OFFSET" 'BEGIN { exit !(value >= 0 && value <= 1) }'; then
        echo "错误: 水平偏移必须是 0 到 1 之间的数字" >&2
        return 1
    fi

    local SIZE WIDTH HEIGHT TARGET_WIDTH TARGET_HEIGHT DIR NAME
    SIZE=$(ffprobe -v error -select_streams v:0 \
        -show_entries stream=width,height -of csv=s=x:p=0 "$INPUT_FILE")
    if [[ ! "$SIZE" =~ ^([0-9]+)x([0-9]+)$ ]]; then
        echo "错误: 无法读取视频分辨率: $INPUT_FILE" >&2
        return 1
    fi

    WIDTH="${BASH_REMATCH[1]}"
    HEIGHT="${BASH_REMATCH[2]}"
    if [ "$WIDTH" -le "$HEIGHT" ]; then
        echo "错误: 输入视频不是横屏: ${WIDTH}x${HEIGHT}" >&2
        return 1
    fi

    # libx264 要求常见 4:2:0 输出为偶数尺寸；奇数输入向下取最近偶数。
    TARGET_WIDTH=$((HEIGHT - HEIGHT % 2))
    TARGET_HEIGHT=$((WIDTH - WIDTH % 2))

    if [ -z "$OUTPUT_FILE" ]; then
        DIR=$(dirname "$INPUT_FILE")
        NAME=$(basename "$INPUT_FILE")
        NAME="${NAME%.*}"
        if [ "$DIR" = "." ]; then
            OUTPUT_FILE="${NAME}_vert.mp4"
        else
            OUTPUT_FILE="${DIR}/${NAME}_vert.mp4"
        fi
    fi

    if [ "$INPUT_FILE" = "$OUTPUT_FILE" ]; then
        echo "错误: 输出文件不能与输入视频相同" >&2
        return 1
    fi

    echo "视频: $INPUT_FILE (${WIDTH}x${HEIGHT})"
    echo "输出: $OUTPUT_FILE (${TARGET_WIDTH}x${TARGET_HEIGHT})"
    echo "水平偏移: $OFFSET"

    ffmpeg -y -i "$INPUT_FILE" \
        -vf "scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${TARGET_WIDTH}:${TARGET_HEIGHT}:(in_w-${TARGET_WIDTH})*${OFFSET}:(in_h-${TARGET_HEIGHT})/2,setsar=1" \
        -c:v libx264 -crf 18 -preset medium -c:a aac \
        "$OUTPUT_FILE"
    local rc=$?

    if [ $rc -ne 0 ]; then
        echo "错误: ffmpeg 执行失败" >&2
        return "$rc"
    fi

    if [ ! -f "$OUTPUT_FILE" ]; then
        echo "错误: 输出文件未生成: $OUTPUT_FILE" >&2
        return 1
    fi

    echo "完成: $OUTPUT_FILE"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    vert "$@"
    exit $?
fi
