# FF Web Editor v2 🎬

网页视频剪辑工具：浏览器里完成 **裁剪、多段拼接、滤镜、倍速、转码、音频提取、封面生成、
文字/图片叠加（可拖动/缩放/旋转/定时间段）、画笔标注**，底层全部由 **ffmpeg 封装** 渲染，
编辑对象**仅限于本地磁盘上的文件**：左侧面板直接浏览服务器本地文件系统（白名单根目录内的任意路径，默认含家目录/挂载目录/输出目录），点击即选；也支持把多个文件加入「拼接清单」做多文件拼接。**不走网页上传**；后端白名单强校验（realpath 解析拒绝符号链接逃逸、目录穿越、系统敏感目录）。
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
                    原视频同目录保存导出成品   assets/ 叠加图片素材   output/ 旧版成品
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
| `FS_ROOTS` | 见说明 | 文件浏览白名单根目录(冒号分隔)，默认 `videos,输出,家目录,/media /mnt /tmp /srv` |
| `MAX_CONCURRENCY` | `2` | ffmpeg 并行任务数 |
| `MAX_UPLOAD_MB` | `8192` | 视频上传上限 |
| `AUTH_TOKEN` | 空 | 设置后网页提示输入口令；API 也接受 `x-auth-token` 请求头 |

## 命令行 ffmpeg 工具（scripts/ffmpeg）

从 `~/PowerShell` 仓库同步的独立 ffmpeg CLI 工具与知识文档（与 Web 编辑器互补，用于服务器/本地批处理）：

| 工具 | 位置 | 说明 |
|------|------|------|
| `rip`（精准剪辑） | `scripts/ffmpeg/linux/cut.sh`（bash 函数） | 重编码帧级精确裁剪；`ffprobe` 自动选 libx264/libx265（CRF 23/28） |
| 横屏转竖屏 | `scripts/ffmpeg/linux/h2v.sh` | `scale+crop`，偏移量 0.0~1.0 |
| `rip`（Windows） | `scripts/ffmpeg/win/cut-function.ps1`、`win/ffmpeg.ps1` | 与 Linux 版同参数行为 |
| `gblur`（区域高斯模糊） | `scripts/ffmpeg/win/ffmpeg.ps1` | 百分数坐标选区域，split+gblur+crop+overlay |
| `h2v` / `split` | `scripts/ffmpeg/win/h2v.ps1` / `win/split.ps1` | 转竖屏 / 按时长分段 |
| 旧版粗剪（封存） | `scripts/ffmpeg/archive/` | `-c copy` 流复制版，仅适合关键帧密集源 |

关键知识文档：`docs/ffmpeg-cut.md`（裁剪方案与 `-ss`/`-to` 置于 `-i` 前的正确用法）、`docs/ffmpeg-keyframe.md`（GOP/关键帧对 `-c copy` 裁剪的影响）。

### Linux 本机部署

```bash
mkdir -p ~/scripts
cp scripts/ffmpeg/linux/cut.sh ~/scripts/ffmpeg.sh   # 提供 rip 函数
echo 'source ~/scripts/ffmpeg.sh' >> ~/.bashrc
```

已部署于本机（`~/.bashrc` 第 180 行 source `~/scripts/ffmpeg.sh`，与仓库版字节一致），登录 shell 即可用 `rip <输入> <起> <止>`。

## 安全设计（限制选择本地文件）

- 文件浏览/任务输入经 `fsResolve` 校验：路径必须位于 `FS_ROOTS` 白名单根目录内（realpath 解析，
  符号链接指向白名单外会被拒绝）；拒绝 `/etc /proc /sys /boot /root` 等敏感前缀与
  `.ssh/.git/.aws` 等受保护目录名；非法请求直接 400。
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

导出成品默认保存在原视频所在目录，文件名为「原文件名_处理方式+参数」；例如原视频 `demo.mp4` 从 01:00 截取到 02:00 后生成
`demo_cut_01000200.mp4`。`output/` 仅保留历史版本成品，`thumbs/` 为缩略图缓存，`jobs/state.json` 为任务状态。

## License

MIT
