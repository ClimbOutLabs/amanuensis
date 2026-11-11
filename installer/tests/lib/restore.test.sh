#!/usr/bin/env bash
# aman restore: from the latest backup, by time or from the list; refusals; the undo when the start fails; other instances.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# What the instance holds now, as the stub's backup command sees it.
set_state() { printf '%s\n' "$1" >"$SB_STATE/db_gen"; }
backup_dirs() { find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | sort; }
backup_count() { backup_dirs | wc -l | tr -d ' '; }
restored_db() { cat "$SB_STATE/restored_aman_${1}_data"; }
restored_memory() { cat "$SB_STATE/volfs/aman_${1}_data/data/memory/note.md"; }
restored_login() { cat "$SB_STATE/volfs/aman_${1}_dex/data/TAR-OF-aman_${1}_dex"; }
add_instance() {
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add "$1" --yes --password-stdin --email "$1@example.invalid"
  clear_input
}
# Writes the checksum list of a backup again, after a test has changed a file in it.
resum() {
  local sums
  sums=$(cd "$1" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum)
  printf '%s\n' "$sums" >"$1/SHA256SUMS"
}
# Two backups of "main": the first when it held "one", the second when it held "two"; it then holds "three".
two_backups() {
  set_state one
  run_install backup
  set_state two
  run_install backup
  set_state three
  FIRST=$(backup_dirs | head -n 1)
  SECOND=$(backup_dirs | tail -n 1)
}

test_restore_latest() {
  t_begin "restore --latest puts back the newest backup: data, settings and login, with the settings private"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  set_state two
  printf 'CHANGED_SINCE=1\n' >>"$AMAN_HOME/instances/main/.env"
  with_input "yes
"
  run_install restore --latest
  assert_rc 0
  assert_flat_contains "$OUT" "This replaces the current chats and settings of main with the backup from"
  assert_flat_contains "$OUT" "A copy of the current state is saved first."
  assert_contains "$ERR" "Type yes to continue:"
  assert_contains "$(restored_db main)" "SQLITE-OF-aman_main_data-one"
  assert_contains "$(restored_memory main)" "memory-one"
  assert_contains "$(restored_login main)" "dex-one"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "CHANGED_SINCE"
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  assert_mode "$AMAN_HOME/instances/main/dex.env" 600
  assert_eq "$(backup_count)" 2 "the copy of the current state is a second backup"
  assert_contains "$(cat "$(backup_dirs | tail -n 1)/main/db.sqlite")" "SQLITE-OF-aman_main_data-two"
  assert_contains "$OUT" "$(backup_dirs | tail -n 1)" "the saved copy is named"
  assert_contains "$OUT" "is running"
  assert_file "$SB_STATE/up/aman-main"
  assert_contains "$(grep 'restore-tar aman_main_dex' "$SB_STATE/restore_runs")" "--user 0:0" "the login data keeps its owners"
  assert_not_contains "$(grep 'restore-tar aman_main_data' "$SB_STATE/restore_runs")" "--user" "the app data belongs to the app's user"
  assert_log_lacks "--network host"
  sandbox_drop
}

test_restore_by_time() {
  t_begin "restore <time> restores that backup and not the newest"
  sandbox_new
  install_machine
  two_backups
  with_input "yes
"
  run_install restore main "$(basename "$FIRST")"
  assert_rc 0
  assert_contains "$(restored_db main)" "SQLITE-OF-aman_main_data-one"
  assert_contains "$(restored_memory main)" "memory-one"
  assert_flat_contains "$OUT" "with the backup from $(printf '%s' "$(basename "$FIRST")" | sed 's/^\(....\)\(..\)\(..\)T\(..\)\(..\).*/\1-\2-\3 \4:\5/') UTC"
  sandbox_drop
}

test_restore_asks_which_backup() {
  t_begin "with no arguments restore lists the backups newest first and restores the number typed"
  sandbox_new
  install_machine
  two_backups
  with_input "2
yes
"
  run_install restore
  assert_rc 0
  assert_contains "$ERR" "Backups of main, newest first:"
  assert_contains "$ERR" "Restore which backup (number):"
  assert_contains "$ERR" "  1. "
  assert_contains "$ERR" "  2. "
  assert_contains "$ERR" " KB"
  assert_contains "$(restored_db main)" "SQLITE-OF-aman_main_data-one" "number 2 is the older backup"
  with_input "7
"
  run_install restore
  assert_rc 1
  assert_flat_contains "$ERR" "There is no backup number 7. Nothing was changed."
  sandbox_drop
}

test_restore_needs_a_yes() {
  t_begin "anything but yes changes nothing, and --yes does not answer for the person"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  set_state two
  with_input "no
"
  run_install restore --latest
  assert_rc 0
  assert_contains "$OUT" "Nothing was changed."
  run_install restore --latest --yes
  assert_contains "$OUT" "Nothing was changed."
  assert_no_path "$SB_STATE/restores"
  assert_no_path "$SB_STATE/restore_runs"
  assert_eq "$(backup_count)" 1
  sandbox_drop
}

test_refuses_an_incomplete_backup() {
  t_begin "a backup with a missing part, a changed file or no checksum list is refused before anything is touched"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  local dir
  dir=$(backup_dirs | head -n 1)
  rm "$dir/main/dex.tar"
  with_input "yes
"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "cannot be used because part of it is missing. Nothing was changed."
  assert_flat_contains "$ERR" "Pick another one with: aman restore main"
  printf 'x\n' >"$dir/main/dex.tar"
  run_install restore --latest
  assert_flat_contains "$ERR" "because it was copied only in part or has been changed"
  rm "$dir/SHA256SUMS"
  run_install restore --latest
  assert_flat_contains "$ERR" "because its list of checks is missing or damaged"
  assert_no_path "$SB_STATE/restores"
  assert_no_path "$SB_STATE/restore_runs"
  assert_eq "$(backup_count)" 1 "no copy of the current state was made"
  assert_log_lacks "down"
  sandbox_drop
}

test_refuses_a_newer_backup() {
  t_begin "a backup from a newer installer is refused in plain words"
  sandbox_new
  install_machine
  run_install backup
  local dir
  dir=$(backup_dirs | head -n 1)
  sed -i.bak 's/"schema": "1"/"schema": "2"/' "$dir/release.json" && rm "$dir/release.json.bak"
  resum "$dir"
  with_input "yes
"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "cannot be used because it was made by a newer version of Aman than this one. Nothing was changed."
  assert_flat_contains "$ERR" "Update Aman with aman upgrade"
  sed -i.bak 's/"schema": "2"/"schema": "1"/' "$dir/release.json" && rm "$dir/release.json.bak"
  sed -i.bak 's/"version":1/"version":2/' "$dir/main/manifest.json" && rm "$dir/main/manifest.json.bak"
  resum "$dir"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "made by a newer version of Aman"
  assert_no_path "$SB_STATE/restores"
  sandbox_drop
}

test_start_failure_puts_the_old_state_back() {
  t_begin "when the instance will not start, its data and settings go back to what they were and one sentence says so"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  set_state two
  printf 'CHANGED_SINCE=1\n' >>"$AMAN_HOME/instances/main/.env"
  STUB_UP_FAIL_ONCE=1
  with_input "yes
"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR$OUT" "The restore did not work, so main was put back the way it was."
  assert_contains "$(restored_db main)" "SQLITE-OF-aman_main_data-two"
  assert_contains "$(restored_memory main)" "memory-two"
  assert_contains "$(restored_login main)" "dex-two"
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "CHANGED_SINCE=1"
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  assert_file "$SB_STATE/up/aman-main"
  assert_eq "$(backup_count)" 2
  sandbox_drop
}

test_failed_data_restore_and_failed_undo() {
  t_begin "a failed data copy is undone too, and when the undo fails the saved copy and the command to use are named"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  set_state two
  STUB_RESTORE_FAIL=aman_main_dex
  with_input "yes
"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "The restore did not work and main could not be put back by itself."
  assert_flat_contains "$ERR" "A copy of it from before is at $(backup_dirs | tail -n 1)."
  assert_flat_contains "$ERR" "Run: aman restore main $(basename "$(backup_dirs | tail -n 1)")"
  sandbox_drop
}

test_other_instances_are_untouched() {
  t_begin "restoring one instance leaves another one's volumes, files and containers alone"
  sandbox_new
  install_machine
  add_instance second
  assert_rc 0
  set_state one
  run_install backup
  set_state two
  local before after
  before=$(cat "$AMAN_HOME/instances/second/.env" "$AMAN_HOME/instances/second/dex.env" "$AMAN_HOME/instances/second/compose.yaml")
  : >"$STUB_LOG"
  with_input "yes
"
  run_install restore main --latest
  assert_rc 0
  after=$(cat "$AMAN_HOME/instances/second/.env" "$AMAN_HOME/instances/second/dex.env" "$AMAN_HOME/instances/second/compose.yaml")
  assert_eq "$after" "$before" "second's files"
  assert_no_path "$SB_STATE/restored_aman_second_data"
  assert_no_path "$SB_STATE/volfs/aman_second_data"
  assert_no_path "$SB_STATE/volfs/aman_second_dex"
  assert_log_lacks "aman-second"
  assert_log_lacks "aman_second_"
  assert_eq "$(dir_names "$(backup_dirs | tail -n 1)")" "SHA256SUMS main release.json " "the saved copy covers main only"
  assert_file "$SB_STATE/up/aman-second"
  run_install restore
  assert_rc 1
  assert_flat_contains "$ERR" "There is more than one instance here (main, second). Next: Say which one: aman restore <name>"
  sandbox_drop
}

test_missing_settings_file_is_put_back() {
  t_begin "an instance whose settings file is gone can be restored, and the saved copy still holds its data"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  set_state two
  rm "$AMAN_HOME/instances/main/.env"
  with_input "yes
"
  run_install restore --latest
  assert_rc 0
  assert_file "$AMAN_HOME/instances/main/.env"
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  assert_contains "$(restored_db main)" "SQLITE-OF-aman_main_data-one"
  assert_contains "$(cat "$(backup_dirs | tail -n 1)/main/db.sqlite")" "SQLITE-OF-aman_main_data-two"
  sandbox_drop
}

test_kept_backups() {
  t_begin "a kept backup is listed with its name and can be restored, and the copy a restore saves is kept apart from the seven"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  # A kept backup as an import leaves it: the same parts, named after its time.
  KEPT="$(backup_dirs | head -n 1)-before-import"
  cp -R "$(backup_dirs | head -n 1)" "$KEPT"
  rm -rf "$(backup_dirs | head -n 1)"
  set_state two
  local i
  for i in 1 2 3 4 5 6 7; do
    run_install backup
  done
  assert_eq "$(backup_dirs | grep -vc -- '-before-')" 7 "seven plain backups"
  OLDEST=$(backup_dirs | grep -v -- '-before-' | head -n 1)
  set_state three
  with_input "yes
"
  run_install restore main "$(basename "$KEPT")"
  assert_rc 0
  assert_flat_contains "$OUT" "with the backup from $(basename "$KEPT" | sed 's/^\(....\)\(..\)\(..\)T\(..\)\(..\).*/\1-\2-\3 \4:\5/') UTC (before import)."
  assert_contains "$(restored_db main)" "SQLITE-OF-aman_main_data-one"
  UNDO=$(backup_dirs | grep -- '-before-restore$')
  assert_contains "$(cat "$UNDO/main/db.sqlite")" "SQLITE-OF-aman_main_data-three" "the copy holds the state before the restore"
  assert_contains "$OUT" "go back with: aman restore main $(basename "$UNDO")"
  [ -d "$OLDEST" ] || t_fail "the copy pushed the oldest plain backup out"
  assert_eq "$(backup_dirs | grep -vc -- '-before-')" 7 "still seven plain backups"
  with_input "1
no
"
  run_install restore
  assert_contains "$ERR" "(before restore)"
  assert_contains "$ERR" "(before import)"
  sandbox_drop
}

test_nothing_to_restore() {
  t_begin "no backup, an unknown instance and a bad time are told in plain words"
  sandbox_new
  install_machine
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "There is no backup of main yet. Next: Make one with: aman backup main"
  run_install restore nosuch --latest
  assert_rc 1
  assert_flat_contains "$ERR" "There is no instance named nosuch."
  run_install backup
  run_install restore main 20000101T000000Z
  assert_rc 1
  assert_flat_contains "$ERR" "There is no backup of main from 20000101T000000Z."
  run_install restore main 20000101T000000Z --latest
  assert_rc 2
  run_install backup --latest
  assert_rc 2
  assert_flat_contains "$ERR" "--latest applies to restore"
  sandbox_drop
}

# The value of KEY that Compose reads from an instance's settings: the last line.
env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | tail -n 1; }
reg_value() { sed -n "s/^$2=//p" "$AMAN_HOME/state/instances/$1.conf" | tail -n 1; }
dex_client_id() { sed -n 's/^ *- id: //p' "$AMAN_HOME/instances/$1/dex.yaml" | head -n 1; }

test_restore_on_a_new_install_keeps_sign_in_working() {
  t_begin "a backup restored on a new install gets this install's sign-in client, cookie and addresses, and keeps its own secrets and owner"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  local saved old_secret old_key old_client
  saved=$(mktemp -d)
  cp -R "$AMAN_HOME/backups/." "$saved/"
  old_secret=$(env_value main OIDC_CLIENT_SECRET)
  old_key=$(env_value main TRUEFORGE_API_KEY)
  old_client=$(env_value main OIDC_CLIENT_ID)
  sandbox_drop
  # A new computer: a fresh install with its own sign-in client and another email, then the old backup copied in.
  sandbox_new
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email new@example.invalid
  assert_rc 0
  mkdir -p "$AMAN_HOME/backups"
  cp -R "$saved/." "$AMAN_HOME/backups/"
  rm -rf "$saved"
  local new_client new_cookie
  new_client=$(reg_value main client_id)
  new_cookie=$(reg_value main cookie_suffix)
  [ "$new_client" != "$old_client" ] || t_fail "the fresh install made a new sign-in client"
  with_input "yes
"
  run_install restore --latest
  assert_rc 0
  assert_flat_contains "$OUT" "You then sign in as owner@example.invalid, the email the backup was made with, not as new@example.invalid."
  assert_eq "$(env_value main OIDC_CLIENT_ID)" "$new_client" "the app's sign-in client"
  assert_eq "$(dex_client_id main)" "$new_client" "the sign-in service's client"
  assert_eq "$(env_value main AUTH_COOKIE_SUFFIX)" "$new_cookie" "the cookie name"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "$(reg_value main public_url)" "the app's address"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "$(reg_value main login_url)/dex" "the sign-in address"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$(reg_value main origins)" "the addresses other devices use"
  assert_eq "$(env_value main OIDC_CLIENT_SECRET)" "$old_secret" "the backup's client secret, which the app and the sign-in service both read"
  assert_eq "$(env_value main TRUEFORGE_API_KEY)" "$old_key" "the backup's own key"
  assert_eq "$(reg_value main owner_email)" owner@example.invalid "the owner of the chats"
  assert_eq "$(env_value main OIDC_ADMIN_ROLE_VALUE)" owner@example.invalid
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" owner@example.invalid
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "email: 'owner@example.invalid'" "the sign-in service knows the backup's owner"
  assert_contains "$(restored_db main)" "SQLITE-OF-aman_main_data-one"
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  sandbox_drop
}

test_restore_takes_this_installs_addresses() {
  t_begin "settings a backup holds for another place (addresses, proxy, a hand-made client id) give way to this install's record"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  local dir env
  dir=$(backup_dirs | head -n 1)
  env=$dir/main/env
  sed -i.bak -e 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=http://old.example.invalid:9999|' "$env" && rm "$env.bak"
  awk '/^# <<< end of managed block/ { print "ALLOWED_ORIGINS=http://old.example.invalid:9999"; print "LOGIN_UPSTREAM_URL=http://127.0.0.1:1/dex"; print "TRUSTED_PROXY_ADDRESSES=172.99.0.1" } { print }' "$env" >"$env.new" && mv "$env.new" "$env"
  printf 'OIDC_CLIENT_ID=hand-made\nMY_OWN_SETTING=kept\n' >>"$env"
  resum "$dir"
  with_input "yes
"
  run_install restore --latest
  assert_rc 0
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "$(reg_value main public_url)"
  assert_eq "$(env_value main OIDC_CLIENT_ID)" "$(reg_value main client_id)"
  assert_eq "$(dex_client_id main)" "$(reg_value main client_id)"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$(reg_value main origins)"
  if [ -z "$(reg_value main origins)" ]; then
    assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "ALLOWED_ORIGINS=" "an instance on this computer only lists no other addresses"
  fi
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "old.example.invalid"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "LOGIN_UPSTREAM_URL=http://127.0.0.1:1/dex"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "172.99.0.1"
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "MY_OWN_SETTING=kept" "the person's own settings come back"
  sandbox_drop
}

test_question_says_what_goes_back() {
  t_begin "the question says the password goes back and devices may have to sign in again"
  sandbox_new
  install_machine
  run_install backup
  with_input "no
"
  run_install restore --latest
  assert_rc 0
  assert_flat_contains "$OUT" "The password goes back to the one main had then, and devices signed in now may have to sign in again."
  assert_not_contains "$OUT" "You then sign in as" "the owner is the same"
  sandbox_drop
}

test_no_answer_is_a_failure() {
  t_begin "no answer, with or without --yes, changes nothing and fails with one next step; a typed no succeeds"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  set_state two
  clear_input
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "No answer was given, so nothing was changed. Next: Run aman restore in a terminal and type your answer."
  run_install restore --latest --yes
  assert_rc 1
  assert_flat_contains "$ERR" "No answer was given, so nothing was changed."
  run_install restore
  assert_rc 1
  assert_flat_contains "$ERR" "No answer was given, so nothing was changed."
  assert_no_path "$SB_STATE/restore_runs"
  assert_eq "$(backup_count)" 1
  sandbox_drop
}

test_refuses_a_database_from_a_newer_version() {
  t_begin "a backup whose database a newer version of Aman updated is refused before anything is touched, and an unreadable one too"
  sandbox_new
  install_machine
  run_install backup
  local dir
  dir=$(backup_dirs | head -n 1)
  printf 'NEWER\n' >>"$dir/main/db.sqlite"
  resum "$dir"
  with_input "yes
"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "cannot be used because it was made by a newer version of Aman than this one. Nothing was changed."
  assert_flat_contains "$ERR" "Update Aman with aman upgrade"
  assert_file "$SB_STATE/backup_checks"
  printf 'BROKEN\n' >"$dir/main/db.sqlite"
  resum "$dir"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "cannot be used because its chats cannot be read. Nothing was changed."
  assert_no_path "$SB_STATE/restores"
  assert_eq "$(backup_count)" 1
  sandbox_drop
}

test_app_image_without_the_database_check() {
  t_begin "an app image from before the database check still restores, judged by the version record as before"
  sandbox_new
  install_machine
  run_install backup
  : >"$SB_STATE/image_without_backup_check"
  with_input "yes
"
  run_install restore --latest
  assert_rc 0
  assert_file "$SB_STATE/backup_checks"
  assert_not_contains "$ERR" "cannot be read"
  assert_file "$SB_STATE/restores"
  sandbox_drop
}

test_undo_of_an_instance_without_data() {
  t_begin "undoing a restore of an instance that had no data takes the restored data away again"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  mkdir -p "$SB_STATE/no_db"
  : >"$SB_STATE/no_db/aman_main_data"
  STUB_UP_FAIL_ONCE=1
  with_input "yes
"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR$OUT" "The restore did not work, so main was put back the way it was."
  assert_contains "$(cat "$SB_STATE/restores")" "cleared aman_main_data"
  assert_no_path "$SB_STATE/restored_aman_main_data"
  sandbox_drop
}

test_failed_copy_after_putting_back_missing_files() {
  t_begin "when the copy fails after missing settings were put back, the message says only those were written"
  sandbox_new
  install_machine
  set_state one
  run_install backup
  rm "$AMAN_HOME/instances/main/.env"
  STUB_BACKUP_FAIL=1
  with_input "yes
"
  run_install restore --latest
  assert_rc 1
  assert_flat_contains "$ERR" "so the backup was not put back. Only the missing files main needs to start were written."
  assert_not_contains "$ERR" "nothing was changed"
  assert_eq "$(env_value main OIDC_CLIENT_ID)" "$(reg_value main client_id)" "the settings put back match this install"
  assert_no_path "$SB_STATE/restore_runs"
  sandbox_drop
}

test_restore_latest
test_restore_by_time
test_restore_asks_which_backup
test_restore_needs_a_yes
test_refuses_an_incomplete_backup
test_refuses_a_newer_backup
test_start_failure_puts_the_old_state_back
test_failed_data_restore_and_failed_undo
test_other_instances_are_untouched
test_missing_settings_file_is_put_back
test_kept_backups
test_nothing_to_restore
test_restore_on_a_new_install_keeps_sign_in_working
test_restore_takes_this_installs_addresses
test_question_says_what_goes_back
test_no_answer_is_a_failure
test_refuses_a_database_from_a_newer_version
test_app_image_without_the_database_check
test_undo_of_an_instance_without_data
test_failed_copy_after_putting_back_missing_files
tests_finish
