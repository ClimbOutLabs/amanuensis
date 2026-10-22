#!/usr/bin/env bash
# The optional email account of an instance: presets, the question, scripted flags, the instance command, the sign-in
# check, and the places the app password must never reach.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

EMAIL_PW="sentinel-mailpw-5d2e9a61"

# slug, incoming host, incoming port, incoming SSL, outgoing host, outgoing port, outgoing SSL, certificate check.
# A value of false for SSL means the STARTTLS setting is the one on.
PRESET_TABLE='gmail imap.gmail.com 993 true smtp.gmail.com 465 true true
yahoo imap.mail.yahoo.com 993 true smtp.mail.yahoo.com 465 true true
aol imap.aol.com 993 true smtp.aol.com 465 true true
icloud imap.mail.me.com 993 true smtp.mail.me.com 587 false true
fastmail imap.fastmail.com 993 true smtp.fastmail.com 465 true true
zoho imap.zoho.com 993 true smtp.zoho.com 465 true true
gmx imap.gmx.net 993 true mail.gmx.net 465 true true
webde imap.web.de 993 true smtp.web.de 587 false true
proton 127.0.0.1 1143 false 127.0.0.1 1025 false false'

env_mail() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env.mail-email" | head -n 1; }

mail_link_lines() { grep -c '^MAIL_EMAIL_MCP_URL=' "$AMAN_HOME/instances/main/.env" || true; }

opposite() { if [ "$1" = true ]; then echo false; else echo true; fi; }

# The sign-in check runs python3 with -c. This stand-in records what it was given and answers with the text in
# imap_answer (ok when absent). Every other python3 call goes to the real one, so the rest of the installer is unchanged.
install_python_stub() {
  local real
  real=$(command -v python3)
  rm -f "$SB_BIN/python3"
  cat >"$SB_BIN/python3" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *imaplib*)
    printf '%s\n' "$*" >>"$STUB_STATE/imap_argv"
    cat >"$STUB_STATE/imap_stdin"
    cat "$STUB_STATE/imap_answer" 2>/dev/null || echo ok
    ;;
  *) exec "$STUB_REAL_PY3" "$@" ;;
esac
STUB
  chmod 755 "$SB_BIN/python3"
  RUN_ENV_EXTRA+=("STUB_REAL_PY3=$real")
}

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

# The app password may appear only in the account file of the instance: not in any other file, the log or the output.
assert_secret_only_in_account_file() {
  local found
  found=$(grep -rIl -- "$EMAIL_PW" "$AMAN_HOME" "$SB/stub.log" "$SB/out" "$SB/err" 2>/dev/null | sort | tr '\n' ' ' || true)
  assert_eq "$found" "$AMAN_HOME/instances/main/.env.mail-email " "files holding the app password"
  assert_not_contains "$OUT" "$EMAIL_PW" "stdout"
  assert_not_contains "$ERR" "$EMAIL_PW" "stderr"
}

test_presets_write_their_servers() {
  t_begin "each preset writes its servers, encryption and certificate check"
  sandbox_new
  install_python_stub
  install_machine
  local slug imap_host imap_port imap_ssl smtp_host smtp_port smtp_ssl verify
  while read -r slug imap_host imap_port imap_ssl smtp_host smtp_port smtp_ssl verify; do
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
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_IMAP_VERIFY_SSL)" "$verify" "$slug incoming certificate check"
    assert_eq "$(env_mail main MCP_EMAIL_SERVER_SMTP_VERIFY_SSL)" "$verify" "$slug outgoing certificate check"
  done <<<"$PRESET_TABLE"
  assert_mode "$AMAN_HOME/instances/main/.env.mail-email" 600
  sandbox_drop
}

test_outlook_families_are_skipped() {
  t_begin "Outlook, Hotmail and Live addresses are skipped with the plain message"
  sandbox_new
  install_python_stub
  install_machine
  local address
  for address in person@outlook.com person@hotmail.co.uk person@live.com; do
    run_install instance email main --email-provider gmail --email-address "$address"
    assert_rc 0
    assert_flat_contains "$OUT$ERR" "Outlook, Hotmail and Live addresses need a Microsoft sign-in" "$address"
    assert_no_path "$AMAN_HOME/instances/main/.env.mail-email"
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
  assert_mode "$AMAN_HOME/instances/main/.env.mail-email" 600
  assert_not_contains "$OUT" "Connect an email account" "the question is not asked with flags"
  assert_flat_contains "$OUT" "Signed in to imap.gmail.com as you@gmail.com"
  assert_eq "$(sed -n 6p "$SB_STATE/imap_stdin")" "$EMAIL_PW" "the password reached the sign-in check on stdin"
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
  assert_no_path "$AMAN_HOME/instances/main/.env.mail-email"
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
Your provider (type a number)=>10
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
  assert_mode "$AMAN_HOME/instances/main/.env.mail-email" 600
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
  assert_mode "$AMAN_HOME/instances/main/.env.mail-email" 600
  run_install instance email main --remove
  assert_rc 0
  assert_no_path "$AMAN_HOME/instances/main/.env.mail-email"
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
  assert_file "$AMAN_HOME/instances/main/.env.mail-email"
  printf 'server\n' >"$SB_STATE/imap_answer"
  mail_run --email-provider gmail --email-address a@gmail.com --email-password-stdin
  assert_flat_contains "$OUT$ERR" "Could not reach imap.gmail.com on port 993" "server unreachable"
  rm -f "$SB_STATE/imap_answer"
  rm -f "$SB_BIN/python3"
  mail_run --email-provider gmail --email-address a@gmail.com --email-password-stdin
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "was not checked: python3 is not on this computer" "no python3"
  assert_file "$AMAN_HOME/instances/main/.env.mail-email"
  sandbox_drop
}

test_password_is_read_from_stdin_without_spaces() {
  t_begin "spaces in an app password are removed and a quote in it is refused"
  sandbox_new
  install_python_stub
  install_machine
  with_input "mail pw 4c1e9d07
"
  run_install instance email main --email-provider gmail --email-address a@gmail.com --email-password-stdin
  clear_input
  assert_rc 0
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_PASSWORD)" "'mailpw4c1e9d07'"
  with_input "bad'pw123456
"
  run_install instance email main --email-provider gmail --email-address a@gmail.com --email-password-stdin
  clear_input
  assert_rc 2
  assert_flat_contains "$ERR" "character this installer cannot use"
  assert_eq "$(env_mail main MCP_EMAIL_SERVER_PASSWORD)" "'mailpw4c1e9d07'" "the old account is kept"
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
  assert_not_contains "$(cat "$compose")" "@@"
  sandbox_drop
}

test_presets_write_their_servers
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
