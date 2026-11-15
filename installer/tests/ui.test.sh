#!/usr/bin/env bash
# The terminal style helpers against the expected renderings in ui-fixtures.txt.
set -euo pipefail
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

FIXTURES=$TESTS_DIR/ui-fixtures.txt
UI_SH=$INSTALLER_DIR/lib/ui.sh

# run_mode MODE CALLS...: the bytes the helpers print in one mode, streams merged, escape bytes shown as \e.
run_mode() {
  local mode=$1 script=$2 out
  local -a env=(PATH="$PATH" TERM=xterm)
  case "$mode" in
    color) env+=(LANG=C.UTF-8 CLICOLOR_FORCE=1) ;;
    nocolor) env+=(LANG=C.UTF-8 CLICOLOR_FORCE=1 NO_COLOR=1) ;;
    plain) env+=(LANG=C.UTF-8) ;;
    ascii) env+=(LANG=C) ;;
  esac
  out=$(env -i "${env[@]}" bash -c "exec 2>&1; . '$UI_SH'; ui_init; $script" </dev/null)
  printf '%s' "${out//$'\033'/\\e}"
}

test_fixtures_match() {
  local line case_name='' mode='' script='' body='' have_body=0 i actual
  local -a modes=() bodies=()
  # A case is complete when the next one starts or the file ends; the blank line between cases is not part of a body.
  commit_mode() {
    if [ -n "$mode" ]; then
      while [ "${body%$'\n'}" != "$body" ]; do body=${body%$'\n'}; done
      modes+=("$mode")
      bodies+=("$body")
    fi
    mode=''
    body=''
    have_body=0
  }
  flush() {
    commit_mode
    t_begin "ui fixture $case_name has every mode"
    assert_eq "${modes[*]}" "color nocolor plain ascii" "a case shows all four modes, in order"
    for i in "${!modes[@]}"; do
      actual=$(run_mode "${modes[$i]}" "$script")
      t_begin "ui fixture $case_name (${modes[$i]})"
      assert_eq "$actual" "${bodies[$i]}" "rendering differs"
    done
    modes=()
    bodies=()
  }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '#'*) ;;
      '== '*)
        if [ -n "$case_name" ]; then flush; fi
        case_name=${line#== }
        script=''
        ;;
      'set verbose '*) script="UI_VERBOSE=${line#set verbose }; $script" ;;
      'set assume_yes '*) script="UI_ASSUME_YES=${line#set assume_yes }; $script" ;;
      'set framed '*) script="AMAN_UI_FRAMED=${line#set framed }; ui_init; $script" ;;
      'call '*) script="$script${line#call }"$'\n' ;;
      '-- '*)
        commit_mode
        mode=${line#-- }
        ;;
      *)
        if [ -n "$mode" ]; then
          if [ "$have_body" = 1 ]; then body="$body"$'\n'"$line"; else body=$line; have_body=1; fi
        fi
        ;;
    esac
  done <"$FIXTURES"
  flush
}

# A progress line on a terminal stays on one line: a text too long for it is cut, while the elapsed time stays whole.
test_progress_line_keeps_the_time() {
  t_begin "a long progress line keeps its elapsed time and stays within the panel"
  local out last
  out=$(env -i PATH="$PATH" TERM=xterm LANG=C.UTF-8 bash -c ". '$UI_SH'; ui_init; UI_ANIM=1; _ui_panel_open 'Step'; ui_step_start 'Starting instance a-rather-long-instance-name-for-testing and waiting until it answers'; sleep 6; ui_step_abort" 2>&1 </dev/null)
  last=$(printf '%s' "$out" | tr '\r' '\n' | grep -E '…  [0-9]+s$' | tail -n 1 || true)
  if [ -n "$last" ]; then t_pass; else t_fail "no progress line ends with its elapsed time: $(printf '%s' "$out" | tr '\r' '\n' | tail -n 3)"; fi
  if [ "$(printf '%s' "$last" | LC_ALL=C.UTF-8 wc -m)" -le 70 ]; then t_pass; else t_fail "line is ${#last} characters wide: $last"; fi
}

test_progress_line_keeps_the_time
test_fixtures_match
tests_finish
