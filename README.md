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
| `rip`（精准剪辑） | `scripts/ffmpeg/linux/cut.sh`（bash 函数） | libx264 重编码，帧级精确裁剪 |
| `h2v`（横屏转竖屏） | `scripts/ffmpeg/linux/h2v.sh`（bash 函数） | `h2v [偏移量] [文件…]`：`scale+crop`，偏移量 0.0~1.0（默认 0.5）；无文件时扫当前目录 `*.mp4` 输出到 `vertical/*_h2v.mp4`，指定文件时输出到源文件同目录 |
| `sub`（添加字幕） | `scripts/ffmpeg/linux/subtitle.sh`（bash 函数） | `sub <视频> <字幕> [输出.mp4] [burn\|embed] [crf]`：前两个参数**顺序可颠倒**（按扩展名/ffprobe 自动识别）；第 3 个起按内容识别（`burn\|embed`=模式、纯整数=crf、其它=输出名）；burn 烧录进画面（默认，重编码），embed 封装为可开关字幕轨（流复制）；`crf` 默认 23，仅 burn 生效，越小越清晰/越大 |
| `vert`（旋转竖屏） | `scripts/ffmpeg/linux/vert.sh`（bash 函数） | 顺/逆时针旋转，不缩放、不裁剪 |
| `pick` / `f`（通用选择器） | `scripts/fzf/fzf.sh`（bash 函数） | 候选源任意（`ls` / `find` / `git ls-files` / ncdu…）：`<候选列表> \| pick` 交互选择，`<候选列表> \| f <命令> [参数…]` 选中后执行，`{}` 替换为选中项；TAB 可多选、逐条执行；取消时不执行 |
| `_ncdu_paths` / `_ncdu_dirs` / `ncf` / `fn` / `fcd` / `ncr` | `scripts/fzf/fzf.sh`（bash 函数） | ncdu 层（只做 JSON→路径列表）：`_ncdu_paths [库]` 列文件，`_ncdu_dirs [库]` 列目录，`ncf [库]` 选择，`fn [库] <命令> [参数…]` = ncdu 绑定的 `f`，`fcd [库]` = 选目录并 `cd`，`ncr [库] <起> <止> [码率]` = `fn rip {} …` |
| `rip`（Windows） | `scripts/ffmpeg/win/cut-function.ps1`、`win/ffmpeg.ps1` | 与 Linux 版同参数行为 |
| `gblur`（区域高斯模糊） | `scripts/ffmpeg/win/ffmpeg.ps1` | 百分数坐标选区域，split+gblur+crop+overlay |
| `h2v` / `split` | `scripts/ffmpeg/win/h2v.ps1` / `win/split.ps1` | 转竖屏 / 按时长分段 |
| 旧版粗剪（封存） | `scripts/ffmpeg/archive/` | `-c copy` 流复制版，仅适合关键帧密集源 |

关键知识文档：`docs/ffmpeg-cut.md`（裁剪方案与 `-ss`/`-to` 置于 `-i` 前的正确用法）、`docs/ffmpeg-keyframe.md`（GOP/关键帧对 `-c copy` 裁剪的影响）。

### Linux 使用

在当前 shell 临时加载：

```bash
source "$HOME/ff/scripts/ffmpeg/linux/cut.sh"
source "$HOME/ff/scripts/ffmpeg/linux/h2v.sh"
source "$HOME/ff/scripts/ffmpeg/linux/subtitle.sh"
source "$HOME/ff/scripts/ffmpeg/linux/vert.sh"
source "$HOME/ff/scripts/fzf/fzf.sh"
```

需要每次登录自动加载时，将下面内容加入 `~/.bashrc`：

```bash
for shell_functions in \
  "$HOME/ff/scripts/ffmpeg/linux/cut.sh" \
  "$HOME/ff/scripts/ffmpeg/linux/h2v.sh" \
  "$HOME/ff/scripts/ffmpeg/linux/subtitle.sh" \
  "$HOME/ff/scripts/ffmpeg/linux/vert.sh" \
  "$HOME/ff/scripts/fzf/fzf.sh"
do
  [[ -r "$shell_functions" ]] && source "$shell_functions"
done
unset shell_functions
```

运行 `source ~/.bashrc` 使其在当前 shell 生效。以上方式直接加载仓库内的真实脚本，不创建或同步副本。

### 与 fzf 选择器组合（`{}` 占位符）

`scripts/fzf/fzf.sh` 分成互不依赖的两层，通用层不认识 ncdu、也不解析 JSON：

| 层 | 函数 | 职责 |
|----|------|------|
| 通用 | `pick` | stdin=候选列表（一行一项），stdout=选中项（TAB 多选、可多行）；空列表或取消时非零退出、无输出 |
| 通用 | `f` | `<候选列表> \| f <命令> [参数…]`：把选中项填进 `{}` 后执行 |
| ncdu | `_ncdu_paths` / `_ncdu_dirs` | 只做 ncdu JSON → 路径列表（文件 / 目录） |
| ncdu | `ncf` / `fn` / `fcd` / `ncr` | 薄包装：选择文件 / 绑定 `f` / 绑定 `f cd` / 绑定 `f rip` |

候选源因此可以是任何「一行一项」的输出，提示符用 `PICK_PROMPT` 定制（默认 `pick> `）：

```bash
ls *.mp4                      | f rip {} 00:01:00 00:02:00   # 当前目录
find ~/videos -name '*.mp4'   | f rip {} 00:01:00 00:02:00   # 递归找
git ls-files '*.mp4'          | PICK_PROMPT='git> ' f git add {}   # 加入暂存
find ~/videos -name '*.mp4'   | pick                          # 只要选中结果
```

ncdu 层（`_ncdu_paths` 提供候选，等于给上面的管道换个来源）。`fn` 是「把 ncdu 库绑好」的 `f`，用法与 `f` 完全一致，只是候选来自库、少写一条管道：

```bash
ncdu -o pp.json ~/videos                     # 生成 ncdu 数据库
ncf                                          # 从默认 pp.json 选择（只输出选中路径）
fn rip {} 00:01:00 00:02:00                  # 选择后裁剪（= _ncdu_paths pp.json | f rip {} …）
fn vert {} left                              # 选择后逆时针旋转
fn sub {} ~/subs/a.srt embed                 # 选择后嵌字幕
fn ~/pp.json rip {} 00:01:00 00:02:00        # 首个参数是 *.json 或存在的文件 → 当作库
fcd ~/pp.json                                # 选目录并 cd 过去（目录来自库，见下节）
ncr 00:01:00 00:02:00                        # = fn rip {} 00:01:00 00:02:00
ncr ~/pp.json 00:01:00 00:02:00 2M           # 指定库 + 固定码率
_ncdu_paths ~/pp.json | f rip {} 00:01:00 00:02:00
```

`f` 把选中项逐条填进 `{}`，TAB 多选时**每条一次调用**；命令的 stdin 接 `/dev/null`（否则 ffmpeg 会抢读 fd 0，吃掉下一行选中项）：

```bash
_ncdu_paths ~/pp.json | f rip  {} 00:01:00 00:02:00        # 裁剪（= ncr 的展开式）
_ncdu_paths ~/pp.json | f rip  {} 00:01:00 00:02:00 2M     # 裁剪 + 固定码率
_ncdu_paths ~/pp.json | f sub  {} ~/subs/a.srt embed       # 同一字幕批量嵌轨（burn 为默认）
_ncdu_paths ~/pp.json | f vert {} left                     # 逆时针旋转（right 为默认）
_ncdu_paths ~/pp.json | f h2v  0.4 {}                      # 偏移 0.4 转竖屏，输出到源文件同目录
```

| 命令 | 占位符位置 | 多选行为 |
|------|-----------|---------|
| `rip {} 开始 结束 [码率]` | 第 1 参 | 每片各出一份 `<名>_cut_<起>-<止>[_码率].mp4` |
| `sub {} <字幕.srt> [输出.mp4] [burn\|embed] [crf]` | 第 1 参 | 同一字幕套用到每片 |
| `sub {} {} [输出.mp4] [burn\|embed] [crf]` | 第 1、2 参 | 两两配对：同时选中「视频 + 对应字幕」→ `sub 视频 字幕`（顺序颠倒也能识别） |
| `vert {} [right\|left] [输出.mp4]` | 第 1 参 | 每片各出一份 `<名>_vert_<方向>.mp4` |
| `h2v [偏移量] {}` | 在偏移量之后 | 每片各出一份 `<名>_h2v.mp4` |

**`{}` 是位置占位符**：一次调用消耗的项数 = 模板里 `{}` 的个数。

| 模板里 `{}` 个数 | 行为 |
|---|---|
| 0 个 | 只执行一次（选中项进不了命令，仅作交互确认） |
| 1 个 | 每个选中项各执行一次（`rip`/`vert`/`sub {} <字幕>` 的批量用法） |
| N 个 | 每 N 个选中项配成一次调用；选中数不是 N 的整数倍 → 报错且**不执行**（避免半途产生错配产物） |

```bash
# 视频 + 字幕一次性配好（选中 2 项 → 1 次调用）
f sub {} {} <<< "$(ls *.mp4 *.srt)"
f sub {} {} embed <<< "$(ls *.mp4 *.srt)"        # 追加固定参数也行
f sub {} {} burn 23 <<< "$(ls *.mp4 *.srt)"      # 追加 crf=23（省体积）

# 批量 4 项 → 2 次调用
f sub {} {} <<< "$(ls a.mp4 a.srt b.mp4 b.srt)"
```

**`sub` 的 crf**（burn 专用，默认 23）：crf 越小越清晰、文件越大，重编码耗时也略增。720p30/12s、`-preset medium` 实测，每格为「输出体积 / 重编码 CPU 秒」：

| crf | 母带源(crf18) | 已压过源(crf31) | 含噪声源(crf30) |
|---|---|---|---|
| 18 | 6950K / 15.5s | 3658K / 13.8s | 15382K / 44.8s |
| 20 | 6000K / 15.1s | 3122K / 13.3s | 12030K / 42.8s |
| 22 | 4968K / 14.4s | 2680K / 12.7s | 9439K / 39.7s |
| 24 | 4006K / 13.9s | 2324K / 12.4s | 7461K / 36.2s |
| 26 | 3062K / 13.4s | 2016K / 12.2s | 5927K / 33.0s |
| 28 | 2247K / 12.7s | 1745K / 11.7s | 4653K / 29.5s |

- **体积**：每 +2 crf ≈ ×0.78~0.86（-14%~-22%），18→28 约为原来的 **1/4~1/5**。
- **速度**：18→28 只省 **15%~34%** CPU 时间（源越难压收益越大），`-preset medium` 下不是数量级差异；体积换来的是画质而非时间。
- **相对源**：母带源 crf18≈1.0x、crf28≈0.3x；已压过源仍会膨胀（18=2.5x → 28=1.2x）；噪声源最难压（18=3.9x → 28=1.2x）。
- **取值**：默认 23 优先兼顾画质与体积；源压得很狠时用 26~28，要尽量接近源码率可试 28~30；18 只适合当作要长期保存的中间产物。

显式给 crf 时输出名会带 `_crfNN`（如 `src_sub_burn_crf23.mp4`），不会和默认产物互相覆盖；`embed` 是流复制，此时会提示 `crf 不生效`。

**配对顺序 = fzf 的输出顺序，`pick`/`f` 不做任何排序或去重**（`--multi` 下即 TAB 勾选的先后）。对 `sub` 来说这已无影响：它按扩展名/ffprobe 识别哪个是视频、哪个是字幕，勾选顺序反了也能正确合并（会打印一行「识别: … 参数顺序已按类型调整」）。其它命令的参数语义固定（如 `vert` 第 2 参是方向），位置错了仍由命令自己报错。

`{}` 只按**整参数**匹配：`{}` 会替换，`pre{}post` 原样传给命令（那种情况 `{}` 不计入占位符个数）。本仓库各命令都自己派生输出名，不需要拼接形式。

`h2v` 只认「数值偏移量 + 文件列表」，所以参数顺序是 `f h2v 0.4 {}` 而不是 `f h2v {} 0.4`；`h2v` 无文件参数时仍按旧行为扫描当前目录 `*.mp4` 并输出到 `vertical/`，因此也可以 `_ncdu_paths ~/pp.json | f h2v 0.4`（候选被丢弃，等价于直接 `h2v 0.4`）。

多选时逐条执行、单条失败不中断；`f` 最终返回最后一次失败调用的退出码（全部成功为 0）。

**`cd` 用法（与 ncdu 无关）**：`cd` 只改调用它的那个 shell，所以两个条件缺一不可 —— ① `f` 必须在当前 shell 跑，**不能用管道**（管道最后一环是子 shell，`cd` 白做；`f` 会打提示）；② 候选必须是**目录**。

可用形式（`<目录列表>` 换成下面任意一种；都是「一行一项」即可）：

```bash
# — 交付方式（三选一，效果相同）—
f cd -- {} <<< "$(<目录列表>)"        # herestring
f cd -- {} < <(<目录列表>)            # 进程替换
cd -- "$(<目录列表> | pick)"          # 命令替换（单选）

# — 目录列表的几种来源 —
find . -maxdepth 1 -type d            # 安全：带 ./ 前缀 + find 不把名字当选项
printf '%s\n' */                      # 一层子目录（纯 shell glob，无需 ls）
ls -p                                 # 混着文件，目录带 /，好辨认
ls -d -- */                           # 只列目录；-- 不能省（见下）
ls -p --                              # 同上（列出当前目录全部，目录带 /）
find ~/videos -maxdepth 2 -type d     # 递归若干层
_ncdu_dirs pp.json                    # ncdu 库里的目录（或直接用 `fcd`）

# — 组合示例 —
f cd -- {} <<< "$(find . -maxdepth 1 -type d)"
f cd -- {} <<< "$(ls -p)"
f cd -- {} < <(find ~/videos -maxdepth 2 -type d)
cd -- "$(find ~/videos -type d | pick)"
f pushd {} <<< "$(find "$PWD" -maxdepth 1 -type d)"   # 需要目录栈时同理（pushd 也改当前 shell）

# ✗ 不行
find ~/videos -type d | f cd {}               # 子 shell：打提示、pwd 不变
find ~/videos -type f | f cd {} <<< "…"       # 候选是文件：cd: Not a directory
f cd {} <<< "$(ls -F)"                        # 后缀标记：选中 run.sh* 会 No such file
f cd {}/sub <<< "…"                           # `{}` 只按整参数替换，不能拼接（见上）
f cd {} <<< "$(ls /path/to/dir)"              # 裸名按【当前】目录解析，跨目录会失败
```

**为什么模板写 `cd --`**：目录名以 `-` 开头时（如 `-dash/`），不加 `--` 会被 `cd` 当成选项 —— `cd: -d: invalid option`（rc=2，pwd 不变）。加 `--` 后正常：

```bash
f cd {} <<< "$(...)"      # 选中 -dash/ → ✗ cd: -d: invalid option
f cd -- {} <<< "$(...)"   # 选中 -dash/ → ✅ 进入 -dash/
```

同理，列表来源也要防这个：`ls -d */` 在存在 `-` 开头目录时会 `ls: invalid option -- '/'`（glob 结果被当选项传入），必须写 `ls -d -- */`；而 `find . -maxdepth 1 -type d`（自带 `./` 前缀）和 `printf '%s\n' */`（shell 展开，不经 ls 解析）天然没这问题。

**两个通用限制**：
- 文件名含**换行符**时无法用（行协议）：`dir\nnewline/` 会被拆成两条候选。
- 多选（TAB）是逐条 `cd`，停在最后一条。用相对路径时后一条会相对**前一条目录**解析，容易失败；多选请用绝对路径列表（`find "$PWD" -type d`）或直接单选。

`ls` 相关注意：
- `ls` 混排文件与目录，选中文件时是 `cd: file.txt: Not a directory`（rc=1，pwd 不变）——不算静默错误，但仍建议用 `ls -p`（只有目录带 `/`，一眼可辨）。
- **别用 `ls -F`**：它给目录加 `/`、可执行文件加 `*`、符号链接加 `@`，这些后缀会被原样传进 `cd`，选中 `run.sh*` 直接 `No such file or directory`。要标记就用 `-p`（只标目录）。
- `ls -d */` 只列目录，但**目录为空时** glob 匹配不到，`ls` 会报 `cannot access '*/'` 并 rc=2；`find . -maxdepth 1 -type d` 无此问题。
- `ls /some/dir` 输出的是裸名（`dirA`），`cd` 时按**当前**目录解析，所以只在“先 cd 到该目录再选”时才正确；跨目录请用 `find /some/dir -type d` 之类输出完整路径。

其它：
- 候选是相对路径也可以（`find . -type d` → 选中 `a/deep` 等价于 `cd a/deep`）。
- 带尾斜杠的候选（`ls -p`、`ls -d -- */` 的输出 `dir/`）照常可用。
- 空候选、取消时不执行任何 `cd`，返回非零。
- ncdu 库场景不用自己拼目录列表，有现成的 `fcd [库]`，等价于 `f cd -- {} <<< "$(_ncdu_dirs 库)"`。

同一坑也适用于 `export` / `unset` / `source` / `eval` / `set` 等只影响调用方状态的命令。

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
