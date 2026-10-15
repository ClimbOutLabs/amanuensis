#!/usr/bin/env bash
# The password prompt on a real terminal: never echoed.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

ANSWERS="Instance name=>
Your email=>owner@example.invalid
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"

test_password_is_not_echoed() {
  t_begin "the password typed at the prompts is not echoed to the terminal"
  sandbox_new
  run_install_tty "$ANSWERS"
  assert_rc 0
  assert_contains "$OUT" "Password for the owner account"
  assert_contains "$OUT" "Repeat the password"
  assert_contains "$OUT" "owner@example.invalid" "ordinary answers are echoed, so the transcript is a real terminal"
  assert_not_contains "$OUT" "$SENTINEL_PASSWORD"
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$SENTINEL_PASSWORD" "the password still reached the hashing step"
  sandbox_drop
}

test_the_echo_test_can_fail() {
  t_begin "the same run echoes the password if the prompt stops using read -s"
  sandbox_new
  sed -i 's/IFS= read -rs /IFS= read -r /' "$SB_INSTALLER/lib/ui.sh"
  assert_not_contains "$(cat "$SB_INSTALLER/lib/ui.sh")" "read -rs"
  run_install_tty "$ANSWERS"
  assert_contains "$OUT" "$SENTINEL_PASSWORD" "echo is visible without -s"
  sandbox_drop
}

test_password_is_not_echoed
test_the_echo_test_can_fail
tests_finish
