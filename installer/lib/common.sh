# shellcheck shell=bash
# Output, prompts, locking and small filesystem helpers shared by every command.

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
usage_die() {
  printf 'error: %s\n' "$*" >&2
  printf 'Run "install.sh --help" for usage.\n' >&2
  exit 2
}

# Only the state directory is written to; never anything that could hold a secret.
log_event() {
  if [ -d "$STATE_DIR" ] && [ "$DRY_RUN" != 1 ]; then
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$STATE_DIR/install.log" 2>/dev/null || true
  fi
}

# ask VAR "question" "default": flags win, --yes takes the default, otherwise prompt on stdin.
ask() {
  local __var=$1 __question=$2 __default=${3:-} __answer=
  if [ -n "${!__var:-}" ]; then
    return 0
  fi
  if [ "$ASSUME_YES" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    printf -v "$__var" '%s' "$__default"
    return 0
  fi
  if [ -n "$__default" ]; then
    printf '%s [%s]: ' "$__question" "$__default" >&2
  else
    printf '%s: ' "$__question" >&2
  fi
  read -r __answer || true
  if [ -z "$__answer" ]; then
    __answer=$__default
  fi
  printf -v "$__var" '%s' "$__answer"
}

confirm() {
  local __answer=
  if [ "$ASSUME_YES" = 1 ]; then
    return 0
  fi
  printf '%s [y/N]: ' "$1" >&2
  read -r __answer || true
  case "$__answer" in
    y | Y | yes | YES | Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# Reads a password twice without echo into the variable named by $1. The value stays in shell
# memory: it is never put in argv, a file or the environment of a child process.
ask_password() {
  local __var=$1 __first='' __second=''
  if [ "$PASSWORD_FROM_STDIN" = 1 ]; then
    IFS= read -r __first || true
    [ -n "$__first" ] || usage_die "--password-stdin got an empty line"
    printf -v "$__var" '%s' "$__first"
    return 0
  fi
  while :; do
    if [ -t 0 ]; then
      printf 'Password for the owner account: ' >&2
      IFS= read -rs __first || true
      printf '\n' >&2
      printf 'Repeat the password: ' >&2
      IFS= read -rs __second || true
      printf '\n' >&2
    else
      IFS= read -r __first || true
      IFS= read -r __second || true
    fi
    if [ "${#__first}" -lt 8 ]; then
      warn "the password needs at least 8 characters"
    elif [ "$__first" != "$__second" ]; then
      warn "the two entries differ"
    else
      printf -v "$__var" '%s' "$__first"
      return 0
    fi
    if [ ! -t 0 ]; then
      die "no valid password could be read from stdin"
    fi
  done
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# Writes stdin to $1 with mode $2 unless the content is already identical.
# Returns 0 when the file changed, 1 when it was left alone.
write_if_changed() {
  local path=$1 mode=$2 tmp
  tmp=$(umask 077 && mktemp "$path.XXXXXX")
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    chmod "$mode" "$path"
    return 1
  fi
  chmod "$mode" "$tmp"
  mv "$tmp" "$path"
  return 0
}

ensure_private_dir() {
  mkdir -p "$1"
  chmod 700 "$1"
}

# A mkdir lock is atomic everywhere; a dead holder's lock is taken over.
lock_acquire() {
  local lock="$STATE_DIR/lock" pid
  ensure_private_dir "$STATE_DIR"
  if ! mkdir "$lock" 2>/dev/null; then
    pid=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      die "another installer run (pid $pid) is active; wait for it to finish"
    fi
    rm -rf "$lock"
    mkdir "$lock" || die "could not take the installer lock at $lock"
  fi
  printf '%s\n' "$$" >"$lock/pid"
  LOCK_HELD=1
}

lock_release() {
  if [ "${LOCK_HELD:-0}" = 1 ]; then
    rm -rf "$STATE_DIR/lock"
    LOCK_HELD=0
  fi
}

# Validators: values end up in templates, so each one is limited to a safe character set.
valid_name() {
  case "$1" in
    machine) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[a-z][a-z0-9-]{0,22}[a-z0-9]$|^[a-z]$'
}

valid_email() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
}

# A bare origin: scheme, host and optional port; no path, query or userinfo.
valid_origin() {
  printf '%s' "$1" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'
}

valid_port() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

is_loopback_origin() {
  printf '%s' "$1" | grep -Eq '^http://(127\.0\.0\.1|\[::1\]|localhost)(:[0-9]+)?$'
}
