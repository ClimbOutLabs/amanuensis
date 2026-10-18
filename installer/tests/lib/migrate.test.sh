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
  assert_log_has "rm -f -v aman-migrate-pg"
  assert_not_contains "$(cat "$SB_STATE/networks" 2>/dev/null)" "aman_migrate_net" "the private network removed"
  local volume
  for volume in aman_migrate_pg aman_migrate_pg_data aman_migrate_memory aman_migrate_knowledge aman_migrate_out; do
    assert_not_contains "$(cat "$SB_STATE/volumes")" "$volume" "$volume removed"
  done
  assert_log_lacks "rm -f old-"
  assert_log_lacks "stop old-"
  assert_log_lacks "trueforge_memory-data:/from/memory "
  assert_log_lacks "trueforge_persona-knowledge-data:/from/knowledge "
  assert_eq "$(grep -c 'old-postgres' "$STUB_LOG" | tr -d ' ')" "$(grep -c 'old-postgres \(pg_dump\|sh -c\)\|^docker inspect .* old-postgres$' "$STUB_LOG" | tr -d ' ')" "the old database is only inspected and dumped"
}

# The temporary database kept its data in the named temporary volumes, made before it started.
assert_database_in_scratch_volumes() {
  assert_log_has "volume create --label com.amanuensis.scratch=migrate aman_migrate_pg"
  assert_log_has "volume create --label com.amanuensis.scratch=migrate aman_migrate_pg_data"
  assert_log_has "-v aman_migrate_pg:/var/lib/postgresql -v aman_migrate_pg_data:/var/lib/postgresql/data -e PGDATA=/var/lib/postgresql/data"
  assert_contains "$(cat "$SB_STATE/scratch_removed" 2>/dev/null)" "aman_migrate_pg_data"
  assert_eq "$(grep -n 'volume create .* aman_migrate_pg_data$' "$STUB_LOG" | head -n 1 | cut -d: -f1)" \
    "$(grep -n 'volume create .* aman_migrate_pg_data$\|run -d --name aman-migrate-pg' "$STUB_LOG" | head -n 1 | cut -d: -f1)" \
    "the data volume exists before the database starts"
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
  assert_eq "$(cat "$SB_STATE/copy_umask")" 0077 "the archive is private from its first byte (install.sh runs under umask 077)"
  assert_mode "$AMAN_HOME/exports" 700
  assert_contains "$(cat "$SB_STATE/pg_restored")" "PGDUMP-OF-OLD"
  assert_contains "$(cat "$SB_STATE/volume_copies")" "-v trueforge_memory-data:/from/memory:ro"
  assert_contains "$(cat "$SB_STATE/volume_copies")" "-v trueforge_persona-knowledge-data:/from/knowledge:ro"
  assert_contains "$(cat "$SB_STATE/volume_copies")" "chown -R 10001:10001 /to /out"
  assert_log_has "network create --internal"
  assert_log_has "POSTGRES_HOST_AUTH_METHOD=trust postgres:17"
  assert_database_in_scratch_volumes
  runs=$(export_runs)
  assert_eq "$(printf '%s\n' "$runs" | wc -l | tr -d ' ')" 2
  assert_contains "$(printf '%s\n' "$runs" | head -n 1)" "export-data --migrate --list-users"
  assert_contains "$(printf '%s\n' "$runs" | tail -n 1)" "--user 10001:10001"
  assert_contains "$(printf '%s\n' "$runs" | tail -n 1)" "export-data --migrate --include-uploads --include-instance-data --user trueforge-default --secrets-env /migrate/old.env --out /out/aman-export.zip"
  assert_eq "$(cat "$SB_STATE/export_stdin")" "$OLD_ENV_TEXT"
  assert_not_contains "$(cat "$STUB_LOG")" "invented-model-key" "the old keys never reach a command line"
  assert_flat_contains "$OUT" "The old Aman was not changed, and the temporary copies are removed."
  assert_flat_contains "$OUT" "Next: aman import $file --display-name 'Sam Example'"
  assert_cleaned_and_old_untouched
  sandbox_drop
}

test_the_next_line_is_safe_to_paste() {
  t_begin "the import line migrate prints keeps a name from the old database inert when pasted"
  setup_machine
  # shellcheck disable=SC2016 # the name is meant to hold a command substitution
  export STUB_EXPORT_USERS='{"sign_in":"off","users":[{"user_id":"kai-id","display_name":"Kai $(touch PWNED)","sessions":2}]}'
  run_install migrate --from-compose "$OLD"
  unset STUB_EXPORT_USERS
  assert_rc 0
  # shellcheck disable=SC2016
  assert_flat_contains "$OUT" "--display-name 'Kai \$(touch PWNED)'"
  local line
  line=$(flat "$OUT" | grep -o "Next: aman import [^']*'[^']*'" || true)
  # Pasting the line hands the name to the import as written, and runs nothing from it.
  # shellcheck disable=SC2329 # called by the pasted line
  (cd "$SB" && aman() { printf '%s\n' "$@" >"$SB/pasted"; } && eval "${line#Next: }")
  # shellcheck disable=SC2016
  assert_eq "$(tail -n 1 "$SB/pasted" 2>/dev/null)" 'Kai $(touch PWNED)' "the pasted line passes the name as written"
  assert_eq "$(find "$SB" -name PWNED | wc -l | tr -d ' ')" 0 "nothing ran from the name"
  sandbox_drop
}

test_migrate_finds_the_app_by_its_memory_folder() {
  t_begin "migrate finds the old app and its database by what they hold, whatever the services are called"
  setup_machine
  # The stacks the guide names call the app service aman.
  printf 'old-postgres aman-prod-sam postgres postgres\nold-app aman-prod-sam aman app\nold-redis aman-prod-sam redis other\n' >"$SB_STATE/old_containers"
  run_install migrate --from-compose "$OLD"
  assert_rc 0
  assert_contains "$(cat "$SB_STATE/volume_copies")" "-v trueforge_memory-data:/from/memory:ro"
  assert_contains "$(cat "$SB_STATE/pg_dumps")" "old-postgres"
  # The dev database started from the same folder belongs to another project and is never read.
  rm -f "$SB_STATE/pg_dumps"
  printf 'dev-postgres amanuensis postgres postgres\nold-server trueforge server app\nold-postgres trueforge postgres postgres\n' >"$SB_STATE/old_containers"
  run_install migrate --from-compose "$OLD"
  assert_rc 0
  assert_contains "$(cat "$SB_STATE/pg_dumps")" "old-postgres"
  assert_log_lacks "dev-postgres sh -c"
  assert_log_lacks "exec dev-postgres"
  assert_cleaned_and_old_untouched
  sandbox_drop
}

test_migrate_refuses_two_old_apps() {
  t_begin "migrate refuses a folder with two old apps or no database, and copies nothing"
  setup_machine
  printf 'old-postgres trueforge postgres postgres\nold-server trueforge server app\nold-server-2 trueforge server app\n' >"$SB_STATE/old_containers"
  run_install migrate --from-compose "$OLD"
  assert_rc 1
  assert_flat_contains "$ERR" "More than one old Aman runs from $OLD, so this move cannot tell which one to copy."
  printf 'old-server trueforge server app\nother-postgres amanuensis postgres postgres\n' >"$SB_STATE/old_containers"
  run_install migrate --from-compose "$OLD"
  assert_rc 1
  assert_flat_contains "$ERR" "Aman found no database of the old Aman made from $OLD."
  assert_log_lacks "pg_dump"
  assert_eq "$(exports | wc -l | tr -d ' ')" 0
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
  assert_flat_contains "$ERR" "has neither packages/trueforge/.env nor .env. Pass --from-compose the folder that holds the old compose.yml or docker-compose.yml."
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
  export STUB_EXPORT_USERS='Error: the copy could not be opened'
  run_install migrate --from-compose "$OLD"
  unset STUB_EXPORT_USERS
  assert_rc 1
  assert_flat_contains "$ERR" "Aman could not read the list of people from the copy of the old database. Run this again."
  printf 'MEMORY_BACKEND=mem0\n' >>"$OLD/packages/trueforge/.env"
  run_install migrate --from-compose "$OLD"
  assert_rc 1
  assert_flat_contains "$ERR" "The old Aman keeps its memory outside its files"
  assert_eq "$(exports | wc -l | tr -d ' ')" 0
  sandbox_drop
}

test_migrate_reads_a_top_level_env() {
  t_begin "a folder with only compose.yml and .env is read from that .env; packages/trueforge/.env wins when both exist"
  setup_machine
  rm -rf "$OLD/packages"
  : >"$OLD/compose.yml"
  printf '%s\n' "$OLD_ENV_TEXT" >"$OLD/.env"
  chmod 600 "$OLD/.env"
  run_install migrate --from-compose "$OLD"
  assert_rc 0
  assert_eq "$(exports | wc -l | tr -d ' ')" 1
  assert_eq "$(cat "$SB_STATE/export_stdin")" "$OLD_ENV_TEXT"
  assert_cleaned_and_old_untouched
  rm -f "$AMAN_HOME"/exports/aman-export-*.zip
  mkdir -p "$OLD/packages/trueforge"
  printf 'POSTGRES_USER=trueforge\nNEBIUS_API_KEY=invented-checkout-key-4444\n' >"$OLD/packages/trueforge/.env"
  run_install migrate --from-compose "$OLD"
  assert_rc 0
  assert_contains "$(cat "$SB_STATE/export_stdin")" "invented-checkout-key-4444" "the checkout's settings file is used first"
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

test_an_interrupted_copy_leaves_nothing_behind() {
  t_begin "an interrupt while the archive is copied out leaves no half-written file and removes every temporary piece"
  setup_machine
  export STUB_COPY_SIGNAL=INT
  run_install migrate --from-compose "$OLD"
  unset STUB_COPY_SIGNAL
  assert_rc 130
  assert_eq "$(find "$AMAN_HOME/exports" -type f 2>/dev/null | wc -l | tr -d ' ')" 0 "no export or half-written file"
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
test_the_next_line_is_safe_to_paste
test_migrate_finds_the_app_by_its_memory_folder
test_migrate_refuses_two_old_apps
test_migrate_asks_which_person_when_several_have_chats
test_migrate_refuses_what_it_cannot_read
test_migrate_reads_a_top_level_env
test_a_failed_copy_or_export_still_cleans_up
test_an_interrupted_copy_leaves_nothing_behind
test_migrate_options_belong_to_migrate
tests_finish
