#!/usr/bin/env bash
# The Twilio listener's port: published on 127.0.0.1 only, and only when the settings file turns texts on.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

test_no_texts_no_port() {
  t_begin "a new install publishes no port for Twilio"
  sandbox_new
  install_machine
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "8793" "nothing is opened for texts that are off"
  sandbox_drop
}

test_texts_on_publish_the_default_port_on_loopback() {
  t_begin "with texts on, the listener port is published on 127.0.0.1 and nowhere else"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' >>"$env"
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "'127.0.0.1:8793:8793'" "the default port, on loopback"
  assert_eq "$(grep -c ':8793:' "$AMAN_HOME/instances/main/compose.yaml")" 1 "once"
  sandbox_drop
}

test_a_chosen_port_is_used_and_a_bad_one_ignored() {
  t_begin "a port the person chose is used, and a value that is not a port opens nothing"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' 'TWILIO_WEBHOOK_PORT=9123' >>"$env"
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "'127.0.0.1:9123:9123'"
  printf '%s\n' 'TWILIO_WEBHOOK_PORT=abc' >>"$env"
  repo_commit_change "another app change"
  run_install upgrade
  assert_rc 0
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "abc" "a bad value is never written into the compose file"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "9123"
  sandbox_drop
}

test_no_texts_no_port
test_texts_on_publish_the_default_port_on_loopback
test_a_chosen_port_is_used_and_a_bad_one_ignored
tests_finish
