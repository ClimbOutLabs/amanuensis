#!/usr/bin/env bash
# The Twilio listener's port: published on 127.0.0.1 only, and only when the settings file turns texts on.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

add_instance() {
  local name=$1
  shift
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add "$name" --yes --password-stdin --email "$name@example.invalid" "$@"
  clear_input
}

compose_of() { cat "$AMAN_HOME/instances/$1/compose.yaml"; }

# Each instance's sandbox disks count against the free space, so a run with several instances needs more of it.
room_for_instances() { STUB_DF_KB=$((400 * 1024 * 1024)); }

test_no_texts_no_port() {
  t_begin "a new install publishes no port for Twilio"
  sandbox_new
  install_machine
  assert_not_contains "$(compose_of main)" "9201" "nothing is opened for texts that are off"
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
  assert_contains "$(compose_of main)" "'127.0.0.1:9201:9201'" "the default port, on loopback"
  assert_eq "$(grep -c ':9201:' "$AMAN_HOME/instances/main/compose.yaml")" 1 "once"
  sandbox_drop
}

test_a_plain_rerun_opens_the_port() {
  t_begin "running the installer again, with no upgrade, opens the port once texts are turned on"
  sandbox_new
  install_machine
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' >>"$AMAN_HOME/instances/main/.env"
  run_install --yes
  assert_rc 0
  assert_contains "$(compose_of main)" "'127.0.0.1:9201:9201'" "a plain re-run publishes it"
  sed -i.bak '/^REACH_SMS_PROVIDER=/d' "$AMAN_HOME/instances/main/.env"
  rm -f "$AMAN_HOME/instances/main/.env.bak"
  run_install --yes
  assert_rc 0
  assert_not_contains "$(compose_of main)" "9201" "and closes it once texts are off again"
  sandbox_drop
}

test_the_provider_line_is_read_like_the_app_reads_it() {
  t_begin "quotes and capitals on the provider line still open the port"
  sandbox_new
  install_machine
  printf '%s\n' 'REACH_SMS_PROVIDER="Twilio"' >>"$AMAN_HOME/instances/main/.env"
  printf '%s\n' "TWILIO_WEBHOOK_PORT='9123'" >>"$AMAN_HOME/instances/main/.env"
  run_install --yes
  assert_rc 0
  assert_contains "$(compose_of main)" "'127.0.0.1:9123:9123'"
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
  assert_contains "$(compose_of main)" "'127.0.0.1:9123:9123'"
  printf '%s\n' 'TWILIO_WEBHOOK_PORT=abc' >>"$env"
  repo_commit_change "another app change"
  run_install upgrade
  assert_rc 0
  assert_not_contains "$(compose_of main)" "abc" "a bad value is never written into the compose file"
  assert_not_contains "$(compose_of main)" "9123"
  sandbox_drop
}

test_a_port_another_instance_uses_is_refused() {
  t_begin "a Twilio port that another instance or Aman itself uses is not opened, and the installer says what to change"
  sandbox_new
  install_machine
  add_instance second
  assert_rc 0
  add_instance third
  assert_rc 0
  room_for_instances
  assert_contains "$(compose_of third)" "127.0.0.1:8793:8790" "the third instance has the app port 8793"
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' 'TWILIO_WEBHOOK_PORT=8793' >>"$AMAN_HOME/instances/main/.env"
  run_install --yes
  assert_rc 0
  assert_not_contains "$(compose_of main)" "8793:8793" "the other instance's port is not taken"
  assert_contains "$ERR" "TWILIO_WEBHOOK_PORT 8793"
  assert_contains "$ERR" "$AMAN_HOME/instances/main/.env"
  sandbox_drop
}

test_two_instances_with_texts_never_share_a_port() {
  t_begin "two instances with texts on and no port set: the first gets the default, the second the next free port"
  sandbox_new
  install_machine
  add_instance second
  assert_rc 0
  room_for_instances
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' >>"$AMAN_HOME/instances/main/.env"
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' >>"$AMAN_HOME/instances/second/.env"
  run_install --yes
  assert_rc 0
  assert_contains "$(compose_of main)" "'127.0.0.1:9201:9201'"
  assert_contains "$(compose_of second)" "'127.0.0.1:9202:9202'"
  local managed
  managed=$(cat "$AMAN_HOME/instances/second/.env")
  managed=${managed%%# <<< end of managed block*}
  assert_contains "$managed" "TWILIO_WEBHOOK_PORT=9202" "the picked port is written down, so the app listens on it"
  assert_not_contains "$ERR" "TWILIO_WEBHOOK_PORT" "nothing to change by hand"
  sandbox_drop
}

test_the_instance_that_has_the_port_keeps_it() {
  t_begin "an instance that already publishes the Twilio port keeps it when an instance earlier by name turns texts on"
  sandbox_new
  install_machine
  add_instance second
  assert_rc 0
  room_for_instances
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' >>"$AMAN_HOME/instances/second/.env"
  run_install --yes
  assert_rc 0
  assert_contains "$(compose_of second)" "'127.0.0.1:9201:9201'"
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' >>"$AMAN_HOME/instances/main/.env"
  run_install --yes
  assert_rc 0
  assert_contains "$(compose_of second)" "'127.0.0.1:9201:9201'" "the one that has it keeps it"
  assert_contains "$(compose_of main)" "'127.0.0.1:9202:9202'" "the newcomer gets the next free port"
  sandbox_drop
}

test_a_rerun_applies_a_new_auth_token() {
  t_begin "running the installer again after the Twilio auth token changes restarts the app with it"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' 'TWILIO_AUTH_TOKEN=first-token-for-tests' >>"$env"
  run_install --yes
  assert_rc 0
  : >"$STUB_LOG"
  run_install --yes
  assert_rc 0
  assert_eq "$(log_count 'force-recreate')" 0 "nothing changed, nothing restarts"
  assert_flat_contains "$OUT" "Instance main is running"
  sed -i.bak 's/^TWILIO_AUTH_TOKEN=.*/TWILIO_AUTH_TOKEN=second-token-for-tests/' "$env"
  rm -f "$env.bak"
  run_install --yes
  assert_rc 0
  assert_flat_contains "$OUT" "Restart instance main with the texts settings from its settings file"
  assert_eq "$(log_count 'force-recreate')" 1 "one restart, for the new token"
  local found
  found=$(grep -rIl -- "second-token-for-tests" "$AMAN_HOME" "$STUB_LOG" 2>/dev/null | sort | tr '\n' ' ' || true)
  assert_eq "$found" "$env " "the token is kept only in the settings file"
  assert_not_contains "$OUT$ERR" "second-token-for-tests" "the token is never printed"
  sandbox_drop
}

test_a_rerun_applies_a_new_day_cap() {
  t_begin "running the installer again after the server's day cap on texts changes restarts the app with it"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' 'REACH_SMS_MAX_TEXTS_PER_DAY=500' >>"$env"
  run_install --yes
  assert_rc 0
  : >"$STUB_LOG"
  sed -i.bak 's/^REACH_SMS_MAX_TEXTS_PER_DAY=.*/REACH_SMS_MAX_TEXTS_PER_DAY=40/' "$env"
  rm -f "$env.bak"
  run_install --yes
  assert_rc 0
  assert_eq "$(log_count 'force-recreate')" 1 "one restart, for the new cap"
  sandbox_drop
}

test_a_picked_port_reaches_the_app_without_a_managed_block() {
  t_begin "a port picked for a settings file with no managed block is published onto the port the app listens on"
  sandbox_new
  install_machine
  add_instance second
  assert_rc 0
  room_for_instances
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' >>"$AMAN_HOME/instances/main/.env"
  local env=$AMAN_HOME/instances/second/.env
  sed -i.bak '/^# >>> managed by the installer/,/^# <<< end of managed block/d' "$env"
  rm -f "$env.bak"
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' >>"$env"
  run_install --yes
  assert_rc 0
  assert_contains "$(compose_of main)" "'127.0.0.1:9201:9201'"
  assert_contains "$(compose_of second)" "'127.0.0.1:9202:9201'" "the picked port leads to the app's own port"
  sandbox_drop
}

test_lines_compose_reads_are_read_the_same() {
  t_begin "an export line and a trailing comment on the texts lines are read the way Compose reads them"
  sandbox_new
  install_machine
  printf '%s\n' 'export REACH_SMS_PROVIDER=twilio # texts on' 'TWILIO_WEBHOOK_PORT=9124 # for Funnel' >>"$AMAN_HOME/instances/main/.env"
  run_install --yes
  assert_rc 0
  assert_contains "$(compose_of main)" "'127.0.0.1:9124:9124'"
  sandbox_drop
}

test_a_new_instance_never_takes_the_twilio_port() {
  t_begin "a new instance's app port skips a port the Twilio listener has"
  sandbox_new
  install_machine
  printf '%s\n' 'REACH_SMS_PROVIDER=twilio' 'TWILIO_WEBHOOK_PORT=8792' >>"$AMAN_HOME/instances/main/.env"
  run_install --yes
  assert_rc 0
  assert_contains "$(compose_of main)" "'127.0.0.1:8792:8792'"
  add_instance second
  assert_rc 0
  assert_not_contains "$(compose_of second)" "8792:8790" "the app port is not the Twilio port"
  assert_contains "$(compose_of second)" "127.0.0.1:8793:8790"
  sandbox_drop
}

test_no_texts_no_port
test_texts_on_publish_the_default_port_on_loopback
test_a_plain_rerun_opens_the_port
test_the_provider_line_is_read_like_the_app_reads_it
test_a_chosen_port_is_used_and_a_bad_one_ignored
test_a_port_another_instance_uses_is_refused
test_two_instances_with_texts_never_share_a_port
test_the_instance_that_has_the_port_keeps_it
test_a_rerun_applies_a_new_auth_token
test_a_rerun_applies_a_new_day_cap
test_a_picked_port_reaches_the_app_without_a_managed_block
test_lines_compose_reads_are_read_the_same
test_a_new_instance_never_takes_the_twilio_port
tests_finish
