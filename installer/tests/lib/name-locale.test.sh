#!/usr/bin/env bash
# Name checks give the same answers under a UTF-8 locale, where bash's bracket ranges follow the locale's collation.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

test_name_checks_under_utf8_locale() {
  t_begin "under a UTF-8 locale, aman-maya passes the name checks and Main is refused for capitals"
  local loc=en_US.UTF-8 out
  locale -a 2>/dev/null | grep -Fxq "$loc" || loc=C.UTF-8
  out=$(LC_ALL=$loc bash -c "set -euo pipefail; . '$INSTALLER_DIR/lib/common.sh'
    printf '%s\n' \"\$(locale charmap)\" \"[\$(name_problem aman-maya)]\" \"\$(name_problem Main)\" \"[\$(name_problem a-slots)]\"" </dev/null)
  assert_eq "$(printf '%s\n' "$out" | sed -n 1p)" "UTF-8" "the test locale $loc is not active"
  assert_eq "$(printf '%s\n' "$out" | sed -n 2p)" "[]" "aman-maya was refused"
  assert_contains "$(printf '%s\n' "$out" | sed -n 3p)" "has capital letters" "Main was not refused for capitals"
  assert_eq "$(printf '%s\n' "$out" | sed -n 4p)" "[\"a-slots\" must not end with -slots; that ending is used for the run-code sandbox of another instance.]" "a-slots was not refused"
}

test_name_checks_under_utf8_locale
tests_finish
