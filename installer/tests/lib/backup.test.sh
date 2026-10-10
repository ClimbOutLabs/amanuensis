#!/usr/bin/env bash
# Backups: layout, modes, checksums and retention.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

test_backup_layout_and_modes() {
  t_begin "a backup is private, checksummed and streamed from containers"
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
  assert_mode "$dir/main/files.tar" 600
  assert_mode "$dir/main/dex.tar" 600
  assert_mode "$dir/main/env" 600
  assert_mode "$dir/SHA256SUMS" 600
  assert_contains "$(cat "$dir/main/db.sqlite")" "SQLITE-OF"
  assert_contains "$(cat "$dir/main/files.tar")" "TAR-OF-aman_main_data"
  assert_log_has "compose --project-name aman-main"
  assert_log_has "exec -T app amanuensis backup"
  assert_log_has "-v aman_main_data:/data:ro"
  assert_log_has "--exclude=./db"
  assert_contains "$(cat "$dir/SHA256SUMS")" "main/db.sqlite"
  if (cd "$dir" && sha256sum -c SHA256SUMS >/dev/null 2>&1); then t_pass; else t_fail "checksums do not verify"; fi
  assert_not_contains "$(cat "$STUB_LOG")" "bind" "no bind mounts"
  assert_tree_lacks "$AMAN_HOME/backups" "$SENTINEL_PASSWORD"
  sandbox_drop
}

test_backup_of_stopped_instance() {
  t_begin "a stopped instance is backed up through a one-off container"
  sandbox_new
  install_machine
  rm -f "$SB_STATE/up/aman-main"
  run_install backup main
  assert_rc 0
  assert_log_has "run --rm --network none -v aman_main_data:/data -e STANDALONE=true"
  sandbox_drop
}

test_backup_prunes_to_five() {
  t_begin "only the five newest backups are kept"
  sandbox_new
  install_machine
  local i
  for i in 1 2 3 4 5 6 7; do
    run_install backup
    assert_rc 0
  done
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 5
  sandbox_drop
}

test_failed_backup_leaves_nothing() {
  t_begin "a failed backup is removed instead of left half-written"
  sandbox_new
  install_machine
  STUB_EXEC_FAIL=1
  run_install backup
  assert_rc 1
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 0
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
test_backup_of_stopped_instance
test_backup_prunes_to_five
test_failed_backup_leaves_nothing
test_unknown_instance_and_empty_machine
tests_finish
