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

test_noop_when_current
test_check_reports_without_changing
test_successful_upgrade_backs_up_first
test_failed_upgrade_restores_database_and_images
test_restore_goes_only_into_the_right_volume
test_restore_does_not_wait_for_a_migration_marker
test_failed_build_changes_nothing
test_doctor_failure_blocks_unless_forced
tests_finish
