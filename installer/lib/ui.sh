# shellcheck shell=bash
# Terminal output style shared by the installer and the doctor shim. One symbol and one sentence per line.
# Human lines go to the stream in UI_FD (stdout unless a caller sets 2); prompts and progress always use stderr.
# Color goes on markers, status words and verdicts only. Bash 3.2 compatible; nothing here needs tput.

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
UI_FRAMES=("|" "/" "-" "\\")
UI_ASKING=0
UI_IN_PROMPT=0
UI_LAST_BLANK=1
UI_SUMMARY_CODE=1
# UI_FULL is the width of the screen block; UI_WIDTH is what text may take, 4 columns less inside a panel.
UI_FULL=72
UI_PANEL=0
# The stream the panel was opened on, so it closes and opens again there even when a question writes to stderr.
UI_PANEL_FD=1
UI_PANEL_RESUME=0
UI_PENDING_BLANK=0
# Set in a command this run starts while a panel is open (the doctor's summary, the sandbox setup), so its lines join
# that panel instead of opening their own.
UI_FRAMED=0
S_OK=+ S_WARN=! S_FAIL=x S_PROMPT=">" S_SKIP=- S_RULE=- S_ELL=... S_ARROW="->"
S_TL=+ S_TR=+ S_BL=+ S_BR=+ S_H=- S_V="|" S_BAR_ON="#" S_BAR_OFF=-

# Decides symbols, color and width once. Color needs a terminal and no NO_COLOR; CLICOLOR_FORCE=1 is for tests.
ui_init() {
  local loc=${LC_ALL:-} term=${TERM:-} cols=
  if [ -z "$loc" ]; then loc=${LC_CTYPE:-}; fi
  if [ -z "$loc" ]; then loc=${LANG:-}; fi
  loc=$(printf '%s' "$loc" | LC_ALL=C tr '[:upper:]' '[:lower:]')
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
      '' | *[![:digit:]]*)
        cols=
        if command -v stty >/dev/null 2>&1; then cols=$(stty size <&2 2>/dev/null | awk '{print $2}'); fi
        ;;
    esac
    case "$cols" in
      '' | *[![:digit:]]*) ;;
      *) if [ "$cols" -lt "$UI_WIDTH" ]; then UI_WIDTH=$cols; fi ;;
    esac
    if [ "$UI_WIDTH" -lt 40 ]; then UI_WIDTH=40; fi
  fi
  UI_FULL=$UI_WIDTH
  UI_PANEL=0
  UI_PANEL_RESUME=0
  UI_PENDING_BLANK=0
  UI_FRAMED=0
  if [ "${AMAN_UI_FRAMED:-}" = 1 ]; then
    UI_FRAMED=1
    UI_WIDTH=$((UI_FULL - 4))
  fi
  if [ "$UI_UTF8" = 1 ]; then
    S_OK=✓ S_WARN=! S_FAIL=✗ S_PROMPT=› S_SKIP=· S_RULE=─ S_ELL=… S_ARROW=→
    S_TL=╭ S_TR=╮ S_BL=╰ S_BR=╯ S_H=─ S_V=│ S_BAR_ON=━ S_BAR_OFF=─
    UI_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧)
  else
    S_OK=+ S_WARN=! S_FAIL=x S_PROMPT=">" S_SKIP=- S_RULE=- S_ELL=... S_ARROW="->"
    S_TL=+ S_TR=+ S_BL=+ S_BR=+ S_H=- S_V="|" S_BAR_ON="#" S_BAR_OFF=-
    UI_FRAMES=("|" "/" "-" "\\")
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

# Any line that is not part of a question ends the question block, so the next question gets its separator again,
# and reopens the panel the questions closed. Inside a panel a line gets the panel's sides, and a blank line waits for
# the next line, so a panel never ends on an empty row.
_ui_out() {
  if [ "$UI_IN_PROMPT" != 1 ]; then
    UI_ASKING=0
    if [ "$UI_PANEL_RESUME" = 1 ]; then
      UI_PANEL_RESUME=0
      UI_FD=$UI_PANEL_FD _ui_gap
      UI_FD=$UI_PANEL_FD _ui_panel_open ""
    fi
  fi
  if [ "$UI_PANEL" = 1 ] || [ "$UI_FRAMED" = 1 ]; then
    UI_LAST_BLANK=1
    if [ -z "$1" ]; then
      UI_PENDING_BLANK=1
      return 0
    fi
    if [ "$UI_PENDING_BLANK" = 1 ]; then _ui_raw "$(_ui_framed "")"; fi
    UI_PENDING_BLANK=0
    UI_LAST_BLANK=0
    _ui_raw "$(_ui_framed "$1")"
    return 0
  fi
  if [ -z "$1" ]; then UI_LAST_BLANK=1; else UI_LAST_BLANK=0; fi
  _ui_raw "$1"
}

_ui_raw() { printf '%s\n' "$1" >&"$UI_FD"; }

# A line between the two sides of a panel. A line too long for it (a word that cannot break, such as a fingerprint)
# keeps only the left side, so the word stays whole for copying.
_ui_framed() { # line
  local pad=$((UI_FULL - 4 - $(_ui_width "$1")))
  if [ "$pad" -lt 0 ]; then
    printf '%s %s' "$(_ui_s 2 "$S_V")" "$1"
    return 0
  fi
  printf '%s %s%*s %s' "$(_ui_s 2 "$S_V")" "$1" "$pad" '' "$(_ui_s 2 "$S_V")"
}

# Opens a panel: a top line with LEFT (already styled) after the corner and RIGHT before the other corner.
_ui_panel_open() { # left [right]
  local left=${1:-} right=${2:-} head tail fill
  _ui_panel_close
  if [ -n "$left" ]; then head="$(_ui_s 2 "$S_TL$S_H") $left "; else head=$(_ui_s 2 "$S_TL"); fi
  if [ -n "$right" ]; then tail=" $right $(_ui_s 2 "$S_H$S_TR")"; else tail=$(_ui_s 2 "$S_TR"); fi
  fill=$((UI_FULL - $(_ui_width "$head") - $(_ui_width "$tail")))
  if [ "$fill" -lt 1 ] && [ -n "$right" ]; then
    tail=$(_ui_s 2 "$S_TR")
    fill=$((UI_FULL - $(_ui_width "$head") - 1))
  fi
  if [ "$fill" -lt 0 ]; then fill=0; fi
  _ui_raw "$head$(_ui_s 2 "$(_ui_repeat "$S_H" "$fill")")$tail"
  UI_PANEL=1
  UI_PANEL_FD=$UI_FD
  UI_WIDTH=$((UI_FULL - 4))
  UI_LAST_BLANK=1
  UI_PENDING_BLANK=0
  export AMAN_UI_FRAMED=1
}

# Closes the open panel with its bottom line; does nothing when none is open.
_ui_panel_close() {
  UI_PANEL_RESUME=0
  [ "$UI_PANEL" = 1 ] || return 0
  UI_PANEL=0
  UI_PENDING_BLANK=0
  UI_WIDTH=$UI_FULL
  unset AMAN_UI_FRAMED
  UI_FD=$UI_PANEL_FD _ui_raw "$(UI_FD=$UI_PANEL_FD _ui_s 2 "$S_BL$(_ui_repeat "$S_H" $((UI_FULL - 2)))$S_BR")"
  UI_LAST_BLANK=0
}

# Ends the step panel, for a run that stops without its closing block.
ui_panel_end() { _ui_panel_close; }

# One blank line between blocks, never two.
_ui_gap() {
  if [ "$UI_LAST_BLANK" != 1 ]; then _ui_out ""; fi
}

# Columns a line takes on screen: SGR codes take none and a UTF-8 character takes one, whatever the locale says.
_ui_width() {
  local s=$1 LC_ALL=C csi=$'\033[' head rest
  while [[ $s == *"$csi"* ]]; do
    head=${s%%"$csi"*}
    rest=${s#*"$csi"}
    s=$head${rest#*m}
  done
  s=${s//[$'\x80'-$'\xbf']/}
  printf '%s' "${#s}"
}

# N copies of a string.
_ui_repeat() { # string n
  local out='' i=0
  while [ "$i" -lt "$2" ]; do
    out=$out$1
    i=$((i + 1))
  done
  printf '%s' "$out"
}

# LEFT, then RIGHT pushed to the right edge; RIGHT is dropped when the two do not fit on one line.
_ui_spread() { # left right
  local gap
  gap=$((UI_WIDTH - $(_ui_width "$1") - $(_ui_width "$2")))
  if [ -z "$2" ] || [ "$gap" -lt 2 ]; then
    printf '%s' "$1"
  else
    printf '%s%*s%s' "$1" "$gap" '' "$2"
  fi
}

# A label that stands out: inverted colors on a terminal, brackets everywhere else.
_ui_badge() { # code text
  if _ui_color_on; then
    _ui_s "7;$1" " $2 "
  else
    printf '[ %s ]' "$2"
  fi
}

_ui_color_on() {
  if [ "$UI_FD" = 2 ]; then [ "$UI_COLOR_2" = 1 ]; else [ "$UI_COLOR_1" = 1 ]; fi
}

# A box around short lines of text, as wide as the screen. CODE colors the frame; the lines keep their own styles.
_ui_box() { # code line...
  local code=$1 line pad inner=$((UI_FULL - 4))
  shift
  _ui_out "$(_ui_s "$code" "$S_TL$(_ui_repeat "$S_H" $((UI_FULL - 2)))$S_TR")"
  for line in "$@"; do
    pad=$((inner - $(_ui_width "$line")))
    if [ "$pad" -lt 0 ]; then pad=0; fi
    _ui_out "$(_ui_s "$code" "$S_V") $line$(printf '%*s' "$pad" '') $(_ui_s "$code" "$S_V")"
  done
  _ui_out "$(_ui_s "$code" "$S_BL$(_ui_repeat "$S_H" $((UI_FULL - 2)))$S_BR")"
}

# Words wrapped to WIDTH columns, one line per output line.
_ui_wrap() { # width text
  local cur='' word oldf=$-
  set -f
  for word in $2; do
    if [ -z "$cur" ]; then
      cur=$word
    elif [ $((${#cur} + 1 + ${#word})) -le "$1" ]; then
      cur="$cur $word"
    else
      printf '%s\n' "$cur"
      cur=$word
    fi
  done
  case "$oldf" in *f*) ;; *) set +f ;; esac
  printf '%s\n' "$cur"
}

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

# The banner at the top of a run: the name in bold color, then what the run does, in a box.
ui_title() { # text [name]
  local name=${2:-AMAN} line first=1
  _ui_panel_close
  while IFS= read -r line; do
    if [ "$first" = 1 ]; then
      set -- "$(_ui_s "1;36" "$name")  $line"
      first=0
    else
      set -- "$@" "$(printf '%*s' $((${#name} + 2)) '')$line"
    fi
  done < <(_ui_wrap $((UI_FULL - 6 - ${#name})) "$1")
  _ui_box 36 "$@"
}

# A step of a run, in a panel of its own: "1 of 6" as a badge and the step in bold in the panel's top line, and how far
# the run has come as a bar at its right end.
ui_phase() { # text [n total]
  local line bar='' off
  if [ -z "${2:-}" ]; then
    line=$(_ui_badge 36 "$1")
  else
    line="$(_ui_badge 36 "$2 of $3")  $(_ui_s 1 "$1")"
    # With color the part still to come is the same thick line, dimmed; without color it has to be a different
    # character.
    off=$S_BAR_OFF
    if _ui_color_on; then off=$S_BAR_ON; fi
    bar="$(_ui_s 32 "$(_ui_repeat "$S_BAR_ON" $((2 * $2)))")$(_ui_s 2 "$(_ui_repeat "$off" $((2 * ($3 - $2))))")"
  fi
  _ui_open_part "$line" "$bar"
}

# A part of a report, in a panel of its own: its name as a badge and, at the right end, a short count of what was found.
ui_section() { # text [counts]
  _ui_open_part "$(_ui_badge 36 "$1")" "${2:-}"
}

# A panel for a step or a part; inside another command's panel, a heading line, since panels do not nest.
_ui_open_part() { # left right
  if [ "$UI_FRAMED" = 1 ]; then
    _ui_gap
    _ui_out "$(_ui_spread "$1" "$2")"
    return 0
  fi
  _ui_panel_close
  _ui_gap
  _ui_panel_open "$1" "$2"
}

# The elapsed time sits at the right edge when the line has room, so the times of a step line up.
ui_ok() { # text [elapsed]
  local plain
  if [ -n "${2:-}" ]; then
    plain="  $S_OK $1"
    if [ $(($(_ui_width "$plain") + 2 + ${#2})) -le "$UI_WIDTH" ]; then
      _ui_out "$(_ui_spread "  $(_ui_s 32 "$S_OK") $1" "$(_ui_s 2 "$2")")"
      return 0
    fi
    _ui_marked 32 "$S_OK" "$1" "  $(_ui_s 2 "$2")"
    return 0
  fi
  _ui_marked 32 "$S_OK" "$1"
}

# Warnings are remembered so the closing block can repeat them.
ui_warn() { # text [next] [details]
  UI_WARNS="$UI_WARNS$1"$'\n'
  _ui_marked 33 "$S_WARN" "$1"
  _ui_follow "${2:-}" "${3:-}"
}

# A warning shown a second time, in a closing list, so it is not remembered again.
ui_warn_again() { # text [next]
  _ui_marked 33 "$S_WARN" "$1"
  _ui_follow "${2:-}" ""
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

# A command to copy, on a line of its own and never wrapped, so it pastes whole however narrow the terminal is.
ui_command() { _ui_out "    $(_ui_s 1 "$1")"; }

# Lines of plain text from the older output helpers, kept inside the open panel: each line's leading spaces stay as
# its indent.
ui_say() { # text
  local text lead
  while IFS= read -r text; do
    lead="  ${text%%[! ]*}"
    _ui_block "$lead" "${#lead}" "${text#"${lead#  }"}"
  done <<<"$1"
}

# Plain indented text, for lists under a heading.
ui_line() { _ui_block "  " 2 "$1"; }

ui_heading() { # blank line, then a bold word
  _ui_gap
  _ui_out "$(_ui_s 1 "$1")"
}

ui_row() { # label value
  _ui_block "  $(printf '%-8s' "$1")  " 12 "$2"
}

# A row of the closing table: a marker (ok, todo, warn or skip for something left off), the label and the value.
ui_check_row() { # ok|todo|warn|skip label value
  local color=32 marker=$S_OK
  case "$1" in
    skip)
      color=2
      marker=$S_SKIP
      ;;
    todo)
      color=36
      marker=$S_PROMPT
      ;;
    warn)
      color=33
      marker=$S_WARN
      ;;
  esac
  _ui_block "  $(_ui_s "$color" "$marker") $(printf '%-8s' "$2")  " 14 "$3"
}

# Another value under the label of the row above.
ui_check_more() { # value
  _ui_block "$(printf '%14s' '')" 14 "$1"
}

ui_rule() {
  local line
  line=$(printf '%*s' "$UI_WIDTH" '')
  _ui_out "$(_ui_s 2 "${line// /$S_RULE}")"
}

ui_newline() { _ui_out ""; }

# A blank line unless the last line was already blank.
ui_gap() { _ui_gap; }

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

# The closing block: the verdict in a box colored by how the run went, then whatever the caller prints, then
# ui_summary_end. Only the verdict is boxed, so the addresses and commands under it copy cleanly.
ui_summary() { # ok|warn|fail verdict
  local code=1 marker=$S_OK line first=1
  case "$1" in
    ok) code=32 ;;
    warn)
      code=33
      marker=$S_WARN
      ;;
    fail)
      code=31
      marker=$S_FAIL
      ;;
  esac
  UI_SUMMARY_CODE=$code
  _ui_panel_close
  while IFS= read -r line; do
    if [ "$first" = 1 ]; then
      set -- "$(_ui_s "1;$code" "$marker $line")"
      first=0
    else
      set -- "$@" "  $(_ui_s "1;$code" "$line")"
    fi
  done < <(_ui_wrap $((UI_FULL - 6)) "$2")
  _ui_gap
  _ui_box "$code" "$@"
  _ui_out ""
}

# The warnings of the run again, then a closing rule in the verdict's color with the total time at its end.
ui_summary_end() { # [total elapsed]
  local w end
  _ui_panel_close
  if [ -n "$UI_WARNS" ]; then
    _ui_gap
    _ui_out "$(_ui_s "1;33" "Warnings")"
    while IFS= read -r w; do
      if [ -n "$w" ]; then _ui_marked 33 "$S_WARN" "$w"; fi
    done <<<"$UI_WARNS"
  fi
  _ui_gap
  if [ -z "${1:-}" ]; then
    _ui_out "$(_ui_s "$UI_SUMMARY_CODE" "$(_ui_repeat "$S_RULE" "$UI_FULL")")"
    return 0
  fi
  end=" Done in $1 "
  _ui_out "$(_ui_s "$UI_SUMMARY_CODE" "$(_ui_repeat "$S_RULE" $((UI_FULL - ${#end} - 2)))")$(_ui_s 2 "$end")$(_ui_s "$UI_SUMMARY_CODE" "$S_RULE$S_RULE")"
}

# ---- prompts (stderr) -----------------------------------------------------------------------------

# A separator line before a question, so the moment the run waits for a person stands out. Questions in a row share
# one; any other line in between ends the group, and the next question gets its own separator. Questions stand
# outside the step's panel, which reopens after them.
ui_ask_begin() {
  local UI_FD=2 label="Your answer is needed"
  if [ "$UI_ASKING" = 1 ]; then return 0; fi
  if [ "$UI_PANEL" = 1 ]; then
    _ui_panel_close
    UI_PANEL_RESUME=1
  fi
  _ui_gap
  _ui_out "$(_ui_s "1;36" "$S_PROMPT $label") $(_ui_s 2 "$(_ui_repeat "$S_RULE" $((UI_WIDTH - ${#label} - 3)))")"
  UI_ASKING=1
}

# "  > Label [default] " without a newline. A label ending in a colon keeps the colon after the default.
ui_prompt_head() { # label [default]
  local UI_FD=2 line label=$1 colon=''
  if [ -n "${2:-}" ] && [[ $label == *: ]]; then
    label=${label%:}
    colon=:
  fi
  line="  $(_ui_s 1 "$S_PROMPT") $label"
  if [ -n "${2:-}" ]; then line="$line $(_ui_s 2 "[$2]")$colon"; fi
  printf '%s ' "$line" >&2
}

# ui_prompt VAR label default [hint]: one line from stdin; Enter keeps the default. Returns 1 at the end of the input.
ui_prompt() {
  local __var=$1 __answer='' __rc=0 UI_FD=2 UI_IN_PROMPT=1
  ui_ask_begin
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
  local def=${2:-n} hint answer='' tries=0 UI_FD=2 UI_IN_PROMPT=1
  ui_ask_begin
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
    case "$(printf '%s' "$answer" | LC_ALL=C tr '[:upper:]' '[:lower:]')" in
      y | yes) return 0 ;;
      n | no) return 1 ;;
      '') [ "$def" = y ] && return 0 || return 1 ;;
    esac
    tries=$((tries + 1))
    ui_fail "Type y or n."
  done
  return 1
}

# Reads a secret without echo into VAR. Returns 1 at the end of the input. Every label ends in "(not shown):".
ui_password() { # VAR label
  local __value='' __rc=0 UI_FD=2 __label=$2 UI_IN_PROMPT=1
  ui_ask_begin
  __label="${__label%:} (not shown):"
  ui_prompt_head "$__label"
  IFS= read -rs __value || __rc=1
  printf '\n' >&2
  printf -v "$1" '%s' "$__value"
  return "$__rc"
}

# ---- long steps -----------------------------------------------------------------------------------

# One progress line while a long step runs: a spinner with the elapsed time on a terminal, a start line and a
# "still working" line every minute elsewhere. The tool's own output belongs in LOG, not on the screen.
ui_step_start() { # text [log file]
  local text=$1 log=${2:-} t0=$SECONDS note='' side
  UI_STEP_T0=$t0
  if [ -n "$log" ]; then note="log: $(ui_path "$log")"; fi
  if [ "$UI_ANIM" = 1 ]; then
    # Inside a panel the progress line has the panel's left side; a blank row waiting above it is printed first,
    # so the result line lands where the progress line was.
    side=''
    if [ "$UI_PANEL" = 1 ] || [ "$UI_FRAMED" = 1 ]; then
      side="$(UI_FD=2 _ui_s 2 "$S_V") "
      if [ "$UI_PENDING_BLANK" = 1 ]; then
        UI_FD=2 _ui_raw "$(UI_FD=2 _ui_framed "")"
        UI_PENDING_BLANK=0
      fi
    fi
    (
      i=0
      n=${#UI_FRAMES[@]}
      shown=0
      while :; do
        e=$((SECONDS - t0))
        line="  ${UI_FRAMES[$((i % n))]} $text"
        # A few seconds is noise; and one line never wraps, since a wrapped line cannot be redrawn in place.
        if [ "$e" -ge 5 ]; then line="$line  $(ui_fmt_elapsed "$e")"; fi
        if [ -n "$note" ] && [ $((${#line} + 3 + ${#note})) -lt "$UI_WIDTH" ]; then line="$line   $note"; fi
        if [ "${#line}" -ge "$UI_WIDTH" ]; then line="${line:0:$((UI_WIDTH - 4))}$S_ELL"; fi
        printf '\r%*s\r%s%s' "$shown" '' "$side" "$line" >&2
        shown=$((${#line} + 2))
        i=$((i + 1))
        sleep 0.2 >/dev/null 2>&1 || sleep 1 >/dev/null 2>&1
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
          sleep 1 >/dev/null 2>&1
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
    if [ "$UI_ANIM" = 1 ]; then printf '\r%*s\r' "$UI_FULL" '' >&2; fi
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
