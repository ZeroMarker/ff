# ncdu -o pp.json
# ncr ~/pp.json 01:00 02:00
# ncr 01:00 02:00  # db 默认为 pp.json
#
# 分两层，通用层不认识 ncdu/json：
#
#   通用层（任何「一行一项」的列表来源都能配）
#     pick                 stdin=候选列表 → stdout=选中项（TAB 多选，可多行；原样透传 fzf 输出）
#     f <命令> [参数…]      选定后执行命令，`{}` 按位置替换为选中项（顺序即 fzf 输出顺序）
#     例: ls *.mp4                | f rip {} 01:00 02:00
#         find . -name '*.mp4'    | f rip {} 01:00 02:00
#         git ls-files            | PICK_PROMPT='git> ' f git add {}
#         ls *.mp4 *.srt | f sub {} {} embed    # 两个 {} → 两两配对（视频 + 字幕）
#     占位符个数决定一次调用消耗几项：0 个只跑一次，1 个每项一次，N 个每 N 项一次
#
#   ncdu 层（只负责把数据库变成路径列表）
#     _ncdu_paths [库]     ncdu 数据库 → 文件路径列表
#     _ncdu_dirs [库]      ncdu 数据库 → 目录路径列表（含根目录）
#     ncf [库]             = _ncdu_paths | pick
#     fn [库] <命令> [参数…] = _ncdu_paths | f <命令> [参数…]（ncdu 绑定的 f）
#     fcd [库]             = _ncdu_dirs | f cd {}（选目录并切换过去）
#     ncr [库] <起> <止>    = fn rip {} <起> <止>（默认 pp.json）
#     例: fn rip {} 01:00 02:00
#         fcd                 # 从默认库选目录并 cd 过去
#
# 界面提示符读 PICK_PROMPT（默认 "pick> "），ncdu 层用它显示 "ncdu> "。
#
# 要 cd：候选项必须是目录。fn 的候选来自 _ncdu_paths（文件），`fn cd {}` 会
# cd 到文件而失败；选目录用 fcd，或 f cd {} <<< "$(_ncdu_dirs 库)"。

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

# 选中项并执行命令: <候选列表> | f <命令> [参数…]
#
# `{}` 按【位置】取选中项，一次调用消耗的项数 = 模板里 `{}` 的个数：
#   0 个 {}  → 只执行一次（模板与选中项无关，选中项仅用于交互确认）
#   1 个 {}  → 每个选中项各执行一次（= rip/vert/sub 的批量用法）
#   N 个 {}  → 每 N 个选中项配成一次调用，如 `f sub {} {}` 选中 mp4+srt → `sub a.mp4 a.srt`
# 占用哪个位置由 fzf 的输出顺序决定（--multi 下即勾选顺序），f 本身不做重排。
# 选中项数不是 N 的整数倍时报错且不执行（避免半途产生错配的输出）。
# 单条失败不中断后续，最终返回最后一次失败调用的退出码（全部成功为 0）。
#
# 命令的 stdin 接 /dev/null：ffmpeg 会读 stdin 找交互命令（退格一次一个字符），
# 若让它继承 fd 0，它会吃掉这里待读的下一行选中项，导致后续路径缺字符（如丢开头的 /）。
#
# 注意 cd 这类只改调用方状态的命令：管道会把 f 放进子 shell，改动只作用于子 shell。
# 要用 f 改变当前目录，别用管道，改用 herestring / 进程替换：
#   f cd -- {} <<< "$(_ncdu_paths pp.json)"
#   f cd -- {} < <(_ncdu_paths pp.json)
#   cd -- "$(_ncdu_paths pp.json | pick)"
# （`cd --`：目录名以 - 开头时不会被当成选项）
f() {
    if [[ $# -eq 0 ]]; then
        echo "用法: <候选列表> | f <命令> [参数…]（{} 为选中项占位符）" >&2
        return 1
    fi

    # BASHPID≠$$ 说明当前是管道/子 shell 的副本；影响父 shell 的命令会静默失效，先提醒
    if [[ "$BASHPID" != "$$" ]]; then
        case "$1" in
            cd|pushd|popd|export|unset|read|source|.|eval|exec|set|shopt|alias|umask|trap|hash)
                echo "提示: f 运行在子 shell（管道最后一环），$1 不会改变当前 shell；改用 f $1 {} <<< \"<候选列表>\"" >&2
                ;;
        esac
    fi

    local picked
    picked="$(pick)" || return

    local arg slots=0
    for arg in "$@"; do
        [[ "$arg" == "{}" ]] && slots=$((slots + 1))
    done

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

        "${args[@]}" </dev/null || rc=$?
    done

    return "$rc"
}

# ── ncdu 层 ───────────────────────────────────────────────
#
# ncdu 导出格式: 每个节点是 [meta, 子节点…] 的数组（目录）或 {name,…} 的对象（文件）。
# 目录判定只能看类型：0 字节文件没有 asize 字段，按 has("asize") 判文件会漏掉它们。

_ncdu_check_db() {
    [[ -f "$1" ]] || {
        echo "ncdu database not found: $1" >&2
        return 1
    }
}

# ncdu 数据库 → 文件路径列表（不含目录）
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

# ncdu 数据库 → 目录路径列表（含根目录；供 f cd / pick 使用）
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

ncf() {
    _ncdu_paths "${1:-pp.json}" | PICK_PROMPT="ncdu> " pick
}

# ncdu 绑定的 f: fn [库] <命令> [参数…]
#   首个参数是存在的文件或 *.json 则视为库（默认 pp.json），其余交给 f
#   例: fn rip {} 01:00 02:00        # 用默认 pp.json
#       fn ~/pp.json vert {} left    # 指定库
# 候选用 herestring 传给 f（不是管道），f 因此在当前 shell 里执行，
# 所以 fn cd {} 能真正切换当前目录。
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

# ncdu 绑定的 f cd: fcd [库] —— 选中目录后切换当前目录
# 同理用 herestring，改动作用于当前 shell
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
