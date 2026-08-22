#!/usr/bin/env bash
# deploy.sh — 部署 ffmpeg CLI 工具（rip 精准剪辑）到本机并接入 ~/.bashrc
#
# 安装内容:
#   scripts/ffmpeg/linux/cut.sh  ->  ~/scripts/ffmpeg.sh（rip 函数）
#   ~/.bashrc 追加: source ~/scripts/ffmpeg.sh（幂等，重复执行不重复追加）
#
# 用法: bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

SRC="scripts/ffmpeg/linux/cut.sh"
DEST="$HOME/scripts/ffmpeg.sh"
BASHRC="$HOME/.bashrc"
MARKER='source ~/scripts/ffmpeg.sh'

echo "==> 校验脚本语法: $SRC"
bash -n "$SRC"

echo "==> 安装到 $DEST"
mkdir -p "$HOME/scripts"
cp "$SRC" "$DEST"
chmod +x "$DEST"

if [ -f "$BASHRC" ] && grep -qF "$MARKER" "$BASHRC"; then
    echo "==> $BASHRC 已包含 $MARKER，跳过"
else
    echo "==> 追加到 $BASHRC"
    { echo; echo "# ffmpeg CLI 工具（rip 精准剪辑）"; echo "$MARKER"; } >> "$BASHRC"
fi

echo ""
echo "✅ 完成。新开 shell 即可使用: rip <输入文件> <开始时间> <结束时间>"
echo "   当前 shell 立即生效: source ~/scripts/ffmpeg.sh"
