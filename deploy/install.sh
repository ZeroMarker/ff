#!/usr/bin/env bash
# deploy/install.sh — 安装 systemd 服务（Caddy 配置请手动并入现有站点块）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 安装 npm 依赖（含构建需要的 devDeps）"
npm install

echo "==> 构建前端 (React + Video.js + Konva + Fabric) -> public/"
npm run build

echo "==> 创建数据目录"
mkdir -p videos output jobs assets

echo "==> 安装 systemd 服务"
sudo cp deploy/ff-web-editor.service /etc/systemd/system/ff-web-editor.service
sudo systemctl daemon-reload
sudo systemctl enable --now ff-web-editor
systemctl --no-pager status ff-web-editor --lines=8 || true

echo ""
echo "✅ 完成。"
echo "   日志: journalctl -u ff-web-editor -f"
echo "   本地: http://127.0.0.1:8345"
echo "   接入 Caddy: 在 /etc/caddy/Caddyfile 中加入:"
echo "     redir /edit /edit/ 308"
echo "     handle_path /edit/* { reverse_proxy 127.0.0.1:8345 }"
echo "   然后 sudo systemctl reload caddy"