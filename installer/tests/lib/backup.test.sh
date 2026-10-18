#!/usr/bin/env bash
# Backups: layout, modes, checksums and retention.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

test_backup_layout_and_modes() {
  t_begin "a backup is the CLI's output, private, checksummed and streamed from containers"
  sandbox_new
  install_machine
  assert_no_path "$AMAN_HOME/backups"
  run_install backup
  assert_rc 0
  local dir
  dir=$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  assert_mode "$AMAN_HOME/backups" 700
  assert_mode "$dir" 700
  assert_mode "$dir/main" 700
  assert_mode "$dir/main/db.sqlite" 600
  assert_mode "$dir/main/dex.tar" 600
  assert_mode "$dir/main/env" 600
  assert_mode "$dir/SHA256SUMS" 600
  assert_contains "$(cat "$dir/main/db.sqlite")" "SQLITE-OF-aman_main_data"
  assert_file "$dir/main/manifest.json"
  assert_eq "$([ -d "$dir/main/memory" ] && [ -d "$dir/main/persona-knowledge" ] && echo yes)" yes "memory and persona directories"
  assert_contains "$(cat "$dir/main/dex.tar")" "TAR-OF-aman_main_dex"
  assert_contains "$(cat "$dir/SHA256SUMS")" "main/db.sqlite"
  if (cd "$dir" && sha256sum -c SHA256SUMS >/dev/null 2>&1); then t_pass; else t_fail "checksums do not verify"; fi
  assert_not_contains "$(cat "$STUB_LOG")" "bind" "no bind mounts"
  assert_tree_lacks "$AMAN_HOME/backups" "$SENTINEL_PASSWORD"
  sandbox_drop
}

test_backup_runs_the_cli_with_a_target() {
  t_begin "the installer runs 'aman backup --target' on a scratch volume and removes the volume"
  sandbox_new
  install_machine
  run_install backup
  assert_rc 0
  local run
  run=$(cat "$SB_STATE/backup_runs")
  assert_contains "$run" "-v aman_main_data:/data -v aman_main_backup_scratch:/backup"
  assert_contains "$run" "--network none"
  assert_contains "$run" "aman backup --target /backup"
  assert_contains "$run" "--sqlite /data/db/db.sqlite --memory-dir /data/memory --persona-dir /data/persona-knowledge"
  assert_not_contains "$run" "-v aman_main_data:/data:ro" "the live database is opened read-write by the SQLite backup API"
  assert_log_has "volume create --label com.amanuensis.scratch=backup aman_main_backup_scratch"
  assert_contains "$(cat "$SB_STATE/scratch_removed")" "aman_main_backup_scratch"
  assert_no_path "$SB_STATE/volumes_removed"
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_main_backup_scratch"
  assert_log_lacks "exec -T app"
  sandbox_drop
}

test_backup_of_stopped_instance() {
  t_begin "a stopped instance is backed up the same way"
  sandbox_new
  install_machine
  rm -f "$SB_STATE/up/aman-main"
  run_install backup main
  assert_rc 0
  assert_contains "$(cat "$SB_STATE/backup_runs")" "aman backup --target /backup"
  assert_file "$(find "$AMAN_HOME/backups" -name db.sqlite | head -n 1)"
  sandbox_drop
}

test_leftover_scratch_volume_is_pruned() {
  t_begin "a scratch volume left by a killed run is removed before the next backup"
  sandbox_new
  install_machine
  printf 'aman_old_backup_scratch\n' >>"$SB_STATE/volumes"
  printf 'aman_old_backup_scratch\n' >>"$SB_STATE/volumes_scratch"
  run_install backup
  assert_rc 0
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_old_backup_scratch"
  assert_contains "$(cat "$SB_STATE/scratch_removed")" "aman_old_backup_scratch"
  sandbox_drop
}

test_backup_prunes_to_seven() {
  t_begin "only the seven newest backups are kept"
  sandbox_new
  install_machine
  local i
  for i in 1 2 3 4 5 6 7 8 9; do
    run_install backup
    assert_rc 0
  done
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 7
  sandbox_drop
}

test_kept_backups_are_never_pruned() {
  t_begin "a kept backup is never pruned and does not count toward the seven"
  sandbox_new
  install_machine
  mkdir -p "$AMAN_HOME/backups/20200101T000000Z-before-import"
  local i
  for i in 1 2 3 4 5 6 7 8 9; do
    run_install backup
    assert_rc 0
  done
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d -name '*Z' -o -mindepth 1 -maxdepth 1 -type d -name '*Z-[0-9]*' | wc -l | tr -d ' ')" 7
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d -name '*-before-import' | wc -l | tr -d ' ')" 1
  sandbox_drop
}

test_failed_backup_leaves_nothing() {
  t_begin "a failed backup is removed instead of left half-written"
  sandbox_new
  install_machine
  STUB_BACKUP_FAIL=1
  run_install backup
  assert_rc 1
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 0
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_main_backup_scratch" "scratch volume removed after a failure"
  sandbox_drop
}

test_unknown_instance_and_empty_machine() {
  t_begin "backup of a missing instance fails and a machine without instances has nothing to do"
  sandbox_new
  run_install backup
  assert_rc 0
  assert_contains "$OUT" "nothing to back up"
  install_machine
  run_install backup nosuch
  assert_rc 1
  sandbox_drop
}

test_backup_layout_and_modes
test_backup_runs_the_cli_with_a_target
test_backup_of_stopped_instance
test_leftover_scratch_volume_is_pruned
test_backup_prunes_to_seven
test_kept_backups_are_never_pruned
test_failed_backup_leaves_nothing
test_unknown_instance_and_empty_machine
tests_finish
