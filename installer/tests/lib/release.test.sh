#!/usr/bin/env bash
# The release record and the shipped pins: previous.release.json is written
# only by an upgrade (STATE.md), and the pins no longer carry a setup image.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Runs a body in its own bash with the release library loaded and the
# release folder pointed at $1.
REL_OUT=
REL_RC=0
rel_run() {
  local dir=$1 body=$2
  REL_RC=0
  REL_OUT=$(bash -c ". '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/shared.sh'; . '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/release.sh'; RELEASE_DIR='$dir'; PINS_FILE='$dir/pins.json'; DRY_RUN=0; $body" 2>&1) || REL_RC=$?
}

rel_record() {
  # rel_record DIR APP_TAG: writes a release record naming the app tag.
  REL_REF=testref REL_APP_TAG=$2 REL_STT_TAG=aman-stt:test REL_CALENDAR_TAG=aman-calendar-caldav:test \
    REL_DEX_IMAGE=ghcr.io/example/dex@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    REL_MAIL_EMAIL_IMAGE=ghcr.io/example/mail@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    rel_run "$1" 'release_write'
}

pins_write() {
  # pins_write FILE DEX SETUP: a pins manifest; SETUP is "absent", "pinned" or "plain".
  {
    printf '{\n'
    printf '  "schema": "1",\n'
    printf '  "dex_image": "%s",\n' "$2"
    printf '  "mail_email_image": "ghcr.io/example/mail@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",\n'
    case "$3" in
      pinned) printf '  "setup_image": "docker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",\n' ;;
      plain) printf '  "setup_image": "docker:cli",\n' ;;
    esac
    printf '  "caddy_image": "ghcr.io/example/caddy@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",\n'
    printf '  "node_version": "22.14.0",\n'
    printf '  "node_sha256_linux_x64": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",\n'
    printf '  "node_sha256_linux_arm64": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",\n'
    printf '  "node_sha256_darwin_x64": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",\n'
    printf '  "node_sha256_darwin_arm64": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"\n'
    printf '}\n'
  } >"$1"
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
  REL_REF=testref REL_APP_TAG=aman-app:two REL_STT_TAG=aman-stt:test REL_CALENDAR_TAG=aman-calendar-caldav:test \
    REL_DEX_IMAGE=ghcr.io/example/dex@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    REL_MAIL_EMAIL_IMAGE=ghcr.io/example/mail@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    rel_run "$dir" 'release_write upgrade'
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
  rel_record "$dir" aman-app:one
  assert_eq "$REL_RC" 0
  assert_no_path "$dir/previous.release.json"
  rm -rf "$dir"
}

test_pins_without_setup_image_validate() {
  t_begin "the shipped pins validate with no setup_image field"
  local dir
  dir=$(mktemp -d)
  pins_write "$dir/pins.json" "ghcr.io/example/dex@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" absent
  rel_run "$dir" 'pins_validate'
  assert_eq "$REL_RC" 0
  rm -rf "$dir"
}

test_pins_with_plain_setup_image_validate() {
  t_begin "a setup_image left in a pins file is not checked any more"
  local dir
  dir=$(mktemp -d)
  pins_write "$dir/pins.json" "ghcr.io/example/dex@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" plain
  rel_run "$dir" 'pins_validate'
  assert_eq "$REL_RC" 0
  rm -rf "$dir"
}

test_pins_with_unpinned_dex_fail() {
  t_begin "an unpinned dex_image still stops the run"
  local dir
  dir=$(mktemp -d)
  pins_write "$dir/pins.json" "ghcr.io/example/dex:latest" absent
  rel_run "$dir" 'pins_validate'
  assert_eq "$REL_RC" 1
  assert_contains "$REL_OUT" "dex_image" "the failure names the field"
  rm -rf "$dir"
}

test_install_write_keeps_previous
test_upgrade_write_keeps_replaced_record
test_identical_write_changes_nothing
test_pins_without_setup_image_validate
test_pins_with_plain_setup_image_validate
test_pins_with_unpinned_dex_fail
tests_finish
