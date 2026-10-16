#!/usr/bin/env bash
# Names and other values are validated as whole strings; nothing outside instances/<name> is ever deleted.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

in_lib() {
  PATH=$SB_BIN "$SB_BIN/bash" -c "set -euo pipefail; AMAN_HOME='$AMAN_HOME'; INSTANCES_DIR='$AMAN_HOME/instances'; . '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/templates.sh'; . '$INSTALLER_DIR/lib/tls.sh'; . '$INSTALLER_DIR/lib/instance.sh'; $1"
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

# A UTF-8 en_US locale that works here, or nothing. Where only the locale source is installed (most Linux images) it
# is compiled into the sandbox. On macOS a range like [A-Z] follows collation in that locale.
en_us_locale() {
  if [ "$(env LC_ALL=en_US.UTF-8 locale charmap 2>/dev/null)" = UTF-8 ]; then
    echo en_US.UTF-8
  elif command -v localedef >/dev/null 2>&1 && localedef -i en_US -f UTF-8 "$SB/locales/en_US.UTF-8" >/dev/null 2>&1; then
    echo en_US.UTF-8
  fi
}

test_validators_ignore_the_locale() {
  t_begin "name, user, email, address and template checks answer the same in UTF-8 locales"
  sandbox_new
  mkdir -p "$SB/locales"
  printf '%s\n' 'x=@@KEY@@' 'y=@@lower@@' >"$SB/tpl"
  cat >"$SB/check.sh" <<'CHECK'
yes_no() { if "$@"; then echo ok; else echo no; fi; }
for v in mac mac-trial a abc-1 Mac mAc MAC 1ab -ab 'a b' a_b café; do echo "problem $v: $(name_problem "$v")"; done
for v in mac mac-trial Mac café a-; do echo "name $v: $(yes_no valid_name "$v") user $v: $(yes_no valid_user_name "$v")"; done
for v in you@example.com You@Example.com yé@example.com; do echo "email $v: $(yes_no valid_email "$v")"; done
for v in https://aman.example.com https://amé.example.com; do echo "origin $v: $(yes_no valid_origin "$v")"; done
for v in 192.168.1.20 192.168.1.256 spark.local SPARK café; do echo "private $v: $(yes_no private_host "$v")"; done
echo "address Spark.Local: [$(address_problem Spark.Local)]"
echo "address café: [$(address_problem café)]"
echo "template: $(render_template "$SB_TPL" KEY=1 2>&1 | tr '\n' '|')"
CHECK
  local loc out first=''
  for loc in C.UTF-8 en_US.UTF-8; do
    if [ "$loc" = en_US.UTF-8 ]; then
      loc=$(en_us_locale)
      [ -n "$loc" ] || continue
    fi
    out=$(LC_ALL=$loc LOCPATH=$SB/locales SB_TPL=$SB/tpl in_lib ". '$INSTALLER_DIR/lib/shared.sh'; . '$INSTALLER_DIR/lib/network.sh'; . '$INSTALLER_DIR/lib/users.sh'; . '$SB/check.sh'" 2>&1 || true)
    [ -n "$first" ] || first=$out
    assert_eq "$out" "$first" "answers in $loc differ from C.UTF-8"
    assert_contains "$out" "problem mac: " "mac is fine in $loc"
    assert_contains "$out" "problem mac-trial: "$'\n' "mac-trial is fine in $loc"
    assert_contains "$out" 'problem Mac: "Mac" has capital letters' "capitals are refused in $loc"
    assert_contains "$out" 'problem mAc: "mAc" has capital letters' "a middle capital is refused in $loc"
    assert_contains "$out" 'problem 1ab: "1ab" must start with a letter.' "a leading digit is refused in $loc"
    assert_contains "$out" 'problem café: "café" has the character é' "an accented letter is refused whole in $loc"
    assert_contains "$out" "name mac: ok user mac: ok" "valid_name and valid_user_name take lowercase in $loc"
    assert_contains "$out" "name Mac: no user Mac: no" "valid_name and valid_user_name refuse capitals in $loc"
    assert_contains "$out" "name café: no user café: no" "valid_name and valid_user_name refuse accents in $loc"
    assert_contains "$out" "email You@Example.com: ok" "capitals are fine in an email in $loc"
    assert_contains "$out" "email yé@example.com: no" "an accent in an email is refused in $loc"
    assert_contains "$out" "origin https://amé.example.com: no" "an accent in an origin is refused in $loc"
    assert_contains "$out" "private SPARK: ok" "a single-label name is private whatever its case in $loc"
    assert_contains "$out" "private café: no" "an accented name is not a host in $loc"
    assert_contains "$out" "template: x=1|y=@@lower@@|" "a lowercase @@word@@ is not a placeholder in $loc"
  done
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
test_validators_ignore_the_locale
test_removal_is_confined_to_instances
tests_finish
