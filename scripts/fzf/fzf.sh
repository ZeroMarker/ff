# 基于 fzf 的 Bash 选择器：从候选列表选出条目，再输出条目或执行命令。
#
# 加载与依赖：
#   source ~/ff/scripts/fzf/fzf.sh
#   本文件只定义函数；需 source 到当前 Bash，直接执行不会打开选择界面。
#   Bash 4+（使用 mapfile 和数组）；交互选择需要 fzf；读取 ncdu 库还需要 jq。
#   ncr 调用外部定义的 rip 函数/命令，需要另行加载或安装。
#
# 两层接口：
#   通用层接收 stdin 中「一行一项」的候选列表，不解析 ncdu/JSON：
#     pick                        输出选中项，TAB 多选，ENTER 确认
#     f <命令> [参数…]            选中后执行命令，用独立参数 '{}' 填入选中项
#   ncdu 层读取 ncdu -o 导出的 JSON，再交给通用层：
#     _ncdu_paths [库]             输出非目录条目的路径
#     _ncdu_dirs [库]              输出目录路径，包含扫描根目录
#     ncf [库]                    选文件并输出路径
#     fn [库] <命令> [参数…]      选文件并执行命令
#     fcd [库]                    选目录并切换当前目录
#     ncr [库] <开始> <结束> [码率] 选文件并调用 rip 裁剪
#
# 快速示例（rip、sub、vert 等命令需由调用方提供）：
#   find . -type f -name '*.mp4' | f rip '{}' 01:00 02:00
#   git ls-files | PICK_PROMPT='git> ' f git add -- '{}'
#   printf '%s\n' video.mp4 subtitle.srt | f sub '{}' '{}' embed
#   ncdu -o pp.json .                  # 先生成扫描数据库
#   ncf                               # 从当前目录的 pp.json 选文件
#   fn ~/pp.json vert '{}' left        # 从指定库选文件，再执行 vert
#   fcd ~/pp.json                      # 从指定库选目录，再 cd
#   ncr 01:00 02:00                    # 默认库，时间参数原样传给 rip
#   ncr ~/pp.json 01:00 02:00 2M        # 指定库和码率
#
# 库参数规则：
#   默认库是当前工作目录下的 pp.json，不是脚本所在目录下的文件。
#   fn/fcd/ncr 仅在首参是已有普通文件或以 .json 结尾时，才把它当作库参数。
#   因此不存在且不以 .json 结尾的库名不会被识别；已有文件名也可能与命令名冲突。
#   ncf/_ncdu_paths/_ncdu_dirs 直接把首参当作库路径，不使用上述识别规则。
#
# 输入、输出与限制：
#   路径中的空格、反斜杠和通配符按字面保留；换行分隔的接口不支持含换行的路径。
#   f 仅替换整个参数恰好等于 '{}' 的位置，不替换 'prefix{}' 等字符串的一部分。
#   命令通过 Bash 参数数组直接调用，不经过 eval；管道、重定向等不是模板语法。
#   多选条目不排序、不去重，配组顺序以 fzf 实际输出为准。
#   PICK_PROMPT 控制提示符（默认 "pick> "）；只有 ncf 显式设置为 "ncdu> "。
#   ncdu 库是扫描时的快照，不检查路径现在是否仍存在，也不将相对路径转为绝对路径。
#   使用相对路径库时，应在与扫描时相同的工作目录下调用这些函数。
#
# 切换目录请用 fcd；fn 的候选是文件，通常不能用 fn cd '{}'。
# 用管道调用 f 时，它通常在子 shell 中执行，cd 等改动不能带回父 shell。
# 要修改当前 shell 的状态，需 source 本文件并用输入重定向调用，示例见 f 的注释。

# ── 通用层 ────────────────────────────────────────────────

# 选择界面: stdin=候选列表，stdout=选中项（TAB 标记多项，ENTER 确认）
# 空列表直接非零返回（不弹出空界面），取消时同样非零退出且无输出
#
# 输出原样透传 fzf 的结果：不做排序、不去重，顺序就是 fzf 给出的顺序。
pick() {
    local -a items
    mapfile -t items

    [[ ${#items[@]} -gt 0 ]] || return 1

    printf '%s\n' "${items[@]}" |
        fzf --multi \
            --prompt="${PICK_PROMPT:-pick> }" \
            --height=80% \
            --reverse
}

# 选中项并执行命令：<候选列表> | f <命令> [参数…]
#
# 独立参数 '{}' 的个数决定每次调用消耗多少条选中项：
#   0 个：确认选择后只执行一次，选中项不传给命令。
#   1 个：每项执行一次，例如 f rip '{}' 01:00 02:00。
#   N 个：每 N 项执行一次，例如 f sub '{}' '{}' embed 需要按视频、字幕顺序选中。
# 同一次调用的多个 '{}' 依次取不同条目，不会重复填入同一条目。
# 选中项数不是 N 的整数倍时，整批报错返回 1，不执行任何命令。
# 空行不会作为命令参数传入；若只选中空行，有占位符时不执行并返回 0。
#
# 返回状态：缺少命令返回 1；pick 失败/取消时返回其状态，不执行命令。
# 每组调用失败后继续执行后续组；全部成功返回 0，否则返回最后一次失败的状态。
# stdout/stderr 直接来自执行的命令（诊断信息写 stderr），不额外输出选中列表。
#
# 所有选中项先读入数组，再调用命令；命令的 stdin 统一接 /dev/null，
# 避免 ffmpeg 等程序从候选输入中读取交互指令。这也意味着执行的命令不能
# 再从 stdin 读取正文或交互输入；需要的数据应通过参数或文件传入。
#
# cd 等修改 shell 状态的命令要在当前 shell 执行，不能依赖普通管道：
#   f cd -- '{}' <<< "$(_ncdu_dirs pp.json)"
#   f cd -- '{}' < <(_ncdu_dirs pp.json)
# 以上写法让 f 在当前 shell 执行；首选 fcd，它还会检查生成列表是否成功。
# `cd --` 防止以 - 开头的目录名被当成选项；多选会逐个 cd，最终停在最后一次
# 成功切换的目录。相对路径会受前一次 cd 影响，切换目录时建议只选一项。
f() {
    if [[ $# -eq 0 ]]; then
        echo "用法: <候选列表> | f <命令> [参数…]（{} 为选中项占位符）" >&2
        return 1
    fi

    # BASHPID 与 $$ 不同时，当前处于子 shell；对常见修改 shell 状态的命令给出提示
    if [[ "$BASHPID" != "$$" ]]; then
        case "$1" in
            cd|pushd|popd|export|unset|read|source|.|eval|exec|set|shopt|alias|umask|trap|hash)
                echo "提示: f 运行在子 shell（管道最后一环），$1 不会改变当前 shell；改用 f $1 {} <<< \"<候选列表>\"" >&2
                ;;
        esac
    fi

    # 命令替换只捕获 pick 的 stdout；fzf 的交互界面仍由终端显示。
    local picked
    picked="$(pick)" || return

    # 统计模板中完整匹配的占位符，其他参数保持原样。
    local arg slots=0
    for arg in "$@"; do
        [[ "$arg" == "{}" ]] && slots=$((slots + 1))
    done

    # IFS= 与 read -r 保留空格和反斜杠；空行不进入执行队列。
    local -a items=()
    local path
    while IFS= read -r path; do
        [[ -n "$path" ]] && items+=("$path")
    done <<< "$picked"

    # 模板不含占位符：执行一次即可（选中项无法进入命令）
    if ((slots == 0)); then
        local rc0=0
        "$@" </dev/null || rc0=$?
        return "$rc0"
    fi

    ((${#items[@]})) || return 0

    # 按位配对：凑不满一组就整体拒绝，避免只跑了一半
    if ((${#items[@]} % slots)); then
        echo "错误: 模板含 $slots 个 {}，但选中 ${#items[@]} 项（需为 $slots 的整数倍）" >&2
        return 1
    fi

    local rc=0 i k
    local -a args
    for ((i = 0; i < ${#items[@]}; i += slots)); do
        k=0
        args=()
        for arg in "$@"; do
            if [ "$arg" = "{}" ]; then
                args+=("${items[i + k]}")
                k=$((k + 1))
            else
                args+=("$arg")
            fi
        done

        # 数组展开保证每条路径仍是单个参数；成功调用不覆盖之前记录的失败状态。
        "${args[@]}" </dev/null || rc=$?
    done

    return "$rc"
}

# ── ncdu 层 ───────────────────────────────────────────────
#
# ncdu JSON 顶层形如 [主版本, 次版本, 导出信息, 根目录节点]，所以从 .[3] 开始遍历。
# 目录节点是 [meta, 子节点…] 数组，非目录节点是 {name,…} 对象。
# 对象条目也可能是符号链接等；这里按结构区分目录，并不检查是否为普通文件。
# 0 字节文件可能没有 asize 字段，不能用 has("asize") 来判断是不是文件。

# 只检查库路径是否为普通文件；可读性、JSON 语法由后续 jq 检查。
# 检查通过返回 0，缺失或非普通文件时写 stderr 并返回 1。
_ncdu_check_db() {
    [[ -f "$1" ]] || {
        echo "ncdu database not found: $1" >&2
        return 1
    }
}

# _ncdu_paths [库]：逐行输出非目录条目路径（不输出目录）。
# 按库中子节点的顺序递归遍历；路径由根节点 name 和后续 name 拼接。
# 缺少库返回 1；jq 读取/解析失败时返回 jq 的状态。
_ncdu_paths() {
    local db="${1:-pp.json}"
    _ncdu_check_db "$db" || return 1

    jq -r '
      def walk($parent):
        if type == "array" then
          .[0] as $meta |
          ($meta.name // "") as $name |
          (
            if $parent == "" then $name
            elif $parent == "/" then "/" + $name
            else $parent + "/" + $name
            end
          ) as $path |
          (
            .[1:][]? |
            if type == "object" then $path + "/" + .name
            elif type == "array" then walk($path)
            else empty
            end
          )
        else
          empty
        end;

      .[3] | walk("")
    ' "$db"
}

# _ncdu_dirs [库]：逐行输出目录路径，先输出根目录，再递归输出子目录。
# 默认库及错误状态与 _ncdu_paths 相同；跳过所有非目录条目。
_ncdu_dirs() {
    local db="${1:-pp.json}"
    _ncdu_check_db "$db" || return 1

    jq -r '
      def walk($parent):
        if type == "array" then
          .[0] as $meta |
          ($meta.name // "") as $name |
          (
            if $parent == "" then $name
            elif $parent == "/" then "/" + $name
            else $parent + "/" + $name
            end
          ) as $path |
          $path,
          (
            .[1:][]? |
            if type == "array" then walk($path)
            else empty
            end
          )
        else
          empty
        end;

      .[3] | walk("")
    ' "$db"
}

# ncf [库]：从库中选择文件路径并输出，只有此包装显式使用 "ncdu> " 提示符。
# 返回管道状态：默认取 pick 的状态；启用 pipefail 时也受 _ncdu_paths 状态影响。
ncf() {
    _ncdu_paths "${1:-pp.json}" | PICK_PROMPT="ncdu> " pick
}

# fn [库] <命令> [参数…]：从库中选文件，再按 f 的占位符规则执行命令。
#   fn rip '{}' 01:00 02:00       # 默认 pp.json
#   fn ~/pp.json vert '{}' left  # 指定库
# 库参数识别规则见文件头；缺少命令返回 1。
# 先捕获路径列表，生成失败则直接返回其状态，不打开选择界面。
# 再用 here-string（<<<）传给 f，让 f 在当前 shell 执行；返回状态由 f 决定。
# 保留当前 shell 状态不代表候选适合 cd：目录选择应使用 fcd。
fn() {
    local db="pp.json"
    if [[ -f "${1:-}" || "${1:-}" == *.json ]]; then
        db="$1"
        shift
    fi
    if [[ $# -eq 0 ]]; then
        echo "用法: fn [ncdu库] <命令> [参数…]（{} 为选中路径占位符）" >&2
        return 1
    fi

    local list
    list="$(_ncdu_paths "$db")" || return

    f "$@" <<< "$list"
}

# fcd [库]：选择目录后在当前 shell 中执行 cd --，不会输出选中路径。
# 库参数识别规则见文件头；多余参数返回 1，生成列表失败则返回其状态。
# here-string 保证 cd 在当前 shell 执行；取消/执行状态由 f 返回。
# 建议只选一个目录，尤其是库中的路径为相对路径时。
fcd() {
    local db="pp.json"
    if [[ -f "${1:-}" || "${1:-}" == *.json ]]; then
        db="$1"
        shift
    fi
    if [[ $# -gt 0 ]]; then
        echo "用法: fcd [ncdu库]" >&2
        return 1
    fi

    local list
    list="$(_ncdu_dirs "$db")" || return

    f cd -- {} <<< "$list"
}

# ncr [库] <开始> <结束> [码率]：文件选择和裁剪的快捷入口。
# 等价于 fn "$db" rip '{}' "$@"，每个选中文件分别调用一次 rip。
# 这里只要求至少两个时间参数（不足返回 1），不解析时间、码率或额外参数；
# 参数原样交给 rip，具体格式与处理行为由 rip 定义。返回状态由 fn/f 决定。
ncr() {
    local db="pp.json"
    if [[ -f "${1:-}" || "${1:-}" == *.json ]]; then
        db="$1"
        shift
    fi
    if [[ $# -lt 2 ]]; then
        echo "用法: ncr [ncdu库] <开始> <结束> [码率]" >&2
        return 1
    fi

    fn "$db" rip {} "$@"
}
