#!/usr/bin/env bash
# What a person sees: prompts that state their rule and ask again, plan words, color only where it belongs, one
# progress line per long step with the tool's output in a log, and a plain cause when an instance does not start.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

ESC=$'\033'
PASSWORD_ANSWERS="Password for owner@example.invalid=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"

test_the_docs_send_both_names_to_the_app_port() {
  t_begin "the Mac and Windows guide forwards sign-in to the app port, never to the sign-in server, and uses no address range"
  local docs
  docs=$(cat "$(dirname "${BASH_SOURCE[0]}")/../../../docs/install.mdx")
  assert_not_contains "$docs" "127.0.0.1:5556" "sign-in is not sent to the login server itself"
  assert_contains "$docs" "forward both the app name and the sign-in name to"
  assert_not_contains "$docs" "100.64" "no address range in the guide"
}

test_prompts_state_their_rule() {
  t_begin "each question shows the rule for its answer, with an example, and Enter keeps the default"
  sandbox_new
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>y
$PASSWORD_ANSWERS"
  assert_eq "$RC" 0
  assert_contains "$OUT" "Instance name (a-z, 0-9, hyphen; starts with a letter) [main]: "
  assert_contains "$OUT" "Each person gets a new instance. Example: main"
  assert_contains "$OUT" "Your email, used to sign in"
  assert_contains "$OUT" "Example: you@example.com"
  assert_contains "$OUT" "Go ahead? [Y/n]: "
  assert_contains "$OUT" "Password for owner@example.invalid, 8 to 72 characters (not shown): "
  assert_contains "$OUT" "Repeat the password (not shown): "
  sandbox_drop
}

test_an_invalid_name_asks_again_with_the_reason() {
  t_begin "an invalid instance name prints one plain line and asks again; a valid one then continues"
  sandbox_new
  run_install_tty "Instance name=>My_Name
Instance name=>main
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>y
$PASSWORD_ANSWERS"
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "\"My_Name\" has an underscore; use lowercase letters, digits or hyphens."
  assert_not_contains "$OUT" "Run \"install.sh --help\""
  assert_file "$AMAN_HOME/state/instances/main.conf"
  assert_eq "$(printf '%s' "$OUT" | grep -c 'Instance name (a-z')" 2 "the question is asked twice"
  sandbox_drop
}

test_each_kind_of_bad_name_gets_its_own_reason() {
  t_begin "capital letters, a leading digit, a trailing hyphen, a reserved word and a long name each say what is wrong"
  sandbox_new
  run_install_tty "Instance name=>Main
Instance name=>1main
Instance name=>main-
Instance name=>machine
Instance name=>main
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>n"
  assert_flat_contains "$OUT" "\"Main\" has capital letters"
  assert_flat_contains "$OUT" "\"1main\" must start with a letter."
  assert_flat_contains "$OUT" "\"main-\" must not end with a hyphen."
  assert_flat_contains "$OUT" "\"machine\" is reserved; pick another name."
  assert_eq "$RC" 0
  run_install_tty "Instance name=>abcdefghijklmnopqrstuvwxyz
Instance name=>main
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>n"
  assert_flat_contains "$OUT" "\"abcdefghijklmnopqrstuvwxyz\" is longer than 24 characters."
  assert_eq "$RC" 0
  sandbox_drop
}

test_an_invalid_email_asks_again() {
  t_begin "an invalid email asks again with an example"
  sandbox_new
  run_install_tty "Instance name=>
Your email=>not-an-email
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>y
$PASSWORD_ANSWERS"
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "\"not-an-email\" is not an email address; write it like you@example.com."
  assert_eq "$(env_email)" owner@example.invalid
  sandbox_drop
}

env_email() { sed -n 's/^OIDC_ALLOWED_EMAILS=//p' "$AMAN_HOME/instances/main/.env" | head -n 1; }

test_five_wrong_answers_stop_with_a_clear_message() {
  t_begin "after five invalid answers the run stops, says so, and changes nothing"
  sandbox_new
  run_install_tty "Instance name=>a_b
Instance name=>c_d
Instance name=>e_f
Instance name=>g_h
Instance name=>i_j"
  assert_eq "$RC" 1
  assert_flat_contains "$OUT" "No valid answer after 5 tries, so nothing was changed."
  assert_no_path "$AMAN_HOME/state/instances"
  assert_no_path "$AMAN_HOME/state/lock"
  sandbox_drop
}

test_the_end_of_the_input_stops_instead_of_looping() {
  t_begin "the end of the input at a question stops the run at once"
  sandbox_new
  run_install_tty "Instance name=>
Your email=><EOF>"
  assert_eq "$RC" 1
  assert_flat_contains "$OUT" "The input ended before a valid answer"
  sandbox_drop
}

test_flags_and_yes_fail_fast_without_a_prompt() {
  t_begin "a bad value given as a flag, or no email under --yes, stops with the reason and asks nothing"
  sandbox_new
  run_install --yes --name My_Name --email owner@example.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "\"My_Name\" has an underscore; use lowercase letters, digits or hyphens."
  assert_not_contains "$OUT$ERR" "Instance name ("
  run_install --yes --name main --email nope
  assert_rc 2
  assert_flat_contains "$ERR" "\"nope\" is not an email address"
  run_install --yes
  assert_rc 2
  assert_flat_contains "$ERR" "An email address is needed"
  run_install instance add Bad_Name
  assert_rc 2
  assert_flat_contains "$ERR" "has an underscore"
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_a_short_password_asks_again_and_states_the_rule_each_time() {
  t_begin "a short password is refused with the reason and the question, with its rule, is asked again"
  sandbox_new
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>y
Password for owner@example.invalid=>short
Repeat the password=>short
Password for owner@example.invalid=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "The password needs at least 8 characters."
  assert_eq "$(printf '%s' "$OUT" | grep -c 'Password for owner@example.invalid, 8 to 72 characters')" 2 "the rule is in both questions"
  assert_not_contains "$OUT" "short"
  assert_not_contains "$OUT" "$SENTINEL_PASSWORD"
  sandbox_drop
}

test_five_bad_passwords_stop() {
  t_begin "five bad passwords stop the run with a clear message"
  sandbox_new
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>y
Password for owner@example.invalid=>a1
Repeat the password=>a1
Password for owner@example.invalid=>a2
Repeat the password=>a2
Password for owner@example.invalid=>a3
Repeat the password=>a3
Password for owner@example.invalid=>a4
Repeat the password=>a4
Password for owner@example.invalid=>a5
Repeat the password=>a5"
  assert_eq "$RC" 1
  assert_flat_contains "$OUT" "No valid password after 5 tries, so nothing was changed."
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_a_blocker_asks_nothing() {
  t_begin "a failed check stops the run before the first question, with the way out under it"
  sandbox_new
  STUB_COMPOSE_VERSION=1.29.2
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
"
  assert_eq "$RC" 1
  assert_contains "$OUT" "x Docker Compose 1.29.2 is too old"
  assert_flat_contains "$OUT" "Next: Run install.sh docker to update it, then run this again."
  assert_flat_contains "$OUT" "Stopped before changing anything."
  assert_not_contains "$OUT" "Instance name"
  assert_not_contains "$OUT" "Go ahead?"
  assert_not_contains "$OUT" "Password"
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_plan_words_and_nothing_printed_twice() {
  t_begin "the plan says done, to do and needs admin; once the run starts each step prints one finished line and the plan is not repeated"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_not_contains "$OUT$ERR" "will do"
  assert_not_contains "$OUT$ERR" "[done]"
  assert_not_contains "$OUT$ERR" "[root]"
  assert_flat_contains "$OUT" "> to do Create the folder"
  local after
  after=${OUT#*Building images (4 of 6)}
  assert_not_contains "$after" "to do" "the plan is not printed again"
  assert_flat_contains "$after" "+ Built the Aman app"
  assert_flat_contains "$after" "+ Built the speech-to-text service"
  assert_flat_contains "$after" "+ Downloaded the sign-in service"
  assert_flat_contains "$after" "+ Instance main is running and healthy"
  sandbox_drop
}

test_status_words_in_ascii_by_default() {
  t_begin "without a UTF-8 locale the plan uses + done, > to do and ! needs admin"
  sandbox_new
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_contains "$OUT" "> to do        Create the folder"
  assert_contains "$OUT" "! needs admin  Set up the sandbox on this computer"
  assert_not_contains "$OUT" "$ESC"
  sandbox_drop
}

test_utf8_symbols_without_color_when_not_a_terminal() {
  t_begin "a UTF-8 locale gives the symbols; a pipe and NO_COLOR give no escape codes and no carriage returns"
  sandbox_new
  RUN_ENV_EXTRA=(LANG=C.UTF-8 TERM=xterm)
  run_install --dry-run --email owner@example.invalid
  assert_contains "$OUT" "✓ Linux on"
  assert_contains "$OUT" "› to do        Create the folder"
  assert_contains "$OUT" "! needs admin  Set up the sandbox on this computer"
  assert_not_contains "$OUT$ERR" "$ESC"
  assert_not_contains "$OUT$ERR" $'\r'
  RUN_ENV_EXTRA=(LANG=C.UTF-8 TERM=xterm CLICOLOR_FORCE=1 NO_COLOR=1)
  run_install --dry-run --email owner@example.invalid
  assert_contains "$OUT" "✓ Linux on"
  assert_not_contains "$OUT$ERR" "$ESC"
  sandbox_drop
}

test_color_is_on_markers_and_status_words_only() {
  t_begin "with color forced, markers and status words are colored and the sentences keep the terminal's color"
  sandbox_new
  RUN_ENV_EXTRA=(LANG=C.UTF-8 TERM=xterm CLICOLOR_FORCE=1)
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_contains "$OUT" "${ESC}[32m✓${ESC}[0m Linux on"
  assert_contains "$OUT" "${ESC}[36m›${ESC}[0m ${ESC}[36mto do${ESC}[0m        Create the folder"
  assert_contains "$OUT" "${ESC}[33m!${ESC}[0m ${ESC}[33mneeds admin${ESC}[0m  Set up the sandbox on this computer"
  assert_contains "$OUT" "${ESC}[1mThe plan${ESC}[0m ${ESC}[2m(3 of 6)${ESC}[0m"
  assert_contains "$OUT" "${ESC}[1;32mDry run: nothing was changed.${ESC}[0m"
  assert_not_contains "$OUT" "${ESC}[36mCreate the folder"
  sandbox_drop
}

test_lines_stay_readable_in_72_columns() {
  t_begin "no line is wider than 72 columns unless it holds a path or an address, which are never split"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  local line
  while IFS= read -r line; do
    if [ "${#line}" -le 72 ]; then t_pass; else
      case "$line" in */*) t_pass ;; *) t_fail "wide line (${#line}): $line" ;; esac
    fi
  done < <(printf '%s\n%s\n' "$OUT" "$ERR")
  sandbox_drop
}

test_docker_output_stays_in_a_log() {
  t_begin "builds print one progress line each and keep the docker output in a private log file"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_not_contains "$OUT$ERR" "building with"
  assert_not_contains "$OUT$ERR" "Pulling from"
  assert_flat_contains "$ERR" "Building the Aman app (the long step) log: $AMAN_HOME/state/logs/build-app.log"
  assert_contains "$(cat "$AMAN_HOME/state/logs/build-app.log")" "building with"
  assert_mode "$AMAN_HOME/state/logs/build-app.log" 600
  assert_mode "$AMAN_HOME/state/logs" 700
  assert_contains "$(cat "$AMAN_HOME/state/logs/pull-login.log")" "Pulling from"
  sandbox_drop
}

test_a_failed_build_shows_the_log_tail_and_its_path() {
  t_begin "a failed build prints the last log lines and the log path, not the whole output"
  sandbox_new
  STUB_BUILD_FAIL=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "Building the Aman app failed"
  assert_flat_contains "$ERR" "Last lines of the log:"
  assert_contains "$ERR" "build failed"
  assert_flat_contains "$ERR" "Full log: $AMAN_HOME/state/logs/build-app.log"
  sandbox_drop
}

test_an_unhealthy_instance_gets_a_plain_cause_and_a_saved_log() {
  t_begin "an instance that does not start is explained in one sentence and never by a docker command to run"
  sandbox_new
  STUB_UP_FAIL_LOG="Error: EACCES: permission denied, mkdir '/home/trueforge'"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "Instance main did not start. The app could not start: it was not allowed to create a folder (/home/trueforge). This is a bug in Aman, not a problem on your computer."
  assert_flat_contains "$ERR" "Next: Update Aman and run install.sh again. If it fails the same way, share the saved log below."
  assert_not_contains "$OUT$ERR" "Fix that"
  assert_flat_contains "$ERR" "Last 200 log lines: $AMAN_HOME/state/logs/instance-main.log"
  assert_not_contains "$OUT$ERR" "docker compose"
  assert_not_contains "$OUT$ERR" "logs --tail"
  assert_contains "$(cat "$AMAN_HOME/state/logs/instance-main.log")" "EACCES"
  assert_mode "$AMAN_HOME/state/logs/instance-main.log" 600
  sandbox_drop
}

test_any_permission_error_is_a_bug_not_a_user_fix() {
  t_begin "a permission error at startup, whatever the path, is called a bug in Aman with the saved log, never a fix to make"
  sandbox_new
  STUB_UP_FAIL_LOG="Error: EACCES: permission denied, open '/app/state/x.db'"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "a permission error stopped it. This is a bug in Aman, not a problem on your computer."
  assert_flat_contains "$ERR" "Last 200 log lines: $AMAN_HOME/state/logs/instance-main.log"
  assert_not_contains "$OUT$ERR" "chmod"
  assert_not_contains "$ERR" "sudo"
  sandbox_drop
}

test_an_unknown_failure_is_called_a_bug_with_the_log() {
  t_begin "a failure the installer cannot name is called a bug in Aman and the saved log is named"
  sandbox_new
  STUB_UP_FAIL_LOG="something nobody has seen"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "This looks like a bug in Aman."
  assert_flat_contains "$ERR" "Last 200 log lines: $AMAN_HOME/state/logs/instance-main.log"
  sandbox_drop
}

test_the_closing_block_and_warnings() {
  t_begin "a finished run ends in a framed block: one verdict, the rows, one Next line about the model, and the total time"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_flat_contains "$OUT" "Ready. Instance main is running."
  assert_flat_contains "$OUT" "Model not set: add one in Settings > Models"
  assert_contains "$OUT" "------------------------------------------------------------------------"
  assert_eq "$(printf '%s\n' "$OUT" | grep -c '^-\{72\}$')" 2 "a rule above and below"
  sandbox_drop
}

test_the_docs_send_both_names_to_the_app_port
test_prompts_state_their_rule
test_an_invalid_name_asks_again_with_the_reason
test_each_kind_of_bad_name_gets_its_own_reason
test_an_invalid_email_asks_again
test_five_wrong_answers_stop_with_a_clear_message
test_the_end_of_the_input_stops_instead_of_looping
test_flags_and_yes_fail_fast_without_a_prompt
test_a_short_password_asks_again_and_states_the_rule_each_time
test_five_bad_passwords_stop
test_a_blocker_asks_nothing
test_plan_words_and_nothing_printed_twice
test_status_words_in_ascii_by_default
test_utf8_symbols_without_color_when_not_a_terminal
test_color_is_on_markers_and_status_words_only
test_lines_stay_readable_in_72_columns
test_docker_output_stays_in_a_log
test_a_failed_build_shows_the_log_tail_and_its_path
test_an_unhealthy_instance_gets_a_plain_cause_and_a_saved_log
test_any_permission_error_is_a_bug_not_a_user_fix
test_an_unknown_failure_is_called_a_bug_with_the_log
test_the_closing_block_and_warnings
tests_finish
