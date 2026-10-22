#!/usr/bin/env bash
# The optional calendar: presets, refusals, the files it writes, and instance calendar with --remove.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

CAL_SECRET="calendar-sentinel-52b1"

in_lib() {
  PATH=$SB_BIN "$SB_BIN/bash" -c ". '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/shared.sh'; . '$INSTALLER_DIR/lib/calendar.sh'; $1"
}

env_lines() { grep -c '^CALENDAR_CONNECTOR_URL=' "$AMAN_HOME/instances/main/.env" || true; }

test_presets() {
  t_begin "each preset maps to its provider's address; other providers have none built in"
  sandbox_new
  assert_eq "$(in_lib 'calendar_preset_url fastmail owner@fastmail.com')" "https://caldav.fastmail.com/dav/" "fastmail"
  assert_eq "$(in_lib 'calendar_preset_url yahoo owner@yahoo.com')" "https://caldav.calendar.yahoo.com" "yahoo"
  assert_eq "$(in_lib 'calendar_preset_url gmx owner@gmx.com')" "https://caldav.gmx.com/" "gmx.com"
  assert_eq "$(in_lib 'calendar_preset_url gmx owner@gmx.net')" "https://caldav.gmx.net/" "gmx.net"
  assert_eq "$(in_lib 'calendar_preset_url gmx owner@gmx.de')" "" "gmx.de has no preset"
  assert_eq "$(in_lib 'calendar_preset_url webde owner@web.de')" "https://caldav.web.de" "web.de"
  assert_eq "$(in_lib 'calendar_preset_url other owner@icloud.com')" "" "other has no preset"
  sandbox_drop
}

test_gmail_is_skipped() {
  t_begin "Gmail and Googlemail addresses are skipped; other domains are not"
  sandbox_new
  if in_lib 'calendar_is_gmail person@gmail.com'; then t_pass; else t_fail "gmail.com not matched"; fi
  if in_lib 'calendar_is_gmail person@GoogleMail.com'; then t_pass; else t_fail "googlemail.com not matched"; fi
  if in_lib 'calendar_is_gmail person@fastmail.com'; then t_fail "fastmail matched as gmail"; else t_pass; fi
  sandbox_drop
}

test_url_refusals() {
  t_begin "an address must be https, hold no name or password, and not be empty"
  sandbox_new
  assert_contains "$(in_lib 'calendar_url_problem http://caldav.example.invalid/dav/')" "must start with https://"
  assert_contains "$(in_lib 'calendar_url_problem ""')" "A calendar address is needed"
  assert_contains "$(in_lib 'calendar_url_problem https://me:secret@caldav.example.invalid/')" "must not hold a name or password"
  assert_eq "$(in_lib 'calendar_url_problem https://caldav.fastmail.com/dav/')" "" "a good address"
  sandbox_drop
}

test_secret_rules() {
  t_begin "the app password is required and limited to characters a file can hold"
  sandbox_new
  assert_contains "$(in_lib 'calendar_secret_problem ""')" "app password is needed"
  assert_contains "$(in_lib 'calendar_secret_problem "has space"')" "cannot be saved"
  assert_eq "$(in_lib "calendar_secret_problem '$CAL_SECRET'")" "" "a plain app password"
  sandbox_drop
}

# Installs a machine with the main instance, with the calendar left out.
install_for_calendar() {
  install_machine
}

test_install_with_calendar_flags() {
  t_begin "install with calendar flags writes the four keys, one connector line and no other key"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
$CAL_SECRET
"
  run_install --yes --password-stdin --email owner@example.invalid --calendar-provider fastmail \
    --calendar-email owner@example.invalid --calendar-password-stdin
  clear_input
  assert_rc 0
  local file=$AMAN_HOME/instances/main/.env.calendar
  assert_file "$file"
  assert_mode "$file" 600
  assert_eq "$(sed 's/=.*//' "$file" | tr '\n' ' ')" "CALDAV_URL CALDAV_USERNAME CALDAV_PASSWORD CALDAV_USER_EMAIL " "exactly four keys"
  assert_contains "$(cat "$file")" "CALDAV_URL=https://caldav.fastmail.com/dav/"
  assert_contains "$(cat "$file")" "CALDAV_USERNAME=owner@example.invalid"
  assert_eq "$(env_lines)" 1 "one connector line in the main settings"
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "CALENDAR_CONNECTOR_URL=http://calendar-caldav:9558/mcp"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "CALDAV_"
  assert_not_contains "$OUT$ERR" "$CAL_SECRET"
  assert_log_lacks "$CAL_SECRET"
  sandbox_drop
}

test_connect_prompt_yes_asks_the_calendar_questions() {
  t_begin "Yes at Connect a calendar? asks for the provider, address, login and app password, then connects it"
  sandbox_new
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>y
Your provider (type a number)=>1
Email address of the calendar account=>owner@example.invalid
Login name=>
App password for the calendar=>$CAL_SECRET
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD" --local-only
  assert_rc 0
  assert_flat_contains "$OUT" "Calendar: Fastmail at https://caldav.fastmail.com/dav/, signed in as owner@example.invalid."
  assert_eq "$(env_lines)" 1 "one connector line in the main settings"
  assert_not_contains "$OUT$ERR" "$CAL_SECRET"
  assert_log_lacks "$CAL_SECRET"
  sandbox_drop
}

test_second_run_does_not_duplicate() {
  t_begin "running the calendar command twice keeps one connector line"
  sandbox_new
  install_for_calendar
  with_input "1
owner@example.invalid

$CAL_SECRET
"
  run_install instance calendar main
  clear_input
  assert_rc 0
  with_input "1
owner@example.invalid

$CAL_SECRET
"
  run_install instance calendar main
  clear_input
  assert_rc 0
  assert_eq "$(env_lines)" 1 "one connector line after two runs"
  assert_not_contains "$OUT$ERR" "$CAL_SECRET"
  sandbox_drop
}

test_piped_input_and_remove() {
  t_begin "piped answers connect the calendar; --remove deletes the file and the connector line"
  sandbox_new
  install_for_calendar
  with_input "1
owner@example.invalid

$CAL_SECRET
"
  run_install instance calendar main
  clear_input
  assert_rc 0
  assert_file "$AMAN_HOME/instances/main/.env.calendar"
  assert_eq "$(env_lines)" 1 "connector line added"
  run_install instance calendar main --remove
  assert_rc 0
  assert_no_path "$AMAN_HOME/instances/main/.env.calendar"
  assert_eq "$(env_lines)" 0 "connector line gone"
  assert_flat_contains "$OUT$ERR" "The Calendar connector is removed. Any saved app password has been deleted from this computer."
  assert_not_contains "$OUT$ERR" "$CAL_SECRET"
  sandbox_drop
}

test_yes_names_missing_value() {
  t_begin "--yes without the required calendar values fails and names the missing value"
  sandbox_new
  install_for_calendar
  run_install instance calendar main --yes --calendar-provider fastmail
  assert_rc 2
  assert_contains "$ERR" "--calendar-email"
  run_install instance calendar main --yes --calendar-provider fastmail --calendar-email owner@example.invalid
  assert_rc 2
  assert_contains "$ERR" "--calendar-password-stdin"
  assert_no_path "$AMAN_HOME/instances/main/.env.calendar"
  sandbox_drop
}

test_refusals_at_install() {
  t_begin "an http address for the other provider is refused with the one thing to do"
  sandbox_new
  install_for_calendar
  with_input "$CAL_SECRET
"
  run_install instance calendar main --yes --calendar-provider other --calendar-url http://caldav.example.invalid/ \
    --calendar-email owner@example.invalid --calendar-password-stdin
  clear_input
  assert_rc 2
  assert_contains "$ERR" "must start with https://"
  assert_no_path "$AMAN_HOME/instances/main/.env.calendar"
  sandbox_drop
}

test_gmail_skip_writes_nothing() {
  t_begin "a Gmail address is skipped with the Google message and writes nothing"
  sandbox_new
  install_for_calendar
  run_install instance calendar main --yes --calendar-provider fastmail --calendar-email person@gmail.com
  assert_rc 0
  assert_contains "$OUT$ERR" "Google Calendar is already connected through the Google connector"
  assert_no_path "$AMAN_HOME/instances/main/.env.calendar"
  sandbox_drop
}

test_presets
test_gmail_is_skipped
test_url_refusals
test_secret_rules
test_install_with_calendar_flags
test_connect_prompt_yes_asks_the_calendar_questions
test_second_run_does_not_duplicate
test_piped_input_and_remove
test_yes_names_missing_value
test_refusals_at_install
test_gmail_skip_writes_nothing
tests_finish
