# FF Web Editor v2 🎬

网页视频剪辑工具：浏览器里完成 **裁剪、多段拼接、滤镜、倍速、转码、音频提取、封面生成、
文字/图片叠加（可拖动/缩放/旋转/定时间段）、画笔标注**，底层全部由 **ffmpeg 封装** 渲染，
编辑对象**仅限于本地文件库**（后端白名单强校验，拒绝路径穿越/URL/绝对路径），
以 **systemd 服务** 常驻，由 **Caddy** 对外反代（`/edit` 前缀，与现有站点同一套接入模式）。

## 前端技术栈

| 库 | 职责 |
|----|------|
| **React 18 + Vite** | 整站 UI（组件化面板、状态管理） |
| **Video.js** | 视频播放/预览/时间轴同步 |
| **Konva.js (react-konva)** | 叠加层场景图：文字/图片可拖动、缩放、旋转、选中变换(Transformer) |
| **Fabric.js** | 画笔标注：在当前帧上自由绘制/形状/文本，一键发布为叠加图片层 |
| ffmpeg (lib/ffmpeg.js) | 渲染引擎：drawtext 文字合成、overlay 图片合成、全部转码 |

## 架构

```
浏览器 ──HTTPS──> Caddy(80/443, basicauth) ──handle_path /edit/*──> systemd: node :8345
                                                                      │
                                    lib/ffmpeg.js（参数数组化/进度/取消/白名单）
                                                                      │
                    videos/ 本地视频库   assets/ 叠加图片素材   output/ 成品
```

## 功能

| 模式 | 说明 | 底层实现 |
|------|------|----------|
| 区间 | 按时间轴选区导出 | `-ss/-t` 精准快搜 |
| 片段拼接 | 单视频多段裁剪合并 | `trim/atrim + concat` filter_complex |
| 整片 | 全片转码/格式/倍速/滤镜 | libx264 / vp9 / gif 调色板 |
| 音频 | MP3/M4A/AAC/OGG/FLAC/WAV | `-vn` + 对应编码器 |
| 封面 | PNG 缩略图 | `-frames:v 1` |
| 文字叠加 | Konva 编辑 → 导出合成 | `drawtext` + textfile + CJK 字体(Noto Sans CJK) |
| 图片叠加 | 拖动/缩放/旋转/透明度/时间段 | `overlay` + `enable=between(t,…)` |
| 画笔标注 | Fabric 画布绘制 → PNG 叠加层 | 帧捕获 + 素材上传 + overlay |
| 滤镜/倍速/分辨率 | 360p~4K / 0.25x~4x / 6 款滤镜 | `scale/setpts/atempo/vf` |

任务队列：并发上限（默认 2）、进度条、取消、状态持久化 `jobs/state.json`、失败自动清理残留。

## 本地开发

```bash
npm install
npm run dev        # vite 5173，/api 自动代理到后端 8345
# 另开终端：
npm start          # 或者 node server.js（需先 npm run build 一次）
```

## 部署（systemd + Caddy）

```bash
bash deploy/install.sh   # npm install → 构建前端 → 安装并启动 systemd 服务
```

在 `/etc/caddy/Caddyfile` 现有站点块中加入（`sudo systemctl reload caddy`）：

```
redir /edit /edit/ 308
handle_path /edit/* {
    reverse_proxy 127.0.0.1:8345
}
```

服务管理：

```bash
systemctl status ff-web-editor         # journalctl -u ff-web-editor -f 看日志
sudo systemctl restart ff-web-editor
```

## 配置（.env，systemd 通过 EnvironmentFile 读取）

| 变量 | 默认 | 说明 |
|------|------|------|
| `HOST` / `PORT` | `127.0.0.1` / `8345` | 仅本机监听（Caddy 反代） |
| `VIDEOS_DIR` / `OUTPUT_DIR` / `ASSETS_DIR` | 项目内目录 | 视频库 / 输出 / 叠加素材 |
| `MAX_CONCURRENCY` | `2` | ffmpeg 并行任务数 |
| `MAX_UPLOAD_MB` | `8192` | 视频上传上限 |
| `AUTH_TOKEN` | 空 | 设置后 API 需 `x-auth-token` 头 |

## 安全设计（限制选择本地文件）

- 所有输入文件名经 `safeJoin` 白名单校验：仅允许 `videos/`、`assets/` 目录内的**本地文件**；
  拒绝绝对路径、`..` 穿越、URL、Windows 路径分隔符——非法请求直接 400。
- ffmpeg 参数全部数组化传参，无 shell 注入面。
- 前端无任何"粘贴远程 URL"入口；上传仅来自本地文件选择器，画笔输出经 `/api/assets` 存为本地素材。
- 依赖 Caddy basicauth 或 `AUTH_TOKEN` 保护，勿将 8345 直接暴露公网。

## 实测验证记录（v2）

- 全帧遮罩时间窗：t∈[2,4] 整帧纯红(t=2.5: r=251,0,0)，窗口外恢复源画面 ✓
- 文字窗口 [0,1.5]：区域内黄色像素 1.1万+（渲染），窗口外 0 ✓
- 图片叠加：720p 源内尺寸/位置/透明度/旋转正确合成 ✓
- 白名单：`/etc/passwd`、`../..`、`https://…`、不存在文件 → 全部 400 ✓
- Caddy handle_path 剥离前缀 + Range 流式(206) + 任务创建→完成 ✓
- 中文文字（Noto Sans CJK）渲染正常 ✓

## 输出目录产物

`output/` 内为成品（可下载/删除），`thumbs/` 为缩略图缓存，`jobs/state.json` 为任务状态。

## License

MIT