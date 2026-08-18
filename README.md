# FF Web Editor 🎬

网页视频剪辑工具。浏览器里完成 **裁剪、多段拼接、滤镜、倍速、转码、音频提取、封面生成**，
底层全部由 **ffmpeg 封装**（`lib/ffmpeg.js`，参数数组化、无 shell 注入、进度/取消可控）执行，
处理的是 **本地视频**（`videos/` 目录，支持网页上传）。以 **systemd 服务** 常驻，
由 **Caddy** 对外反代（与现有 `/douyin`、`/tiktok` 同一套 `handle_path` 接入模式）。

## 架构

```
浏览器 ── HTTP/HTTPS ──> Caddy (80/443, basicauth) ──> Node.js :8345
                                          │
                       ┌──────────────────┼──────────────────┐
                       ▼                  ▼                  ▼
                  videos/ 本地视频库   lib/ffmpeg.js       output/ 成品
                                          │  封装
                                      ffmpeg / ffprobe
```

## 功能

| 模式 | 说明 | 底层实现 |
|------|------|----------|
| 区间 | 按时间轴选区导出 | `-ss … -t …` 精准快搜 |
| 片段拼接 | 一个视频内多段裁剪后合并 | `trim/atrim + concat` filter_complex |
| 整片 | 全片转码/换格式 | libx264 / vp9 / gif 调色板 |
| 音频 | 提取 MP3/M4A/AAC/OGG/FLAC/WAV | `-vn` + 对应编码器 |
| 封面 | 生成 PNG 缩略图 | `-frames:v 1` |
| 滤镜 | 灰度/反色/镜像/模糊/暗角/锐化 | `-vf` |
| 倍速 | 0.25x ~ 4x | `setpts` + `atempo` 级联 |
| 分辨率 | 360p ~ 4K | `scale=-2:H` |

另含：任务队列（并发上限、进度条、取消、状态持久化 `jobs/state.json`）、
输出文件下载/删除、上传进度、ffprobe 元数据、缩略图缓存。

## 快速开始（开发）

```bash
npm install
mkdir -p videos output jobs          # 把本地视频丢进 videos/ 即可出现在网页里
npm start                            # http://127.0.0.1:8345
```

## 部署（systemd + Caddy）

```bash
bash deploy/install.sh               # npm install + 安装并启动服务
```

然后编辑 `/etc/caddy/Caddyfile`，在现有站点块里追加：

```
redir /edit /edit/ 308
handle_path /edit/* {
    reverse_proxy 127.0.0.1:8345
}
```

```bash
sudo systemctl reload caddy
# 访问 https://20070809.xyz/edit/
```

服务管理：

```bash
systemctl status ff-web-editor        # 状态
journalctl -u ff-web-editor -f        # 日志
sudo systemctl restart ff-web-editor  # 重启
```

## 配置（.env）

| 变量 | 默认 | 说明 |
|------|------|------|
| `HOST` | `127.0.0.1` | 仅本机（Caddy 反代） |
| `PORT` | `8345` | 内部端口 |
| `VIDEOS_DIR` / `OUTPUT_DIR` | 项目内目录 | 视频库 / 输出目录 |
| `MAX_CONCURRENCY` | `2` | ffmpeg 并行任务数 |
| `MAX_UPLOAD_MB` | `8192` | 上传大小上限 |
| `AUTH_TOKEN` | 空 | 设置后 API 需 `x-auth-token` 头 |

## API 一览

```
GET  /api/health                服务状态与 ffmpeg 版本
GET  /api/videos                视频库列表
POST /api/upload                上传(multipart, field=file)
GET  /api/videos/:name          流式播放(支持 Range)
GET  /api/videos/:name/info     元数据
GET  /api/videos/:name/thumbnail 缩略图(自动缓存)
POST /api/jobs                  创建任务 {type: clip|segments|full|audio|thumb|frame}
GET  /api/jobs | /api/jobs/:id  任务列表/状态
POST /api/jobs/:id/cancel       取消任务
GET  /api/outputs               输出文件列表
GET  /api/output/:file          下载
```

## 安全提示

- 依赖 Caddy 的 basicauth 或 `AUTH_TOKEN` 保护，勿将 8345 直接暴露公网。
- 本工具面向受信局域网/单人使用，未实现多用户隔离。

## License

MIT