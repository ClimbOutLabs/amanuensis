# shellcheck shell=bash
# Terminal output style shared by the installer and the doctor shim. One symbol and one sentence per line.
# Human lines go to the stream in UI_FD (stdout unless a caller sets 2); prompts and progress always use stderr.
# Color goes on markers, status words and verdicts only. Bash 3.2 compatible; nothing here needs tput.
# The Node twin is packages/trueforge/scripts/lib/ui.ts; installer/tests/ui-fixtures.txt pins both.

UI_FD=1
UI_UTF8=0
UI_COLOR_1=0
UI_COLOR_2=0
UI_ANIM=0
UI_WIDTH=72
UI_VERBOSE=${UI_VERBOSE:-0}
UI_ASSUME_YES=${UI_ASSUME_YES:-0}
UI_WARNS=
UI_STEP_PID=
UI_STEP_T0=0
UI_STATUS_WIDTH=11
UI_MAX_TRIES=5
UI_FRAMES=('|' '/' '-' '\')
S_OK=+ S_WARN=! S_FAIL=x S_PROMPT=">" S_SKIP=- S_RULE=-

# Decides symbols, color and width once. Color needs a terminal and no NO_COLOR; CLICOLOR_FORCE=1 is for tests.
ui_init() {
  local loc=${LC_ALL:-} term=${TERM:-} cols=
  if [ -z "$loc" ]; then loc=${LC_CTYPE:-}; fi
  if [ -z "$loc" ]; then loc=${LANG:-}; fi
  loc=$(printf '%s' "$loc" | tr '[:upper:]' '[:lower:]')
  UI_UTF8=0
  case "$loc" in *utf-8* | *utf8*) UI_UTF8=1 ;; esac
  if [ "$term" = dumb ]; then UI_UTF8=0; fi
  UI_COLOR_1=0
  UI_COLOR_2=0
  if [ -z "${NO_COLOR:-}" ] && [ "$term" != dumb ]; then
    if [ "${CLICOLOR_FORCE:-}" = 1 ]; then
      UI_COLOR_1=1
      UI_COLOR_2=1
    else
      if [ -t 1 ]; then UI_COLOR_1=1; fi
      if [ -t 2 ]; then UI_COLOR_2=1; fi
    fi
  fi
  UI_ANIM=0
  if [ -t 2 ] && [ "$term" != dumb ]; then UI_ANIM=1; fi
  UI_WIDTH=72
  if [ -t 2 ]; then
    cols=${COLUMNS:-}
    case "$cols" in
      '' | *[!0-9]*)
        cols=
        if command -v stty >/dev/null 2>&1; then cols=$(stty size <&2 2>/dev/null | awk '{print $2}'); fi
        ;;
    esac
    case "$cols" in
      '' | *[!0-9]*) ;;
      *) if [ "$cols" -lt "$UI_WIDTH" ]; then UI_WIDTH=$cols; fi ;;
    esac
    if [ "$UI_WIDTH" -lt 40 ]; then UI_WIDTH=40; fi
  fi
  if [ "$UI_UTF8" = 1 ]; then
    S_OK=✓ S_WARN=! S_FAIL=✗ S_PROMPT=› S_SKIP=· S_RULE=─
    UI_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧)
  else
    S_OK=+ S_WARN=! S_FAIL=x S_PROMPT=">" S_SKIP=- S_RULE=-
    UI_FRAMES=('|' '/' '-' '\')
  fi
}

# ---- low level ------------------------------------------------------------------------------------

# Text in an SGR style, only when the current stream takes color.
_ui_s() {
  local on=$UI_COLOR_1
  if [ "$UI_FD" = 2 ]; then on=$UI_COLOR_2; fi
  if [ "$on" = 1 ]; then
    printf '\033[%sm%s\033[0m' "$1" "$2"
  else
    printf '%s' "$2"
  fi
}

_ui_out() { printf '%s\n' "$1" >&"$UI_FD"; }

# Prints one wrapped block. LEAD is the already styled start of the first line (LW visible columns); later lines are
# indented by LW. CODE styles the text of every line; TAIL (already styled) ends the last line. Words are never split,
# so a URL or a path stays whole. _ui_put reads the locals of this function on purpose.
_ui_block() {
  local lead=$1 lw=$2 text=$3 code=${4:-} tail=${5:-} avail cur='' prev='' have_prev=0 word first=1 oldf=$-
  avail=$((UI_WIDTH - lw))
  if [ "$avail" -lt 20 ]; then avail=20; fi
  set -f
  for word in $text; do
    if [ -z "$cur" ]; then
      cur=$word
    elif [ $((${#cur} + 1 + ${#word})) -le "$avail" ]; then
      cur="$cur $word"
    else
      if [ "$have_prev" = 1 ]; then _ui_put "$prev" 0; fi
      prev=$cur
      have_prev=1
      cur=$word
    fi
  done
  case "$oldf" in *f*) ;; *) set +f ;; esac
  if [ "$have_prev" = 1 ]; then _ui_put "$prev" 0; fi
  _ui_put "$cur" 1
}

_ui_put() {
  local body=$1 prefix
  if [ -n "$code" ] && [ -n "$body" ]; then body=$(_ui_s "$code" "$body"); fi
  if [ "$2" = 1 ] && [ -n "$tail" ]; then body="$body$tail"; fi
  if [ "$first" = 1 ]; then
    prefix=$lead
    first=0
  else
    prefix=$(printf '%*s' "$lw" '')
  fi
  _ui_out "$prefix$body"
}

# A marker line: "  X " then the text. COLOR styles the marker only.
_ui_marked() { # color marker text [tail]
  _ui_block "  $(_ui_s "$1" "$2") " 4 "$3" '' "${4:-}"
}

ui_path() {
  case "$1" in
    "${HOME:-/nonexistent}") printf '~' ;;
    "${HOME:-/nonexistent}"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# 9s, 2m 05s, 1h 02m
ui_fmt_elapsed() {
  local s=$1
  if [ "$s" -ge 3600 ]; then
    printf '%dh %02dm' $((s / 3600)) $((s % 3600 / 60))
  elif [ "$s" -ge 60 ]; then
    printf '%dm %02ds' $((s / 60)) $((s % 60))
  else
    printf '%ds' "$s"
  fi
}

# Elapsed time worth showing; a few seconds is noise and would make logs differ between runs.
_ui_elapsed_since() {
  local n=$((SECONDS - $1))
  if [ "$n" -ge 5 ]; then ui_fmt_elapsed "$n"; fi
}

# ---- lines ----------------------------------------------------------------------------------------

ui_title() { _ui_out "$(_ui_s 1 "$1")"; }

ui_phase() { # text [n total]
  local line
  _ui_out ""
  line=$(_ui_s 1 "$1")
  if [ -n "${2:-}" ]; then line="$line $(_ui_s 2 "($2 of $3)")"; fi
  _ui_out "$line"
}

ui_ok() { # text [elapsed]
  local tail=
  if [ -n "${2:-}" ]; then tail="  $(_ui_s 2 "$2")"; fi
  _ui_marked 32 "$S_OK" "$1" "$tail"
}

# Warnings are remembered so the closing block can repeat them.
ui_warn() { # text [next] [details]
  UI_WARNS="$UI_WARNS$1"$'\n'
  _ui_marked 33 "$S_WARN" "$1"
  _ui_follow "${2:-}" "${3:-}"
}

ui_fail() { # text [next] [details]
  _ui_marked 31 "$S_FAIL" "$1"
  _ui_follow "${2:-}" "${3:-}"
}

# The Next: and Details: lines under a warning or a failure. Technical details wait for --verbose.
_ui_follow() {
  if [ -n "$1" ]; then _ui_block "    Next: " 10 "$1"; fi
  if [ -n "$2" ]; then
    if [ "$UI_VERBOSE" = 1 ]; then
      _ui_block "    $(_ui_s 2 'Details:') " 13 "$2" 2
    else
      _ui_block "    $(_ui_s 2 'Details:') " 13 "--verbose" 2
    fi
  fi
}

ui_skip() { _ui_block "  $S_SKIP " 4 "$1" 2; }

ui_hint() { _ui_block "  " 2 "$1" 2; }

# Plain indented text, for lists under a heading.
ui_line() { _ui_block "  " 2 "$1"; }

ui_heading() { # blank line, then a bold word
  _ui_out ""
  _ui_out "$(_ui_s 1 "$1")"
}

ui_row() { # label value
  _ui_block "  $(printf '%-8s' "$1")  " 12 "$2"
}

ui_rule() {
  local line
  line=$(printf '%*s' "$UI_WIDTH" '')
  _ui_out "$(_ui_s 2 "${line// /$S_RULE}")"
}

ui_newline() { _ui_out ""; }

# Plan rows: marker, status word and text; the color is on the marker and the word only.
_ui_status() { # color marker word text
  local pad
  pad=$(printf '%*s' $((UI_STATUS_WIDTH - ${#3} + 2)) '')
  _ui_block "  $(_ui_s "$1" "$2") $(_ui_s "$1" "$3")$pad" $((UI_STATUS_WIDTH + 6)) "$4"
}

ui_done() { _ui_status 32 "$S_OK" "done" "$1"; }
ui_todo() { _ui_status 36 "$S_PROMPT" "to do" "$1"; }
ui_admin() { _ui_status 33 "$S_WARN" "needs admin" "$1"; }

# Dim detail lines under a plan row, in the text column.
ui_detail() { _ui_block "$(printf '%*s' $((UI_STATUS_WIDTH + 6)) '')" $((UI_STATUS_WIDTH + 6)) "$1" 2; }

# A framed closing block: rule, the verdict, then whatever the caller prints, then ui_summary_end.
ui_summary() { # ok|warn|fail verdict
  local code=1
  case "$1" in
    ok) code="1;32" ;;
    warn) code="1;33" ;;
    fail) code="1;31" ;;
  esac
  _ui_out ""
  ui_rule
  _ui_block "" 0 "$2" "$code"
  _ui_out ""
}

ui_summary_end() { # [total elapsed]
  local w
  if [ -n "$UI_WARNS" ]; then
    ui_heading "Warnings"
    while IFS= read -r w; do
      if [ -n "$w" ]; then _ui_marked 33 "$S_WARN" "$w"; fi
    done <<<"$UI_WARNS"
  fi
  if [ -n "${1:-}" ]; then
    _ui_out ""
    _ui_out "$(_ui_s 2 "Done in $1")"
  fi
  ui_rule
}

# ---- prompts (stderr) -----------------------------------------------------------------------------

# "  > Label [default] " without a newline.
ui_prompt_head() { # label [default]
  local UI_FD=2 line
  line="  $(_ui_s 1 "$S_PROMPT") $1"
  if [ -n "${2:-}" ]; then line="$line $(_ui_s 2 "[$2]")"; fi
  printf '%s ' "$line" >&2
}

# ui_prompt VAR label default [hint]: one line from stdin; Enter keeps the default. Returns 1 at the end of the input.
ui_prompt() {
  local __var=$1 __answer= __rc=0 UI_FD=2
  if [ -n "${4:-}" ]; then ui_hint "$4"; fi
  ui_prompt_head "$2" "${3:-}"
  IFS= read -r __answer || __rc=1
  if [ "$__rc" = 1 ]; then printf '\n' >&2; fi
  if [ -z "$__answer" ]; then __answer=${3:-}; fi
  printf -v "$__var" '%s' "$__answer"
  return "$__rc"
}

# Yes or no with the default capitalised. Returns 0 on yes. A root or delete question passes n; --yes takes the
# default and says so. The end of the input counts as no.
ui_confirm() { # question y|n
  local def=${2:-n} hint answer= tries=0 UI_FD=2
  if [ "$def" = y ]; then hint="Y/n"; else hint="y/N"; fi
  if [ "$UI_ASSUME_YES" = 1 ]; then
    ui_prompt_head "$1 [$hint]"
    if [ "$def" = y ]; then
      printf 'yes (--yes)\n' >&2
      return 0
    fi
    printf 'no (--yes)\n' >&2
    return 1
  fi
  while [ "$tries" -lt "$UI_MAX_TRIES" ]; do
    ui_prompt_head "$1 [$hint]"
    answer=
    if ! IFS= read -r answer; then
      printf '\n' >&2
      return 1
    fi
    case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
      y | yes) return 0 ;;
      n | no) return 1 ;;
      '') [ "$def" = y ] && return 0 || return 1 ;;
    esac
    tries=$((tries + 1))
    ui_fail "Please answer yes or no."
  done
  return 1
}

# Reads a secret without echo into VAR. Returns 1 at the end of the input.
ui_password() { # VAR label
  local __value= __rc=0 UI_FD=2
  ui_prompt_head "$2 (not shown)"
  IFS= read -rs __value || __rc=1
  printf '\n' >&2
  printf -v "$1" '%s' "$__value"
  return "$__rc"
}

# ---- long steps -----------------------------------------------------------------------------------

# One progress line while a long step runs: a spinner with the elapsed time on a terminal, a start line and a
# "still working" line every minute elsewhere. The tool's own output belongs in LOG, not on the screen.
ui_step_start() { # text [log file]
  local text=$1 log=${2:-} t0=$SECONDS note=''
  UI_STEP_T0=$t0
  if [ -n "$log" ]; then note="log: $(ui_path "$log")"; fi
  if [ "$UI_ANIM" = 1 ]; then
    (
      i=0
      n=${#UI_FRAMES[@]}
      shown=0
      while :; do
        line="  ${UI_FRAMES[$((i % n))]} $text  $(ui_fmt_elapsed $((SECONDS - t0)))"
        if [ -n "$note" ] && [ $((${#line} + 3 + ${#note})) -lt "$UI_WIDTH" ]; then line="$line   $note"; fi
        printf '\r%*s\r%s' "$shown" '' "$line" >&2
        shown=${#line}
        i=$((i + 1))
        sleep 0.2 </dev/null >/dev/null 2>&1 || sleep 1 </dev/null >/dev/null 2>&1
      done
    ) &
    UI_STEP_PID=$!
  else
    if [ -n "$note" ]; then text="$text  $note"; fi
    UI_FD=2 _ui_marked 36 "$S_PROMPT" "$text"
    (
      UI_FD=2
      ticks=0
      while :; do
        s=0
        while [ "$s" -lt 60 ]; do
          sleep 1 </dev/null >/dev/null 2>&1
          s=$((s + 1))
        done
        ticks=$((ticks + 1))
        _ui_block "    " 4 "still working, ${ticks}m" 2
      done
    ) &
    UI_STEP_PID=$!
  fi
}

# Stops the progress line without printing a result; safe to call when none runs.
ui_step_abort() {
  if [ -n "$UI_STEP_PID" ]; then
    kill "$UI_STEP_PID" 2>/dev/null || true
    wait "$UI_STEP_PID" 2>/dev/null || true
    UI_STEP_PID=
    if [ "$UI_ANIM" = 1 ]; then printf '\r%*s\r' "$UI_WIDTH" '' >&2; fi
  fi
}

# ui_step_end ok|fail text [next] [details]: the progress line becomes a normal result line.
ui_step_end() {
  local status=$1 text=$2
  ui_step_abort
  if [ "$status" = ok ]; then
    ui_ok "$text" "$(_ui_elapsed_since "$UI_STEP_T0")"
  else
    ui_fail "$text" "${3:-}" "${4:-}"
  fi
}
