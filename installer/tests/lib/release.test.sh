#!/usr/bin/env bash
# The release record: previous.release.json is written only by an upgrade, as STATE.md defines it.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Runs a body in its own bash with the release library loaded and the release folder pointed at $1.
REL_OUT=
REL_RC=0
rel_run() {
  local dir=$1 body=$2
  REL_RC=0
  REL_OUT=$(bash -c ". '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/shared.sh'; . '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/release.sh'; RELEASE_DIR='$dir'; DRY_RUN=0; $body" 2>&1) || REL_RC=$?
}

# rel_record DIR APP_TAG [upgrade]: writes a release record naming the app tag.
rel_record() {
  REL_REF=testref REL_APP_TAG=$2 REL_STT_TAG=aman-stt:test REL_CALENDAR_TAG=aman-calendar-caldav:test \
    REL_DEX_IMAGE=ghcr.io/example/dex@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    REL_MAIL_EMAIL_IMAGE=ghcr.io/example/mail@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    rel_run "$1" "release_write ${3:-}"
}

test_install_write_keeps_previous() {
  t_begin "a plain install write leaves previous.release.json as it was"
  local dir
  dir=$(mktemp -d)
  rel_record "$dir" aman-app:one
  printf 'the record from before the last upgrade\n' >"$dir/previous.release.json"
  rel_record "$dir" aman-app:two
  assert_eq "$REL_RC" 0
  assert_contains "$(cat "$dir/release.json")" "aman-app:two" "the new record is written"
  assert_eq "$(cat "$dir/previous.release.json")" "the record from before the last upgrade" "previous.release.json is untouched by an install write"
  rm -rf "$dir"
}

test_upgrade_write_keeps_replaced_record() {
  t_begin "an upgrade write keeps the record it replaces in previous.release.json"
  local dir
  dir=$(mktemp -d)
  rel_record "$dir" aman-app:one
  rel_record "$dir" aman-app:two upgrade
  assert_eq "$REL_RC" 0
  assert_contains "$(cat "$dir/release.json")" "aman-app:two" "the new record is written"
  assert_contains "$(cat "$dir/previous.release.json")" "aman-app:one" "the replaced record is kept"
  rm -rf "$dir"
}

test_identical_write_changes_nothing() {
  t_begin "writing the same record again changes neither file"
  local dir
  dir=$(mktemp -d)
  rel_record "$dir" aman-app:one
  rel_record "$dir" aman-app:one upgrade
  assert_eq "$REL_RC" 0
  assert_no_path "$dir/previous.release.json"
  rm -rf "$dir"
}

test_install_write_keeps_previous
test_upgrade_write_keeps_replaced_record
test_identical_write_changes_nothing
tests_finish
