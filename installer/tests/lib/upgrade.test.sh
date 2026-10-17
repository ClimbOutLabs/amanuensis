#!/usr/bin/env bash
# Upgrade: no-op, check, success, and the restore path on failure.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

app_tag() { sed -n 's/.*"app_image": "\([^"]*\)".*/\1/p' "$1"; }
compose_image() { sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$AMAN_HOME/instances/$1/compose.yaml" | head -n 1; }

test_noop_when_current() {
  t_begin "upgrade with nothing new says so and rebuilds nothing"
  sandbox_new
  install_machine
  local builds
  builds=$(log_count "docker build")
  run_install upgrade
  assert_rc 0
  assert_contains "$OUT" "Already up to date"
  assert_eq "$(log_count "docker build")" "$builds"
  sandbox_drop
}

test_check_reports_without_changing() {
  t_begin "upgrade --check shows the change and touches nothing"
  sandbox_new
  install_machine
  local old builds
  old=$(app_tag "$AMAN_HOME/release/release.json")
  builds=$(log_count "docker build")
  repo_commit_change "speech update"
  run_install upgrade --check
  assert_rc 0
  assert_contains "$OUT" "speech  aman-stt:"
  assert_eq "$(log_count "docker build")" "$builds"
  assert_eq "$(app_tag "$AMAN_HOME/release/release.json")" "$old"
  assert_no_path "$AMAN_HOME/backups"
  sandbox_drop
}

test_successful_upgrade_backs_up_first() {
  t_begin "upgrade backs up, then rebuilds, then restarts on the new images"
  sandbox_new
  install_machine
  local old new
  old=$(app_tag "$AMAN_HOME/release/release.json")
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  new=$(app_tag "$AMAN_HOME/release/release.json")
  if [ "$new" != "$old" ]; then t_pass; else t_fail "release not updated"; fi
  assert_eq "$(app_tag "$AMAN_HOME/release/previous.release.json")" "$old" "previous release kept"
  assert_eq "$(compose_image main)" "$new" "instance runs the new image"
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 1 "one backup"
  local backup_line build_line up_line
  backup_line=$(grep -n 'aman backup --target' "$STUB_LOG" | tail -n 1 | cut -d: -f1)
  build_line=$(grep -n 'docker build' "$STUB_LOG" | tail -n 1 | cut -d: -f1)
  up_line=$(grep -n 'aman-main.* up -d' "$STUB_LOG" | tail -n 1 | cut -d: -f1)
  if [ "$backup_line" -lt "$build_line" ] && [ "$build_line" -lt "$up_line" ]; then t_pass; else t_fail "order was backup=$backup_line build=$build_line up=$up_line"; fi
  assert_log_lacks "docker push"
  assert_eq "$(cat "$SB_STATE/restores" 2>/dev/null || true)" "" "nothing restored on success"
  sandbox_drop
}

test_failed_upgrade_restores_database_and_images() {
  t_begin "a failed health check restores the database and the previous images"
  sandbox_new
  install_machine
  local old
  old=$(app_tag "$AMAN_HOME/release/release.json")
  repo_commit_change "bad app change"
  STUB_UP_FAIL_UNLESS_TAG=$old
  run_install upgrade
  assert_rc 1
  assert_flat_contains "$ERR" "restoring the previous version"
  assert_contains "$OUT" "Rolled back to the previous version"
  assert_eq "$(app_tag "$AMAN_HOME/release/release.json")" "$old" "release record restored"
  assert_eq "$(compose_image main)" "$old" "compose points at the previous image"
  assert_contains "$(cat "$SB_STATE/restores")" "restore aman_main_data"
  assert_contains "$(cat "$SB_STATE/restored_aman_main_data")" "SQLITE-OF" "database content comes from the backup"
  assert_log_has "run --rm -i --network none -v aman_main_data:/data $old sh -c"
  assert_eq "$(cat "$SB_STATE/up/aman-main")" "$old" "stack running on the previous image"
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 1 "backup kept"
  assert_no_path "$AMAN_HOME/state/lock"
  run_install upgrade --check
  assert_rc 0
  sandbox_drop
}

test_restore_goes_only_into_the_right_volume() {
  t_begin "with two instances each database is restored into its own volume and no other"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email second@example.invalid
  clear_input
  assert_rc 0
  local old
  old=$(app_tag "$AMAN_HOME/release/release.json")
  repo_commit_change "unhealthy change for two"
  STUB_UP_FAIL_UNLESS_TAG=$old
  run_install upgrade
  assert_rc 1
  assert_eq "$(sort "$SB_STATE/restores" | tr '\n' ',')" "restore aman_main_data,restore aman_second_data," "one restore per instance"
  assert_eq "$(cat "$SB_STATE/restored_aman_main_data")" "SQLITE-OF-aman_main_data" "main gets main's database"
  assert_eq "$(cat "$SB_STATE/restored_aman_second_data")" "SQLITE-OF-aman_second_data" "second gets second's database"
  assert_eq "$(find "$SB_STATE" -maxdepth 1 -name 'restored_*' | wc -l | tr -d ' ')" 2 "no other volume was written"
  assert_not_contains "$(cat "$STUB_LOG")" "restored_" "no restore touches a dex volume"
  sandbox_drop
}

test_restore_does_not_wait_for_a_migration_marker() {
  t_begin "the database is restored even when no migration ran"
  sandbox_new
  install_machine
  local old
  old=$(app_tag "$AMAN_HOME/release/release.json")
  repo_commit_change "unhealthy change"
  STUB_UP_FAIL_UNLESS_TAG=$old
  run_install upgrade
  assert_rc 1
  assert_contains "$(cat "$SB_STATE/restores")" "restore aman_main_data"
  sandbox_drop
}

test_failed_build_changes_nothing() {
  t_begin "a failed build leaves the running version alone"
  sandbox_new
  install_machine
  local old
  old=$(app_tag "$AMAN_HOME/release/release.json")
  repo_commit_change "does not build"
  STUB_BUILD_FAIL=1
  run_install upgrade
  assert_rc 1
  assert_eq "$(app_tag "$AMAN_HOME/release/release.json")" "$old"
  assert_eq "$(compose_image main)" "$old"
  assert_no_path "$SB_STATE/restores"
  sandbox_drop
}

test_doctor_failure_blocks_unless_forced() {
  t_begin "a doctor failure blocks the upgrade unless --force is given"
  sandbox_new
  install_machine
  repo_commit_change "needs doctor"
  STUB_DOCTOR_EXIT=1
  run_install upgrade
  assert_rc 1
  assert_flat_contains "$ERR" "doctor reports a failure"
  assert_no_path "$AMAN_HOME/backups"
  run_install upgrade --force
  assert_rc 0
  sandbox_drop
}

# An install whose first start failed leaves an instance that never became healthy: no data, no backup.
install_that_never_starts() {
  STUB_UP_FAIL_LOG="Error: EACCES: permission denied, mkdir '/home/trueforge'"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  unset STUB_UP_FAIL_LOG
  rm -rf "$SB_STATE/failed"
}

test_install_rerun_updates_instead_of_reusing_old_images() {
  t_begin "re-running install on a newer checkout says so, plans the update, backs up what has data and builds new images"
  sandbox_new
  install_machine
  local old new
  old=$(app_tag "$AMAN_HOME/release/release.json")
  repo_commit_change "newer checkout"
  run_install --dry-run
  assert_rc 0
  assert_flat_contains "$OUT" "This checkout is newer than the installed version, so it will be updated."
  assert_flat_contains "$OUT" "Update the installed version to this checkout"
  assert_flat_contains "$OUT" "Instances that have data are backed up first."
  assert_flat_contains "$OUT" "Restart instance main on the new version"
  assert_not_contains "$OUT" "Nothing to do"
  assert_eq "$(app_tag "$AMAN_HOME/release/release.json")" "$old" "a dry run changes nothing"
  run_install --yes
  assert_rc 0
  new=$(app_tag "$AMAN_HOME/release/release.json")
  if [ "$new" != "$old" ]; then t_pass; else t_fail "the old release was reused"; fi
  assert_not_contains "$OUT$ERR" "already built"
  assert_eq "$(compose_image main)" "$new" "the instance runs the new image"
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 1 "the instance had data, so it was backed up"
  assert_eq "$(app_tag "$AMAN_HOME/release/previous.release.json")" "$old" "the old release is kept for the rollback"
  sandbox_drop
}

test_failed_update_through_install_rolls_back() {
  t_begin "if the instance does not come up on the new version, install restores the database and the old images"
  sandbox_new
  install_machine
  local old
  old=$(app_tag "$AMAN_HOME/release/release.json")
  repo_commit_change "broken update"
  STUB_UP_FAIL_UNLESS_TAG=$old
  run_install --yes
  assert_rc 1
  assert_eq "$(app_tag "$AMAN_HOME/release/release.json")" "$old" "the old release is back"
  assert_eq "$(compose_image main)" "$old"
  assert_flat_contains "$ERR" "restoring the previous version"
  sandbox_drop
}

test_install_rerun_of_an_instance_that_never_started_is_a_fresh_build() {
  t_begin "re-running install after a first start that failed builds the new checkout without a backup"
  sandbox_new
  install_that_never_starts
  assert_eq "$(sed -n 's/^healthy=//p' "$AMAN_HOME/state/instances/main.conf")" 0 "the instance never became healthy"
  repo_commit_change "the fix"
  run_install --yes
  assert_rc 0
  assert_flat_contains "$OUT" "This checkout is newer than the installed version, so it will be updated."
  assert_not_contains "$OUT$ERR" "Backing up instance"
  assert_no_path "$AMAN_HOME/backups"
  assert_eq "$(compose_image main)" "$(app_tag "$AMAN_HOME/release/release.json")"
  assert_eq "$(sed -n 's/^healthy=//p' "$AMAN_HOME/state/instances/main.conf")" 1 "now it is healthy and counts as having data"
  sandbox_drop
}

test_upgrade_needs_no_force_when_the_instance_never_started() {
  t_begin "upgrade does not ask for --force when the failing instance never became healthy, and takes no backup of it"
  sandbox_new
  install_that_never_starts
  repo_commit_change "the fix"
  STUB_DOCTOR_EXIT=1
  run_install upgrade
  assert_rc 0
  assert_not_contains "$ERR" "doctor reports a failure"
  assert_no_path "$AMAN_HOME/backups"
  assert_flat_contains "$OUT" "not needed (no instance had data)"
  sandbox_drop
}

test_upgrade_still_needs_force_for_an_instance_with_data() {
  t_begin "upgrade still stops at a doctor failure of an instance that was healthy, with the way out named"
  sandbox_new
  install_machine
  repo_commit_change "needs doctor"
  STUB_DOCTOR_EXIT=1
  run_install upgrade
  assert_rc 1
  assert_flat_contains "$ERR" "The doctor reports a failure for instance main, which was healthy before."
  assert_flat_contains "$ERR" "upgrade --force"
  assert_no_path "$AMAN_HOME/backups"
  sandbox_drop
}

test_a_record_from_before_the_flag_counts_as_having_data() {
  t_begin "an instance record without the healthy flag is treated as having data: backed up and checked"
  sandbox_new
  install_machine
  sed -i '/^healthy=/d' "$AMAN_HOME/state/instances/main.conf"
  repo_commit_change "older record"
  STUB_DOCTOR_EXIT=1
  run_install upgrade
  assert_rc 1
  assert_flat_contains "$ERR" "which was healthy before"
  unset STUB_DOCTOR_EXIT
  run_install upgrade
  assert_rc 0
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 1
  sandbox_drop
}

# The data volume exists (Docker made it when the app first started) but holds no database.
no_database_yet() {
  mkdir -p "$SB_STATE/no_db"
  : >"$SB_STATE/no_db/aman_$1_data"
  printf 'aman_%s_data\n' "$1" >>"$SB_STATE/volumes"
}

test_backup_and_upgrade_force_cope_with_an_instance_without_a_database() {
  t_begin "an instance that never created its database is not a failed backup, by backup or by upgrade --force"
  sandbox_new
  install_that_never_starts
  no_database_yet main
  run_install backup
  assert_rc 0
  assert_flat_contains "$OUT" "Instance main has no database yet, so there is nothing to back up for it"
  assert_not_contains "$OUT$ERR" "Cannot open database"
  assert_not_contains "$OUT$ERR" "failed"
  assert_no_path "$SB_STATE/backup_runs"
  repo_commit_change "the fix"
  run_install upgrade --force
  assert_rc 0
  assert_not_contains "$OUT$ERR" "backup of main failed"
  sandbox_drop
}

test_owner_path_remove_upgrade_install() {
  t_begin "the owner's path works end to end: a first start that failed, instance remove, upgrade, then install"
  sandbox_new
  install_that_never_starts
  no_database_yet main
  run_install --yes instance remove main
  assert_rc 0
  repo_commit_change "the fix"
  run_install upgrade
  assert_rc 0
  assert_not_contains "$ERR" "--force"
  rm -f "$SB_STATE/no_db/aman_main_data"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_flat_contains "$OUT" "Instance main is running."
  assert_eq "$(sed -n 's/^healthy=//p' "$AMAN_HOME/state/instances/main.conf")" 1
  assert_eq "$(compose_image main)" "$(app_tag "$AMAN_HOME/release/release.json")"
  sandbox_drop
}

test_noop_when_current
test_backup_and_upgrade_force_cope_with_an_instance_without_a_database
test_owner_path_remove_upgrade_install
test_install_rerun_updates_instead_of_reusing_old_images
test_failed_update_through_install_rolls_back
test_install_rerun_of_an_instance_that_never_started_is_a_fresh_build
test_upgrade_needs_no_force_when_the_instance_never_started
test_upgrade_still_needs_force_for_an_instance_with_data
test_a_record_from_before_the_flag_counts_as_having_data
test_check_reports_without_changing
test_successful_upgrade_backs_up_first
test_failed_upgrade_restores_database_and_images
test_restore_goes_only_into_the_right_volume
test_restore_does_not_wait_for_a_migration_marker
test_failed_build_changes_nothing
test_doctor_failure_blocks_unless_forced
tests_finish
