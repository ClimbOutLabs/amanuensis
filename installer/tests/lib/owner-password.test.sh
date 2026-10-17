#!/usr/bin/env bash
# install.sh instance password: a new owner password, written with the installer's own hashing, and every session ended.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

OWNER=owner@example.invalid
NEW_PASSWORD='a-brand-new-secret'
BCRYPT='^[$]2[aby][$][0-9]{2}[$][./A-Za-z0-9]{53}$'

dex_env() { cat "$AMAN_HOME/instances/${1:-main}/dex.env"; }
hash_of() { sed -n "s/^DEX_USER_PASSWORD_HASH='\(.*\)'\$/\1/p" "$AMAN_HOME/instances/${1:-main}/dex.env"; }
wipes() { cat "$SB_STATE/dex_wipes" 2>/dev/null || true; }

change_password() { # input, then install.sh arguments
  with_input "$1"
  shift
  run_install "$@"
  clear_input
}

add_second_instance() {
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email second@example.invalid
  clear_input
  [ "$RC" = 0 ] || { printf 'second instance failed: %s %s\n' "$OUT" "$ERR" >&2; return 1; }
}

test_password_is_changed() {
  t_begin "instance password writes the new hash and says how to sign in again"
  sandbox_new
  install_machine
  local old
  old=$(hash_of)
  change_password "$NEW_PASSWORD
$NEW_PASSWORD
" instance password
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$NEW_PASSWORD" "the new password reached the hashing step"
  assert_eq "$([ "$(hash_of)" != "$old" ] && echo changed)" changed "the hash differs from the old one"
  assert_flat_contains "$OUT" "Password changed. Sign in again with the new password."
  assert_flat_contains "$OUT" "Everyone is signed out"
  assert_not_contains "$OUT$ERR" "$NEW_PASSWORD"
  assert_not_contains "$(cat "$STUB_LOG")" "$NEW_PASSWORD" "the password is never on a command line"
  sandbox_drop
}

test_hash_format_and_mode() {
  t_begin "the new hash is a bcrypt hash in the same single-quoted line, and dex.env stays private"
  sandbox_new
  install_machine
  change_password "$NEW_PASSWORD
$NEW_PASSWORD
" instance password
  assert_rc 0
  if printf '%s' "$(hash_of)" | grep -Eq "$BCRYPT"; then t_pass; else t_fail "not a bcrypt hash: $(hash_of)"; fi
  assert_eq "$(dex_env | grep -c '^DEX_USER_PASSWORD_HASH=')" 1 "one hash line"
  assert_contains "$(dex_env)" "# >>> managed by the installer"
  assert_mode "$AMAN_HOME/instances/main/dex.env" 600
  assert_eq "$(dir_names "$AMAN_HOME/instances/main" | tr ' ' '\n' | grep -c '^dex.env.')" 0 "no temporary copy is left behind"
  sandbox_drop
}

test_stdin_takes_one_line() {
  t_begin "--password-stdin reads the password from the first line"
  sandbox_new
  install_machine
  change_password "$NEW_PASSWORD
" instance password --password-stdin
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$NEW_PASSWORD"
  assert_flat_contains "$OUT" "Password changed."
  sandbox_drop
}

test_short_password_is_refused() {
  t_begin "a password that is too short changes nothing"
  sandbox_new
  install_machine
  local before
  before=$(dex_env)
  change_password "short
" instance password --password-stdin
  assert_rc 2
  assert_flat_contains "$ERR" "The password needs at least 8 characters."
  assert_eq "$(dex_env)" "$before"
  assert_eq "$(wipes)" ""
  sandbox_drop
}

test_wrong_repeat_changes_nothing() {
  t_begin "a repeat that does not match changes nothing"
  sandbox_new
  install_machine
  local before
  before=$(dex_env)
  change_password "$NEW_PASSWORD
another-different-one
" instance password
  assert_rc 1
  assert_flat_contains "$ERR" "The passwords do not match."
  assert_eq "$(dex_env)" "$before" "the old hash stays"
  assert_eq "$(wipes)" "" "nobody is signed out"
  assert_log_lacks "force-recreate --no-deps --wait --wait-timeout 240 dex"
  sandbox_drop
}

test_prompts_on_a_terminal() {
  t_begin "on a terminal it asks for the new password twice, not shown, and a wrong repeat asks again"
  sandbox_new
  install_machine
  run_install_tty "New password for $OWNER:=>wrong-first-time
Repeat the new password:=>not-the-same
New password for $OWNER:=>$NEW_PASSWORD
Repeat the new password:=>$NEW_PASSWORD" instance password
  assert_rc 0
  assert_contains "$OUT" "New password for $OWNER:"
  assert_contains "$OUT" "Repeat the new password:"
  assert_contains "$OUT" "The passwords do not match. Type them again."
  assert_not_contains "$OUT" "$NEW_PASSWORD" "not echoed"
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$NEW_PASSWORD"
  sandbox_drop
}

test_sessions_are_signed_out() {
  t_begin "only the sign-in service and the app restart, and the sign-in keys are cleared so old sessions end"
  sandbox_new
  install_machine
  local before_up
  before_up=$(log_count "up -d")
  change_password "$NEW_PASSWORD
$NEW_PASSWORD
" instance password
  assert_rc 0
  assert_contains "$(wipes)" "aman_main_dex" "the sign-in service's saved keys are cleared"
  assert_log_has "--project-name aman-main"
  assert_log_has "stop dex"
  assert_log_has "up -d --force-recreate --no-deps --wait --wait-timeout 240 dex"
  assert_log_has "up -d --force-recreate --no-deps --wait --wait-timeout 240 app"
  assert_eq "$(( $(log_count "up -d") - before_up ))" 2 "two restarts, nothing else"
  assert_log_lacks "up -d --force-recreate --wait --wait-timeout 240 --no-deps loopback"
  assert_flat_contains "$OUT" "Everyone is signed out of instance main"
  sandbox_drop
}

test_several_instances_need_a_name() {
  t_begin "with several instances it asks which one and changes none"
  sandbox_new
  install_machine
  add_second_instance
  local main_before second_before
  main_before=$(dex_env main)
  second_before=$(dex_env second)
  change_password "$NEW_PASSWORD
$NEW_PASSWORD
" instance password
  assert_rc 2
  assert_flat_contains "$ERR" "several instances exist (main second); say which with --instance NAME"
  assert_eq "$(dex_env main)" "$main_before"
  assert_eq "$(dex_env second)" "$second_before"
  sandbox_drop
}

test_instance_flag_picks_one() {
  t_begin "--instance NAME changes only that instance, and the name can also follow the command"
  sandbox_new
  install_machine
  add_second_instance
  local main_before second_before
  main_before=$(dex_env main)
  second_before=$(hash_of second)
  change_password "$NEW_PASSWORD
$NEW_PASSWORD
" instance password --instance second
  assert_rc 0
  assert_eq "$(dex_env main)" "$main_before" "the other instance is untouched"
  assert_eq "$([ "$(hash_of second)" != "$second_before" ] && echo changed)" changed
  assert_contains "$(wipes)" "aman_second_dex"
  assert_not_contains "$(wipes)" "aman_main_dex"
  second_before=$(hash_of second)
  change_password "another-secret-2
another-secret-2
" instance password main
  assert_rc 0
  assert_eq "$([ "$(hash_of main)" != "$(printf '%s' "$main_before" | sed -n "s/^DEX_USER_PASSWORD_HASH='\(.*\)'\$/\1/p")" ] && echo changed)" changed "the positional name works for scripts"
  assert_eq "$(hash_of second)" "$second_before"
  sandbox_drop
}

test_unknown_instance() {
  t_begin "an instance that does not exist is named, and nothing happens"
  sandbox_new
  install_machine
  change_password "$NEW_PASSWORD
$NEW_PASSWORD
" instance password --instance ghost
  assert_rc 1
  assert_flat_contains "$ERR" "instance ghost does not exist"
  assert_eq "$(wipes)" ""
  sandbox_drop
}

test_not_installed() {
  t_begin "on a computer without Aman it says to install first"
  sandbox_new
  with_input "$NEW_PASSWORD
$NEW_PASSWORD
"
  run_install instance password
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "this machine is not set up yet; run install.sh first"
  sandbox_drop
}

test_password_is_changed
test_hash_format_and_mode
test_stdin_takes_one_line
test_short_password_is_refused
test_wrong_repeat_changes_nothing
test_prompts_on_a_terminal
test_sessions_are_signed_out
test_several_instances_need_a_name
test_instance_flag_picks_one
test_unknown_instance
test_not_installed
tests_finish
