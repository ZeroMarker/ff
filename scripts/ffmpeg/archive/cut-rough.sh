rip() {
# 视频裁剪工具（快速粗剪）
# 用法: ./cut.sh <输入文件> <开始时间> <结束时间>
# 示例: ./cut.sh video.mp4 00:01:30 00:03:45

if [ $# -lt 3 ]; then
    echo "用法: $0 <输入文件> <开始时间> <结束时间>" >&2
    return 1
fi

INPUT_FILE="$1"
START_TIME="$2"
END_TIME="$3"

if [ ! -f "$INPUT_FILE" ]; then
    echo "错误: 文件不存在: $INPUT_FILE" >&2
    return 1
fi

if ! command -v ffmpeg &> /dev/null; then
    echo "错误: ffmpeg 未安装或不在 PATH 中" >&2
    return 1
fi

DIR=$(dirname "$INPUT_FILE")
NAME=$(basename "$INPUT_FILE" | sed 's/\.[^.]*$//')
EXT="${INPUT_FILE##*.}"
START_CLEAN=$(echo "$START_TIME" | tr -d ':')
END_CLEAN=$(echo "$END_TIME" | tr -d ':')

if [ "$DIR" = "." ]; then
    OUTPUT="${NAME}_cut_${START_CLEAN}-${END_CLEAN}.${EXT}"
else
    OUTPUT="${DIR}/${NAME}_cut_${START_CLEAN}-${END_CLEAN}.${EXT}"
fi

echo "裁剪: $INPUT_FILE"
echo "时间: $START_TIME -> $END_TIME"
echo "输出: $OUTPUT"

ffmpeg -y -ss "$START_TIME" -i "$INPUT_FILE" -to "$END_TIME" -c copy -copyts "$OUTPUT"

if [ $? -ne 0 ]; then
    echo "错误: ffmpeg 执行失败" >&2
    return 1
fi

if [ ! -f "$OUTPUT" ]; then
    echo "错误: 输出文件未生成: $OUTPUT" >&2
    return 1
fi

echo "完成: $OUTPUT"

}

