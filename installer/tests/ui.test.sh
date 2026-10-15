#!/usr/bin/env bash
# The terminal style helpers against installer/tests/ui-fixtures.txt, which the Node twin is tested against too.
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

test_fixtures_match
tests_finish
