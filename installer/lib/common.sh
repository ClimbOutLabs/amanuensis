# shellcheck shell=bash
# Output, prompts, locking and small filesystem helpers shared by every command.

say() { printf '%s\n' "$*"; }
# Warnings and failures use the shared line style on stderr.
warn() { UI_FD=2 ui_warn "$*"; }
die() {
  ui_step_abort
  UI_FD=2 ui_fail "$*"
  exit 1
}
usage_die() {
  ui_step_abort
  UI_FD=2 ui_fail "$*" "install.sh --help"
  exit 2
}

# Only the state directory is written to; never anything that could hold a secret.
log_event() {
  if [ -d "$STATE_DIR" ] && [ "$DRY_RUN" != 1 ]; then
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$STATE_DIR/install.log" 2>/dev/null || true
  fi
}

# ask_valid VAR "label" "default" "hint" CHECK: CHECK prints one sentence about a bad value and nothing for a good one.
# A value from a flag, --yes or --dry-run is checked once and a bad one stops the run, since nobody can answer a prompt.
# Otherwise the question repeats with the reason up to five times; the end of the input stops the run.
ask_valid() {
  local __var=$1 __label=$2 __default=${3:-} __hint=${4:-} __check=$5 __tries=0 __problem __eof=0 __shown_hint=$4
  if [ -n "${!__var:-}" ] || [ "$ASSUME_YES" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    if [ -z "${!__var:-}" ]; then printf -v "$__var" '%s' "$__default"; fi
    __problem=$("$__check" "${!__var}")
    if [ -n "$__problem" ]; then usage_die "$__problem"; fi
    return 0
  fi
  while [ "$__tries" -lt "$UI_MAX_TRIES" ]; do
    ui_prompt "$__var" "$__label" "$__default" "$__shown_hint" || __eof=1
    __problem=$("$__check" "${!__var}")
    if [ -z "$__problem" ]; then return 0; fi
    UI_FD=2 ui_fail "$__problem"
    if [ "$__eof" = 1 ]; then die "The input ended before a valid answer, so nothing was changed."; fi
    __shown_hint=
    __tries=$((__tries + 1))
  done
  die "No valid answer after $UI_MAX_TRIES tries, so nothing was changed. Run install.sh again."
}

# Root-level changes need their own flag or an interactive yes; --yes never grants them.
# consent_root "question" FLAGVALUE
consent_root() {
  [ "$2" = 1 ] && return 0
  [ "$ASSUME_YES" = 1 ] && return 1
  ui_confirm "$1" n
}

# The rules shown above the password question, the way a sign-up form lists them under the field.
password_rules() {
  UI_FD=2 ui_line "Your password needs:"
  UI_FD=2 ui_line "  - At least 8 characters"
  UI_FD=2 ui_line "  - At least one number (0-9)"
  UI_FD=2 ui_line "  - At least one symbol, like @ # \$ % ! -"
  UI_FD=2 ui_line "You can use letters (a-z, A-Z), numbers, symbols and spaces."
}

# One plain sentence naming what the password still lacks, empty when it can be used. bcrypt ignores everything
# past 72 bytes, so a longer one would silently be shortened; bytes, not characters, are counted.
password_problem() {
  local LC_ALL=C missing=()
  if [ "${#1}" -gt 72 ]; then
    echo "The password can have at most 72 characters. Accented or non-Latin letters count as more than one."
    return 0
  fi
  if [ "${#1}" -lt 8 ]; then missing+=("at least 8 characters"); fi
  if [[ $1 != *[[:digit:]]* ]]; then missing+=("a number"); fi
  if [[ $1 != *[[:punct:]]* ]]; then missing+=("a symbol, like @ # \$ %"); fi
  case ${#missing[@]} in
    0) ;;
    1) echo "That password still needs ${missing[0]}." ;;
    2) echo "That password still needs ${missing[0]} and ${missing[1]}." ;;
    *) echo "That password still needs ${missing[0]}, ${missing[1]} and ${missing[2]}." ;;
  esac
}

# The answers given on stdin, one line each, in this fixed order: sign-in password (--password-stdin), Token Factory key
# (--token-factory-key-stdin), calendar app password (--calendar-password-stdin), email app password
# (--email-password-stdin). A line is there only when its option is given. main reads every line here, once, before any
# question, so an answer can never be taken for another one. A dry run reads none of them.
STDIN_SIGNIN_PASSWORD=
STDIN_CAL_PASSWORD=
STDIN_EMAIL_PASSWORD=

stdin_answers_read() {
  local line
  [ "$DRY_RUN" != 1 ] || return 0
  if [ "$PASSWORD_FROM_STDIN" = 1 ]; then IFS= read -r STDIN_SIGNIN_PASSWORD || true; fi
  if [ "$OPT_TF_KEY_STDIN" = 1 ]; then
    line=
    IFS= read -r line || true
    token_factory_key_take "$line"
  fi
  if [ "$OPT_CAL_PASSWORD_STDIN" = 1 ]; then IFS= read -r STDIN_CAL_PASSWORD || true; fi
  if [ "$OPT_EMAIL_PASSWORD_STDIN" = 1 ]; then IFS= read -r STDIN_EMAIL_PASSWORD || true; fi
}

# Reads a password twice without echo into the variable named by $1. The value stays in shell
# memory: it is never put in argv, a file or the environment of a child process. Ending the input
# (Ctrl-D) stops the run. The optional labels replace the two prompts.
ask_password() {
  local __var=$1 __first='' __second='' __problem __tries=0
  local __label_first=${2:-"Enter a password for ${I_EMAIL:-the owner account}"} __label_second=${3:-"Enter password again"}
  if [ "$PASSWORD_FROM_STDIN" = 1 ]; then
    __first=$STDIN_SIGNIN_PASSWORD
    [ -n "$__first" ] || usage_die "The first line of the input was empty, and --password-stdin reads the password from it."
    __problem=$(password_problem "$__first")
    [ -z "$__problem" ] || usage_die "$__problem"
    printf -v "$__var" '%s' "$__first"
    return 0
  fi
  while [ "$__tries" -lt "$UI_MAX_TRIES" ]; do
    if [ -t 0 ]; then
      password_rules
      ui_password __first "$__label_first" || die "No password was entered, so nothing more was changed."
      ui_password __second "$__label_second" || die "No password was entered, so nothing more was changed."
    else
      IFS= read -r __first || die "No password was given on the input."
      IFS= read -r __second || die "The password was not repeated on the input."
    fi
    __problem=$(password_problem "$__first")
    if [ -n "$__problem" ]; then
      UI_FD=2 ui_fail "$__problem"
    elif [ "$__first" != "$__second" ]; then
      UI_FD=2 ui_fail "The passwords do not match. Type them again."
    else
      printf -v "$__var" '%s' "$__first"
      return 0
    fi
    if [ ! -t 0 ]; then
      die "No valid password came from the input, so nothing was changed."
    fi
    __tries=$((__tries + 1))
  done
  die "No valid password after $UI_MAX_TRIES tries, so nothing was changed. Run the command again."
}

# ---- long steps: a spinner line on screen, the tool's own output in a log file ---------------------

STEP_LOG=

# step_begin NAME "Doing the thing": run the command with >"$STEP_LOG" 2>&1, then call step_ok or step_fail.
step_begin() {
  ensure_private_dir "$STATE_DIR/logs"
  STEP_LOG="$STATE_DIR/logs/$1.log"
  : >"$STEP_LOG"
  ui_step_start "$2" "$STEP_LOG"
}

step_ok() { ui_step_end ok "$1"; }

# The last lines of the step's log and where the rest is, for a failure the person cannot see otherwise.
step_log_tail() {
  local line
  if [ -s "$STEP_LOG" ]; then
    {
      ui_hint "Last lines of the log:"
      tail -n 20 "$STEP_LOG" | while IFS= read -r line; do
        printf '    %s\n' "$(_ui_s 2 "${line:0:200}")"
      done
    } >&2
  fi
  UI_FD=2 ui_hint "Full log: $(ui_path "$STEP_LOG")"
}

# step_fail "what failed" "next" [details]: ends the line as a failure, shows the log tail and stops the run.
step_fail() {
  UI_FD=2 ui_step_end fail "$1" "${2:-}" "${3:-}"
  step_log_tail
  exit 1
}

# ---- the app's own reason when one of its commands fails -------------------------------------------

# cli_log NAME: an emptied private file to send a CLI run's error output to; prints its path.
cli_log() {
  ensure_private_dir "$STATE_DIR/logs"
  : >"$STATE_DIR/logs/$1.log"
  printf '%s' "$STATE_DIR/logs/$1.log"
}

# cli_reason LOG FALLBACK: the last plain line the CLI wrote, which is its error (its log lines are JSON and skipped),
# or FALLBACK when it wrote none. Running out of memory ends Node with a stack dump instead, so it is named here.
cli_reason() {
  local line
  if grep -q 'JavaScript heap out of memory' "$1" 2>/dev/null; then
    printf '%s' "Aman ran out of memory. Give Docker more memory, then run this again."
    return 0
  fi
  line=$({ grep -v '^[[:space:]]*{' "$1" 2>/dev/null || true; } | { grep -v '^[[:space:]]*$' || true; } | tail -n 1)
  printf '%s' "${line:-$2}"
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

# The run lock, as installer/STATE.md ("The lock") writes it down. state/lock is a folder made with mkdir,
# which is atomic everywhere. The holder refreshes state/lock/beat every LOCK_BEAT_SECONDS for as long as it
# runs, so a long image build never looks stopped; a lock whose beat is older than LOCK_DEAD_SECONDS belongs to a
# holder that stopped without cleaning up. The pid file is for people: when the home is a Docker volume the holder
# ran in its own container, so its pid means nothing to the next run. The TypeScript installer and the volume
# script follow the same contract, so keep the three in step.
LOCK_BEAT_SECONDS=15
LOCK_DEAD_SECONDS=120

# Seconds since the time written in file $1, or nothing when there is no readable time.
lock_age_of() {
  local when
  when=$(cat "$1" 2>/dev/null || true)
  case $when in '' | *[!0-9]*) return 1 ;; esac
  printf '%s\n' $(($(date +%s) - when))
}

# Whether the folder $1 shows a sign of life in its file $2 within the dead limit. A folder with no time yet
# belongs to a run between mkdir and its first write, so it is given a moment.
lock_is_live() {
  local tries=0 age
  [ -d "$1" ] || return 1
  while [ "$tries" -lt 3 ]; do
    if age=$(lock_age_of "$1/$2"); then
      [ "$age" -lt "$LOCK_DEAD_SECONDS" ]
      return
    fi
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

lock_write_beat() {
  date +%s >"$1/beat.$$" && mv -f "$1/beat.$$" "$1/beat"
}

# A takeover goes through a second folder, state/takeover, made with mkdir like the lock: only the run holding it
# may move a lock folder aside, so two runs that both find a dead lock cannot both move it. Under it the run
# judges the lock again, reads its owner, moves the folder aside with one rename, and checks that what it moved
# still has that owner and a stopped beat; if not, it is a live lock another run made a moment ago, and it goes
# back. A guard left by a crashed run is judged by its own timestamp. After writing its owner the run reads it
# back, and waits a second once in case the folder is being put back.
lock_take_over() {
  local lock=$1 guard="$STATE_DIR/takeover" aside="$STATE_DIR/lock.stale-$LOCK_TOKEN" old_owner age
  lock_is_live "$lock" beat && lock_busy
  if ! mkdir "$guard" 2>/dev/null; then
    lock_is_live "$guard" since && lock_busy
    mv "$guard" "$STATE_DIR/takeover.stale-$LOCK_TOKEN" 2>/dev/null || lock_busy
    mkdir "$guard" 2>/dev/null || lock_busy
    rm -rf "$STATE_DIR/takeover.stale-$LOCK_TOKEN"
  fi
  date +%s >"$guard/since"
  if lock_is_live "$lock" beat; then rm -rf "$guard"; lock_busy; fi
  old_owner=$(cat "$lock/owner" 2>/dev/null || true)
  if [ -d "$lock" ]; then
    if ! mv "$lock" "$aside" 2>/dev/null; then rm -rf "$guard"; lock_busy; fi
    age=$(lock_age_of "$aside/beat" || true)
    if [ "$(cat "$aside/owner" 2>/dev/null || true)" != "$old_owner" ] || { [ -n "$age" ] && [ "$age" -lt "$LOCK_DEAD_SECONDS" ]; }; then
      if [ ! -e "$lock" ]; then mv "$aside" "$lock" 2>/dev/null || true; fi
      rm -rf "$guard"
      lock_busy
    fi
    rm -rf "$aside"
  fi
  if ! mkdir "$lock" 2>/dev/null; then rm -rf "$guard"; lock_busy; fi
  rm -rf "$guard"
}

lock_acquire() {
  local lock="$STATE_DIR/lock"
  ensure_private_dir "$STATE_DIR"
  LOCK_TOKEN="$$-$(date +%s)"
  if ! mkdir "$lock" 2>/dev/null; then lock_take_over "$lock"; fi
  printf '%s\n' "$LOCK_TOKEN" >"$lock/owner"
  lock_write_beat "$lock"
  printf '%s\n' "$$" >"$lock/pid"
  if [ "$(cat "$lock/owner" 2>/dev/null || true)" != "$LOCK_TOKEN" ]; then
    sleep 1
    [ "$(cat "$lock/owner" 2>/dev/null || true)" = "$LOCK_TOKEN" ] || lock_busy
  fi
  LOCK_HELD=1
  lock_beat_start "$lock"
}

lock_busy() {
  die "Another install is running right now. Wait for it to finish, or wait $((LOCK_DEAD_SECONDS / 60)) minutes if you stopped an install a moment ago, then run this again."
}

# The beat stops with the holder, and never touches a lock another run took over.
lock_beat_start() {
  local lock=$1 holder=$$ token=$LOCK_TOKEN
  (
    while sleep "$LOCK_BEAT_SECONDS"; do
      kill -0 "$holder" 2>/dev/null || exit 0
      [ "$(cat "$lock/owner" 2>/dev/null)" = "$token" ] || exit 0
      lock_write_beat "$lock"
    done
  ) </dev/null >/dev/null 2>&1 &
  LOCK_BEAT_PID=$!
}

# Only the run that still owns the lock removes it.
lock_release() {
  if [ "${LOCK_HELD:-0}" = 1 ]; then
    if [ -n "${LOCK_BEAT_PID:-}" ]; then kill "$LOCK_BEAT_PID" 2>/dev/null || true; fi
    if [ "$(cat "$STATE_DIR/lock/owner" 2>/dev/null)" = "$LOCK_TOKEN" ]; then
      rm -rf "$STATE_DIR/lock"
    fi
    LOCK_HELD=0
  fi
}

# Validators: values end up in templates and paths, so each one must match as a whole string. They use
# bash's [[ =~ ]], where ^ and $ anchor the entire value; line-wise tools such as grep would accept a
# value whose second line matches.
has_control_chars() {
  [[ $1 == *[[:cntrl:]]* ]]
}

# Whole-string match of $1 against the extended regex $2, never accepting control characters. Bracket ranges
# follow the locale's collation on macOS (bash 3.2 under a UTF-8 locale: [A-Z] also matches lowercase), so the
# match runs as plain ASCII.
matches_whole() {
  local LC_ALL=C
  has_control_chars "$1" && return 1
  [[ $1 =~ $2 ]]
}

valid_name() {
  [ "$1" != machine ] && matches_whole "$1" '^[a-z]([a-z0-9-]{0,22}[a-z0-9])?$'
}

valid_email() {
  [ "${#1}" -le 254 ] && matches_whole "$1" '^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
}

# The name checks below read ranges such as [A-Z] as plain ASCII, whatever the locale's collation says.
name_has_capitals() { local LC_ALL=C; [[ $1 == *[A-Z]* ]]; }
name_starts_with_letter() { local LC_ALL=C; [[ $1 == [a-z]* ]]; }
# What is left of $1 once the allowed characters are removed, so the caller can show the first one.
name_other_chars() { local LC_ALL=C; printf '%s' "${1//[a-z0-9-]/}"; }

# The reason a value is refused, or nothing when it is fine. The prompts show it and ask again.
NAME_RULE="Use 1 to 24 lowercase letters, numbers or hyphens, starting with a letter."
name_problem() {
  local v=$1 rest
  if [ -z "$v" ]; then
    echo "A name is needed. $NAME_RULE"
  elif [ "$v" = machine ]; then
    echo "\"machine\" is kept for Aman's own use. Pick another name."
  elif has_control_chars "$v"; then
    echo "The name has a control character. $NAME_RULE"
  elif [[ $v == *_* ]]; then
    echo "\"$v\" has an underscore. $NAME_RULE"
  elif [[ $v == *[[:space:]]* ]]; then
    echo "\"$v\" has a space. $NAME_RULE"
  elif name_has_capitals "$v"; then
    echo "\"$v\" has capital letters. $NAME_RULE"
  elif ! name_starts_with_letter "$v"; then
    echo "\"$v\" does not start with a letter. $NAME_RULE"
  elif rest=$(name_other_chars "$v") && [ -n "$rest" ]; then
    echo "\"$v\" has the character ${rest:0:1}. $NAME_RULE"
  elif [ "${#v}" -gt 24 ]; then
    echo "\"$v\" is longer than 24 characters. $NAME_RULE"
  elif [[ $v == *- ]]; then
    echo "\"$v\" ends with a hyphen. End it with a letter or a number."
  # Instance "x-slots" runs as project aman-x-slots, which is the sandbox project of instance "aman-x".
  elif [[ $v == *-slots ]]; then
    echo "\"$v\" must not end with -slots; that ending is used for the run-code sandbox of another instance."
  elif ! valid_name "$v"; then
    echo "\"$v\" cannot be used as a name. $NAME_RULE"
  fi
}

email_problem() {
  if [ -z "$1" ]; then
    echo "An email address is needed; write it like you@example.com."
  elif ! valid_email "$1"; then
    echo "\"$1\" is not an email address; write it like you@example.com."
  fi
}

# A bare origin: scheme, host and optional port; no path, query or userinfo.
valid_origin() {
  matches_whole "$1" '^https?://[A-Za-z0-9.-]+(:[[:digit:]]{1,5})?$'
}

valid_port() {
  matches_whole "$1" '^[[:digit:]]{1,5}$' || return 1
  [ "$((10#$1))" -ge 1024 ] && [ "$((10#$1))" -le 65535 ]
}

# The state folder goes into shell profiles and scheduled jobs, so it must be an absolute path of plain characters.
valid_home_path() {
  matches_whole "$1" '^/[A-Za-z0-9._/+@:=,-]*$' && case "$1" in *..* | *//*) return 1 ;; esac
}

is_loopback_origin() {
  matches_whole "$1" '^http://(127\.0\.0\.1|\[::1\]|localhost)(:[[:digit:]]+)?$'
}
