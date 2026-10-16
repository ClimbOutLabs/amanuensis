#!/usr/bin/env bash
# instance import: the app is stopped, the CLI runs in a one-off container with the data volume and no network, and
# the app is started again whatever the outcome.
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
  assert_contains "$run" "aman import-data --in /import/export.zip --user \"\$1\" import $OWNER"
  local stop_line run_line up_line
  stop_line=$(grep -n 'compose .* stop app' "$STUB_LOG" | head -n 1 | cut -d: -f1)
  run_line=$(grep -n 'aman import-data' "$STUB_LOG" | head -n 1 | cut -d: -f1)
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
  assert_file "$SB_STATE/up/aman-main"
  unset STUB_IMPORT_FAIL
  sandbox_drop
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

test_import_stops_the_app_runs_the_cli_and_starts_it_again
test_a_failed_import_still_starts_the_app_and_fails
test_import_needs_a_name_and_a_file
test_import_for_an_unknown_instance_is_refused
test_a_fourth_word_belongs_to_import_only
tests_finish
