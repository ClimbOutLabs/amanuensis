#!/usr/bin/env bash
# Downloading the Aman images CI publishes: pull, fallback to a build, the revision check and --build-from-source.
set -euo pipefail
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

APP_REMOTE=ghcr.io/climboutlabs/aman-app

install_with_password() {
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid "$@"
  clear_input
}

test_pull_replaces_build_and_records_digest() {
  t_begin "a published app image is downloaded, given the local tag, and its digest recorded"
  sandbox_new
  install_with_password
  assert_rc 0
  assert_log_has "docker pull $APP_REMOTE:"
  assert_log_has "docker tag $APP_REMOTE:"
  assert_log_lacks "docker build -f $REPO/Dockerfile.dev"
  assert_log_has "docker pull ghcr.io/climboutlabs/aman-stt:"
  assert_log_lacks "docker build -t aman-stt:"
  assert_contains "$OUT" "Downloaded the Aman app"
  assert_contains "$(cat "$AMAN_HOME/release/release.json")" "\"app_image_digest\": \"$APP_REMOTE@sha256:"
  assert_contains "$(cat "$AMAN_HOME/release/release.json")" "\"stt_image_digest\": \"ghcr.io/climboutlabs/aman-stt@sha256:"
  sandbox_drop
}

test_failed_pull_builds_here() {
  t_begin "when the download is not available, the app is built here and no digest is recorded"
  sandbox_new
  export STUB_PULL_FAIL=climboutlabs
  install_with_password
  assert_rc 0
  assert_log_has "docker build -f $REPO/Dockerfile.dev"
  assert_contains "$OUT$ERR" "Not available to download; building it here"
  assert_contains "$(cat "$AMAN_HOME/release/release.json")" "\"app_image_digest\": \"\""
  sandbox_drop
}

test_revision_mismatch_stops() {
  t_begin "a downloaded app that is not this commit is refused, not used"
  sandbox_new
  printf 'not-this-commit\n' >"$SB_STATE/revision"
  install_with_password
  assert_rc 1
  assert_contains "$OUT$ERR" "The downloaded Aman app does not match this copy of the code"
  assert_contains "$OUT$ERR" "--build-from-source"
  assert_log_lacks "docker build -f $REPO/Dockerfile.dev"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_build_from_source_skips_pull() {
  t_begin "--build-from-source builds every image and attempts no download"
  sandbox_new
  install_with_password --build-from-source
  assert_rc 0
  assert_log_lacks "docker pull $APP_REMOTE"
  assert_log_lacks "docker pull ghcr.io/climboutlabs/aman-stt"
  assert_log_has "docker build -f $REPO/Dockerfile.dev"
  assert_log_has "docker build -t aman-stt:"
  assert_log_lacks "docker pull $APP_REMOTE"
  sandbox_drop
}

test_dry_run_says_download_or_build() {
  t_begin "the plan says download by default and build with --build-from-source"
  sandbox_new
  run_install --dry-run
  assert_rc 0
  assert_contains "$OUT" "Download the Aman app"
  assert_contains "$OUT" "Download the speech-to-text service"
  assert_contains "$OUT" "Download the calendar connector"
  assert_not_contains "$OUT" "Build the Aman app"
  run_install --dry-run --build-from-source
  assert_rc 0
  assert_contains "$OUT" "Build the Aman app"
  assert_not_contains "$OUT" "Download the Aman app"
  assert_log_lacks "docker pull"
  sandbox_drop
}

test_print_network_lists_registry() {
  t_begin "--print-network lists ghcr.io for the image downloads"
  sandbox_new
  run_install --print-network
  assert_rc 0
  assert_contains "$OUT" "ghcr.io"
  sandbox_drop
}

test_pull_replaces_build_and_records_digest
test_failed_pull_builds_here
test_revision_mismatch_stops
test_build_from_source_skips_pull
test_dry_run_says_download_or_build
test_print_network_lists_registry
tests_finish
