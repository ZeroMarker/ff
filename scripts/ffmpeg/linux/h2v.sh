#!/bin/bash
# 横屏转竖屏，支持偏移量参数
# 用法: ./h2v.sh [偏移量]  偏移量: 0.0(最左) ~ 1.0(最右)，默认0.5(居中)

OFFSET="${1:-0.5}"

if (( $(echo "$OFFSET < 0 || $OFFSET > 1" | bc -l) )); then
    echo "错误: 偏移量必须在 0.0 到 1.0 之间" >&2
    exit 1
fi

mkdir -p vertical

for f in *.mp4; do
    [ -f "$f" ] || continue
    echo "处理: $f (偏移: $OFFSET)"
    ffmpeg -i "$f" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)*${OFFSET}:(in_h-1920)/2" -c:a copy "vertical/${f%.mp4}_竖屏.mp4"
done
