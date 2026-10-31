#!/usr/bin/env bash
# The registry writers: reg_set replaces only the first line of a key, the
# same as the TypeScript store, so a file with a repeated key keeps its
# later lines.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Runs a body in its own bash with the registry library loaded and the
# registry folder pointed at $1.
reg_run() {
  local dir=$1 body=$2
  bash -c ". '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/shared.sh'; . '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/registry.sh'; REG_DIR='$dir'; DRY_RUN=0; $body"
}

test_reg_set_replaces_first_line_only() {
  t_begin "reg_set replaces the first line of a key and leaves later lines alone"
  local dir
  dir=$(mktemp -d)
  mkdir -p "$dir"
  printf 'name=main\npublic_url=https://old.example\npublic_url=https://second.example\n' >"$dir/main.conf"
  reg_run "$dir" 'reg_set main public_url https://new.example'
  assert_eq "$(cat "$dir/main.conf")" "name=main
public_url=https://new.example
public_url=https://second.example" "only the first line changed"
  assert_eq "$(reg_run "$dir" 'reg_get main public_url')" "https://new.example" "reg_get reads the first line"
  rm -rf "$dir"
}

test_reg_set_appends_a_missing_key() {
  t_begin "reg_set appends a key the file does not have"
  local dir
  dir=$(mktemp -d)
  printf 'name=main\n' >"$dir/main.conf"
  reg_run "$dir" 'reg_set main tls on'
  assert_eq "$(cat "$dir/main.conf")" "name=main
tls=on" "the key was appended"
  rm -rf "$dir"
}

test_reg_set_replaces_first_line_only
test_reg_set_appends_a_missing_key
tests_finish
