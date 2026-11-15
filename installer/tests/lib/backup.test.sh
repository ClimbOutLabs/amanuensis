#!/usr/bin/env bash
# Backups: layout, modes, checksums and retention.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Turns the only backup into the readable layout backups had before sealing, with the checksums such a backup had.
make_backup_readable() { # dir name
  unseal_to_old_layout "$1" "$2"
  local sums
  sums=$(cd "$1" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f"; else shasum -a 256 "$f"; fi
  done)
  printf '%s\n' "$sums" >"$1/SHA256SUMS"
}

test_old_readable_backups_are_sealed() {
  t_begin "the next backup encrypts backups made before sealing, and takes the certificate key out of them"
  sandbox_new
  install_machine
  run_install backup
  local old
  old=$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  make_backup_readable "$old" main
  mkdir -p "$old/tls"
  echo "PRIVATE KEY" >"$old/tls/root.key"
  mv "$old" "$AMAN_HOME/backups/20261016T031500Z"
  old=$AMAN_HOME/backups/20261016T031500Z
  local doctor
  doctor=$(AMANUENSIS_HOME="$AMAN_HOME" PATH="$SB_BIN" bash "$INSTALLER_DIR/doctor/aman" doctor --json --only backup) || true
  assert_contains "$doctor" '"id":"backup","state":"warn","detail":"1 old backup(s) in' "the doctor says an old backup is readable"
  assert_contains "$doctor" "Run aman backup"
  run_install backup
  assert_rc 0
  assert_flat_contains "$OUT" "Encrypted 1 old backup(s). They open on this computer, or with the recovery key."
  assert_flat_contains "$OUT" "Removed a copy of the certificate key from 1 old backup(s)."
  assert_no_path "$old/main"
  assert_no_path "$old/tls/root.key"
  assert_mode "$old/main.sealed" 600
  assert_contains "$(sealed_cat "$old/main.sealed" db.sqlite)" "SQLITE-OF-aman_main_data"
  assert_contains "$(sealed_names "$old/main.sealed")" "memory/note.md"
  assert_eq "$(sealed_recovery "$old/main.sealed")" "000001-222222-333333-444444-555555-666666-777777-888888" "the recovery key opens it too"
  if (cd "$old" && sha256sum -c SHA256SUMS >/dev/null 2>&1); then t_pass; else t_fail "checksums do not verify"; fi
  assert_not_contains "$(cat "$old/SHA256SUMS")" "root.key"
  assert_eq "$(find "$AMAN_HOME/backups" -name db.sqlite | wc -l | tr -d ' ')" 0 "no readable database is left"
  assert_eq "$(cat "$SB_STATE/volumes" 2>/dev/null | grep -c backup_scratch || true)" 0 "the scratch volume is gone"
  with_input "yes
"
  run_install restore main 20261016T031500Z
  assert_rc 0
  : >"$SB_STATE/seal_runs"
  run_install backup
  assert_not_contains "$OUT" "old backup"
  sandbox_drop
}

test_old_backup_of_a_removed_instance() {
  t_begin "an old backup of an instance that is gone is encrypted for this computer only"
  sandbox_new
  install_machine
  run_install backup
  local old
  old=$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  make_backup_readable "$old" main
  mv "$old/main" "$old/gone"
  run_install backup
  assert_rc 0
  assert_no_path "$old/gone"
  assert_eq "$(sealed_recovery "$old/gone.sealed")" none
  assert_contains "$(sealed_cat "$old/gone.sealed" db.sqlite)" "SQLITE-OF-aman_main_data"
  sandbox_drop
}

test_old_backup_waits_for_the_key() {
  t_begin "an old backup stays as it is while its instance is not tied to this computer's key, and says so"
  sandbox_new
  install_machine
  run_install backup
  local old
  old=$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  make_backup_readable "$old" main
  sed -i.bak '/^secrets=/d' "$AMAN_HOME/state/instances/main.conf"
  rm -f "$AMAN_HOME/state/instances/main.conf.bak"
  run_install backup
  assert_rc 0
  assert_file "$old/main/db.sqlite"
  assert_no_path "$old/main.sealed"
  assert_flat_contains "$ERR" "1 old backup(s) are not encrypted yet"
  sandbox_drop
}

test_backup_layout_and_modes() {
  t_begin "a backup is one sealed file per instance, private, checksummed and streamed from containers"
  sandbox_new
  install_machine
  assert_no_path "$AMAN_HOME/backups"
  run_install backup
  assert_rc 0
  local dir
  dir=$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  assert_mode "$AMAN_HOME/backups" 700
  assert_mode "$dir" 700
  assert_mode "$dir/main.sealed" 600
  assert_mode "$dir/SHA256SUMS" 600
  assert_no_path "$dir/main"
  assert_eq "$(find "$dir" -type f | sed "s|$dir/||" | LC_ALL=C sort | tr '\n' ' ')" "SHA256SUMS main.sealed release.json " "the instance is one sealed file"
  assert_contains "$(sealed_cat "$dir/main.sealed" db.sqlite)" "SQLITE-OF-aman_main_data"
  assert_contains "$(sealed_names "$dir/main.sealed")" "manifest.json"
  assert_contains "$(sealed_names "$dir/main.sealed")" "db.sqlite.keys" "the database's key records go with it"
  assert_contains "$(cat "$SB_STATE/backup_runs")" "-v aman_key:/run/aman-key:ro -e SECRETS_KEY_FILE=/run/aman-key/master.key" "the copy is made with this computer's key"
  assert_contains "$(sealed_names "$dir/main.sealed")" "memory/note.md" "the memory files are inside"
  assert_contains "$(sealed_names "$dir/main.sealed")" "persona-knowledge/" "the persona folder is inside"
  assert_contains "$(sealed_cat "$dir/main.sealed" dex.tar | tr -d '\0')" "TAR-OF-aman_main_dex"
  assert_contains "$(sealed_cat "$dir/main.sealed" env)" "OIDC_CLIENT_SECRET=" "the settings are inside"
  assert_contains "$(sealed_cat "$dir/main.sealed" dex.env)" "PASSWORD_HASH" "the sign-in settings are inside"
  assert_eq "$(sealed_recovery "$dir/main.sealed")" "000001-222222-333333-444444-555555-666666-777777-888888" "the instance's recovery key opens it"
  assert_contains "$(cat "$SB_STATE/seal_runs")" "--sqlite /backup/db.sqlite"
  assert_contains "$(cat "$SB_STATE/seal_runs")" "aman_key:/run/aman-key:ro" "the key is only read"
  assert_contains "$(cat "$dir/SHA256SUMS")" "main.sealed"
  assert_flat_contains "$OUT" "It is encrypted. Only this computer, or the recovery key of each instance, can open it."
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
  assert_contains "$(sealed_names "$(find "$AMAN_HOME/backups" -name main.sealed | head -n 1)")" "db.sqlite"
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
  assert_eq "$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d -name '*Z' -o -mindepth 1 -maxdepth 1 -type d -name '*Z-[[:digit:]]*' | wc -l | tr -d ' ')" 7
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

test_backup_with_a_lost_settings_file() {
  t_begin "a settings file that is already lost is told, and the rest of the backup is still made"
  sandbox_new
  install_machine
  rm "$AMAN_HOME/instances/main/dex.env"
  run_install backup
  assert_rc 0
  assert_flat_contains "$ERR" "The settings file dex.env of main is missing, so this backup does not include it."
  local dir
  dir=$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  assert_contains "$(sealed_names "$dir/main.sealed")" "env"
  assert_contains "$(sealed_names "$dir/main.sealed")" "db.sqlite"
  assert_not_contains "$(sealed_names "$dir/main.sealed")" "dex.env"
  sandbox_drop
}

test_a_failed_seal_leaves_nothing() {
  t_begin "when the backup cannot be sealed nothing is left behind, readable or not"
  sandbox_new
  install_machine
  STUB_SEAL_FAIL=1 run_install backup
  assert_rc 1
  assert_flat_contains "$ERR" "The backup of main failed, so the unfinished backup was removed."
  assert_eq "$(find "$AMAN_HOME/backups" -type f 2>/dev/null | wc -l | tr -d ' ')" 0 "no file is left"
  assert_not_contains "$(cat "$SB_STATE/volumes")" "backup_scratch" "the scratch volume is gone"
  sandbox_drop
}

test_an_instance_without_a_recovery_key_is_sealed_for_this_computer() {
  t_begin "an instance not yet tied to this computer's key is sealed for this computer only, making the key if needed"
  sandbox_new
  install_machine
  local conf=$AMAN_HOME/state/instances/main.conf dir
  grep -v '^secrets=' "$conf" >"$conf.new" && mv "$conf.new" "$conf"
  chmod 600 "$conf"
  rm -f "$SB_STATE/secrets_aman-main" "$SB_STATE/key"
  run_install backup
  assert_rc 0
  dir=$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  assert_contains "$(cat "$SB_STATE/seal_runs")" "--this-computer-only"
  assert_eq "$(sealed_recovery "$dir/main.sealed")" none
  assert_file "$SB_STATE/key"
  assert_contains "$(sealed_cat "$dir/main.sealed" db.sqlite)" "SQLITE-OF-aman_main_data"
  sandbox_drop
}

test_an_older_version_is_told_to_upgrade() {
  t_begin "a version of Aman from before sealed backups is told to upgrade, and no readable backup is written"
  sandbox_new
  install_machine
  sed -n 's/^    image: //p' "$AMAN_HOME/instances/main/compose.yaml" | sort -u >"$SB_STATE/images_without_seal"
  run_install backup
  assert_rc 1
  assert_flat_contains "$ERR" "This version of Aman cannot make an encrypted backup yet. Run: aman upgrade"
  assert_eq "$(find "$AMAN_HOME/backups" -type f 2>/dev/null | wc -l | tr -d ' ')" 0
  sandbox_drop
}

test_backup_layout_and_modes
test_backup_with_a_lost_settings_file
test_a_failed_seal_leaves_nothing
test_an_instance_without_a_recovery_key_is_sealed_for_this_computer
test_an_older_version_is_told_to_upgrade
test_backup_runs_the_cli_with_a_target
test_backup_of_stopped_instance
test_leftover_scratch_volume_is_pruned
test_old_readable_backups_are_sealed
test_old_backup_of_a_removed_instance
test_old_backup_waits_for_the_key
test_backup_prunes_to_seven
test_kept_backups_are_never_pruned
test_failed_backup_leaves_nothing
test_unknown_instance_and_empty_machine
tests_finish
