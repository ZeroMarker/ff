# ncdu -o pp.json
# ncr ~/pp.json 01:00 02:00
# ncr 01:00 02:00  # db 默认为 pp.json

ncf() {
    local db="${1:-pp.json}"
    local selected

    [[ -f "$db" ]] || {
        echo "ncdu database not found: $db" >&2
        return 1
    }

    selected="$(
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
                if type == "object" and has("asize") then $path + "/" + .name
                elif type == "array" then walk($path)
                else empty
                end
              )
            else
              empty
            end;

          .[3] | walk("")
        ' "$db" |
        fzf --prompt="ncdu> " \
            --height=80% \
            --reverse
    )" || return

    printf '%s\n' "$selected"
}

ncr() {
    local db="pp.json"
    if [[ -f "${1:-}" ]]; then
        db="$1"
        shift
    fi
    if [[ $# -lt 2 ]]; then
        echo "用法: ncr [ncdu库] <开始> <结束> [码率]" >&2
        return 1
    fi
    local selected
    selected="$(ncf "$db")" || return
    rip "$selected" "$@"
}
