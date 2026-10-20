#!/usr/bin/env bash
# macOS regex refuses a repeat count above 255 (RE_DUP_MAX), so such a pattern never matches there. Linux accepts it,
# so only this scan catches it.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Reads "file:line:quantifier" lines on stdin and prints those whose repeat count is above 255.
over_limit() {
  awk -F'[{},]' '{ for (i = 2; i <= NF; i++) if ($i + 0 > 255) { print; break } }'
}

test_repeat_scan_flags_counts_above_255() {
  t_begin "the repeat-count scan flags 256 and passes 255"
  local flagged clean
  flagged=$(printf '%s\n' 'f:1:]{1,256}' 'f:2:)}{0,4096}' | over_limit | wc -l | tr -d ' ')
  clean=$(printf '%s\n' 'f:1:]{1,255}' 'f:2:]{16,255}' | over_limit)
  assert_eq "$flagged" 2 "both over-limit counts are found"
  assert_eq "$clean" "" "counts up to 255 pass"
}

test_no_installer_regex_repeats_above_255() {
  t_begin "no regex in installer/lib or installer/install.sh repeats a piece more than 255 times"
  local hits
  hits=$(grep -rnoE '[]a-zA-Z0-9)]\{[0-9]+(,[0-9]*)?\}' "$INSTALLER_DIR/lib" "$INSTALLER_DIR/install.sh" | over_limit || true)
  assert_eq "$hits" "" "repeat counts above 255 that macOS would refuse"
}

test_repeat_scan_flags_counts_above_255
test_no_installer_regex_repeats_above_255
tests_finish
