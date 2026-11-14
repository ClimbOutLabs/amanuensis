#!/usr/bin/env bash
# The shared speech services: one secret in the machine settings, a copy in every instance.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

machine_secret() { sed -n 's/^SPEECH_SECRET=//p' "$AMAN_HOME/machine/.env"; }
instance_secret() { sed -n 's/^SPEECH_SECRET=//p' "$AMAN_HOME/instances/$1/.env"; }

test_one_secret_on_the_machine_and_a_copy_in_the_instance() {
  t_begin "the machine settings hold one speech secret and the instance holds a copy of the same value"
  sandbox_new
  install_machine
  local machine
  machine=$(machine_secret)
  assert_eq "${#machine}" 64 "a random secret of 64 characters is made"
  assert_eq "$(instance_secret main)" "$machine" "the instance holds the same value"
  assert_eq "$(grep -c '^SPEECH_SECRET=' "$AMAN_HOME/machine/.env")" 1 "one line in the machine settings"
  assert_eq "$(grep -c '^SPEECH_SECRET=' "$AMAN_HOME/instances/main/.env")" 1 "one line in the instance settings"
  assert_mode "$AMAN_HOME/machine/.env" 600
  assert_contains "$(cat "$AMAN_HOME/machine/compose.yaml")" "SPEECH_SECRET: \${SPEECH_SECRET:?missing from .env}"
  assert_not_contains "$(cat "$AMAN_HOME/machine/compose.yaml")" "$machine" "the machine compose file never holds the secret"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "$machine" "the instance compose file never holds the secret"
  sandbox_drop
}

test_refresh_keeps_the_secret_and_puts_back_a_lost_copy() {
  t_begin "refresh never changes the speech secret, and an instance that lost its copy gets the same value back"
  sandbox_new
  install_machine
  local machine env
  machine=$(machine_secret)
  env=$AMAN_HOME/instances/main/.env
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(machine_secret)" "$machine" "the machine value is unchanged"
  assert_eq "$(instance_secret main)" "$machine" "the instance copy is unchanged"
  grep -v '^SPEECH_SECRET=' "$env" >"$SB/env.cut"
  cat "$SB/env.cut" >"$env"
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(instance_secret main)" "$machine" "the lost copy comes back with the machine's value"
  assert_eq "$(grep -c '^SPEECH_SECRET=' "$env")" 1 "one line is left"
  sandbox_drop
}

test_a_second_instance_shares_the_machine_secret() {
  t_begin "a second instance gets a copy of the same machine speech secret"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD\n"
  run_install instance add second --yes --password-stdin --email second@example.invalid
  clear_input
  assert_rc 0
  assert_eq "$(instance_secret second)" "$(machine_secret)" "the second instance holds the machine's value"
  sandbox_drop
}

test_one_secret_on_the_machine_and_a_copy_in_the_instance
test_refresh_keeps_the_secret_and_puts_back_a_lost_copy
test_a_second_instance_shares_the_machine_secret
tests_finish
