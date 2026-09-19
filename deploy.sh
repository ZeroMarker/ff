#!/usr/bin/env bash
# deploy.sh — 将仓库内的 shell 工具接入 ~/.bashrc
#
# 不复制脚本；~/.bashrc 直接加载仓库内的真实文件。
#
# 用法: bash deploy.sh
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BASHRC="$HOME/.bashrc"
SCRIPTS=(
    "$REPO_ROOT/scripts/ffmpeg/linux/cut.sh"
    "$REPO_ROOT/scripts/ffmpeg/linux/h2v.sh"
    "$REPO_ROOT/scripts/ffmpeg/linux/subtitle.sh"
    "$REPO_ROOT/scripts/ffmpeg/linux/vert.sh"
    "$REPO_ROOT/scripts/fzf/fzf.sh"
)

for script in "${SCRIPTS[@]}"; do
    echo "==> 校验脚本语法: $script"
    bash -n "$script"
done

missing=()
for script in "${SCRIPTS[@]}"; do
    if [ ! -f "$BASHRC" ] || ! grep -qF -- "$script" "$BASHRC"; then
        missing+=("$script")
    fi
done

if [ "${#missing[@]}" -eq 0 ]; then
    echo "==> $BASHRC 已加载全部脚本，跳过"
else
    echo "==> 将缺失的真实脚本路径追加到 $BASHRC"
    {
        echo
        echo "# ff shell tools (canonical project files)"
        for script in "${missing[@]}"; do
            printf '[[ -r %q ]] && source %q\n' "$script" "$script"
        done
    } >> "$BASHRC"
fi

echo ""
echo "✅ 完成。新开 shell 后可使用: rip、h2v、sub、vert、ncf、ncr"
echo "   当前 shell 立即生效: source \"$BASHRC\""
