#!/bin/bash
# 横屏转竖屏：旋转画面，将 宽×高 转为 高×宽，不缩放、不裁剪。
#
# 用法：
#   source scripts/ffmpeg/linux/vert.sh
#   vert video.mp4 [right|left] [输出.mp4]
#
# 方向：right=顺时针（默认），left=逆时针。

function vert {
    if [ $# -lt 1 ] || [ $# -gt 3 ]; then
        echo "用法: vert <输入视频> [right|left] [输出.mp4]" >&2
        return 1
    fi

    local INPUT_FILE="$1"
    local DIRECTION="${2:-right}"
    local OUTPUT_FILE="${3:-}"

    if [ ! -f "$INPUT_FILE" ]; then
        echo "错误: 视频文件不存在: $INPUT_FILE" >&2
        return 1
    fi

    if ! command -v ffmpeg &> /dev/null; then
        echo "错误: ffmpeg 未安装或不在 PATH 中" >&2
        return 1
    fi

    local TRANSPOSE DIR NAME
    case "$DIRECTION" in
        right) TRANSPOSE="clock" ;;
        left) TRANSPOSE="cclock" ;;
        *)
            echo "错误: 方向必须是 right 或 left: $DIRECTION" >&2
            return 1
            ;;
    esac

    if [ -z "$OUTPUT_FILE" ]; then
        DIR=$(dirname "$INPUT_FILE")
        NAME=$(basename "$INPUT_FILE")
        NAME="${NAME%.*}"
        if [ "$DIR" = "." ]; then
            OUTPUT_FILE="${NAME}_vert_${DIRECTION}.mp4"
        else
            OUTPUT_FILE="${DIR}/${NAME}_vert_${DIRECTION}.mp4"
        fi
    fi

    if [ "$INPUT_FILE" = "$OUTPUT_FILE" ]; then
        echo "错误: 输出文件不能与输入视频相同" >&2
        return 1
    fi

    echo "视频: $INPUT_FILE"
    echo "方向: $DIRECTION"
    echo "输出: $OUTPUT_FILE"

    ffmpeg -y -i "$INPUT_FILE" \
        -vf "transpose=${TRANSPOSE}" \
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
