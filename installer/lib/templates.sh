# shellcheck shell=bash
# Template rendering: @@KEY@@ placeholders replaced from KEY=value arguments. Callers validate every
# value against a safe character set first, so no escaping is needed here.

render_template() {
  local file=$1 line pair key value
  shift
  [ -f "$file" ] || die "template missing: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    for pair in "$@"; do
      key=${pair%%=*}
      value=${pair#*=}
      line=${line//@@$key@@/$value}
    done
    case "$line" in
      *@@[A-Z_]*@@*) die "unfilled placeholder in $file: $line" ;;
    esac
    printf '%s\n' "$line"
  done <"$file"
}

# Rejects characters that would break out of a YAML scalar or a replacement.
safe_value() {
  has_control_chars "$1" && return 1
  case "$1" in
    *[\&\\\"\'\`\;\|]*) return 1 ;;
  esac
  return 0
}
