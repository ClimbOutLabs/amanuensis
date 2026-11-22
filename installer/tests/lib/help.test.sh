#!/usr/bin/env bash
# aman help: a short overview that groups the commands, a page for each command, and the same pages from -h and --help.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

ESC=$'\033'
ALL_COMMANDS="status upgrade backup restore password doctor import migrate local-model address"

# The real aman command with the given arguments, as a person would run it; OUT is its standard output, ERR its error
# output and RC its exit code.
run_aman() { # [ENV=VALUE...] -- args...
  local -a env=()
  while [ "$1" != -- ]; do
    env+=("$1")
    shift
  done
  shift
  set +e
  env -i PATH="$PATH" TERM=xterm "${env[@]+"${env[@]}"}" AMANUENSIS_HOME="$SB/home" bash "$INSTALLER_DIR/doctor/aman" "$@" >"$SB/help_out" 2>"$SB/help_err"
  RC=$?
  set -e
  OUT=$(cat "$SB/help_out")
  ERR=$(cat "$SB/help_err")
}

test_help_lists_every_command_in_groups() {
  t_begin "command:help is one short screen: every command once, in groups, with one line each"
  sandbox_new
  mkdir -p "$SB/home"
  local c
  run_aman LANG=C.UTF-8 -- help
  assert_rc 0
  for c in $ALL_COMMANDS; do
    assert_eq "$(printf '%s\n' "$OUT" | grep -c "^  $c ")" 1 "$c has one line"
  done
  assert_contains "$OUT" "Every day"
  assert_contains "$OUT" "When something is wrong"
  assert_contains "$OUT" "Your data"
  assert_contains "$OUT" "Advanced"
  assert_contains "$OUT" "aman help doctor" "it says how to see the options"
  assert_not_contains "$OUT" "--" "no options on the overview"
  [ "$(printf '%s\n' "$OUT" | wc -l)" -le 30 ] || t_fail "the overview is longer than 30 lines"
  assert_eq "$ERR" "" "nothing on the error output"
  sandbox_drop
}

test_help_flags_and_no_command_show_the_overview() {
  t_begin "-h, --help and a bare aman show the same overview as aman help"
  sandbox_new
  mkdir -p "$SB/home"
  local want arg
  run_aman LANG=C.UTF-8 -- help
  want=$OUT
  for arg in -h --help; do
    run_aman LANG=C.UTF-8 -- "$arg"
    assert_rc 0
    assert_eq "$OUT" "$want" "$arg"
  done
  run_aman LANG=C.UTF-8 --
  assert_rc 0
  assert_eq "$OUT" "$want" "a bare aman"
  sandbox_drop
}

test_every_command_has_a_page_from_help_and_from_its_flag() {
  t_begin "aman help COMMAND and aman COMMAND --help show the same page, with the usage line"
  sandbox_new
  mkdir -p "$SB/home"
  local c page
  for c in $ALL_COMMANDS; do
    run_aman LANG=C.UTF-8 -- help "$c"
    assert_rc 0
    assert_contains "$OUT" "aman $c" "the page of $c names the command"
    assert_contains "$OUT" "Usage" "the page of $c has a usage line"
    page=$OUT
    run_aman LANG=C.UTF-8 -- "$c" --help
    assert_rc 0
    assert_eq "$OUT" "$page" "$c --help"
  done
  run_aman LANG=C.UTF-8 -- help upgrade
  assert_contains "$OUT" "--check"
  assert_contains "$OUT" "--force"
  run_aman LANG=C.UTF-8 -- help doctor
  assert_contains "$OUT" "--fix"
  assert_contains "$OUT" "--add-python"
  assert_contains "$OUT" "--no-hard-disk-limit"
  run_aman LANG=C.UTF-8 -- doctor -h
  assert_rc 0
  assert_contains "$OUT" "aman doctor"
  sandbox_drop
}

test_every_dispatched_command_has_a_page() {
  t_begin "a command the aman command dispatches without a page here fails this test"
  local c
  # The commands of the main case block, as the help check reads them.
  for c in $(sed -n '/^# -* main/,$p' "$INSTALLER_DIR/doctor/aman" | awk '/^case "\$\{1:-\}" in/{n++} n>0{block[n]=block[n] $0 "\n"} END{for(i=1;i<=n;i++) if (block[i] ~ /Unknown command/) printf "%s", block[i]}' | grep -E '^  [a-z][a-z| -]*\)$' | tr -d ' )' | tr '|' ' '); do
    case " help $ALL_COMMANDS " in
      *" $c "*) ;;
      *) t_fail "aman $c has no page in lib/help.sh" ;;
    esac
  done
}

test_unknown_names_say_what_to_do() {
  t_begin "an unknown command or help topic says so on the error output and points to aman help"
  sandbox_new
  mkdir -p "$SB/home"
  run_aman LANG=C.UTF-8 -- bogus
  assert_rc 2
  assert_contains "$ERR" "Unknown command: bogus"
  assert_contains "$ERR" "Run aman help"
  assert_eq "$OUT" "" "nothing on the standard output"
  run_aman LANG=C.UTF-8 -- help bogus
  assert_rc 2
  assert_contains "$ERR" "There is no command called bogus."
  assert_contains "$ERR" "Run aman help"
  sandbox_drop
}

test_colors_and_plain_text() {
  t_begin "help has color on a terminal style, none under NO_COLOR, and only ASCII in a plain locale, none wider than the screen"
  sandbox_new
  mkdir -p "$SB/home"
  run_aman CLICOLOR_FORCE=1 LANG=C.UTF-8 -- help
  assert_contains "$OUT" "${ESC}[1mstatus"
  run_aman CLICOLOR_FORCE=1 NO_COLOR=1 LANG=C.UTF-8 -- help doctor
  assert_not_contains "$OUT" "$ESC" "no escape bytes without color"
  run_aman LANG=C -- help doctor
  assert_not_contains "$OUT" "$ESC"
  if printf '%s' "$OUT" | LC_ALL=C grep -q '[^ -~[:space:]]'; then t_fail "the plain locale printed non-ASCII"; fi
  assert_contains "$OUT" "+---"
  local c
  # In the plain locale a byte is a column.
  for c in "" $ALL_COMMANDS; do
    run_aman LANG=C -- help ${c:+"$c"}
    assert_eq "$(printf '%s\n' "$OUT" | awk 'length($0) > 80 { n++ } END { print n + 0 }')" 0 "no line of help $c is wider than the screen"
  done
  sandbox_drop
}

test_the_help_file_is_installed_with_the_command() {
  t_begin "installing the aman command puts lib/help.sh beside it, and a changed copy is put back"
  sandbox_new
  install_machine
  assert_file "$AMAN_HOME/lib/help.sh"
  printf 'broken\n' >"$AMAN_HOME/lib/help.sh"
  run_install command
  assert_rc 0
  assert_eq "$(cmp -s "$SB_INSTALLER/lib/help.sh" "$AMAN_HOME/lib/help.sh" && echo same)" same
  sandbox_drop
}

test_help_lists_every_command_in_groups
test_help_flags_and_no_command_show_the_overview
test_every_command_has_a_page_from_help_and_from_its_flag
test_every_dispatched_command_has_a_page
test_unknown_names_say_what_to_do
test_colors_and_plain_text
test_the_help_file_is_installed_with_the_command
tests_finish
