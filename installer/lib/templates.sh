# shellcheck shell=bash
# Template rendering: @@KEY@@ placeholders replaced from KEY=value arguments. Callers validate every
# value against a safe character set first, so no escaping is needed here. A line that starts with
# @@IF_NAME@@ is kept without the marker when IF_NAME=1 is given and dropped otherwise.

render_template() {
  local file=$1 line pair key value marker
  shift
  [ -f "$file" ] || die "template missing: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      @@IF_[A-Z_]*@@*)
        marker=${line:2}
        marker=${marker%%@@*}
        value=0
        for pair in "$@"; do
          if [ "${pair%%=*}" = "$marker" ]; then value=${pair#*=}; fi
        done
        [ "$value" = 1 ] || continue
        line=${line#"@@$marker@@"}
        ;;
    esac
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
