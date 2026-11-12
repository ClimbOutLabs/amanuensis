#!/usr/bin/env bash
# The key pair the app signs push notices with: made at install, added to an older instance, never changed.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

env_value() { sed -n "s/^$1=//p" "$AMAN_HOME/instances/main/.env" | head -n 1; }

# Byte length of a URL-safe base64 value, counted by the machine's own tools.
b64url_bytes() {
  local v=$1
  while [ $((${#v} % 4)) -ne 0 ]; do v="$v="; done
  printf '%s' "$v" | tr '_-' '/+' | openssl base64 -d -A | wc -c | tr -d ' '
}

test_install_makes_the_keys() {
  t_begin "install writes a push key pair into the settings file, in the managed part, and no contact"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  assert_eq "$(b64url_bytes "$(env_value WEB_PUSH_PUBLIC_KEY)")" 65 "the public key is 65 bytes"
  assert_eq "$(b64url_bytes "$(env_value WEB_PUSH_PRIVATE_KEY)")" 32 "the private key is 32 bytes"
  assert_eq "$(grep -c '^WEB_PUSH_SUBJECT=' "$env")" 0 "no contact line, so the app's default names no one"
  assert_not_contains "$(grep '^WEB_PUSH_' "$env")" "owner@example.invalid" "the owner's email is not handed to push"
  assert_mode "$env" 600
  assert_eq "$(awk '/^# >>> managed/{f=1} /^# <<< end/{f=0} f && /^WEB_PUSH_/{n++} END{print n+0}' "$env")" 2 "both are in the managed part"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "$(env_value WEB_PUSH_PRIVATE_KEY)" "the compose file never holds the private key"
  sandbox_drop
}

test_a_later_run_keeps_the_keys() {
  t_begin "a later run never changes the keys"
  sandbox_new
  install_machine
  local pub priv
  pub=$(env_value WEB_PUSH_PUBLIC_KEY)
  priv=$(env_value WEB_PUSH_PRIVATE_KEY)
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_eq "$(env_value WEB_PUSH_PUBLIC_KEY)" "$pub"
  assert_eq "$(env_value WEB_PUSH_PRIVATE_KEY)" "$priv"
  sandbox_drop
}

test_an_older_instance_gets_keys() {
  t_begin "an instance made before push existed gets keys on its next run, and its other settings stay"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env before after
  grep -v '^WEB_PUSH_' "$env" >"$env.new" && mv "$env.new" "$env"
  chmod 600 "$env"
  before=$(cat "$env")
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  after=$(cat "$env")
  assert_eq "$(b64url_bytes "$(env_value WEB_PUSH_PUBLIC_KEY)")" 65
  assert_eq "$(b64url_bytes "$(env_value WEB_PUSH_PRIVATE_KEY)")" 32
  assert_eq "$(printf '%s\n' "$after" | grep -v '^WEB_PUSH_')" "$(printf '%s\n' "$before")" "every other line is as it was"
  assert_mode "$env" 600
  sandbox_drop
}

test_a_file_without_a_managed_part_gets_the_lines() {
  t_begin "a settings file with no managed part gets the push lines at its end, and nothing else changes"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  printf '%s\n' 'OWN_SETTING=kept' 'ANOTHER=also-kept' >"$env"
  chmod 600 "$env"
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_eq "$(grep -c '^WEB_PUSH_' "$env")" 2 "each line is there once"
  assert_eq "$(grep -v '^WEB_PUSH_\|^CALENDAR_ACCOUNT_SECRET=\|^BROWSER_SECRET=\|^SPEECH_SECRET=' "$env")" "$(printf 'OWN_SETTING=kept\nANOTHER=also-kept')"
  assert_mode "$env" 600
  sandbox_drop
}

test_a_contact_set_by_hand_stays() {
  t_begin "a contact the owner set by hand is kept as it is"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  printf '%s\n' 'WEB_PUSH_SUBJECT=https://example.invalid/aman' >>"$env"
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_eq "$(env_value WEB_PUSH_SUBJECT)" "https://example.invalid/aman"
  sandbox_drop
}

test_keys_come_from_the_app_image() {
  t_begin "the keys are made by the app image's Node.js with no network, so the computer needs no key tools"
  sandbox_new
  install_machine
  local runs
  runs=$(cat "$STUB_STATE/push_keys_runs")
  assert_contains "$runs" "--network none"
  assert_contains "$runs" "--entrypoint node"
  sandbox_drop
}

test_a_failed_key_leaves_push_off() {
  t_begin "when no key can be made, the install still finishes, says what to do, and push stays off"
  sandbox_new
  STUB_PUSH_KEYS_FAIL=1 install_machine
  assert_contains "$OUT$ERR" "Run the installer again"
  assert_eq "$(env_value WEB_PUSH_PUBLIC_KEY)" "" "no public key"
  assert_eq "$(env_value WEB_PUSH_PRIVATE_KEY)" "" "no private key"
  sandbox_drop
}

test_install_makes_the_keys
test_keys_come_from_the_app_image
test_a_failed_key_leaves_push_off
test_a_later_run_keeps_the_keys
test_an_older_instance_gets_keys
test_a_file_without_a_managed_part_gets_the_lines
test_a_contact_set_by_hand_stays
tests_finish
