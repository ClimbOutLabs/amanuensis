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

# The account as the connector's account agent saved it, in the named volume the stub models for the instance's
# compose project. Tests read the volume, never a host file: the installer writes no host file.
CAL_VOLUME() { printf '%s' "$STUB_STATE/calendar-account-aman-main"; }
cal_value() { sed -n "s/^$1=//p" "$(CAL_VOLUME)" 2>/dev/null | head -n 1; }

# The app password may appear only in the connector's volume for the instance: not in any other file, the log or the output.
assert_secret_only_in_volume() {
  local found
  found=$(grep -rIl -- "$CAL_SECRET" "$AMAN_HOME" "$SB/stub.log" "$SB/out" "$SB/err" "$(CAL_VOLUME)" 2>/dev/null | sort | tr '\n' ' ' || true)
  assert_eq "$found" "$(CAL_VOLUME) " "files holding the app password"
  assert_not_contains "$OUT" "$CAL_SECRET" "stdout"
  assert_not_contains "$ERR" "$CAL_SECRET" "stderr"
}

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
  assert_eq "$(in_lib 'calendar_preset_url gmx OWNER@GMX.NET')" "https://caldav.gmx.net/" "the domain is matched in lower case"
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
  assert_contains "$(in_lib 'calendar_url_problem https://localhost/dav/')" "needs a full server name with dots"
  assert_contains "$(in_lib 'calendar_url_problem https://calendar-caldav:9558/')" "needs a full server name with dots"
  assert_eq "$(in_lib 'calendar_url_problem https://nas.example.invalid:8443/dav/')" "" "a home server with a port"
  sandbox_drop
}

test_secret_rules() {
  t_begin "the app password is required; which characters it may hold is left to the connector's agent"
  sandbox_new
  assert_contains "$(in_lib 'calendar_secret_problem ""')" "app password is needed"
  assert_eq "$(in_lib 'calendar_secret_problem "has space"')" "" "spaces and punctuation are allowed"
  assert_eq "$(in_lib "calendar_secret_problem 'it\"s a #1 pass'")" "" "quotes and a hash are allowed"
  assert_eq "$(in_lib "calendar_secret_problem '$CAL_SECRET'")" "" "a plain app password"
  sandbox_drop
}

# Installs a machine with the main instance, with the calendar left out.
install_for_calendar() {
  install_machine
}

test_install_with_calendar_flags() {
  t_begin "install with calendar flags saves the four settings in the connector's volume and writes no host file"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
$CAL_SECRET
"
  run_install --yes --password-stdin --email owner@example.invalid --calendar-provider fastmail \
    --calendar-email owner@example.invalid --calendar-password-stdin
  clear_input
  assert_rc 0
  assert_file "$(CAL_VOLUME)"
  assert_eq "$(sed 's/=.*//' "$(CAL_VOLUME)" | tr '\n' ' ')" "CALDAV_URL CALDAV_USERNAME CALDAV_PASSWORD CALDAV_USER_EMAIL " "exactly four keys"
  assert_eq "$(cal_value CALDAV_URL)" "https://caldav.fastmail.com/dav/"
  assert_eq "$(cal_value CALDAV_USERNAME)" "owner@example.invalid"
  assert_eq "$(cal_value CALDAV_PASSWORD)" "$CAL_SECRET"
  assert_no_path "$AMAN_HOME/instances/main/.env.calendar"
  assert_eq "$(env_lines)" 0 "no connector line in the main settings: the app learns of the calendar from the connector itself"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "CALDAV_"
  assert_flat_contains "$OUT" "Signed in to https://caldav.fastmail.com/dav/ as owner@example.invalid."
  assert_secret_only_in_volume
  sandbox_drop
}

test_connector_starts_with_the_instance() {
  t_begin "the calendar connector has no profile, keeps its login in its own volume and the app knows where its agent is"
  sandbox_new
  install_for_calendar
  local compose=$AMAN_HOME/instances/main/compose.yaml
  assert_not_contains "$(cat "$compose")" "profiles: ['calendar']" "no profile keeps it from starting"
  assert_not_contains "$(cat "$compose")" "./.env.calendar" "no host file is read"
  assert_contains "$(cat "$compose")" "calendar-account:/account"
  assert_contains "$(cat "$compose")" "CALENDAR_ACCOUNT_URL: http://calendar-caldav:9560"
  assert_contains "$(cat "$compose")" "name: aman_main_calendar_account"
  sandbox_drop
}

test_agent_secret_and_network() {
  t_begin "the app and the connector share one secret through the settings file, and the connector has a network of its own"
  sandbox_new
  install_for_calendar
  local env=$AMAN_HOME/instances/main/.env compose=$AMAN_HOME/instances/main/compose.yaml first
  first=$(sed -n 's/^CALENDAR_ACCOUNT_SECRET=//p' "$env")
  assert_eq "${#first}" 64 "a random secret of 64 characters is made"
  assert_not_contains "$(cat "$compose")" "$first" "the compose file never holds the secret"
  assert_contains "$(cat "$compose")" "CALENDAR_ACCOUNT_SECRET: \${CALENDAR_ACCOUNT_SECRET:?missing from .env}"
  assert_eq "$(awk '/^  calendar-caldav:/{f=1;next} /^  [a-z]/{f=0} f && /^    networks:/{n=1;next} f && n && /^      - /{print $2} f && n && !/^      - /{n=0}' "$compose" | tr '\n' ' ')" "calendar " "the connector joins only its own network"
  assert_eq "$(awk '/^  mail-email:/{f=1;next} /^  [a-z]/{f=0} f && /calendar/{print}' "$compose")" "" "the mail connector is not on the calendar network"
  assert_contains "$(awk '/^  loopback:/{f=1;next} /^  [a-z]/{f=0} f' "$compose")" "- calendar" "the app's network holder joins it"
  run_install instance calendar main --remove
  assert_rc 0
  assert_eq "$(sed -n 's/^CALENDAR_ACCOUNT_SECRET=//p' "$env")" "$first" "a later run never changes the secret"
  sandbox_drop
}

test_an_older_instance_gets_a_secret() {
  t_begin "an instance whose settings file has no calendar secret gets one on the next calendar command"
  sandbox_new
  install_for_calendar
  local env=$AMAN_HOME/instances/main/.env
  grep -v '^CALENDAR_ACCOUNT_SECRET=' "$env" >"$env.new" && mv "$env.new" "$env"
  chmod 600 "$env"
  run_install instance calendar main --remove
  assert_rc 0
  assert_eq "$(sed -n 's/^CALENDAR_ACCOUNT_SECRET=//p' "$env" | wc -c | tr -d ' ')" 65 "64 characters and a newline"
  assert_mode "$env" 600
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
  assert_eq "$(cal_value CALDAV_PASSWORD)" "$CAL_SECRET"
  assert_secret_only_in_volume
  sandbox_drop
}

test_second_run_replaces_the_account() {
  t_begin "running the calendar command twice keeps one account, the later one"
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
second@example.invalid

$CAL_SECRET
"
  run_install instance calendar main
  clear_input
  assert_rc 0
  assert_eq "$(grep -c '^CALDAV_USERNAME=' "$(CAL_VOLUME)")" 1 "one account in the volume"
  assert_eq "$(cal_value CALDAV_USERNAME)" "second@example.invalid"
  assert_secret_only_in_volume
  sandbox_drop
}

test_app_restarts_to_learn_of_the_calendar() {
  t_begin "saving the account starts the connector and restarts the app, so the app registers the calendar"
  sandbox_new
  install_for_calendar
  : >"$STUB_LOG"
  with_input "1
owner@example.invalid

$CAL_SECRET
"
  run_install instance calendar main
  clear_input
  assert_rc 0
  assert_log_has "up -d --no-deps calendar-caldav"
  assert_log_has "run --rm --no-deps --entrypoint node calendar-caldav /app/agent.mjs --write-stdin"
  assert_log_has "up -d --force-recreate --no-deps --wait --wait-timeout 240 app"
  assert_log_lacks "$CAL_SECRET"
  sandbox_drop
}

test_piped_input_and_remove() {
  t_begin "piped answers connect the calendar; --remove empties the volume and says so"
  sandbox_new
  install_for_calendar
  with_input "1
owner@example.invalid

$CAL_SECRET
"
  run_install instance calendar main
  clear_input
  assert_rc 0
  assert_eq "$(cal_value CALDAV_PASSWORD)" "$CAL_SECRET"
  : >"$STUB_LOG"
  run_install instance calendar main --remove
  assert_rc 0
  assert_not_contains "$(cat "$(CAL_VOLUME)")" "CALDAV_" "the saved account is gone from the volume"
  assert_log_has "calendar-caldav /app/agent.mjs --remove"
  assert_log_has "up -d --force-recreate --no-deps --wait --wait-timeout 240 app"
  assert_flat_contains "$OUT$ERR" "The Calendar connector is removed. Any saved app password has been deleted from this computer."
  assert_not_contains "$OUT$ERR" "$CAL_SECRET"
  sandbox_drop
}

test_remove_clears_an_old_way_file_and_line() {
  t_begin "--remove also deletes the file and the settings line an older installer left"
  sandbox_new
  install_for_calendar
  printf 'CALDAV_PASSWORD=old\n' >"$AMAN_HOME/instances/main/.env.calendar"
  printf 'CALENDAR_CONNECTOR_URL=http://calendar-caldav:9558/mcp\n' >>"$AMAN_HOME/instances/main/.env"
  run_install instance calendar main --remove
  assert_rc 0
  assert_no_path "$AMAN_HOME/instances/main/.env.calendar"
  assert_eq "$(env_lines)" 0 "the old connector line is gone"
  sandbox_drop
}

test_a_refused_address_saves_nothing() {
  t_begin "an address the connector may not sign in to is refused with the one thing to do"
  sandbox_new
  install_for_calendar
  with_input "$CAL_SECRET
"
  STUB_CALENDAR_REFUSES=1 run_install instance calendar main --yes --calendar-provider other \
    --calendar-url https://169.254.169.254/dav/ --calendar-email owner@example.invalid --calendar-password-stdin
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "That calendar address cannot be used here. Use the address your provider gives you"
  assert_not_contains "$OUT$ERR" "$CAL_SECRET"
  assert_log_lacks "$CAL_SECRET"
  sandbox_drop
}

test_a_failed_sign_in_check_keeps_the_account() {
  t_begin "a refused login is reported in plain words and the saved account stays, so the fix is the password"
  sandbox_new
  install_for_calendar
  with_input "$CAL_SECRET
"
  STUB_CALENDAR_CHECK=login run_install instance calendar main --yes --calendar-provider fastmail \
    --calendar-email owner@example.invalid --calendar-password-stdin
  clear_input
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "did not accept this login and app password"
  assert_flat_contains "$OUT$ERR" "install.sh instance calendar main"
  assert_eq "$(cal_value CALDAV_PASSWORD)" "$CAL_SECRET"
  assert_not_contains "$OUT$ERR" "$CAL_SECRET"
  STUB_CALENDAR_CHECK=server run_install instance calendar main --yes --calendar-provider fastmail \
    --calendar-email owner@example.invalid --calendar-password-stdin
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
  assert_no_path "$(CAL_VOLUME)"
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
  assert_no_path "$(CAL_VOLUME)"
  sandbox_drop
}

test_gmail_skip_writes_nothing() {
  t_begin "a Gmail address is skipped with the Google message and writes nothing"
  sandbox_new
  install_for_calendar
  run_install instance calendar main --yes --calendar-provider fastmail --calendar-email person@gmail.com
  assert_rc 0
  assert_contains "$OUT$ERR" "Google Calendar is already connected through the Google connector"
  assert_no_path "$(CAL_VOLUME)"
  sandbox_drop
}

test_presets
test_gmail_is_skipped
test_url_refusals
test_secret_rules
test_agent_secret_and_network
test_an_older_instance_gets_a_secret
test_install_with_calendar_flags
test_connector_starts_with_the_instance
test_connect_prompt_yes_asks_the_calendar_questions
test_second_run_replaces_the_account
test_app_restarts_to_learn_of_the_calendar
test_piped_input_and_remove
test_remove_clears_an_old_way_file_and_line
test_a_refused_address_saves_nothing
test_a_failed_sign_in_check_keeps_the_account
test_yes_names_missing_value
test_refusals_at_install
test_gmail_skip_writes_nothing
tests_finish
