#!/usr/bin/env bash
# The run lock (common.sh): a lock is dead only when its holder's beat stopped, however long the run takes,
# and only one of several runs can take over a dead lock.
# shellcheck disable=SC2016 # the lock scripts are strings for a second bash, so they must not expand here
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Runs a lock script in its own bash with common.sh loaded, a short beat and the state folder $1.
LOCK_OUT=
LOCK_RC=0
lock_run() {
  local state=$1 body=$2
  LOCK_RC=0
  LOCK_OUT=$(bash -c '. "$1"; STATE_DIR=$2; die() { printf "%s\n" "$*" >&2; exit 1; }
LOCK_BEAT_SECONDS=1; LOCK_DEAD_SECONDS=3; set -euo pipefail; '"$body" _ "$INSTALLER_DIR/lib/common.sh" "$state" 2>&1) || LOCK_RC=$?
}

make_lock() {
  local state=$1 beat=$2
  mkdir -p "$state/lock"
  printf 'other-run\n' >"$state/lock/owner"
  printf '%s\n' "$beat" >"$state/lock/beat"
}

test_a_fresh_beat_blocks() {
  t_begin "a lock with a fresh beat blocks a run, and the message says how long to wait"
  local state
  state=$(mktemp -d)
  make_lock "$state" "$(date +%s)"
  lock_run "$state" 'LOCK_DEAD_SECONDS=120; lock_acquire'
  assert_eq "$LOCK_RC" 1
  assert_contains "$LOCK_OUT" "Another install is running right now"
  assert_contains "$LOCK_OUT" "wait 2 minutes"
  assert_eq "$(cat "$state/lock/owner")" other-run "the other run's lock is left alone"
  rm -rf "$state"
}

test_a_stopped_beat_is_taken_over() {
  t_begin "a lock whose beat stopped is taken over, and released again at the end"
  local state
  state=$(mktemp -d)
  make_lock "$state" $(($(date +%s) - 3600))
  lock_run "$state" 'lock_acquire; cat "$STATE_DIR/lock/owner" >"$STATE_DIR/seen"; lock_release'
  assert_eq "$LOCK_RC" 0
  assert_not_contains "$(cat "$state/seen")" other-run "the new holder owns the lock"
  assert_no_path "$state/lock"
  assert_eq "$(dir_names "$state")" "seen " "no moved-aside folder is left"
  rm -rf "$state"
}

test_a_long_run_is_never_taken_over() {
  t_begin "a holder that keeps beating keeps its lock long past the dead limit"
  local state holder
  state=$(mktemp -d)
  bash -c '. "$1"; STATE_DIR=$2; LOCK_BEAT_SECONDS=1; LOCK_DEAD_SECONDS=3; lock_acquire; sleep 7; lock_release' _ "$INSTALLER_DIR/lib/common.sh" "$state" >/dev/null 2>&1 &
  holder=$!
  sleep 5
  lock_run "$state" 'lock_acquire'
  assert_eq "$LOCK_RC" 1 "a lock older than the dead limit, still beating, is busy"
  wait "$holder"
  assert_no_path "$state/lock"
  rm -rf "$state"
}

test_a_killed_holder_is_taken_over_when_its_beat_stops() {
  t_begin "a holder killed without cleanup stops beating, and its lock is then taken over"
  local state holder
  state=$(mktemp -d)
  bash -c '. "$1"; STATE_DIR=$2; LOCK_BEAT_SECONDS=1; LOCK_DEAD_SECONDS=3; lock_acquire; sleep 8' _ "$INSTALLER_DIR/lib/common.sh" "$state" >/dev/null 2>&1 &
  holder=$!
  sleep 1
  kill -9 "$holder"
  wait "$holder" 2>/dev/null || true
  sleep 5
  lock_run "$state" 'lock_acquire; lock_release'
  assert_eq "$LOCK_RC" 0
  rm -rf "$state"
}

test_a_taken_over_holder_leaves_the_new_lock() {
  t_begin "a holder whose lock was taken over does not remove the new holder's lock"
  local state
  state=$(mktemp -d)
  lock_run "$state" 'lock_acquire; rm -rf "$STATE_DIR/lock"; mkdir "$STATE_DIR/lock"; printf "new-run\n" >"$STATE_DIR/lock/owner"; lock_write_beat "$STATE_DIR/lock"; lock_release'
  assert_eq "$LOCK_RC" 0
  assert_eq "$(cat "$state/lock/owner")" new-run
  rm -rf "$state"
}

test_a_live_lock_moved_by_mistake_is_put_back() {
  t_begin "when a run moves aside a lock another run made a moment ago, it puts that lock back and stays out"
  local state
  state=$(mktemp -d)
  make_lock "$state" $(($(date +%s) - 3600))
  lock_run "$state" 'mv() { if [ "$1" = "$STATE_DIR/lock" ] && [ -z "${raced:-}" ]; then raced=1; command rm -rf "$1"; command mkdir "$1"; printf "other-run\n" >"$1/owner"; date +%s >"$1/beat"; fi; command mv "$@"; }
lock_acquire'
  assert_eq "$LOCK_RC" 1
  assert_eq "$(cat "$state/lock/owner")" other-run "the live lock is back where it was"
  assert_eq "$(dir_names "$state")" "lock " "no moved-aside folder is left"
  rm -rf "$state"
}

test_a_fresh_beat_blocks
test_a_stopped_beat_is_taken_over
test_a_long_run_is_never_taken_over
test_a_killed_holder_is_taken_over_when_its_beat_stops
test_a_taken_over_holder_leaves_the_new_lock
test_a_live_lock_moved_by_mistake_is_put_back
tests_finish
