#!/usr/bin/env bash
# This computer's key for saved logins: made once, shared by every instance, and each instance's recovery key
# shown once and never written anywhere.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

KEY_PATTERN='[0-9]\{6\}\(-[0-9]\{6\}\)\{7\}'
shown_key() { printf '%s\n' "$1" | grep -o "$KEY_PATTERN" | tail -n 1; }
setup_runs() { grep -c ' secrets-setup init ' "$STUB_LOG" || true; }

test_install_sets_up_the_key_before_the_app_starts() {
  t_begin "install makes this computer's key, ties the instance to it before the app starts, and shows the recovery key once"
  sandbox_new
  install_machine
  local compose key
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_key" "the key has its own volume"
  assert_contains "$compose" "- machine-key:/run/aman-key:ro" "the app can only read the key"
  assert_contains "$compose" "SECRETS_KEY_FILE: /run/aman-key/master.key"
  assert_contains "$(printf '%s\n' "$compose" | sed -n '/^  secrets-setup:/,/^$/p')" "network_mode: none" "setup has no network"
  assert_contains "$(printf '%s\n' "$compose" | sed -n '/^  secrets-setup:/,/^$/p')" "- setup" "setup never runs on a normal start"
  assert_eq "$(grep -n ' secrets-setup init \| up -d ' "$STUB_LOG" | grep 'aman-main' | head -n 1 | grep -c 'secrets-setup init')" 1 "setup runs before the first start"
  key=$(shown_key "$OUT")
  assert_eq "$key" "000001-222222-333333-444444-555555-666666-777777-888888" "the recovery key is shown"
  assert_eq "$(printf '%s\n' "$OUT" | grep -c "$KEY_PATTERN")" 1 "and shown once"
  assert_flat_contains "$OUT" "Write it down now and keep it somewhere safe. It is shown only this once."
  assert_flat_contains "$OUT$ERR" "Without disk encryption, a lost or stolen computer can be read."
  assert_flat_contains "$OUT$ERR" "Turn on disk encryption for this computer: FileVault on a Mac, BitLocker on Windows, LUKS on Linux."
  assert_contains "$(cat "$AMAN_HOME/state/instances/main.conf")" "secrets=1"
  assert_tree_lacks "$AMAN_HOME" "$key"
  sandbox_drop
}

test_an_encrypted_disk_gets_no_warning() {
  t_begin "a computer whose disk is already encrypted is not told to turn disk encryption on"
  sandbox_new
  STUB_DISK_ENCRYPTED=1 install_machine
  assert_eq "$(shown_key "$OUT")" "000001-222222-333333-444444-555555-666666-777777-888888"
  assert_not_contains "$OUT$ERR" "disk encryption"
  sandbox_drop
}

test_a_later_run_does_not_set_up_again() {
  t_begin "a later run and an upgrade leave the key and the instance alone, and show no recovery key"
  sandbox_new
  install_machine
  install_machine
  assert_eq "$(setup_runs)" 1 "setup ran once"
  assert_eq "$(shown_key "$OUT")" "" "no key on the second run"
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_eq "$(setup_runs)" 1 "an upgrade does not run it again"
  assert_eq "$(shown_key "$OUT")" ""
  sandbox_drop
}

test_an_older_instance_is_set_up_on_upgrade() {
  t_begin "an instance from before the key is stopped, set up and shown its recovery key on its next upgrade"
  sandbox_new
  install_machine
  local conf=$AMAN_HOME/state/instances/main.conf
  grep -v '^secrets=' "$conf" >"$conf.new" && mv "$conf.new" "$conf"
  chmod 600 "$conf"
  rm -f "$SB_STATE/secrets_aman-main" "$SB_STATE/key"
  grep -Fxv aman_key "$SB_STATE/volumes" >"$SB_STATE/volumes.new" && mv "$SB_STATE/volumes.new" "$SB_STATE/volumes"
  : >"$STUB_LOG"
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_log_has "stop app"
  assert_eq "$(grep -n ' stop app\| secrets-setup init ' "$STUB_LOG" | head -n 1 | grep -c 'stop app')" 1 "the old app stops before setup touches its data"
  assert_eq "$(shown_key "$OUT")" "000002-222222-333333-444444-555555-666666-777777-888888"
  assert_contains "$(cat "$conf")" "secrets=1"
  assert_flat_contains "$OUT" "Instance main is running and answering"
  sandbox_drop
}

test_a_second_instance_shares_the_key_and_gets_its_own_recovery_key() {
  t_begin "a second instance uses the same key and gets a recovery key of its own, with no second disk warning"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
$SENTINEL_PASSWORD
"
  run_install instance add work --email work@example.invalid
  assert_rc 0
  assert_eq "$(wc -l <"$SB_STATE/key_made_by" | tr -d ' ')" 1 "the key was made once"
  assert_eq "$(shown_key "$OUT")" "000002-222222-333333-444444-555555-666666-777777-888888"
  assert_not_contains "$OUT$ERR" "Turn on disk encryption" "the warning belongs to the run that made the key"
  sandbox_drop
}

test_the_key_is_typed_back_at_a_terminal() {
  t_begin "at a terminal the recovery key is asked back, a wrong one is refused, and the right one is accepted"
  sandbox_new
  install_machine
  run_install_tty "Your email=>work@example.invalid
What should Aman call you?=>
Enter a password for work@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD
Recovery key=>000002-222222-333333-444444-555555-666666-777777-000000
Recovery key=>000002 222222 333333 444444 555555 666666 777777 888888" instance add work
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "Type the recovery key back now, so you know your copy is right."
  assert_flat_contains "$OUT" "That does not match. Check each group of six digits and type it again."
  assert_flat_contains "$OUT" "That matches. Keep it somewhere safe."
  assert_log_has "secrets-setup check-recovery"
  assert_flat_contains "$OUT" "Instance work is ready."
  sandbox_drop
}

test_a_failed_setup_stops_before_the_app_starts() {
  t_begin "when setup fails the app is not started and the person is told what to do"
  sandbox_new
  STUB_SECRETS_FAIL=1 install_machine 2>/dev/null || true
  assert_flat_contains "$OUT$ERR" "The key that protects saved logins could not be set up for main."
  assert_flat_contains "$OUT$ERR" "Run the installer again."
  assert_no_path "$SB_STATE/up/aman-main"
  assert_not_contains "$(cat "$AMAN_HOME/state/instances/main.conf" 2>/dev/null)" "secrets=1"
  sandbox_drop
}

test_data_from_another_key_is_not_started() {
  t_begin "data that belongs to another computer's key is not started, and the person is pointed at restore"
  sandbox_new
  install_machine
  local conf=$AMAN_HOME/state/instances/main.conf
  grep -v '^secrets=' "$conf" >"$conf.new" && mv "$conf.new" "$conf"
  chmod 600 "$conf"
  echo "another-key" >"$SB_STATE/key"
  repo_commit_change "app change"
  run_install upgrade
  assert_flat_contains "$OUT$ERR" "was protected with a key from another computer"
  assert_flat_contains "$OUT$ERR" "install.sh restore"
  sandbox_drop
}

test_removing_the_last_instance_removes_the_key() {
  t_begin "the key goes only with the last instance's data"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
$SENTINEL_PASSWORD
"
  run_install instance add work --email work@example.invalid
  assert_rc 0
  run_install instance remove work --purge-data --confirm-name work
  assert_rc 0
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_key" "another instance still needs it"
  run_install instance remove main --purge-data --confirm-name main
  assert_rc 0
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_key" "nothing is left to open with it"
  sandbox_drop
}

test_a_paid_key_in_the_settings_file_is_moved_after_a_good_start() {
  t_begin "a paid-account key typed into the settings file is saved encrypted after the app started with it, and its line is removed"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  printf '%s\n' 'MY_OWN_SETTING=kept' 'NEBIUS_API_KEY="made-up-model-key-0123456789"' >>"$env"
  : >"$STUB_LOG"
  run_install --yes instance refresh main
  assert_rc 0
  assert_eq "$(grep -n ' up -d \| secrets-setup env put ' "$STUB_LOG" | grep 'aman-main' | head -n 1 | grep -c ' up -d ')" 1 "the app starts with the key before it is moved"
  assert_eq "$(saved_key main NEBIUS_API_KEY)" "$(key_digest made-up-model-key-0123456789)" "saved without the quotes"
  assert_not_contains "$(cat "$env")" "NEBIUS_API_KEY" "the line is gone"
  assert_contains "$(cat "$env")" "MY_OWN_SETTING=kept" "other lines stay"
  assert_mode "$env" 600
  assert_tree_lacks "$AMAN_HOME" "made-up-model-key-0123456789"
  assert_tree_lacks "$STUB_LOG" "made-up-model-key-0123456789"
  assert_flat_contains "$OUT" "The paid-account keys of main are now kept encrypted, and no longer in its settings file."
  sandbox_drop
}

test_a_version_from_before_saved_keys_keeps_the_settings_file() {
  t_begin "with a version that cannot keep keys encrypted, the key stays in the settings file where that version reads it"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env
  printf '%s\n' 'TWILIO_AUTH_TOKEN=made-up-twilio-token' >>"$env"
  STUB_SAVED_ENV_OLD=1 run_install --yes instance refresh main
  assert_rc 0
  assert_contains "$(cat "$env")" "TWILIO_AUTH_TOKEN=made-up-twilio-token" "the line stays"
  assert_eq "$(saved_key main TWILIO_AUTH_TOKEN)" "" "nothing was saved"
  assert_not_contains "$OUT" "are now kept encrypted"
  sandbox_drop
}

test_install_sets_up_the_key_before_the_app_starts
test_an_encrypted_disk_gets_no_warning
test_a_later_run_does_not_set_up_again
test_an_older_instance_is_set_up_on_upgrade
test_a_second_instance_shares_the_key_and_gets_its_own_recovery_key
test_the_key_is_typed_back_at_a_terminal
test_a_failed_setup_stops_before_the_app_starts
test_data_from_another_key_is_not_started
test_removing_the_last_instance_removes_the_key
test_a_paid_key_in_the_settings_file_is_moved_after_a_good_start
test_a_version_from_before_saved_keys_keeps_the_settings_file
tests_finish
