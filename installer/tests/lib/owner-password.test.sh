#!/usr/bin/env bash
# install.sh instance password: a new owner password, written with the installer's own hashing, and every session ended.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

OWNER=owner@example.invalid
NEW_PASSWORD='a-brand-new-secret-9'
BCRYPT='^[$]2[aby][$][[:digit:]]{2}[$][./A-Za-z0-9]{53}$'

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
  assert_flat_contains "$ERR" "That password still needs at least 8 characters, a number and a symbol"
  assert_eq "$(dex_env)" "$before"
  assert_eq "$(wipes)" ""
  sandbox_drop
}

test_a_number_and_a_symbol_are_needed() {
  t_begin "8 characters with a number and a symbol are accepted; the refusal names only what is missing"
  sandbox_new
  install_machine
  change_password "seven-7
" instance password --password-stdin
  assert_rc 2
  assert_flat_contains "$ERR" "That password still needs at least 8 characters."
  change_password "eight-ch
" instance password --password-stdin
  assert_rc 2
  assert_flat_contains "$ERR" "That password still needs a number."
  change_password "eightch8
" instance password --password-stdin
  assert_rc 2
  assert_flat_contains "$ERR" "That password still needs a symbol"
  change_password "eightchr
" instance password --password-stdin
  assert_rc 2
  assert_flat_contains "$ERR" "That password still needs a number and a symbol"
  change_password "eight ch8
" instance password --password-stdin
  assert_rc 2
  assert_flat_contains "$ERR" "That password still needs a symbol"
  change_password "eight-c8
" instance password --password-stdin
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "eight-c8"
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
  run_install_tty "Enter a new password for $OWNER (not shown):=>wrong-first-time-1
Enter the new password again (not shown):=>not-the-same
Enter a new password for $OWNER (not shown):=>$NEW_PASSWORD
Enter the new password again (not shown):=>$NEW_PASSWORD" instance password
  assert_rc 0
  assert_contains "$OUT" "Enter a new password for $OWNER (not shown):"
  assert_contains "$OUT" "Enter the new password again (not shown):"
  assert_contains "$OUT" "Your password needs:"
  assert_contains "$OUT" "The passwords do not match. Type them again."
  assert_not_contains "$OUT" "$NEW_PASSWORD" "not echoed"
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$NEW_PASSWORD"
  sandbox_drop
}

# The line number of the first docker call containing the text, 0 when there is none.
log_line() { grep -nF -- "$1" "$STUB_LOG" | head -n 1 | cut -d: -f1 | grep . || echo 0; }
dex_stopped() { [ -e "$SB_STATE/dex_stopped_aman-${1:-main}" ]; }
DEX_UP="force-recreate --no-deps --wait --wait-timeout 240 dex"
APP_UP="force-recreate --no-deps --wait --wait-timeout 240 app"

test_sessions_are_signed_out() {
  t_begin "the sign-in service stops, its keys are deleted as the Dex user, then it starts, then the app restarts"
  sandbox_new
  install_machine
  local before_up stop wipe dex app
  before_up=$(log_count "up -d")
  change_password "$NEW_PASSWORD
$NEW_PASSWORD
" instance password
  assert_rc 0
  assert_log_has "--project-name aman-main"
  stop=$(log_line "stop dex")
  wipe=$(log_line "rm -f /var/dex/dex.db")
  dex=$(log_line "$DEX_UP")
  app=$(log_line "$APP_UP")
  if [ "$stop" -gt 0 ] && [ "$stop" -lt "$wipe" ] && [ "$wipe" -lt "$dex" ] && [ "$dex" -lt "$app" ]; then t_pass; else t_fail "order is stop=$stop delete=$wipe dex=$dex app=$app"; fi
  assert_eq "$(wipes)" "aman_main_dex:/var/dex dex.db dex.db-wal dex.db-shm " "the mounted folder and the three database files"
  if grep -Eq 'run --rm --network none --user 1001:1001 -v aman_main_dex:/var/dex --entrypoint sh [^ ]*dex[^ ]* -c rm -f' "$STUB_LOG"; then t_pass; else t_fail "the delete does not run as the Dex user in the Dex image"; fi
  assert_eq "$(( $(log_count "up -d") - before_up ))" 2 "two restarts, nothing else"
  assert_log_lacks "up -d --force-recreate --wait --wait-timeout 240 --no-deps loopback"
  assert_flat_contains "$OUT" "Everyone is signed out of instance main"
  sandbox_drop
}

test_the_stub_refuses_a_delete_that_cannot_work() {
  t_begin "the Docker stand-in refuses the delete in the app image or as another user, as a real volume owned by 1001 does"
  sandbox_new
  install_machine
  local dex_image
  dex_image=$(sed -n 's/.*--entrypoint sh \([^ ]*dex[^ ]*\) -c .*/\1/p' "$STUB_LOG" | head -n 1)
  : "${dex_image:=dexidp/dex}"
  if "$SB_BIN/docker" run --rm --network none -v aman_main_dex:/var/dex --entrypoint sh aman-app:x -c rm -f /var/dex/dex.db >/dev/null 2>&1; then t_fail "the app image deleted it"; else t_pass; fi
  if "$SB_BIN/docker" run --rm --network none --user 10001:10001 -v aman_main_dex:/var/dex --entrypoint sh "$dex_image" -c rm -f /var/dex/dex.db >/dev/null 2>&1; then t_fail "uid 10001 deleted it"; else t_pass; fi
  if "$SB_BIN/docker" run --rm --network none --user 1001:1001 -v aman_main_dex:/var/dex --entrypoint sh "$dex_image" -c rm -f /var/dex/dex.db >/dev/null 2>&1; then t_pass; else t_fail "uid 1001 in the Dex image was refused"; fi
  sandbox_drop
}

# Runs the command with the docker calls containing $1 failing.
change_failing() { # failing text
  with_input "$NEW_PASSWORD
$NEW_PASSWORD
"
  STUB_FAIL_ON=$1
  run_install instance password
  unset STUB_FAIL_ON
  clear_input
}

test_stop_fails() {
  t_begin "if the sign-in service does not stop, nothing changes and the message says the old sign-ins still work"
  sandbox_new
  install_machine
  local before
  before=$(dex_env)
  change_failing "stop dex"
  assert_rc 1
  assert_flat_contains "$ERR" "Nothing was changed: the old password and the old sign-ins still work"
  assert_eq "$(dex_env)" "$before" "the old hash stays"
  assert_eq "$(wipes)" "" "nothing deleted"
  if dex_stopped; then t_fail "the sign-in service was left stopped"; else t_pass; fi
  sandbox_drop
}

test_delete_fails() {
  t_begin "if the keys cannot be deleted, the old password stays, the sign-in service is started again and the message says old sign-ins still work"
  sandbox_new
  install_machine
  local before
  before=$(dex_env)
  change_failing "rm -f /var/dex/dex.db"
  assert_rc 1
  assert_flat_contains "$ERR" "the old password and every old sign-in still work"
  assert_flat_contains "$ERR" "Run aman password again"
  assert_eq "$(dex_env)" "$before" "the old hash stays"
  assert_eq "$(log_count "$DEX_UP")" 1 "the sign-in service was started again"
  assert_eq "$(log_count "$APP_UP")" 0 "the app was not touched"
  if dex_stopped; then t_fail "the sign-in service was left stopped"; else t_pass; fi
  sandbox_drop
}

test_sign_in_service_does_not_start() {
  t_begin "if the sign-in service does not start again, the new password and cleared keys stay and the message says what to run"
  sandbox_new
  install_machine
  local old
  old=$(hash_of)
  change_failing "--wait-timeout 240 dex"
  assert_rc 1
  assert_flat_contains "$ERR" "the old sign-ins ended, but the sign-in service did not start again. Run: aman doctor instance --fix"
  assert_eq "$([ "$(hash_of)" != "$old" ] && echo changed)" changed "the new hash is saved"
  assert_eq "$(wipes)" "aman_main_dex:/var/dex dex.db dex.db-wal dex.db-shm " "the keys are gone"
  if dex_stopped; then t_pass; else t_fail "the sign-in service is not stopped"; fi
  assert_eq "$(log_count "$APP_UP")" 0 "the app waits for the sign-in service"
  sandbox_drop
}

test_app_does_not_start() {
  t_begin "if the app does not restart, the message says old sign-ins can last up to ten minutes"
  sandbox_new
  install_machine
  local old
  old=$(hash_of)
  change_failing "--wait-timeout 240 app"
  assert_rc 1
  assert_flat_contains "$ERR" "old sign-ins can keep working for up to ten minutes. Run: aman doctor instance --fix"
  assert_eq "$([ "$(hash_of)" != "$old" ] && echo changed)" changed "the new hash is saved"
  if dex_stopped; then t_fail "the sign-in service was left stopped"; else t_pass; fi
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
  assert_flat_contains "$ERR" "Aman is not set up on this computer yet. Run install.sh first."
  sandbox_drop
}

test_password_is_changed
test_hash_format_and_mode
test_stdin_takes_one_line
test_short_password_is_refused
test_a_number_and_a_symbol_are_needed
test_wrong_repeat_changes_nothing
test_prompts_on_a_terminal
test_sessions_are_signed_out
test_the_stub_refuses_a_delete_that_cannot_work
test_stop_fails
test_delete_fails
test_sign_in_service_does_not_start
test_app_does_not_start
test_several_instances_need_a_name
test_instance_flag_picks_one
test_unknown_instance
test_not_installed
tests_finish
