# Archive（封存区）

被替换/淘汰的旧版脚本与方案，保留供参考或特殊场景回退。**日常使用请到 `win/` 或 `linux/`。**

| 文件 | 内容 | 封存原因 |
|------|------|----------|
| `cut-v1.ps1`（函数 `rip-v1`） | Windows 粗剪函数（`-c copy` 流复制） | 已替换为精准剪辑（重编码帧级精确），仅适合关键帧密集源（如 JAV） |
| `cut-rough.sh` | Linux 服务器粗剪脚本（`-c copy` 流复制 + `-copyts`） | `linux/cut.sh` 已更换为精准剪辑 |

## 历史梳理

| 版本 | 工具 | 方式 | 结果 |
|------|------|------|------|
| **v1（粗剪）** | `cut-v1.ps1` / `cut-rough.sh` | `-c copy` 流复制 | 秒出；起点回退到最近关键帧（最多一个 GOP 偏移）、终点精确、保留原始 PTS |
| **v2（精准剪辑）** | `linux/cut.sh`（函数 `rip`）、`win/cut-function.ps1`、profile `rip` | 重编码，`-ss`/`-to` 置于 `-i` 前 | 帧级精确：首帧 I 帧、PTS 从 0 开始、终点精确 |

- 更早的服务器端两阶段/clean 版 `cut.sh` 变体：见 git 历史（`git log --oneline -- scripts/ffmpeg/linux/cut.sh`）
- 旧"两阶段粗剪方案"决策记录：见 `docs/ffmpeg-cut.md` 文末"历史方案"小节