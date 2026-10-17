#!/usr/bin/env bash
# migrate --from-compose: the old database is copied into a temporary Postgres and the old volumes into temporary
# volumes, the export runs from those copies as the app user, and every temporary piece is removed again. The old
# stack is only read.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

OLD_ENV_TEXT='POSTGRES_USER=trueforge
POSTGRES_PASSWORD=invented-db-pass-0000
NEBIUS_API_KEY=invented-model-key-1111aaaa2222
OIDC_CLIENT_SECRET=invented-client-secret-3333'

export_runs() { cat "$SB_STATE/export_runs" 2>/dev/null || true; }
exports() { find "$AMAN_HOME/exports" -name 'aman-export-*.zip' 2>/dev/null; }

old_stack() {
  OLD=$SB/old-aman
  mkdir -p "$OLD/packages/trueforge"
  printf '%s\n' "$OLD_ENV_TEXT" >"$OLD/packages/trueforge/.env"
  chmod 600 "$OLD/packages/trueforge/.env"
  printf '%s' "$OLD" >"$SB_STATE/old_compose_dir"
}

setup_machine() {
  sandbox_new
  install_machine
  old_stack
}

# Every temporary piece is gone and nothing of the old stack was stopped, removed or written.
assert_cleaned_and_old_untouched() {
  assert_contains "$(cat "$SB_STATE/containers_removed" 2>/dev/null)" "aman-migrate-pg"
  assert_not_contains "$(cat "$SB_STATE/networks" 2>/dev/null)" "aman_migrate_net" "the private network removed"
  local volume
  for volume in aman_migrate_memory aman_migrate_knowledge aman_migrate_out; do
    assert_not_contains "$(cat "$SB_STATE/volumes")" "$volume" "$volume removed"
  done
  assert_log_lacks "rm -f old-"
  assert_log_lacks "stop old-"
  assert_log_lacks "trueforge_memory-data:/from/memory "
  assert_log_lacks "trueforge_persona-knowledge-data:/from/knowledge "
  assert_eq "$(grep -c 'old-postgres' "$STUB_LOG" | tr -d ' ')" "$(grep -c 'old-postgres \(pg_dump\|sh -c\)\|State.Running.* old-postgres\|Config.Image.* old-postgres' "$STUB_LOG" | tr -d ' ')" "the old database is only inspected and dumped"
}

test_migrate_exports_from_copies_and_cleans_up() {
  t_begin "migrate copies the old stack, exports as the app user with the old .env, and removes the copies"
  setup_machine
  run_install migrate --from-compose "$OLD"
  assert_rc 0
  assert_eq "$(exports | wc -l | tr -d ' ')" 1
  local file runs
  file=$(exports)
  assert_eq "$(cat "$file")" "PK-EXPORT-FROM-COPY"
  assert_mode "$file" 600
  assert_mode "$AMAN_HOME/exports" 700
  assert_contains "$(cat "$SB_STATE/pg_restored")" "PGDUMP-OF-OLD"
  assert_contains "$(cat "$SB_STATE/volume_copies")" "-v trueforge_memory-data:/from/memory:ro"
  assert_contains "$(cat "$SB_STATE/volume_copies")" "-v trueforge_persona-knowledge-data:/from/knowledge:ro"
  assert_contains "$(cat "$SB_STATE/volume_copies")" "chown -R 10001:10001 /to /out"
  assert_log_has "network create --internal"
  assert_log_has "POSTGRES_HOST_AUTH_METHOD=trust postgres:17"
  runs=$(export_runs)
  assert_eq "$(printf '%s\n' "$runs" | wc -l | tr -d ' ')" 2
  assert_contains "$(printf '%s\n' "$runs" | head -n 1)" "export-data --migrate --list-users"
  assert_contains "$(printf '%s\n' "$runs" | tail -n 1)" "--user 10001:10001"
  assert_contains "$(printf '%s\n' "$runs" | tail -n 1)" "export-data --migrate --include-uploads --include-instance-data --user trueforge-default --secrets-env /migrate/old.env --out /out/aman-export.zip"
  assert_eq "$(cat "$SB_STATE/export_stdin")" "$OLD_ENV_TEXT"
  assert_not_contains "$(cat "$STUB_LOG")" "invented-model-key" "the old keys never reach a command line"
  assert_flat_contains "$OUT" "The old Aman was not changed, and the temporary copies are removed."
  assert_flat_contains "$OUT" "Next: aman import $file --display-name \"Sam Example\""
  assert_cleaned_and_old_untouched
  sandbox_drop
}

test_migrate_asks_which_person_when_several_have_chats() {
  t_begin "migrate with chats from two people names them, exports nothing, and --user then picks one"
  setup_machine
  export STUB_EXPORT_USERS='{"sign_in":"on","users":[{"user_id":"sam-id","display_name":"Sam","sessions":12},{"user_id":"kai-id","display_name":"Kai","sessions":3}]}'
  run_install migrate --from-compose "$OLD"
  assert_rc 1
  assert_flat_contains "$ERR" "The old Aman has chats from more than one person: sam-id (12 chats), kai-id (3 chats). Run this again with --user and the id of the person to move."
  assert_eq "$(exports | wc -l | tr -d ' ')" 0
  assert_cleaned_and_old_untouched
  run_install migrate --from-compose "$OLD" --user kai-id
  assert_rc 0
  assert_contains "$(export_runs | tail -n 1)" "export-data --migrate --include-uploads --user kai-id"
  assert_not_contains "$(export_runs | tail -n 1)" "--include-instance-data" "shared data stays behind when others used it"
  run_install migrate --from-compose "$OLD" --user nobody
  assert_rc 1
  assert_flat_contains "$ERR" "No chats in the old Aman belong to nobody. Run this again with --user and one of: sam-id (12 chats), kai-id (3 chats)."
  unset STUB_EXPORT_USERS
  sandbox_drop
}

test_migrate_refuses_what_it_cannot_read() {
  t_begin "migrate refuses a folder without the old settings, a missing or stopped old stack, and no chats"
  setup_machine
  run_install migrate --from-compose "$SB/nope"
  assert_rc 1
  assert_flat_contains "$ERR" "There is no folder at $SB/nope. Pass --from-compose the folder the old Aman runs from."
  mkdir -p "$SB/empty"
  run_install migrate --from-compose "$SB/empty"
  assert_rc 1
  assert_flat_contains "$ERR" "has no packages/trueforge/.env."
  rm -f "$SB_STATE/old_compose_dir"
  run_install migrate --from-compose "$OLD"
  assert_rc 1
  assert_flat_contains "$ERR" "Aman found no old Aman containers made from $OLD."
  printf '%s' "$OLD" >"$SB_STATE/old_compose_dir"
  export STUB_OLD_PG_STOPPED=1
  run_install migrate --from-compose "$OLD"
  unset STUB_OLD_PG_STOPPED
  assert_rc 1
  assert_flat_contains "$ERR" "The database of the old Aman is not running."
  export STUB_EXPORT_USERS='{"sign_in":"off","users":[{"user_id":"trueforge-default","display_name":"trueforge-default","sessions":0}]}'
  run_install migrate --from-compose "$OLD"
  unset STUB_EXPORT_USERS
  assert_rc 1
  assert_flat_contains "$ERR" "The old Aman has no chats, so there is nothing to move."
  printf 'MEMORY_BACKEND=mem0\n' >>"$OLD/packages/trueforge/.env"
  run_install migrate --from-compose "$OLD"
  assert_rc 1
  assert_flat_contains "$ERR" "The old Aman keeps its memory outside its files"
  assert_eq "$(exports | wc -l | tr -d ' ')" 0
  sandbox_drop
}

test_a_failed_copy_or_export_still_cleans_up() {
  t_begin "a failed database copy or export leaves no export file and removes every temporary piece"
  setup_machine
  export STUB_PGDUMP_FAIL=1
  run_install migrate --from-compose "$OLD"
  unset STUB_PGDUMP_FAIL
  assert_rc 1
  assert_flat_contains "$ERR" "The old database could not be copied, and the old Aman was not changed."
  assert_cleaned_and_old_untouched
  export STUB_EXPORT_FAIL=1
  run_install migrate --from-compose "$OLD"
  unset STUB_EXPORT_FAIL
  assert_rc 1
  assert_flat_contains "$ERR" "Memory export failed for a namespace"
  assert_flat_contains "$ERR" "The export from the copy failed"
  assert_eq "$(exports | wc -l | tr -d ' ')" 0
  assert_eq "$(find "$AMAN_HOME/exports" -name '*.part' 2>/dev/null | wc -l | tr -d ' ')" 0
  assert_cleaned_and_old_untouched
  sandbox_drop
}

test_migrate_options_belong_to_migrate() {
  t_begin "--from-compose and --user apply to migrate only, and migrate needs an installed machine"
  sandbox_new
  run_install migrate
  assert_rc 2
  assert_flat_contains "$ERR" "usage: install.sh migrate --from-compose FOLDER"
  old_stack
  run_install migrate --from-compose "$OLD"
  assert_rc 1
  assert_flat_contains "$ERR" "this machine is not set up yet; run install.sh first"
  run_install backup --from-compose "$OLD"
  assert_rc 2
  assert_flat_contains "$ERR" "--from-compose and --user apply to migrate"
  sandbox_drop
}

test_migrate_exports_from_copies_and_cleans_up
test_migrate_asks_which_person_when_several_have_chats
test_migrate_refuses_what_it_cannot_read
test_a_failed_copy_or_export_still_cleans_up
test_migrate_options_belong_to_migrate
tests_finish
