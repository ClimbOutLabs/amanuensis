#!/usr/bin/env bash
# The host report the app shows as its last full check: valid JSON, escaped text, saved atomically, a failed save that
# only warns, and the command each installer run saves it for.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"
# shellcheck source=../../lib/host-report.sh
. "$INSTALLER_DIR/lib/host-report.sh"

FAKE_DATA=
# Defines a stand-in for `docker run ... sh -c SCRIPT` that runs the script here, with the container's /data pointed at
# $FAKE_DATA. FAKE_DOCKER_FAIL makes the run fail the way a missing volume or a stopped Docker does. Defined only while a
# test here needs it, so the sandbox helpers keep the real command lookup.
fake_data_new() {
  FAKE_DATA=$(mktemp -d)
  docker() {
    local script="" prev="" arg
    for arg in "$@"; do
      if [ "$prev" = -c ]; then script=$arg; fi
      prev=$arg
    done
    if [ -n "${FAKE_DOCKER_FAIL:-}" ]; then
      cat >/dev/null
      return 1
    fi
    sh -c "${script//\/data\//$FAKE_DATA/}"
  }
}

fake_data_drop() {
  rm -rf "$FAKE_DATA"
  FAKE_DATA=
  FAKE_DOCKER_FAIL=
  unset -f docker
}

sample_report() { # text: a one-check report with the text as its message
  json_escape "$1"
  printf '{"schema_version":1,"command":"doctor","checked_at":"2026-10-21T08:57:59Z","overall":"warn",'
  printf '"checks":[{"id":"docker","name":"Docker","status":"warn","message":"%s","next_step":null}]}\n' "$JSON_ESCAPED"
}

# Whether the text is one JSON document: the host's Python parses it, which is the same check the other installer tests use.
is_json() {
  printf '%s' "$1" | python3 -c 'import json, sys; json.load(sys.stdin)' 2>/dev/null
}

# Lists the folder's entries, one per line, hidden ones included.
folder_entries() {
  find "$FAKE_DATA" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort
}

test_escapes_quotes_backslashes_and_newlines() {
  t_begin "a message with quotes, a backslash and a new line is escaped so that it reads back unchanged"
  local message='He said "hi" in C:\temp
and left'
  json_escape "$message"
  local back
  back=$(printf '{"message":"%s"}' "$JSON_ESCAPED" | python3 -c 'import json, sys; print(json.load(sys.stdin)["message"], end="")')
  assert_eq "$back" "$message" "the escaped message reads back as the same text"
}

test_save_writes_valid_json_and_no_temp_file() {
  t_begin "a saved report is valid JSON in the data folder, and no temporary file is left beside it"
  fake_data_new
  local rc=0
  host_report_save aman_main_data aman-app:test "$(sample_report 'Docker is "running" with C:\x')" || rc=$?
  assert_eq "$rc" 0 "the save succeeds"
  assert_eq "$(folder_entries)" "host-report.json" "only the report is in the folder"
  if is_json "$(cat "$FAKE_DATA/host-report.json")"; then t_pass; else t_fail "the saved report is not valid JSON"; fi
  assert_contains "$(cat "$FAKE_DATA/host-report.json")" '"message":"Docker is \"running\" with C:\\x"' "the message is escaped"
  fake_data_drop
}

test_a_second_save_replaces_the_first() {
  t_begin "a second save replaces the report in one step and leaves nothing behind"
  fake_data_new
  host_report_save aman_main_data aman-app:test "$(sample_report first)" || true
  host_report_save aman_main_data aman-app:test "$(sample_report second)" || true
  assert_contains "$(cat "$FAKE_DATA/host-report.json")" '"message":"second"' "the newer report is in place"
  assert_eq "$(folder_entries)" "host-report.json" "no temporary file remains"
  fake_data_drop
}

test_failed_save_warns_and_keeps_the_old_report() {
  t_begin "a save that fails prints one plain warning, returns 1, and leaves the last good report in place"
  fake_data_new
  host_report_save aman_main_data aman-app:test "$(sample_report kept)" || true
  local rc=0 err
  FAKE_DOCKER_FAIL=1
  err=$(host_report_save aman_main_data aman-app:test "$(sample_report lost)" 2>&1 >/dev/null) || rc=$?
  assert_eq "$rc" 1 "a failed save returns 1"
  assert_contains "$err" "Run aman doctor again to save it." "the warning says what to do"
  assert_eq "$(printf '%s\n' "$err" | wc -l | tr -d ' ')" 1 "the warning is one line"
  assert_contains "$(cat "$FAKE_DATA/host-report.json")" '"message":"kept"' "the old report is still there"
  assert_eq "$(folder_entries)" "host-report.json" "no temporary file is left after a failed save"
  fake_data_drop
}

test_doctor_saves_a_valid_report_for_each_instance() {
  t_begin "aman doctor saves a valid host report into the data folder of each instance that has one"
  sandbox_new
  install_machine
  run_doctor_direct --json
  local saved="$SB_STATE/host_report_aman_main_data"
  assert_file "$saved"
  if is_json "$(cat "$saved")"; then t_pass; else t_fail "the doctor's report is not valid JSON: $(cat "$saved")"; fi
  assert_contains "$(cat "$saved")" '"schema_version":1,"command":"doctor"' "the report names the doctor"
  assert_contains "$(cat "$saved")" '"checked_at":"' "the report has a time"
  assert_contains "$(cat "$saved")" '"id":"instance_' "instance checks carry the instance prefix"
  assert_not_contains "$(cat "$saved")" '"state"' "the report uses the report's own fields"
  sandbox_drop
}

test_doctor_report_names_the_installer_command() {
  t_begin "a report written for an installer run names that command; a plain doctor run names the doctor"
  sandbox_new
  install_machine
  run_doctor_direct AMAN_REPORT_COMMAND=install --json
  assert_contains "$(cat "$SB_STATE/host_report_aman_main_data")" '"command":"install"' "the installer's command is named"
  run_doctor_direct --json
  assert_contains "$(cat "$SB_STATE/host_report_aman_main_data")" '"command":"doctor"' "a plain run is named doctor"
  sandbox_drop
}

test_partial_and_local_runs_save_nothing() {
  t_begin "a run limited with --only or kept to this machine with --local does not replace the last full report"
  sandbox_new
  install_machine
  run_doctor_direct --local
  run_doctor_direct --only docker --json
  assert_no_path "$SB_STATE/host_reports"
  run_doctor_direct --json
  assert_file "$SB_STATE/host_report_aman_main_data"
  sandbox_drop
}

test_failed_save_only_warns_in_the_doctor() {
  t_begin "when the doctor cannot save its report it warns once and exits with the same code as before"
  sandbox_new
  install_machine
  run_doctor_direct --json
  local normal_rc=$DOC_RC
  STUB_FAIL_ON=host-report run_doctor_direct --json
  assert_eq "$DOC_RC" "$normal_rc" "the exit status is unchanged"
  assert_contains "$DOC_ERR" "Aman could not save the latest check result for the app." "the warning is printed"
  sandbox_drop
}

test_installer_commands_ask_for_their_own_report() {
  t_begin "install, upgrade and refresh each save the report under their own name, and a check-only upgrade saves none"
  sandbox_new
  install_machine
  assert_log_has "report install"
  run_install upgrade
  assert_rc 0
  assert_log_has "report upgrade"
  run_install instance refresh main
  assert_rc 0
  assert_log_has "report refresh"
  local before
  before=$(log_count "report upgrade")
  run_install upgrade --check
  assert_rc 0
  assert_eq "$(log_count "report upgrade")" "$before" "a check-only upgrade saves no report"
  sandbox_drop
}

# run_doctor_direct ARGS...: runs the real doctor script against the sandbox's stub docker; NAME=VALUE arguments before
# the doctor's own arguments are set in its environment. Output lands in DOC_OUT and DOC_ERR, the exit code in DOC_RC.
run_doctor_direct() {
  local env_extra=() arg
  while [ "$#" -gt 0 ]; do
    case "$1" in
      AMAN_REPORT_COMMAND=*) env_extra+=("$1") ;;
      *) break ;;
    esac
    shift
  done
  build_run_env
  set +e
  env -i "${RUN_ENV[@]}" AMANUENSIS_HOME="$AMAN_HOME" ${env_extra[@]+"${env_extra[@]}"} \
    bash "$INSTALLER_DIR/doctor/aman" doctor "$@" >"$SB/doctor_out" 2>"$SB/doctor_err"
  DOC_RC=$?
  set -e
  DOC_OUT=$(cat "$SB/doctor_out")
  DOC_ERR=$(cat "$SB/doctor_err")
}

test_escapes_quotes_backslashes_and_newlines
test_save_writes_valid_json_and_no_temp_file
test_a_second_save_replaces_the_first
test_failed_save_warns_and_keeps_the_old_report
test_doctor_saves_a_valid_report_for_each_instance
test_doctor_report_names_the_installer_command
test_partial_and_local_runs_save_nothing
test_failed_save_only_warns_in_the_doctor
test_installer_commands_ask_for_their_own_report
tests_finish
