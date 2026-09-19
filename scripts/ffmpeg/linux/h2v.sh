#!/bin/bash
# 横屏转竖屏，支持偏移量参数。
#
# source 后调用: h2v [偏移量]
# 直接执行:     ./h2v.sh [偏移量]
# 偏移量: 0.0（最左）~ 1.0（最右），默认 0.5（居中）。

h2v() {
    if [ "$#" -gt 1 ]; then
        echo "用法: h2v [偏移量]" >&2
        return 1
    fi

    local offset="${1:-0.5}"
    local f name
    local rc=0

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

    mkdir -p vertical || return 1

    for f in ./*.mp4; do
        [ -f "$f" ] || continue
        name="${f#./}"
        echo "处理: $name (偏移: $offset)"
        ffmpeg -i "$f" \
            -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)*${offset}:(in_h-1920)/2" \
            -c:a copy "vertical/${name%.mp4}_h2v.mp4"
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
