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
