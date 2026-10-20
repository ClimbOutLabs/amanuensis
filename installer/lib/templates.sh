# shellcheck shell=bash
# Template rendering: @@KEY@@ placeholders replaced from KEY=value arguments. Callers validate every
# value against a safe character set first, so no escaping is needed here. A line that starts with
# @@IF_NAME@@ is kept without the marker when IF_NAME=1 is given and dropped otherwise.

render_template() {
  local LC_ALL=C file=$1 line pair key value marker
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

# Sets KEY=VALUE inside the managed block of an instance .env (0600, atomic) and leaves every other line, including
# the owner's own settings below the block, as they were. A block without the key gets it. The value passes only
# through shell builtins, so a secret never reaches argv.
env_managed_set() {
  local env=$1 key=$2 value=$3 line inblock=0 written=0
  [ -f "$env" ] || die "The settings file $env is missing."
  grep -q '^# >>> managed by the installer' "$env" || die "The settings file $env is missing the part the installer manages."
  {
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        '# >>> managed by the installer'*) inblock=1 ;;
        '# <<< end of managed block'*)
          if [ "$inblock" = 1 ] && [ "$written" = 0 ]; then
            printf '%s=%s\n' "$key" "$value"
            written=1
          fi
          inblock=0
          ;;
        "$key="*)
          if [ "$inblock" = 1 ]; then
            line="$key=$value"
            written=1
          fi
          ;;
      esac
      printf '%s\n' "$line"
    done <"$env"
  } | write_if_changed "$env" 600 || true
}

# Removes every line of an instance .env outside the managed block that Compose reads as KEY, so the managed value is
# the one Compose reads. Needs lib/shared.sh.
env_drop_outside_block() { # env key
  local env=$1 key=$2
  [ -f "$env" ] || return 0
  LC_ALL=C awk -v re="$(env_key_line_re "$key")" '
    /^# >>> managed by the installer/ { inblock = 1 }
    /^# <<< end of managed block/ { inblock = 0 }
    !inblock && $0 ~ re { next }
    { print }' "$env" | write_if_changed "$env" 600 || true
}
