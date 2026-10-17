#!/usr/bin/env bash
# instance import: a kept backup is taken and the search model waited for, then the app is stopped, the CLI runs in a
# one-off container with the data volume and no network, and the app is started again whatever the outcome.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

OWNER=owner@example.invalid

import_runs() { cat "$SB_STATE/import_runs" 2>/dev/null || true; }
import_count() { import_runs | grep -c . || true; }

make_export() {
  EXPORT_DIR=$SB/exports
  mkdir -p "$EXPORT_DIR"
  EXPORT_FILE=$EXPORT_DIR/aman-export.zip
  printf 'PK-not-really-a-zip' >"$EXPORT_FILE"
}

install_with_owner() {
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email "$OWNER"
  clear_input
}

test_import_stops_the_app_runs_the_cli_and_starts_it_again() {
  t_begin "instance import stops the app, runs aman import-data offline for the owner, then starts the app"
  sandbox_new
  install_with_owner
  make_export
  run_install instance import main "$EXPORT_FILE"
  assert_rc 0
  assert_eq "$(import_count)" 1
  local run
  run=$(import_runs)
  assert_contains "$run" "--rm -i --network none"
  assert_contains "$run" "-v aman_main_data:/data"
  assert_contains "$run" "--tmpfs /import:rw,mode=0700,uid=10001,gid=10001"
  assert_contains "$run" "--env-file $AMAN_HOME/instances/main/.env"
  assert_contains "$run" "aman import-data --in /import/export.zip --user \"\$1\" --display-name \"\$2\" import $OWNER owner"
  local stop_line run_line up_line
  stop_line=$(grep -n 'compose .* stop app' "$STUB_LOG" | head -n 1 | cut -d: -f1)
  run_line=$(grep -n 'aman import-data --in' "$STUB_LOG" | head -n 1 | cut -d: -f1)
  up_line=$(grep -n 'up -d --wait' "$STUB_LOG" | tail -n 1 | cut -d: -f1)
  if [ "$stop_line" -lt "$run_line" ] && [ "$run_line" -lt "$up_line" ]; then
    t_pass
  else
    t_fail "expected stop ($stop_line) before the import ($run_line) before the restart ($up_line)"
  fi
  assert_flat_contains "$OUT" "Imported into instance main"
  assert_flat_contains "$OUT" "Model keys and connector sign-ins are not part of an export"
  assert_file "$SB_STATE/up/aman-main"
  sandbox_drop
}

test_a_failed_import_still_starts_the_app_and_fails() {
  t_begin "a refused import restarts the app and exits 1 with the CLI's reason"
  sandbox_new
  install_with_owner
  make_export
  export STUB_IMPORT_FAIL=1
  run_install instance import main "$EXPORT_FILE"
  assert_rc 1
  assert_flat_contains "$ERR" "already has chats"
  assert_flat_contains "$ERR" "The import failed"
  # Only the CLI knows whether a failed run left anything behind, so the installer does not claim it.
  assert_not_contains "$ERR" "Nothing was kept"
  assert_file "$SB_STATE/up/aman-main"
  unset STUB_IMPORT_FAIL
  sandbox_drop
}

test_an_interrupted_import_still_starts_the_app() {
  local signal
  for signal in INT TERM HUP; do
    t_begin "an import interrupted by SIG$signal still starts the app it stopped"
    sandbox_new
    install_with_owner
    make_export
    export STUB_IMPORT_SIGNAL=$signal
    run_install instance import main "$EXPORT_FILE"
    unset STUB_IMPORT_SIGNAL
    if [ "$RC" != 0 ]; then t_pass; else t_fail "expected a non-zero exit after SIG$signal"; fi
    assert_eq "$(import_count)" 1
    assert_file "$SB_STATE/up/aman-main"
    assert_flat_contains "$OUT$ERR" "Starting the app of instance main again"
    sandbox_drop
  done
}

test_import_needs_a_name_and_a_file() {
  t_begin "instance import without a file or with a missing file is refused before anything stops"
  sandbox_new
  install_with_owner
  run_install instance import main
  assert_rc 2
  assert_flat_contains "$ERR" "usage: install.sh instance import NAME FILE"
  run_install instance import main "$SB/nope.zip"
  assert_rc 1
  assert_flat_contains "$ERR" "there is no file at"
  assert_eq "$(import_count)" 0
  assert_eq "$(log_count 'stop app')" 0 "the app was never stopped"
  sandbox_drop
}

test_import_for_an_unknown_instance_is_refused() {
  t_begin "instance import for an instance that does not exist says so"
  sandbox_new
  install_with_owner
  make_export
  run_install instance import ghost "$EXPORT_FILE"
  assert_rc 1
  assert_flat_contains "$ERR" "instance ghost does not exist"
  assert_eq "$(import_count)" 0
  sandbox_drop
}

test_a_fourth_word_belongs_to_import_only() {
  t_begin "a fourth word on any other instance command is an unexpected argument"
  sandbox_new
  install_with_owner
  run_install instance list main extra
  assert_rc 2
  assert_flat_contains "$ERR" "unexpected argument extra"
  sandbox_drop
}

kept_backups() { find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d -name '*-before-import' 2>/dev/null; }

test_import_passes_the_display_name() {
  t_begin "instance import names the owner on imported chats with --display-name"
  sandbox_new
  install_with_owner
  make_export
  run_install instance import main "$EXPORT_FILE" --display-name "Sam Example"
  assert_rc 0
  assert_contains "$(import_runs)" "import $OWNER Sam Example"
  run_install instance import main "$EXPORT_FILE" --display-name "$(printf 'n%.0s' $(seq 1 81))"
  assert_rc 2
  assert_flat_contains "$ERR" "The name is longer than 80 characters."
  run_install instance list --display-name "Sam Example"
  assert_rc 2
  assert_flat_contains "$ERR" "--display-name applies to instance import"
  assert_eq "$(import_count)" 1
  sandbox_drop
}

test_import_takes_a_kept_backup_first() {
  t_begin "instance import takes a backup that is never pruned before anything is imported"
  sandbox_new
  install_with_owner
  make_export
  run_install instance import main "$EXPORT_FILE"
  assert_rc 0
  assert_eq "$(kept_backups | wc -l | tr -d ' ')" 1
  assert_file "$(kept_backups)/main/db.sqlite"
  assert_flat_contains "$OUT" "and kept until you remove it"
  local backup_line run_line
  backup_line=$(grep -n 'aman backup' "$STUB_LOG" | tail -n 1 | cut -d: -f1)
  run_line=$(grep -n 'aman import-data --in' "$STUB_LOG" | head -n 1 | cut -d: -f1)
  if [ "$backup_line" -lt "$run_line" ]; then t_pass; else t_fail "expected the backup ($backup_line) before the import ($run_line)"; fi
  sandbox_drop
}

test_a_failed_backup_stops_the_import() {
  t_begin "when the backup before an import fails, nothing is imported and the app keeps running"
  sandbox_new
  install_with_owner
  make_export
  export STUB_BACKUP_FAIL=1
  run_install instance import main "$EXPORT_FILE"
  unset STUB_BACKUP_FAIL
  assert_rc 1
  assert_flat_contains "$ERR" "The backup before the import failed, so nothing was imported."
  assert_eq "$(import_count)" 0
  assert_eq "$(log_count 'stop app')" 0 "the app was never stopped"
  sandbox_drop
}

test_an_instance_that_never_started_is_started_once() {
  t_begin "an instance that never started is started once, so it can be backed up, then imported into"
  sandbox_new
  install_with_owner
  make_export
  grep -Fxv aman_main_data "$SB_STATE/volumes" >"$SB_STATE/volumes.new" || true
  mv "$SB_STATE/volumes.new" "$SB_STATE/volumes"
  rm -f "$SB_STATE/up/aman-main"
  run_install instance import main "$EXPORT_FILE"
  assert_rc 0
  assert_flat_contains "$OUT" "Instance main has never started, so it starts once now"
  assert_eq "$(kept_backups | wc -l | tr -d ' ')" 1
  assert_eq "$(import_count)" 1
  sandbox_drop
}

test_import_waits_for_the_search_model() {
  t_begin "instance import waits for the search model with one progress line, then imports"
  sandbox_new
  install_with_owner
  make_export
  export STUB_MODEL_DOWNLOADING=3
  run_install instance import main "$EXPORT_FILE"
  unset STUB_MODEL_DOWNLOADING
  assert_rc 0
  assert_eq "$(printf '%s\n' "$OUT" | grep -c 'Waiting for instance main to finish downloading its search model')" 1
  assert_eq "$(wc -l <"$SB_STATE/model_checks" | tr -d ' ')" 4
  assert_eq "$(import_count)" 1
  sandbox_drop
}

test_a_stopped_instance_is_started_to_download_the_model() {
  t_begin "a stopped instance without its search model is started so it can download it"
  sandbox_new
  install_with_owner
  make_export
  rm -f "$SB_STATE/up/aman-main"
  export STUB_MODEL_DOWNLOADING=1
  run_install instance import main "$EXPORT_FILE"
  unset STUB_MODEL_DOWNLOADING
  assert_rc 0
  assert_flat_contains "$OUT" "Instance main is running and healthy"
  assert_eq "$(import_count)" 1
  sandbox_drop
}

test_import_gives_up_when_the_model_never_arrives() {
  t_begin "instance import stops waiting, imports nothing and says what to check when the model never arrives"
  sandbox_new
  install_with_owner
  make_export
  export STUB_MODEL_DOWNLOADING=1000
  run_install instance import main "$EXPORT_FILE"
  unset STUB_MODEL_DOWNLOADING
  assert_rc 1
  assert_flat_contains "$ERR" "did not finish downloading its search model in 20 minutes, so nothing was imported. Check this computer's internet connection, then run the import again."
  assert_eq "$(import_count)" 0
  assert_eq "$(log_count 'stop app')" 0 "the app was never stopped"
  export STUB_MODEL_BROKEN=1
  run_install instance import main "$EXPORT_FILE"
  unset STUB_MODEL_BROKEN
  assert_rc 1
  assert_flat_contains "$ERR" "Aman could not tell whether instance main has its search model yet, so nothing was imported."
  assert_eq "$(import_count)" 0
  sandbox_drop
}

test_import_stops_the_app_runs_the_cli_and_starts_it_again
test_import_passes_the_display_name
test_import_takes_a_kept_backup_first
test_a_failed_backup_stops_the_import
test_an_instance_that_never_started_is_started_once
test_import_waits_for_the_search_model
test_a_stopped_instance_is_started_to_download_the_model
test_import_gives_up_when_the_model_never_arrives
test_a_failed_import_still_starts_the_app_and_fails
test_an_interrupted_import_still_starts_the_app
test_import_needs_a_name_and_a_file
test_import_for_an_unknown_instance_is_refused
test_a_fourth_word_belongs_to_import_only
tests_finish
