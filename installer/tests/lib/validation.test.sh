#!/usr/bin/env bash
# Names and other values are validated as whole strings; nothing outside instances/<name> is ever deleted.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

in_lib() {
  PATH=$SB_BIN "$SB_BIN/bash" -c "set -euo pipefail; AMAN_HOME='$AMAN_HOME'; INSTANCES_DIR='$AMAN_HOME/instances'; . '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/templates.sh'; . '$INSTALLER_DIR/lib/instance.sh'; $1"
}

tree_of() { (cd "$AMAN_HOME" && find . ! -path './state/lock*' ! -name install.log | sort); }

test_bad_names_are_refused() {
  t_begin "newline, .., /, a leading dash and an empty name are refused and nothing is deleted"
  sandbox_new
  install_machine
  local before bad
  before=$(tree_of)
  for bad in $'zed\nq' $'zed\nq/../../machine' '..' '../machine' 'a/b' '-x' '' 'Up' 'machine' $'a\tb' "$(printf 'a%.0s' $(seq 1 26))"; do
    run_install instance add "$bad"
    if [ "$RC" != 0 ]; then t_pass; else t_fail "instance add accepted [$bad]"; fi
    run_install instance remove "$bad"
    if [ "$RC" != 0 ]; then t_pass; else t_fail "instance remove accepted [$bad]"; fi
    run_install instance remove "$bad" --purge-data --confirm-name "$bad"
    if [ "$RC" != 0 ]; then t_pass; else t_fail "purge accepted [$bad]"; fi
  done
  assert_eq "$(tree_of)" "$before" "the home directory is untouched"
  assert_file "$AMAN_HOME/machine/compose.yaml"
  assert_file "$AMAN_HOME/instances/main/.env"
  assert_no_path "$SB_STATE/volumes_removed"
  sandbox_drop
}

test_values_with_newlines_are_refused() {
  t_begin "an email, URL or flag value with a second line is refused"
  sandbox_new
  local bad
  for bad in $'owner@example.invalid\nINJECTED=1' $'x@example.invalid\n'; do
    run_install --dry-run --email "$bad"
    if [ "$RC" != 0 ]; then t_pass; else t_fail "email accepted [$bad]"; fi
  done
  run_install --dry-run --email owner@example.invalid --public-url $'https://aman.example.invalid\nINJECTED=1' --login-url https://login.example.invalid
  if [ "$RC" != 0 ]; then t_pass; else t_fail "public URL accepted"; fi
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_validators_match_whole_strings() {
  t_begin "the validators reject a value whose second line would match"
  sandbox_new
  local out
  cat >"$SB/check.sh" <<'CHECK'
report() { if "$@"; then echo "ok:$1"; else echo "no:$1"; fi; }
report valid_name "$(printf 'ab\n../x')"
report valid_email "$(printf 'a@b.co\nx')"
report valid_origin "$(printf 'https://a.co\nx')"
report valid_name main
report valid_name a
report valid_name a-b
report valid_name a-
CHECK
  out=$(in_lib ". '$SB/check.sh'" | tr '\n' ' ')
  assert_eq "$out" "no:valid_name no:valid_email no:valid_origin ok:valid_name ok:valid_name ok:valid_name no:valid_name " "second-line values are refused, ordinary names and a trailing dash are judged on the whole string"
  sandbox_drop
}

test_removal_is_confined_to_instances() {
  t_begin "the directory removal refuses a symbolic link or a path outside instances/"
  sandbox_new
  install_machine
  ln -s "$AMAN_HOME/machine" "$AMAN_HOME/instances/evil"
  if in_lib 'remove_instance_dir evil' >/dev/null 2>&1; then t_fail "removed through a symlink"; else t_pass; fi
  assert_file "$AMAN_HOME/machine/compose.yaml"
  rm -f "$AMAN_HOME/instances/evil"
  if in_lib "remove_instance_dir '../machine'" >/dev/null 2>&1; then t_fail "removed a path outside instances"; else t_pass; fi
  if in_lib "remove_instance_dir \"\$(printf 'zed\nq/../../machine')\"" >/dev/null 2>&1; then t_fail "removed a traversal name"; else t_pass; fi
  assert_file "$AMAN_HOME/machine/compose.yaml"
  in_lib 'remove_instance_dir main'
  assert_no_path "$AMAN_HOME/instances/main"
  assert_file "$AMAN_HOME/machine/compose.yaml"
  sandbox_drop
}

test_bad_names_are_refused
test_values_with_newlines_are_refused
test_validators_match_whole_strings
test_removal_is_confined_to_instances
tests_finish
