#!/bin/bash
# 横屏转竖屏，支持偏移量参数。
#
# source 后调用:
#   h2v                      # 处理当前目录全部 *.mp4，偏移 0.5，输出 vertical/
#   h2v 0.4                  # 同上，偏移 0.4
#   h2v 0.4 video.mp4 [...]  # 只处理指定文件，偏移 0.4，输出到各源文件同目录
#   h2v video.mp4            # 偏移默认 0.5
# 直接执行: ./h2v.sh [偏移量] [文件…]
#
# 偏移量: 0.0（最左）~ 1.0（最右），默认 0.5（居中）。
#
# 输出位置: 未指定文件（目录模式）→ vertical/<名>_h2v.mp4；
#           指定文件 → 与源文件同目录的 <名>_h2v.mp4（与 rip/vert/sub 一致）。

h2v() {
    local offset=0.5
    local -a files=() inputs=() found=()
    local f name base dir out
    local rc=0

    # 首个参数是纯数值时按偏移量解析，其余参数视为待处理文件；否则全部视为文件
    if [ "$#" -gt 0 ] && [[ "$1" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]]; then
        offset="$1"
        shift
    fi
    files=("$@")

    if ! awk -v value="$offset" 'BEGIN {
        valid = value ~ /^([0-9]+([.][0-9]*)?|[.][0-9]+)$/
        exit !(valid && value >= 0 && value <= 1)
    }'; then
        echo "错误: 偏移量必须在 0.0 到 1.0 之间" >&2
        return 1
    fi

    if ! command -v ffmpeg >/dev/null 2>&1; then
        echo "错误: ffmpeg 未安装或不在 PATH 中" >&2
        return 1
    fi

    if [ "${#files[@]}" -gt 0 ]; then
        inputs=("${files[@]}")
    else
        # 目录模式: 扫描当前目录，输出集中到 vertical/
        for f in ./*.mp4; do
            [ -f "$f" ] || continue
            found+=("${f#./}")
        done
        if [ "${#found[@]}" -gt 0 ]; then
            inputs=("${found[@]}")
        fi
        mkdir -p vertical || return 1
    fi

    if [ "${#inputs[@]}" -eq 0 ]; then
        echo "错误: 没有待处理的 mp4 文件" >&2
        return 1
    fi

    for f in "${inputs[@]}"; do
        if [ ! -f "$f" ]; then
            echo "错误: 文件不存在: $f" >&2
            rc=1
            continue
        fi

        name=$(basename "$f")
        base="${name%.*}"
        dir=$(dirname "$f")

        if [ "${#files[@]}" -gt 0 ]; then
            if [ "$dir" = "." ]; then
                out="${base}_h2v.mp4"
            else
                out="${dir}/${base}_h2v.mp4"
            fi
        else
            out="vertical/${base}_h2v.mp4"
        fi

        echo "处理: $name (偏移: $offset)"
        echo "输出: $out"
        ffmpeg -y -i "$f" \
            -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)*${offset}:(in_h-1920)/2" \
            -c:a copy "$out"
        if [ "$?" -ne 0 ]; then
            rc=1
        fi
    done

    return "$rc"
}

# 被 source 时只定义函数；直接运行时才开始处理。
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    h2v "$@"
    exit $?
fi
