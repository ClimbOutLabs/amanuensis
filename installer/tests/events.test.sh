#!/usr/bin/env bash
# The --events stream: one JSON line per phase, step, warning and result on a descriptor the caller
# opens, the terminal output unchanged by it, and nothing written anywhere when the flag is absent.
set -euo pipefail
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

EVENTS_FILE=

# run_install_events [args...]: like run_install, with descriptor 3 open on $EVENTS_FILE for the run.
run_install_events() {
  local out=$SB/out err=$SB/err
  build_run_env
  set +e
  env -i "${RUN_ENV[@]}" bash "$SB_INSTALLER/install.sh" "$@" <"${INPUT_FILE:-/dev/null}" >"$out" 2>"$err" 3>"$EVENTS_FILE"
  RC=$?
  set -e
  OUT=$(cat "$out")
  ERR=$(cat "$err")
}

# run_install_events_tty ANSWERS: like run_install_tty, with descriptor 3 open on $EVENTS_FILE.
run_install_events_tty() {
  local answers=$1
  build_run_env
  printf '%s\n' "$answers" >"$SB/answers"
  set +e
  OUT=$(python3 "$TESTS_DIR/pty_run.py" "$SB/answers" -- env -i "${RUN_ENV[@]}" TERM=dumb bash -c 'exec 3>>"$1"; shift; exec bash "$@"' _ "$EVENTS_FILE" "$SB_INSTALLER/install.sh" --events 3)
  set -e
  RC=$(printf '%s\n' "$OUT" | sed -n 's/^\[exit \([[:digit:]]*\)\]$/\1/p' | tail -n 1)
  ERR=
}

# Every line of the events file parses as JSON.
assert_events_json() {
  if python3 -c '
import json, sys
for line in open(sys.argv[1]):
    if line.strip():
        json.loads(line)
' "$EVENTS_FILE" 2>/dev/null; then
    t_pass
  else
    t_fail "an events line is not JSON: $(cat "$EVENTS_FILE")"
  fi
}

# The type field of every event, one per line, in stream order.
event_types() {
  python3 -c '
import json, sys
for line in open(sys.argv[1]):
    if line.strip():
        print(json.loads(line)["type"])
' "$EVENTS_FILE"
}

# How many events of one type the stream holds.
event_count() {
  event_types | grep -c "^$1\$" || true
}

test_events_dry_run() {
  t_begin "a dry run with --events streams its phases and checks in the order it prints them, and the terminal output is unchanged"
  sandbox_new
  EVENTS_FILE=$SB/events.jsonl
  run_install --dry-run
  assert_rc 0
  local plain_out=$OUT plain_err=$ERR
  run_install_events --dry-run --events 3
  assert_rc 0
  assert_eq "$OUT" "$plain_out" "terminal output of a run with --events"
  assert_eq "$ERR" "$plain_err" "terminal errors of a run with --events"
  assert_file "$EVENTS_FILE"
  assert_events_json
  assert_eq "$(event_types | head -n 1)" "phase_start" "the stream opens with a phase"
  assert_eq "$(event_count final_result)" 1 "exactly one final line"
  assert_eq "$(event_types | tail -n 1)" "final_result" "the final line is last"
  assert_contains "$(tail -n 1 "$EVENTS_FILE")" '"result":"success"' "the dry run ends as a success"
  if python3 - "$EVENTS_FILE" "$SB/out" <<'PYEOF'
import json, sys
events = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
out = open(sys.argv[2]).read()
phases = [e["name"] for e in events if e["type"] == "phase_start"]
assert phases == ["Checking this computer", "Your first instance", "The plan"], phases
pos = -1
for e in events:
    if e["type"] == "step_result":
        found = out.find(e["name"], pos + 1)
        assert found > pos, "step result %r is not printed after the previous one" % e["name"]
        pos = found
PYEOF
  then
    t_pass
  else
    t_fail "the stream's phases or steps do not match the printed run: $(cat "$EVENTS_FILE")"
  fi
  sandbox_drop
}

test_events_first_install() {
  t_begin "a first install streams its phases and steps, warns as an event, ends with one success line, and never holds the password"
  sandbox_new
  EVENTS_FILE=$SB/events.jsonl
  STUB_DOCKER_MEM_BYTES=7000000000
  with_input "$SENTINEL_PASSWORD
"
  run_install_events --yes --password-stdin --email owner@example.invalid --events 3
  clear_input
  assert_rc 0
  assert_events_json
  local events
  events=$(cat "$EVENTS_FILE")
  assert_contains "$events" '"name":"Building the app"' "the build phase is streamed"
  assert_contains "$events" '"name":"Starting services"' "the services phase is streamed"
  assert_contains "$events" '"name":"Checking the result"' "the check phase is streamed"
  assert_contains "$events" '"type":"step_start"' "long steps open as events"
  assert_contains "$events" "Running the doctor's full check" "the doctor step is streamed"
  assert_contains "$events" '"result":"done"' "finished steps report done"
  assert_contains "$events" '"type":"warning"' "a warning is streamed as its own kind"
  assert_contains "$events" "Docker has" "the memory warning is streamed"
  assert_eq "$(event_count final_result)" 1 "exactly one final line"
  assert_contains "$(tail -n 1 "$EVENTS_FILE")" '"result":"success"' "the install ends as a success"
  assert_not_contains "$events" "$SENTINEL_PASSWORD" "the password is never an event"
  assert_contains "$OUT" "Ready." "the run really installed"
  sandbox_drop
}

test_events_admin_prompt() {
  t_begin "the sandbox consent question reaches the stream as an admin prompt, and the password does not"
  sandbox_new
  printf 'needs_disk\n' >"$SB_STATE/slots_state"
  EVENTS_FILE=$SB/events.jsonl
  run_install_events_tty "Name for this instance=>
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD
Set up the sandbox now?=>y"
  assert_eq "$RC" 0 "the run finishes"
  assert_events_json
  local events
  events=$(cat "$EVENTS_FILE")
  assert_contains "$events" '"type":"admin_prompt"' "the consent question is an admin prompt event"
  assert_contains "$events" "Set up the sandbox now?" "the question's own words are the event"
  assert_eq "$(event_count final_result)" 1 "exactly one final line"
  assert_not_contains "$events" "$SENTINEL_PASSWORD" "the password is never an event"
  sandbox_drop
}

test_events_bad_descriptor() {
  t_begin "an events descriptor that cannot be written stops the run before anything happens and names the one fix"
  sandbox_new
  run_install --events 9
  assert_rc 2
  assert_flat_contains "$ERR" "File descriptor 9 is not open for writing"
  assert_flat_contains "$ERR" "3>events.txt"
  assert_no_path "$AMAN_HOME"
  assert_eq "$(cat "$STUB_LOG")" "" "no command ran"
  run_install --events 1
  assert_rc 2
  assert_flat_contains "$ERR" "cannot use 0, 1 or 2"
  assert_no_path "$AMAN_HOME"
  run_install --events abc
  assert_rc 2
  assert_flat_contains "$ERR" "takes the number of an open file descriptor"
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_events_words_survive() {
  t_begin "quotes, backslashes, newlines and other scripts in a moment's words reach the stream as the same words"
  sandbox_new
  EVENTS_FILE=$SB/events.jsonl
  env -i PATH="$PATH" TERM=xterm bash -c '
    . "$1/lib/ui.sh"
    ui_init
    UI_EVENTS_FD=3
    UI_EVENTS_T0=$SECONDS
    ui_phase "Phase \"quoted\" \\name" 2 6
    ui_warn "Ünïcode ✓ in \"quotes\"" "Next: do it"
    ui_step_start "One
two"
    ui_step_end fail "One
two"
  ' _ "$INSTALLER_DIR" 3>"$EVENTS_FILE" >/dev/null 2>&1
  assert_events_json
  if python3 - "$EVENTS_FILE" <<'PYEOF'
import json, sys
events = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
assert [e["type"] for e in events] == ["phase_start", "warning", "step_start", "step_result"], events
assert events[0]["name"] == 'Phase "quoted" \\name', events[0]
assert events[0]["index"] == 2 and events[0]["total"] == 6, events[0]
assert events[1]["text"] == 'Ünïcode ✓ in "quotes"', events[1]
assert events[1]["next"] == "Next: do it", events[1]
assert events[2]["name"] == "One\ntwo", events[2]
assert events[3]["name"] == "One\ntwo" and events[3]["result"] == "failed", events[3]
assert all(isinstance(e["elapsed_seconds"], int) and e["elapsed_seconds"] >= 0 for e in events), events
PYEOF
  then
    t_pass
  else
    t_fail "the words changed on their way into the stream: $(cat "$EVENTS_FILE")"
  fi
  sandbox_drop
}

test_no_events_without_the_flag() {
  t_begin "without --events a run writes no event lines anywhere"
  sandbox_new
  install_machine
  assert_tree_lacks "$SB" '"type":"phase_start"'
  assert_tree_lacks "$SB" '"type":"final_result"'
  sandbox_drop
}

test_events_dry_run
test_events_first_install
test_events_admin_prompt
test_events_bad_descriptor
test_events_words_survive
test_no_events_without_the_flag
tests_finish
