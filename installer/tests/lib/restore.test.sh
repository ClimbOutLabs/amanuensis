#!/usr/bin/env bash
# aman restore: from the latest backup, by time or from the list; refusals; the undo when the start fails; other instances.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# What the instance holds now, as the stub's backup command sees it.
set_state() { printf '%s\n' "$1" >"$SB_STATE/db_gen"; }
backup_dirs() { find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | sort; }
backup_count() { backup_dirs | wc -l | tr -d ' '; }
restored_db() { cat "$SB_STATE/restored_aman_${1:-main}_data"; }
restored_memory() { cat "$SB_STATE/volfs/aman_${1:-main}_data/data/memory/note.md"; }
restored_login() { cat "$SB_STATE/volfs/aman_${1:-main}_dex/data/TAR-OF-aman_${1:-main}_dex"; }
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
  assert_contains "$(restored_db)" "SQLITE-OF-aman_main_data-one"
  assert_contains "$(restored_memory)" "memory-one"
  assert_contains "$(restored_login)" "dex-one"
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
  assert_contains "$(restored_db)" "SQLITE-OF-aman_main_data-one"
  assert_contains "$(restored_memory)" "memory-one"
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
  assert_contains "$(restored_db)" "SQLITE-OF-aman_main_data-one" "number 2 is the older backup"
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
  assert_contains "$(restored_db)" "SQLITE-OF-aman_main_data-two"
  assert_contains "$(restored_memory)" "memory-two"
  assert_contains "$(restored_login)" "dex-two"
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
  assert_contains "$(restored_db)" "SQLITE-OF-aman_main_data-one"
  assert_contains "$(cat "$(backup_dirs | tail -n 1)/main/db.sqlite")" "SQLITE-OF-aman_main_data-two"
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
test_nothing_to_restore
tests_finish
