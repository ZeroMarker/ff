#!/bin/bash
# 视频 + 字幕合并工具（函数封装）
#
# 两种用法：
#   1) source 方式（可反复调用）:
#        . scripts/ffmpeg/linux/subtitle.sh
#        sub video.mp4 subtitle.srt
#        sub subtitle.srt video.mp4          # 顺序可颠倒，按类型自动识别
#        sub video.mp4 subtitle.srt embed
#        sub video.mp4 subtitle.srt output.mp4 embed
#        sub video.mp4 subtitle.srt burn 23  # crf=23（burn 的画质/体积开关）
#   2) 直接执行:
#        bash scripts/ffmpeg/linux/subtitle.sh video.mp4 subtitle.srt [burn|embed]
#        bash scripts/ffmpeg/linux/subtitle.sh video.mp4 subtitle.srt [output.mp4] [burn|embed] [crf]
#
# 前两个参数按类型识别，谁是视频谁是字幕由内容/扩展名判断，与书写顺序无关；
# 两个都是视频或两个都是字幕时报错。第 3 个起按内容识别，顺序自由：
#   burn|embed  → 模式；纯整数 → crf；其它 → 输出文件名
#   例: sub v.mp4 s.srt embed / sub v.mp4 s.srt 23 burn / sub v.mp4 s.srt out.mp4 burn 20
#
# 模式：
#   burn  默认，将字幕烧录到画面中；播放器无法关闭字幕（重编码，用 crf 控制体积）
#   embed 将字幕封装为 MP4 字幕轨；播放器可以开关字幕（视频流复制，crf 无效）
#
# crf（burn 专用，默认 18）：x264 恒定画质，取值 0~51，越小越清晰、文件越大。
#   已压过的源（低码率/高 crf 编码过、含噪声）在 crf 18 下体积可能膨胀数倍，
#   此时调大 crf（如 23~28）可接近源体积。explicit 指定 crf 时输出名追加 _crfNN，
#   避免与默认 crf 的同名产物互相覆盖。
#
# 路径含 ':' 的文件名（如 "a:b.mp4"）会先转成绝对路径：
# ffmpeg 以 URL 解析路径，相对名里的 "a:" 会被当成协议名而打开失败。

# 相对/绝对路径 → 绝对路径
_sub_abs_path() {
    local dir
    dir="$(cd -- "$(dirname -- "$1")" 2>/dev/null && pwd)" || return 1
    printf '%s/%s\n' "$dir" "$(basename -- "$1")"
}

# 判断文件是 video 还是 subtitle（扩展名优先，认不出时问 ffprobe）
# 输出 video | subtitle | unknown
_sub_kind() {
    local f="$1" ext
    [ -f "$f" ] || { printf 'unknown\n'; return 0; }

    ext="$(printf '%s' "${f##*.}" | tr '[:upper:]' '[:lower:]')"
    case "$ext" in
        srt | ass | ssa | vtt | sbv | ttml | dfxp | sub | idx)
            printf 'subtitle\n'
            return 0
            ;;
        mp4 | mkv | mov | webm | avi | m4v | flv | ts | m2ts | mpeg | mpg | wmv | 3gp | ogv)
            printf 'video\n'
            return 0
            ;;
    esac

    if command -v ffprobe >/dev/null 2>&1; then
        if [ -n "$(ffprobe -v error -select_streams v -show_entries stream=codec_type -of csv=p=0 -- "$f" 2>/dev/null)" ]; then
            printf 'video\n'
            return 0
        fi
        if [ -n "$(ffprobe -v error -select_streams s -show_entries stream=codec_type -of csv=p=0 -- "$f" 2>/dev/null)" ]; then
            printf 'subtitle\n'
            return 0
        fi
    fi

    printf 'unknown\n'
}

function sub {
    if [ $# -lt 2 ] || [ $# -gt 5 ]; then
        echo "用法: sub <视频> <字幕> [输出.mp4] [burn|embed] [crf]" >&2
        echo "      前两个参数顺序可颠倒；第 3 个起：burn|embed=模式、纯整数=crf、其它=输出文件名" >&2
        return 1
    fi

    local INPUT_FILE SUBTITLE_FILE
    local OUTPUT_FILE=""
    local MODE="burn"
    local CRF="18"
    local CRF_GIVEN=0
    local DIR NAME
    local arg

    # 第 3 个起按内容识别，顺序自由（模式 / crf / 输出名互不依赖位置）
    for arg in "${@:3}"; do
        case "$arg" in
            burn | embed)
                MODE="$arg"
                ;;
            -[0-9]*)
                echo "错误: crf 不能为负: $arg" >&2
                return 1
                ;;
            *[!0-9]* | "")
                if [ -n "$OUTPUT_FILE" ]; then
                    echo "错误: 输出文件名出现多次: $OUTPUT_FILE / $arg" >&2
                    return 1
                fi
                OUTPUT_FILE="$arg"
                ;;
            *)
                if [ "$CRF_GIVEN" -eq 1 ]; then
                    echo "错误: crf 出现多次: $CRF / $arg" >&2
                    return 1
                fi
                CRF="$arg"
                CRF_GIVEN=1
                ;;
        esac
    done

    if [ "$CRF_GIVEN" -eq 1 ] && { [ "$CRF" -lt 0 ] || [ "$CRF" -gt 51 ]; }; then
        echo "错误: crf 必须在 0 到 51 之间: $CRF" >&2
        return 1
    fi

    # 识别视频/字幕：谁在前不影响结果
    local KIND_A KIND_B
    KIND_A="$(_sub_kind "$1")"
    KIND_B="$(_sub_kind "$2")"

    if [ "$KIND_A" = "video" ] && [ "$KIND_B" = "video" ]; then
        echo "错误: 两个参数都是视频，无法区分字幕: $1 / $2" >&2
        return 1
    fi
    if [ "$KIND_A" = "subtitle" ] && [ "$KIND_B" = "subtitle" ]; then
        echo "错误: 两个参数都是字幕，无法区分视频: $1 / $2" >&2
        return 1
    fi

    if { [ "$KIND_A" = "subtitle" ] && [ "$KIND_B" != "subtitle" ]; } ||
       { [ "$KIND_B" = "video" ] && [ "$KIND_A" != "video" ]; }; then
        INPUT_FILE="$2"
        SUBTITLE_FILE="$1"
        echo "识别: $1 为字幕，$2 为视频（参数顺序已按类型调整）"
    else
        INPUT_FILE="$1"
        SUBTITLE_FILE="$2"
    fi

    if [ "$INPUT_FILE" = "$SUBTITLE_FILE" ]; then
        echo "错误: 视频与字幕不能是同一个文件: $INPUT_FILE" >&2
        return 1
    fi

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
        # 显式指定 crf 时把值写进文件名，避免不同 crf 的产物互相覆盖
        local CRF_LABEL=""
        if [ "$CRF_GIVEN" -eq 1 ] && [ "$MODE" = "burn" ]; then
            CRF_LABEL="_crf${CRF}"
        fi
        if [ "$DIR" = "." ]; then
            OUTPUT_FILE="${NAME}_sub_${MODE}${CRF_LABEL}.mp4"
        else
            OUTPUT_FILE="${DIR}/${NAME}_sub_${MODE}${CRF_LABEL}.mp4"
        fi
    fi

    if [ "$INPUT_FILE" = "$OUTPUT_FILE" ]; then
        echo "错误: 输出文件不能与输入视频相同" >&2
        return 1
    fi

    if [ "$SUBTITLE_FILE" = "$OUTPUT_FILE" ]; then
        echo "错误: 输出文件不能与输入字幕相同" >&2
        return 1
    fi

    if [ -n "$OUTPUT_FILE" ]; then
        if [ -d "$OUTPUT_FILE" ]; then
            echo "错误: 输出文件名是一个目录: $OUTPUT_FILE" >&2
            return 1
        fi
        case "$OUTPUT_FILE" in
            *.*) ;;
            *)
                echo "错误: 输出文件名缺少扩展名（如 out.mp4）: $OUTPUT_FILE" >&2
                return 1
                ;;
        esac
    fi

    echo "视频: $INPUT_FILE"
    echo "字幕: $SUBTITLE_FILE"
    echo "模式: $MODE"
    if [ "$MODE" = "burn" ]; then
        if [ "$CRF_GIVEN" -eq 1 ]; then
            echo "crf: $CRF"
        else
            echo "crf: $CRF (默认)"
        fi
    elif [ "$CRF_GIVEN" -eq 1 ]; then
        echo "提示: embed 为视频流复制，crf=$CRF 不生效（已被忽略）" >&2
    fi
    echo "输出: $OUTPUT_FILE"

    local ABS_INPUT ABS_SUB ABS_OUTPUT
    ABS_INPUT="$(_sub_abs_path "$INPUT_FILE")" || {
        echo "错误: 无法解析视频路径: $INPUT_FILE" >&2
        return 1
    }
    ABS_SUB="$(_sub_abs_path "$SUBTITLE_FILE")" || {
        echo "错误: 无法解析字幕路径: $SUBTITLE_FILE" >&2
        return 1
    }
    ABS_OUTPUT="$(_sub_abs_path "$OUTPUT_FILE")" || {
        echo "错误: 无法解析输出路径: $OUTPUT_FILE" >&2
        return 1
    }

    local rc
    if [ "$MODE" = "burn" ]; then
        # subtitles 滤镜的路径要过两层解析（滤镜图 + 滤镜选项），且滤镜图把
        # \ ' : , [ ] ; 当语法字符，故每个都写成 3 个反斜杠 + 原字符（两层各吃一个）。
        local FILTER_SUBTITLE="" ESC_CHAR i
        for ((i = 0; i < ${#ABS_SUB}; i++)); do
            ESC_CHAR="${ABS_SUB:i:1}"
            case "$ESC_CHAR" in
                '\' | "'" | ':' | ',' | '[' | ']' | ';') FILTER_SUBTITLE="${FILTER_SUBTITLE}\\\\\\$ESC_CHAR" ;;
                *) FILTER_SUBTITLE="${FILTER_SUBTITLE}${ESC_CHAR}" ;;
            esac
        done

        ffmpeg -y -i "$ABS_INPUT" \
               -vf "subtitles=filename=$FILTER_SUBTITLE" \
               -c:v libx264 -crf "$CRF" -preset medium -c:a copy \
               "$ABS_OUTPUT"
        rc=$?
    else
        ffmpeg -y -i "$ABS_INPUT" -i "$ABS_SUB" \
               -map 0:v -map '0:a?' -map 1:0 \
               -c:v copy -c:a copy -c:s mov_text \
               -metadata:s:s:0 language=chi \
               "$ABS_OUTPUT"
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
    sub "$@"
    exit $?
fi
