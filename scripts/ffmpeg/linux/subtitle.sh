#!/bin/bash
# MP4 + SRT 字幕合并工具（函数封装）
#
# 两种用法：
#   1) source 方式（可反复调用）:
#        . scripts/ffmpeg/linux/subtitle.sh
#        subtitle video.mp4 subtitle.srt
#        subtitle video.mp4 subtitle.srt output.mp4 embed
#   2) 直接执行:
#        bash scripts/ffmpeg/linux/subtitle.sh video.mp4 subtitle.srt [output.mp4] [burn|embed]
#
# 模式：
#   burn  默认，将字幕烧录到画面中；播放器无法关闭字幕
#   embed 将字幕封装为 MP4 字幕轨；播放器可以开关字幕

function subtitle {
    if [ $# -lt 2 ] || [ $# -gt 4 ]; then
        echo "用法: subtitle <视频.mp4> <字幕.srt> [输出.mp4] [burn|embed]" >&2
        return 1
    fi

    local INPUT_FILE="$1"
    local SUBTITLE_FILE="$2"
    local OUTPUT_FILE="${3:-}"
    local MODE="${4:-burn}"
    local DIR NAME

    if [ ! -f "$INPUT_FILE" ]; then
        echo "错误: 视频文件不存在: $INPUT_FILE" >&2
        return 1
    fi

    if [ ! -f "$SUBTITLE_FILE" ]; then
        echo "错误: 字幕文件不存在: $SUBTITLE_FILE" >&2
        return 1
    fi

    if ! command -v ffmpeg &> /dev/null; then
        echo "错误: ffmpeg 未安装或不在 PATH 中" >&2
        return 1
    fi

    case "$MODE" in
        burn|embed) ;;
        *)
            echo "错误: 模式必须是 burn 或 embed: $MODE" >&2
            return 1
            ;;
    esac

    if [ -z "$OUTPUT_FILE" ]; then
        DIR=$(dirname "$INPUT_FILE")
        NAME=$(basename "$INPUT_FILE")
        NAME="${NAME%.*}"
        if [ "$DIR" = "." ]; then
            OUTPUT_FILE="${NAME}_subtitled.mp4"
        else
            OUTPUT_FILE="${DIR}/${NAME}_subtitled.mp4"
        fi
    fi

    if [ "$INPUT_FILE" = "$OUTPUT_FILE" ]; then
        echo "错误: 输出文件不能与输入视频相同" >&2
        return 1
    fi

    echo "视频: $INPUT_FILE"
    echo "字幕: $SUBTITLE_FILE"
    echo "模式: $MODE"
    echo "输出: $OUTPUT_FILE"

    local rc
    if [ "$MODE" = "burn" ]; then
        # subtitles 滤镜会解析 ':'、反斜杠和单引号，因此文件名需再次转义。
        local FILTER_SUBTITLE="$SUBTITLE_FILE"
        FILTER_SUBTITLE="${FILTER_SUBTITLE//\\/\\\\}"
        FILTER_SUBTITLE="${FILTER_SUBTITLE//:/\\:}"
        FILTER_SUBTITLE="${FILTER_SUBTITLE//\'/\\\'}"

        ffmpeg -y -i "$INPUT_FILE" \
               -vf "subtitles=filename='$FILTER_SUBTITLE'" \
               -c:v libx264 -crf 18 -preset medium -c:a copy \
               "$OUTPUT_FILE"
        rc=$?
    else
        ffmpeg -y -i "$INPUT_FILE" -i "$SUBTITLE_FILE" \
               -map 0:v -map '0:a?' -map 1:0 \
               -c:v copy -c:a copy -c:s mov_text \
               -metadata:s:s:0 language=chi \
               "$OUTPUT_FILE"
        rc=$?
    fi

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

# 直接执行模式（bash subtitle.sh ...）: 调用函数并透传退出码
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    subtitle "$@"
    exit $?
fi
