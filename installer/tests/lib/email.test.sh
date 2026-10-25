#!/usr/bin/env bash
# The optional email account of an instance: presets, the question, scripted flags, the instance command, the sign-in
# check, and the places the app password must never reach.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

EMAIL_PW="sentinel-mailpw-5d2e9a61"

# slug, incoming host, incoming port, incoming SSL, outgoing host, outgoing port, outgoing SSL.
# A value of false for SSL means the STARTTLS setting is the one on.
PRESET_TABLE='gmail imap.gmail.com 993 true smtp.gmail.com 465 true
yahoo imap.mail.yahoo.com 993 true smtp.mail.yahoo.com 465 true
aol imap.aol.com 993 true smtp.aol.com 465 true
icloud imap.mail.me.com 993 true smtp.mail.me.com 587 false
fastmail imap.fastmail.com 993 true smtp.fastmail.com 465 true
zoho imap.zoho.com 993 true smtp.zoho.com 465 true
gmx imap.gmx.net 993 true mail.gmx.net 465 true
webde imap.web.de 993 true smtp.web.de 587 false'

# The account as the connector's account agent saved it, in the named volume the stub models for the
# instance's compose project. Tests read the volume, never a host file: the installer writes no host file.
env_mail() { sed -n "s/^$2=//p" "$STUB_STATE/mail-account-aman-$1" | head -n 1; }

mail_link_lines() { grep -c '^MAIL_EMAIL_MCP_URL=' "$AMAN_HOME/instances/main/.env" || true; }

opposite() { if [ "$1" = true ]; then echo false; else echo true; fi; }

# Installs with a Gmail account given on the command line; the app password is the line after the sign-in password.
install_with_gmail() {
  with_input "$SENTINEL_PASSWORD
$EMAIL_PW
"
  run_install --yes --password-stdin --email owner@example.invalid --email-provider gmail --email-address you@gmail.com --email-password-stdin
  clear_input
}

# instance email main ARGS, with the app password on stdin.
mail_run() {
  with_input "$EMAIL_PW
"
  run_install instance email main "$@"
  clear_input
}

# The app password may appear only in the connector's volume for the instance: not in any other file, the log or the output.
assert_secret_only_in_account_file() {
  local found
  found=$(grep -rIl -- "$EMAIL_PW" "$AMAN_HOME" "$SB/stub.log" "$SB/out" "$SB/err" "$STUB_STATE/mail-account-aman-main" 2>/dev/null | sort | tr '\n' ' ' || true)
  assert_eq "$found" "$STUB_STATE/mail-account-aman-main " "files holding the app password"
  assert_not_contains "$OUT" "$EMAIL_PW" "stdout"
  assert_not_contains "$ERR" "$EMAIL_PW" "stderr"
}

# No account is saved: the connector's volume file is absent, or present and empty of any account.
# An empty volume file is the no-account state.
assert_no_mail_account() {
  local file="$STUB_STATE/mail-account-aman-main"
  if [ -f "$file" ]; then
    assert_not_contains "$(cat "$file")" "MCP_EMAIL_SERVER_EMAIL_ADDRESS" "no account is saved"
  fi
}

test_presets_write_their_servers() {
  t_begin "each preset writes its servers, encryption and certificate check"
  sandbox_new
  install_python_stub
  install_machine
  local slug imap_host imap_port imap_ssl smtp_host smtp_port smtp_ssl
  while read -r slug imap_host imap_port imap_ssl smtp_host smtp_port smtp_ssl; do
    mail_run --email-provider "$slug" --email-address person@example.invalid --email-password-stdin
    assert_rc 0
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_HOST)" "$imap_host" "$slug incoming host"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_PORT)" "$imap_port" "$slug incoming port"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_SSL)" "$imap_ssl" "$slug incoming SSL"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_START_SSL)" "$(opposite "$imap_ssl")" "$slug incoming STARTTLS"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_HOST)" "$smtp_host" "$slug outgoing host"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_PORT)" "$smtp_port" "$slug outgoing port"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_SSL)" "$smtp_ssl" "$slug outgoing SSL"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_START_SSL)" "$(opposite "$smtp_ssl")" "$slug outgoing STARTTLS"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_VERIFY_SSL)" true "$slug incoming certificate check"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_VERIFY_SSL)" true "$slug outgoing certificate check"
  done <<<"$PRESET_TABLE"
  assert_file "$STUB_STATE/mail-account-aman-main"
  run_install instance email main --email-provider proton --email-address person@example.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "Type a number from 1 to 9" "Proton Mail Bridge is not offered"
  sandbox_drop
}

# Runs the installer's own sign-in check, from the installer's library, against a local IMAP server.
check_lib() {
  PATH=$SB_BIN SSL_CERT_FILE="$SB/imap/cert.pem" "$SB_BIN/bash" -c ". '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/email.sh'; $1" 2>&1
}

# A local IMAP server with a certificate for localhost that the check trusts through SSL_CERT_FILE.
start_imap() { # mode user password
  mkdir -p "$SB/imap"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost \
    -keyout "$SB/imap/key.pem" -out "$SB/imap/cert.pem" >/dev/null 2>&1
  rm -f "$SB/imap/port"
  python3 "$TESTS_DIR/fake_imap.py" "$1" "$SB/imap/cert.pem" "$SB/imap/key.pem" "$2" "$3" "$SB/imap/port" &
  IMAP_PID=$!
  local tries=0
  while [ ! -s "$SB/imap/port" ] && [ "$tries" -lt 100 ]; do
    sleep 0.1
    tries=$((tries + 1))
  done
  IMAP_PORT=$(cat "$SB/imap/port")
}

stop_imap() {
  kill "$IMAP_PID" 2>/dev/null || true
  wait "$IMAP_PID" 2>/dev/null || true
}

test_sign_in_check_against_a_local_server() {
  t_begin "the sign-in check sends the password as it is, for both kinds of encryption"
  sandbox_new
  local pw='p@ss"w\o-rd9' mode out
  for mode in ssl starttls; do
    start_imap "$mode" user@example.invalid "$pw"
    out=$(check_lib "EM_IMAP_HOST=localhost EM_IMAP_PORT=$IMAP_PORT EM_IMAP_MODE=$mode EM_ADDRESS=user@example.invalid EM_PASSWORD='$pw' email_check main")
    assert_flat_contains "$out" "Signed in to localhost as user@example.invalid" "$mode: the right password is accepted"
    assert_eq "$(cat "$SB/imap/port.login")" "$pw" "$mode: the server received the password exactly"
    out=$(check_lib "EM_IMAP_HOST=localhost EM_IMAP_PORT=$IMAP_PORT EM_IMAP_MODE=$mode EM_ADDRESS=user@example.invalid EM_PASSWORD=wrong-pw-1 email_check main")
    assert_flat_contains "$out" "localhost did not accept this address and app password" "$mode: a wrong password is refused"
    stop_imap
  done
  start_imap ssl user@example.invalid "$pw"
  out=$(PATH=$SB_BIN "$SB_BIN/bash" -c ". '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/email.sh'; EM_IMAP_HOST=localhost EM_IMAP_PORT=$IMAP_PORT EM_IMAP_MODE=ssl EM_ADDRESS=user@example.invalid EM_PASSWORD='$pw' email_check main" 2>&1)
  assert_flat_contains "$out" "its security certificate was refused" "an untrusted certificate is refused"
  stop_imap
  sandbox_drop
}

test_check_ignores_python_files_in_the_working_folder() {
  t_begin "a python file in the folder the installer runs from is not loaded by the sign-in check"
  sandbox_new
  local pw='plain-pw-42' out
  start_imap ssl user@example.invalid "$pw"
  mkdir -p "$SB/cwd"
  printf 'open(%s, "w").write("loaded")\nraise SystemExit(0)\n' "'$SB/planted'" >"$SB/cwd/imaplib.py"
  out=$(cd "$SB/cwd" && check_lib "EM_IMAP_HOST=localhost EM_IMAP_PORT=$IMAP_PORT EM_IMAP_MODE=ssl EM_ADDRESS=user@example.invalid EM_PASSWORD='$pw' email_check main")
  assert_flat_contains "$out" "Signed in to localhost" "the real imaplib signed in"
  assert_no_path "$SB/planted"
  stop_imap
  sandbox_drop
}

test_outlook_families_are_skipped() {
  t_begin "Microsoft addresses are skipped with the plain message"
  sandbox_new
  install_python_stub
  install_machine
  local address
  for address in person@outlook.com person@hotmail.co.uk person@live.com person@msn.com person@passport.com \
    person@windowslive.com person@contoso.onmicrosoft.com; do
    run_install instance email main --email-provider gmail --email-address "$address"
    assert_rc 0
    assert_flat_contains "$OUT$ERR" "Microsoft addresses, such as Outlook, Hotmail, Live and MSN, need a Microsoft sign-in" "$address"
    assert_no_mail_account
  done
  sandbox_drop
}

test_scripted_flags_with_piped_input() {
  t_begin "scripted install writes the account from flags and piped input, and the question is not asked"
  sandbox_new
  install_python_stub
  install_with_gmail
  assert_rc 0
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_EMAIL_ADDRESS)" you@gmail.com
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_HOST)" imap.gmail.com
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_PORT)" 465
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_PASSWORD)" "'$EMAIL_PW'"
  assert_file "$STUB_STATE/mail-account-aman-main"
  assert_not_contains "$OUT" "Connect an email account" "the question is not asked with flags"
  assert_flat_contains "$OUT" "Signed in to imap.gmail.com as you@gmail.com"
  assert_eq "$(sed -n 5p "$SB_STATE/imap_stdin")" "$EMAIL_PW" "the password reached the sign-in check on stdin"
  assert_not_contains "$(cat "$SB_STATE/imap_argv")" "$EMAIL_PW" "the password is not on the command line"
  assert_secret_only_in_account_file
  sandbox_drop
}

test_yes_without_email_flags_skips_the_step() {
  t_begin "--yes without email options skips the email step and shows no Email row"
  sandbox_new
  install_python_stub
  install_machine
  assert_rc 0
  assert_no_mail_account
  assert_not_contains "$OUT" "Connect an email account"
  sandbox_drop
}

test_question_at_a_terminal_with_other_servers() {
  t_begin "at a terminal the question leads to the Other servers, the app password and a saved account"
  sandbox_new
  install_python_stub
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
What should Aman call you?=>
Connect a calendar?=>n
Connect an email account? (optional)=>y
Your provider (type a number)=>9
Email address to connect=>mail@example.org
Incoming mail server=>imap.example.org
Incoming mail port=>993
Outgoing mail server=>smtp.example.org
Outgoing mail port=>587
App password for the email account=>$EMAIL_PW
Back up automatically=>y
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD"
  assert_rc 0
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_HOST)" imap.example.org
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_PORT)" 587
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_SSL)" false
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_START_SSL)" true
  assert_file "$STUB_STATE/mail-account-aman-main"
  assert_not_contains "$OUT" "$EMAIL_PW" "stdout"
  sandbox_drop
}

test_instance_command_adds_changes_and_removes() {
  t_begin "instance email adds, changes and removes the account, and restarts the instance each time"
  sandbox_new
  install_python_stub
  install_machine
  mail_run --email-provider gmail --email-address a@gmail.com --email-password-stdin
  assert_rc 0
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_EMAIL_ADDRESS)" a@gmail.com "added"
  assert_eq "$(mail_link_lines)" 1 "connector line added to the instance settings"
  assert_log_has "--force-recreate"
  mail_run --email-provider fastmail --email-address b@fastmail.com --email-password-stdin
  assert_rc 0
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_EMAIL_ADDRESS)" b@fastmail.com "changed"
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_HOST)" imap.fastmail.com "changed server"
  assert_eq "$(mail_link_lines)" 1 "still one connector line after a change"
  assert_log_has "mail-email"
  assert_file "$STUB_STATE/mail-account-aman-main"
  run_install instance email main --remove
  assert_rc 0
  assert_no_mail_account
  assert_eq "$(mail_link_lines)" 0 "connector line gone after remove"
  assert_flat_contains "$OUT$ERR" "The Email connector is removed. Any saved app password has been deleted from this computer."
  sandbox_drop
}

test_sign_in_check_answers_are_plain() {
  t_begin "each sign-in check answer says what happened and the one next step"
  sandbox_new
  install_python_stub
  install_machine
  printf 'login\n' >"$SB_STATE/imap_answer"
  mail_run --email-provider gmail --email-address a@gmail.com --email-password-stdin
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "imap.gmail.com did not accept this address and app password" "login refused"
  assert_flat_contains "$OUT$ERR" "install.sh instance email main" "next step"
  assert_file "$STUB_STATE/mail-account-aman-main"
  printf 'server\n' >"$SB_STATE/imap_answer"
  mail_run --email-provider gmail --email-address a@gmail.com --email-password-stdin
  assert_flat_contains "$OUT$ERR" "Could not reach imap.gmail.com on port 993" "server unreachable"
  rm -f "$SB_STATE/imap_answer"
  rm -f "$SB_BIN/python3"
  mail_run --email-provider gmail --email-address a@gmail.com --email-password-stdin
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "was not checked: python3 is not on this computer" "no python3"
  assert_file "$STUB_STATE/mail-account-aman-main"
  sandbox_drop
}

test_password_is_read_from_stdin_without_spaces() {
  t_begin "spaces are removed only from the grouped app passwords of Gmail-like providers, and a quote is refused"
  sandbox_new
  install_python_stub
  install_machine
  with_input "mail pw 4c1e9d07
"
  run_install instance email main --email-provider gmail --email-address a@gmail.com --email-password-stdin
  clear_input
  assert_rc 0
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_PASSWORD)" "'mailpw4c1e9d07'"
  local slug
  for slug in icloud yahoo aol fastmail; do
    with_input "abcd efgh ijkl mnop
"
    run_install instance email main --email-provider "$slug" --email-address a@example.invalid --email-password-stdin
    clear_input
    assert_rc 0
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_PASSWORD)" "'abcdefghijklmnop'" "$slug spaces removed"
  done
  for slug in gmx webde zoho; do
    with_input "my pass word9
"
    run_install instance email main --email-provider "$slug" --email-address a@example.invalid --email-password-stdin
    clear_input
    assert_rc 2 "$slug"
    assert_flat_contains "$ERR" "character this installer cannot use" "$slug keeps the spaces"
  done
  with_input "my pass word9
"
  run_install instance email main --yes --email-provider other --email-address a@example.invalid --email-imap-host imap.example.invalid \
    --email-smtp-host smtp.example.invalid --email-password-stdin
  clear_input
  assert_rc 2
  assert_flat_contains "$ERR" "character this installer cannot use" "other keeps the spaces"
  with_input "bad'pw123456
"
  run_install instance email main --email-provider gmail --email-address a@gmail.com --email-password-stdin
  clear_input
  assert_rc 2
  assert_flat_contains "$ERR" "character this installer cannot use"
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_PASSWORD)" "'abcdefghijklmnop'" "the old account is kept"
  sandbox_drop
}

test_email_options_follow_their_commands() {
  t_begin "email options are refused where they do not apply"
  sandbox_new
  install_python_stub
  install_machine
  run_install instance email main --yes
  assert_rc 2
  assert_flat_contains "$ERR" "With --yes the email account needs --email-provider"
  run_install instance email main --remove --email-provider gmail
  assert_rc 2
  assert_flat_contains "$ERR" "--remove cannot be used with the email options"
  run_install --yes --password-stdin --email owner@example.invalid --email-provider gmail --email-address a@gmail.com
  assert_rc 2
  assert_flat_contains "$ERR" "--email-password-stdin"
  run_install instance list --email-provider gmail
  assert_rc 2
  sandbox_drop
}

test_compose_runs_the_connector() {
  t_begin "the instance compose file runs the connector on the send list, with its wrapper script beside it"
  sandbox_new
  install_python_stub
  install_machine
  local compose=$AMAN_HOME/instances/main/compose.yaml
  assert_file "$AMAN_HOME/instances/main/mail-email-entrypoint.sh"
  assert_contains "$(cat "$compose")" "  mail-email:"
  assert_contains "$(cat "$compose")" "./mail-email-entrypoint.sh:/usr/local/bin/aman-mail-entrypoint:ro"
  assert_contains "$(cat "$compose")" "      - mail-policy:/data/mail-policy"
  assert_contains "$(cat "$compose")" "MAIL_POLICY_FILE: /data/mail-policy/allowed_recipients.toml"
  local service
  service=$(sed -n '/^  mail-email:/,/^$/p' "$compose")
  assert_contains "$service" "    cap_drop:
      - ALL" "the connector drops every capability"
  assert_contains "$service" "      - no-new-privileges:true" "the connector cannot gain privileges"
  assert_contains "$service" "      - mail-account:/account" "the account lives in the connector's volume"
  assert_not_contains "$service" "./.env.mail-email" "no host account file is bound"
  assert_not_contains "$service" "env_file" "no host settings file is loaded into the connector"
  assert_contains "$(cat "$compose")" "  mail-account:
    name: aman_main_mail_account" "the account volume is declared"
  assert_not_contains "$(cat "$compose")" "@@"
  sandbox_drop
}

test_instance_commands_keep_the_connector() {
  t_begin "instance email and instance calendar keep the email connector in the compose file"
  sandbox_new
  install_python_stub
  install_machine
  local compose=$AMAN_HOME/instances/main/compose.yaml
  mail_run --email-provider gmail --email-address a@gmail.com --email-password-stdin
  assert_rc 0
  assert_contains "$(cat "$compose")" "  mail-email:" "after instance email"
  with_input "calendar-pw-71
"
  run_install instance calendar main --yes --calendar-provider fastmail --calendar-email owner@example.invalid --calendar-password-stdin
  clear_input
  assert_rc 0
  assert_contains "$(cat "$compose")" "  mail-email:" "after instance calendar"
  sandbox_drop
}

test_instance_email_needs_the_connector_installed() {
  t_begin "instance email on a version without the email connector says to upgrade and changes nothing"
  sandbox_new
  install_python_stub
  install_machine
  local release=$AMAN_HOME/release/release.json
  grep -v '"mail_email_image"' "$release" >"$release.new"
  mv "$release.new" "$release"
  mail_run --email-provider gmail --email-address a@gmail.com --email-password-stdin
  assert_rc 1
  assert_flat_contains "$ERR" "has no email connector yet. Run install.sh upgrade first"
  assert_no_mail_account
  sandbox_drop
}

test_presets_write_their_servers
test_instance_commands_keep_the_connector
test_instance_email_needs_the_connector_installed
test_sign_in_check_against_a_local_server
test_check_ignores_python_files_in_the_working_folder
test_compose_runs_the_connector
test_outlook_families_are_skipped
test_scripted_flags_with_piped_input
test_yes_without_email_flags_skips_the_step
test_question_at_a_terminal_with_other_servers
test_instance_command_adds_changes_and_removes
test_sign_in_check_answers_are_plain
test_password_is_read_from_stdin_without_spaces
test_email_options_follow_their_commands
tests_finish
