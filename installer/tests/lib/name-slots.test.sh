#!/usr/bin/env bash
# A name ending in -slots is refused because its compose project would be the sandbox project of another instance.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

test_slots_suffix_is_refused_where_it_would_share_a_sandbox() {
  t_begin "maya-slots is refused, because its project aman-maya-slots is also the sandbox project of an instance named aman-maya"
  local problem name project sandbox
  problem=$(bash -c "set -euo pipefail; . '$INSTALLER_DIR/lib/common.sh'; name_problem maya-slots")
  assert_contains "$problem" "must not end with -slots" "maya-slots was not refused"
  assert_eq "$(bash -c "set -euo pipefail; . '$INSTALLER_DIR/lib/common.sh'; name_problem aman-maya")" "" "aman-maya is a valid name"
  name=maya-slots
  project="aman-$name"
  name=aman-maya
  sandbox="$name-slots"
  assert_eq "$project" "$sandbox" "the two projects do not collide"
}

test_slots_suffix_is_refused_where_it_would_share_a_sandbox
tests_finish
