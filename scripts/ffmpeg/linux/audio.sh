#!/bin/bash
# source 后使用 audio，或直接 bash audio.sh <视频> [输出音频] [选项]。

audio() {
    if [[ ${1:-} == --help || ${1:-} == -h || $# == 0 ]]; then
        echo '用法: audio <视频> [输出音频] [--format mp3|m4a|aac|ogg|flac|wav] [--start 秒] [--end 秒]'
        echo '默认输出到原视频同目录的 <原名>_audio.mp3；不覆盖已有文件。'
        [[ $# -gt 0 ]]
        return $?
    fi

    local input="$1" output='' format='' start=0 end='' option
    shift
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --format|--start|--end)
                option="$1"
                if [[ $# -lt 2 || -z $2 ]]; then
                    echo "错误: $option 缺少参数" >&2
                    return 1
                fi
                case "$option" in
                    --format) format="$2" ;;
                    --start) start="$2" ;;
                    --end) end="$2" ;;
                esac
                shift 2
                ;;
            --*) echo "错误: 未知选项: $1" >&2; return 1 ;;
            *)
                if [[ -n $output ]]; then
                    echo '错误: 只能指定一个输出文件' >&2
                    return 1
                fi
                output="$1"
                shift
                ;;
        esac
    done

    if [[ ! -f $input ]]; then
        echo "错误: 视频文件不存在: $input" >&2
        return 1
    fi
    # Absolute paths prevent leading '-' or ':' in filenames being parsed as options/URLs.
    local input_dir output_dir
    input_dir=$(cd -- "$(dirname -- "$input")" && pwd) || return 1
    input="$input_dir/$(basename -- "$input")"
    if [[ -z $format ]]; then
        if [[ -n $output ]]; then format="${output##*.}"; else format=mp3; fi
    fi
    format="${format,,}"
    local codec bitrate=192k
    case "$format" in
        mp3) codec=libmp3lame ;;
        m4a|aac) codec=aac ;;
        ogg) codec=libvorbis ;;
        flac) codec=flac; bitrate='' ;;
        wav) codec=pcm_s16le; bitrate='' ;;
        *) echo "错误: 不支持的音频格式: $format" >&2; return 1 ;;
    esac
    if [[ ! $start =~ ^[0-9]+([.][0-9]+)?$ || ( -n $end && ! $end =~ ^[0-9]+([.][0-9]+)?$ ) ]]; then
        echo '错误: 时间必须为非负秒数（可带小数）' >&2
        return 1
    fi
    local duration=''
    if [[ -n $end ]]; then
        duration=$(LC_ALL=C awk -v a="$start" -v b="$end" 'BEGIN { if (b <= a) exit 1; printf "%.9f", b-a }') || {
            echo '错误: --end 必须大于 --start' >&2
            return 1
        }
    fi
    if [[ -z $output ]]; then
        local stem="${input%.*}"
        [[ ${input##*/} == *.* ]] || stem="$input"
        output="${stem}_audio.${format}"
    fi
    output_dir=$(cd -- "$(dirname -- "$output")" && pwd) || return 1
    output="$output_dir/$(basename -- "$output")"
    if [[ $input == "$output" || $input -ef $output ]]; then
        echo '错误: 输出文件不能与输入视频相同' >&2
        return 1
    fi
    local extension="${output##*.}"
    if [[ ${extension,,} != "$format" ]]; then
        echo "错误: 输出文件扩展名必须为 .$format" >&2
        return 1
    fi
    if [[ -e $output || -L $output ]]; then
        echo "错误: 输出文件已存在: $output" >&2
        return 1
    fi
    local executable="${FFMPEG_PATH:-ffmpeg}"
    if ! command -v "$executable" >/dev/null 2>&1; then
        echo '错误: ffmpeg 未安装或不在 PATH 中' >&2
        return 1
    fi
    local -a args=(-hide_banner -nostdin -n -ss "$start" -i "$input")
    [[ -n $duration ]] && args+=(-t "$duration")
    args+=(-map 0:a:0 -vn -c:a "$codec")
    [[ -n $bitrate ]] && args+=(-b:a "$bitrate")
    [[ $format == wav ]] && args+=(-ar 48000)
    "$executable" "${args[@]}" "$output" || return $?
    echo "完成: $output"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    audio "$@"
    exit $?
fi
