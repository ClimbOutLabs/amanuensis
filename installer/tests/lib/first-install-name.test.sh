#!/usr/bin/env bash
# The name question of a first install: Enter keeps main, a typed name is used, a bad one is refused and asked again,
# and flags, --yes or input that is not a terminal never see the question.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

PASSWORD_ANSWERS="Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD"

test_enter_keeps_main() {
  t_begin "pressing Enter at the name question names the instance main"
  sandbox_new
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
$PASSWORD_ANSWERS"
  assert_eq "$RC" 0
  assert_contains "$OUT" "Name for this instance [main]:"
  assert_flat_contains "$OUT" "Create instance main for owner@example.invalid"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_a_typed_name_is_used() {
  t_begin "a name typed at the question is the one the plan shows and the instance gets"
  sandbox_new
  run_install_tty "Name for this instance=>work
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
$PASSWORD_ANSWERS"
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "Create instance work for owner@example.invalid"
  assert_file "$AMAN_HOME/state/instances/work.conf"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_a_bad_name_is_refused_and_asked_again() {
  t_begin "a bad name says why and what is allowed, then the same question is asked again"
  sandbox_new
  run_install_tty "Name for this instance=>Work Notes
Name for this instance=>work
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Connect an email account=>n
Back up automatically=>y
Go ahead?=>n"
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "\"Work Notes\" has a space. Use 1 to 24 lowercase letters, numbers or hyphens, starting with a letter."
  assert_eq "$(printf '%s' "$OUT" | grep -c 'Name for this instance \[main\]:')" 2 "the question is asked twice"
  assert_flat_contains "$OUT" "Create instance work for owner@example.invalid"
  sandbox_drop
}

test_name_flag_skips_the_question() {
  t_begin "--name gives the name, so the question is not asked"
  sandbox_new
  run_install_tty "Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
$PASSWORD_ANSWERS" --name work
  assert_eq "$RC" 0
  assert_not_contains "$OUT" "Name for this instance"
  assert_file "$AMAN_HOME/state/instances/work.conf"
  sandbox_drop
}

test_yes_skips_the_question_and_uses_main() {
  t_begin "--yes asks no name and uses main"
  sandbox_new
  run_install_tty "$PASSWORD_ANSWERS" --yes --email owner@example.invalid
  assert_eq "$RC" 0
  assert_not_contains "$OUT" "Name for this instance"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_no_terminal_skips_the_question() {
  t_begin "input that is not a terminal asks no name: the first line answers the email question, and the instance is main"
  sandbox_new
  with_input "owner@example.invalid
n
n
y
y
$SENTINEL_PASSWORD
$SENTINEL_PASSWORD
"
  run_install
  clear_input
  assert_rc 0
  assert_not_contains "$OUT$ERR" "Name for this instance"
  assert_not_contains "$OUT$ERR" "What should Aman call you?"
  assert_flat_contains "$OUT" "Aman will call you owner. You can change that later in Personalization."
  assert_file "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_enter_keeps_main
test_a_typed_name_is_used
test_a_bad_name_is_refused_and_asked_again
test_name_flag_skips_the_question
test_yes_skips_the_question_and_uses_main
test_no_terminal_skips_the_question
tests_finish
