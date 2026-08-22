# 视频裁剪方案（服务器精准剪辑）

## 概述

服务器端 `cut.sh` 直接做**精准剪辑**：重新编码、帧级精确，无需再下载后二次剪辑。本地 `cut` 仅作为补充工具（处理已下载的片段）。

| 工具 | 位置 | 模式 | 速度 | 精度 |
|------|------|------|------|------|
| `scripts/ffmpeg/linux/cut.sh` | 服务器（ssh ali） | 重新编码 | 🐢 较慢 | ✅ 帧级精确 |
| `rip` (profile) | 本地 Windows | 重新编码 | 🐢 较慢 | ✅ 帧级精确 |

> 旧"两阶段粗剪方案"（服务器 `-c copy` 粗剪 → 本地细剪）已封存，见文末[历史方案](#历史方案已封存)。

## 服务器精准剪辑（linux/cut.sh）

### 命令（脚本在仓库 `scripts/ffmpeg/linux/cut.sh`，可先 scp 到服务器）

```bash
ssh ali
cd ~/tiktook/
bash scripts/ffmpeg/linux/cut.sh PRIAN-050.mp4 01:39:26 01:40:10
```

### 实际执行

```bash
ffmpeg -y -ss 01:39:26 -to 01:40:10 -i PRIAN-050.mp4 \
       -c:v libx264 -crf 23 -preset fast -c:a aac output.mp4
```

### 行为

| 步骤 | 说明 |
|------|------|
| 1. 编码器探测 | `ffprobe` 探测原视频编码，自动选 libx264 / libx265（CRF 23/28） |
| 2. `-ss`/`-to` 在 `-i` 前 | 跳到起始时间前最近关键帧，快速定位；终点按原始时间戳精确截止 |
| 3. 解码 | 从关键帧开始解码所有帧 |
| 4. 丢弃 | 丢弃解码后时间戳 < 起始时间的帧 |
| 5. 重新编码 | 从起始时间开始以新 I 帧输出，音频重编码为 aac |

> ⚠️ `-to` 必须与 `-ss` 一起放在 `-i` **之前**（两者都是输入选项，按原始时间戳计算）。
> 若把 `-to` 放在 `-i` 之后（输出选项），`-ss` 输入定位会平移输出时间戳，终点按平移后的位置计算，
> 实际产出的是 `[start, start+end]`（终点翻倍）。

### 输出文件特征

| 项目 | 值 |
|------|-----|
| 首帧 | **I 帧**，PTS = 0 |
| 时长 | **精确**（起止之差） |
| 终点 | **精确**（按原始时间戳截止） |
| 画质 | CRF 23 / 28（视觉无损） |
| 时间戳 | 从 0 开始 |
| 二次剪辑 | 可直接用相对时间（`00:00:xx`） |

## 本地二次剪辑（可选）

服务器产物已是帧级精确的成品；如需再剪或处理已下载的片段，在本地 PowerShell 用 `rip`：

```powershell
rip .\PRIAN-050_cut_013926-014010.mp4 00:00:02 00:00:44
# 或直接用原始时间:
rip .\PRIAN-050_cut_013926-014010.mp4 01:39:26 01:40:10
```

行为与 `linux/cut.sh` 一致（重编码、`-ss`/`-to` 前置、帧级精确）。

## 完整工作流

```mermaid
graph LR
    A[原始视频<br>4~7GB] --> B[服务器: linux/cut.sh 精准剪辑]
    B --> C[精准片段<br>12~13MB]
    C --> D[scp 下载到本地]
    D --> E[可选: 本地 rip 再剪]
```

### 示例：PRIAN-050.mp4

```bash
# 服务器上直接精准剪辑（重编码，耗时取决于 CPU）
ssh ali
cd ~/tiktook
bash scripts/ffmpeg/linux/cut.sh PRIAN-050.mp4 01:39:26 01:40:10
# 输出: PRIAN-050_cut_013926-014010.mp4 (12.8MB，帧级精确: 首帧 I 帧 PTS=0, 精确 44s)

# 下载到本地（~1 秒）
# 退出 ssh，在本地执行:
scp ali:~/tiktook/PRIAN-050_cut_013926-014010.mp4 ~/Downloads/
```

## 历史方案（已封存）

**两阶段粗剪方案**：过去为避免服务器 CPU 负担，先服务器快速粗剪（`-c copy` 流复制，秒出），再下载小文件到本地重编码细剪。该方案因**粗剪起点偏移**（回退到最近关键帧，最多一个 GOP，如 PRIAN-050 多出 2s / MEYD-785-C 多出 8.3s）和**PTS 未重置**（二次剪辑必须用原始时间）被放弃。

| 文件 | 去向 |
|------|------|
| 粗剪服务器脚本 | `scripts/ffmpeg/archive/cut-rough.sh` |
| 粗剪 Windows 函数 | `scripts/ffmpeg/archive/cut-v1.ps1` |
| 关键帧限制的详细说明 | `docs/ffmpeg-keyframe.md`（历史背景） |
| 旧版文档 | git 历史（`git log -- docs/ffmpeg-cut.md`） |

## 各工具定位

| 工具 | 位置 | 适用 |
|------|------|------|
| `scripts/ffmpeg/linux/cut.sh` | 服务器 | 精准剪辑大文件，下载即成品 |
| `rip` (profile) | 本地 Windows | 二次剪辑、处理已下载的片段 |
| `scripts/ffmpeg/archive/cut-rough.sh` | 封存 | 旧快速粗剪（仅关键帧密集源，如 JAV，GOP < 1s） |
| `scripts/ffmpeg/archive/cut-v1.ps1` | 封存 | 同上（Windows 版） |