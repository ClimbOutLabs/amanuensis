#!/usr/bin/env bash
# Plan, dry run, first install, idempotent re-run, recovery and secret handling.
set -euo pipefail
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

test_dry_run_changes_nothing() {
  t_begin "dry run prints the plan and changes nothing"
  sandbox_new
  run_install --dry-run
  assert_rc 0
  assert_no_path "$AMAN_HOME"
  assert_contains "$OUT" "Amanuensis install plan"
  assert_contains "$OUT" "First-run downloads (approximate)"
  assert_contains "$OUT" "Whisper small speech model weights"
  assert_contains "$OUT" "Search embedding model"
  assert_contains "$OUT" "total: about"
  assert_contains "$OUT" "Nothing is pushed to any registry"
  assert_contains "$OUT" "Run code and attachment extraction stay off"
  assert_contains "$OUT" "Dry run: nothing was changed."
  assert_log_lacks "docker build"
  assert_log_lacks "docker pull"
  assert_log_lacks "docker run"
  assert_log_lacks " up -d"
  assert_log_lacks "docker push"
  assert_log_lacks "sudo "
  sandbox_drop
}

test_dry_run_without_docker_reports_blocker() {
  t_begin "dry run without docker names the blocker and the root steps"
  sandbox_new
  os_release_ubuntu
  rm -f "$SB_BIN/docker"
  run_install --dry-run
  assert_rc 0
  assert_contains "$OUT" "[root]"
  assert_contains "$OUT" "Install Docker Engine"
  assert_contains "$OUT" "Docker Engine, Compose and Buildx packages"
  assert_eq "$(printf '%s\n' "$OUT" | grep -c 'Whisper small speech model weights')" 1 "each download is listed once"
  assert_log_lacks "sudo "
  sandbox_drop
}

test_first_install() {
  t_begin "first install builds locally and creates private files"
  sandbox_new
  install_machine
  assert_contains "$OUT" "Open:     http://127.0.0.1:8791"
  assert_contains "$OUT" "Use 127.0.0.1 in the browser"
  assert_mode "$AMAN_HOME" 700
  assert_mode "$AMAN_HOME/instances/main" 700
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  assert_mode "$AMAN_HOME/machine/.env" 600
  assert_mode "$AMAN_HOME/state/instances/main.conf" 600
  assert_mode "$AMAN_HOME/state" 700
  assert_file "$AMAN_HOME/release/release.json"
  assert_file "$AMAN_HOME/state/installed"
  assert_log_has "docker build -f $REPO/Dockerfile.dev"
  assert_log_has "docker build -t aman-stt:"
  assert_log_has "ghcr.io/dexidp/dex@sha256:"
  assert_log_lacks "docker push"
  assert_log_lacks "docker.sock"
  local compose env
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  env=$(cat "$AMAN_HOME/instances/main/.env")
  assert_not_contains "$compose" "docker.sock" "app containers never get the socket"
  assert_not_contains "$compose" "subpath" "no volume subpaths"
  assert_not_contains "$(cat "$AMAN_HOME/machine/compose.yaml")" "cpuset" "no cpuset pins"
  assert_not_contains "$compose" "cpuset"
  assert_contains "$env" "STANDALONE=true"
  assert_contains "$env" "PUBLIC_BASE_URL=http://127.0.0.1:8791"
  assert_contains "$env" "OIDC_ISSUER_URL=http://127.0.0.1:5556/dex"
  assert_contains "$env" "OIDC_ALLOWED_EMAILS=owner@example.invalid"
  assert_contains "$env" "SQLITE_PATH=/data/db/db.sqlite"
  assert_contains "$env" "STT_URL=http://aman-stt:8001"
  assert_contains "$env" "AUTH_COOKIE_SUFFIX="
  assert_not_contains "$env" "DEX_USER_PASSWORD_HASH" "the app container never gets the login password hash"
  assert_not_contains "$env" "\$2a\$10\$"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.env")" "DEX_USER_PASSWORD_HASH='\$2a\$10\$"
  assert_mode "$AMAN_HOME/instances/main/dex.env" 600
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "type: sqlite3"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "redirectURIs:"
  assert_contains "$compose" "name: aman_main_data"
  assert_contains "$compose" "name: aman_main_dex"
  assert_contains "$compose" "ghcr.io/dexidp/dex@sha256:"
  assert_not_contains "$compose" "@@" "no unfilled placeholder"
  assert_contains "$compose" "127.0.0.1:8791:8790"
  sandbox_drop
}

test_password_never_leaks() {
  t_begin "the password reaches only the hashing container's stdin"
  sandbox_new
  install_machine
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$SENTINEL_PASSWORD" "hash step got the password on stdin"
  assert_tree_lacks "$AMAN_HOME" "$SENTINEL_PASSWORD"
  assert_not_contains "$(cat "$STUB_LOG")" "$SENTINEL_PASSWORD" "argv log"
  assert_not_contains "$(cat "$SB_STATE/hash_env")" "$SENTINEL_PASSWORD" "child environment"
  assert_not_contains "$OUT$ERR" "$SENTINEL_PASSWORD" "installer output"
  assert_log_has "docker run --rm -i --network none aman-app:"
  sandbox_drop
}

test_rerun_is_idempotent() {
  t_begin "a second run changes nothing"
  sandbox_new
  install_machine
  local before_env before_tree builds runs ups
  before_env=$(cat "$AMAN_HOME/instances/main/.env")
  before_tree=$(cd "$AMAN_HOME" && find . -type f ! -name install.log ! -path './state/lock/*' -exec cksum {} + | sort)
  builds=$(log_count "docker build")
  runs=$(log_count "amanuensis hash-password")
  ups=$(log_count " up -d")
  run_install --yes
  assert_rc 0
  assert_contains "$OUT" "Nothing to do."
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$before_env" ".env untouched"
  assert_eq "$(cd "$AMAN_HOME" && find . -type f ! -name install.log ! -path './state/lock/*' -exec cksum {} + | sort)" "$before_tree" "tree"
  assert_eq "$(log_count "docker build")" "$builds" "no rebuild"
  assert_eq "$(log_count "amanuensis hash-password")" "$runs" "no second hash"
  assert_eq "$(log_count " up -d")" "$ups" "nothing recreated"
  sandbox_drop
}

test_rerun_restarts_stopped_instance() {
  t_begin "a rerun converges a stopped instance without regenerating secrets"
  sandbox_new
  install_machine
  local env_before
  env_before=$(cat "$AMAN_HOME/instances/main/.env")
  rm -f "$SB_STATE/up/aman-main"
  run_install --yes
  assert_rc 0
  assert_contains "$OUT" "Start instance main"
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$env_before" ".env kept"
  assert_file "$SB_STATE/up/aman-main"
  sandbox_drop
}

test_failed_build_then_rerun_converges() {
  t_begin "a failed build leaves no instance and a rerun finishes"
  sandbox_new
  STUB_BUILD_FAIL=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 1
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  unset STUB_BUILD_FAIL
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 0
  assert_file "$AMAN_HOME/state/instances/main.conf"
  clear_input
  sandbox_drop
}

test_partial_instance_dir_is_replaced() {
  t_begin "a half-written instance directory from a killed run is rebuilt"
  sandbox_new
  mkdir -p "$AMAN_HOME/instances/main"
  printf 'STALE=1\n' >"$AMAN_HOME/instances/main/.env"
  install_machine
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "STALE"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_concurrent_run_blocked_and_stale_lock_taken_over() {
  t_begin "a live lock blocks a run and a dead one is replaced"
  sandbox_new
  mkdir -p "$AMAN_HOME/state/lock"
  sleep 30 &
  local pid=$!
  printf '%s\n' "$pid" >"$AMAN_HOME/state/lock/pid"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 1
  assert_contains "$ERR" "another installer run"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 0
  clear_input
  sandbox_drop
}

test_password_mismatch_stops() {
  t_begin "mismatched passwords are refused"
  sandbox_new
  with_input "first-password-1
second-password-2
"
  run_install --yes --email owner@example.invalid
  assert_rc 1
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  clear_input
  sandbox_drop
}

test_declining_changes_nothing() {
  t_begin "answering no at the confirmation changes nothing"
  sandbox_new
  with_input "

n
"
  run_install --name main --email owner@example.invalid
  assert_rc 0
  assert_contains "$OUT" "Nothing was changed."
  assert_no_path "$AMAN_HOME"
  assert_log_lacks "docker build"
  clear_input
  sandbox_drop
}

test_low_disk_blocks() {
  t_begin "less than 10 GB free blocks the plan"
  sandbox_new
  STUB_DF_KB=1000000
  run_install --dry-run
  assert_rc 1
  assert_contains "$OUT$ERR" "Less than 10 GB free"
  sandbox_drop
}

test_print_only_flags() {
  t_begin "print flags show requirements and hosts without touching anything"
  sandbox_new
  run_install --print-proxy-requirements
  assert_rc 0
  assert_contains "$OUT" "Requirements for your reverse proxy"
  assert_contains "$OUT" "forward to http://127.0.0.1:<app port>"
  run_install --print-network
  assert_rc 0
  assert_contains "$OUT" "huggingface.co"
  assert_contains "$OUT" "ghcr.io"
  assert_contains "$OUT" "Nothing is scanned"
  assert_no_path "$AMAN_HOME"
  assert_eq "$(cat "$STUB_LOG")" "" "no docker call"
  sandbox_drop
}

test_dry_run_changes_nothing
test_print_only_flags
test_dry_run_without_docker_reports_blocker
test_first_install
test_password_never_leaks
test_rerun_is_idempotent
test_rerun_restarts_stopped_instance
test_failed_build_then_rerun_converges
test_partial_instance_dir_is_replaced
test_concurrent_run_blocked_and_stale_lock_taken_over
test_password_mismatch_stops
test_declining_changes_nothing
test_low_disk_blocks
tests_finish
