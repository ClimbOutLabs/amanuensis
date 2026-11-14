#!/usr/bin/env bash
# How install (command:install), upgrade (command:upgrade) and the doctor (command:doctor) look from start to end: the
# banner, the step badges with their progress bar, a separator before every question and the boxed verdict, in color
# on a terminal, without color under NO_COLOR, and as plain text when the output is not a terminal.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

ESC=$'\033'
COLOR_ENV=(CLICOLOR_FORCE=1 LANG=C.UTF-8 TERM=xterm)
NOCOLOR_ENV=(CLICOLOR_FORCE=1 NO_COLOR=1 LANG=C.UTF-8 TERM=xterm)

# The doctor of the installed machine, with the given settings, as a person would run it.
run_doctor_with() { # env...
  build_run_env
  set +e
  env -i "${RUN_ENV[@]}" "$@" AMANUENSIS_HOME="$AMAN_HOME" bash "$INSTALLER_DIR/doctor/aman" doctor >"$SB/doctor_out" 2>"$SB/doctor_err"
  RC=$?
  set -e
  OUT=$(cat "$SB/doctor_out")
  ERR=$(cat "$SB/doctor_err")
}

# Whether text holds only ASCII, as a log file or an old terminal needs.
is_ascii() { ! printf '%s' "$1" | LC_ALL=C grep -q '[^ -~[:space:]]'; }

# Fails when a line of the boxes is not exactly as wide as the rest of the frame.
assert_boxes_closed() { # text
  local widths
  # Counting bytes that start a character gives columns whatever the locale of the machine running the test.
  widths=$(printf '%s\n' "$1" | LC_ALL=C grep -E '^(\+-|\| |╭|╰|│ )' | LC_ALL=C tr -d '\200-\277' | LC_ALL=C awk '{ print length($0) }' | sort -u)
  assert_eq "$widths" 72 "every box line is 72 columns wide, so the right side lines up"
}

test_install_in_color() {
  t_begin "command:install on a color terminal: a banner, a badge and bar for each step, and a green verdict box"
  sandbox_new
  RUN_ENV_EXTRA=("${COLOR_ENV[@]}")
  install_machine
  assert_contains "$OUT" "${ESC}[1;36mAMAN${ESC}[0m  Setting up a private assistant on this computer"
  assert_contains "$OUT" "${ESC}[7;36m 1 of 6 ${ESC}[0m  ${ESC}[1mChecking this computer${ESC}[0m"
  assert_contains "$OUT" "${ESC}[7;36m 6 of 6 ${ESC}[0m  ${ESC}[1mChecking the result${ESC}[0m"
  assert_contains "$OUT" "${ESC}[32m━━━━━━━━━━━━${ESC}[0m" "the last step fills the bar"
  assert_contains "$OUT" "${ESC}[1;32m✓ Ready. Instance main is running.${ESC}[0m"
  assert_contains "$OUT" "${ESC}[32m╰"
  sandbox_drop
}

test_install_without_color() {
  t_begin "command:install with NO_COLOR keeps the layout and prints no color codes at all"
  sandbox_new
  RUN_ENV_EXTRA=("${NOCOLOR_ENV[@]}")
  install_machine
  assert_not_contains "$OUT$ERR" "$ESC" "no escape codes"
  assert_contains "$OUT" "│ AMAN  Setting up a private assistant on this computer"
  assert_contains "$OUT" "[ 1 of 6 ]  Checking this computer"
  assert_contains "$OUT" "━━──────────" "the bar shows done and to do with two kinds of line"
  assert_contains "$OUT" "│ ✓ Ready. Instance main is running."
  assert_boxes_closed "$OUT"
  sandbox_drop
}

test_install_not_on_a_terminal() {
  t_begin "command:install into a pipe or a log is plain ASCII, with the same steps and verdict"
  sandbox_new
  install_machine
  assert_not_contains "$OUT$ERR" "$ESC" "no escape codes"
  if ! is_ascii "$OUT"; then t_fail "the output is ASCII only"; else t_pass; fi
  assert_contains "$OUT" "| AMAN  Setting up a private assistant on this computer"
  assert_contains "$OUT" "[ 3 of 6 ]  The plan"
  assert_contains "$OUT" "| + Ready. Instance main is running."
  assert_boxes_closed "$OUT"
  sandbox_drop
}

test_questions_have_a_separator() {
  t_begin "command:install puts a separator line before each group of questions, and the questions under it"
  sandbox_new
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD"
  assert_eq "$RC" 0
  local flat_out
  flat_out=$(flat "$OUT")
  assert_contains "$flat_out" "> Your answer is needed ---" "the separator names what the run waits for"
  assert_contains "$flat_out" "Your answer is needed ------------------------------------------------ Each person gets a new instance. > Name for this instance"
  assert_contains "$flat_out" "Your answer is needed ------------------------------------------------ > Connect a calendar?"
  assert_contains "$flat_out" "Your answer is needed ------------------------------------------------ > Go ahead? [Y/n]"
  assert_contains "$flat_out" "Asked now so the rest of the setup runs on its own. Your password needs:" "the password rules sit with the question they belong to"
  sandbox_drop
}

test_upgrade_looks_like_install() {
  t_begin "command:upgrade has the same banner, numbered steps and verdict box, with color and without"
  sandbox_new
  install_machine
  repo_commit_change "look"
  RUN_ENV_EXTRA=("${COLOR_ENV[@]}")
  run_install upgrade
  assert_rc 0
  assert_contains "$OUT" "${ESC}[1;36mAMAN${ESC}[0m  Upgrading Aman on this computer"
  assert_contains "$OUT" "${ESC}[7;36m 1 of 4 ${ESC}[0m  ${ESC}[1mWhat this upgrade changes${ESC}[0m"
  assert_contains "$OUT" "${ESC}[7;36m 4 of 4 ${ESC}[0m  ${ESC}[1mChecking the result${ESC}[0m"
  assert_contains "$OUT" "app       aman-app:"
  assert_contains "$OUT" " → aman-app:"
  assert_contains "$OUT" "${ESC}[1;32m✓ Upgraded to aman-app:"
  repo_commit_change "look again"
  RUN_ENV_EXTRA=()
  run_install upgrade
  assert_rc 0
  assert_not_contains "$OUT$ERR" "$ESC" "no escape codes when the output is not a terminal"
  if ! is_ascii "$OUT"; then t_fail "the output is ASCII only"; else t_pass; fi
  assert_contains "$OUT" "[ 2 of 4 ]  Checking and backing up"
  assert_contains "$OUT" " -> aman-app:"
  assert_contains "$OUT" "| + Upgraded to aman-app:"
  assert_boxes_closed "$OUT"
  sandbox_drop
}

test_doctor_looks_like_install() {
  t_begin "command:doctor has a banner, a badge per part with what it found, and the problems again in its verdict"
  sandbox_new
  install_machine
  STUB_DOCKER_DOWN=1
  run_doctor_with "${COLOR_ENV[@]}"
  assert_contains "$OUT" "${ESC}[1;36mAMAN DOCTOR${ESC}[0m  Checks this computer and each instance."
  assert_contains "$OUT" "${ESC}[7;36m Checking this computer ${ESC}[0m"
  assert_contains "$OUT" "${ESC}[31m1 problem${ESC}[0m" "the part's heading counts its problems"
  assert_contains "$OUT" "${ESC}[1;31m✗ "
  assert_contains "$OUT" "Do the Next step of each, then run aman doctor again."
  run_doctor_with "${NOCOLOR_ENV[@]}"
  assert_not_contains "$OUT$ERR" "$ESC" "NO_COLOR: no escape codes"
  assert_contains "$OUT" "[ Checking this computer ]"
  assert_boxes_closed "$OUT"
  run_doctor_with
  assert_not_contains "$OUT$ERR" "$ESC" "not a terminal: no escape codes"
  assert_contains "$OUT" "| AMAN DOCTOR  Checks this computer and each instance."
  assert_contains "$(flat "$OUT")" "x Docker is installed, but it is not running. Next:"
  assert_boxes_closed "$OUT"
  sandbox_drop
}

test_install_in_color
test_install_without_color
test_install_not_on_a_terminal
test_questions_have_a_separator
test_upgrade_looks_like_install
test_doctor_looks_like_install
tests_finish
