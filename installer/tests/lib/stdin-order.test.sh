#!/usr/bin/env bash
# The answers on stdin: one line per option that ends in -stdin, always in the order sign-in password, Token Factory key,
# calendar app password, email app password, on a first install and on a run over an existing instance.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

SIGNIN_PW="sentinel-signin-pw-61"
TF_LINE="v1.sentinel-order-tf-key_3b7c"
CAL_LINE="sentinel-order-cal-pw-58"
MAIL_LINE="sentinel-order-mail-pw-94"

file_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/main/$1" 2>/dev/null | head -n 1; }

# The email account as the connector's account agent saved it, in the named volume the stub models.
account_value() { sed -n "s/^$1=//p" "$STUB_STATE/mail-account-aman-main" 2>/dev/null | head -n 1; }

# Runs install.sh with the stdin options in $1 (letters p, t, c, m), the matching lines in the fixed order, and the
# account options each of them needs.
run_with_lines() { # letters [more args]
  local letters=$1 input='' args=(--yes)
  shift
  case "$letters" in *p*)
    input+="$SIGNIN_PW"$'\n'
    args+=(--password-stdin)
    ;;
  esac
  case "$letters" in *t*)
    input+="$TF_LINE"$'\n'
    args+=(--token-factory-key-stdin)
    ;;
  esac
  case "$letters" in *c*)
    input+="$CAL_LINE"$'\n'
    args+=(--calendar-provider fastmail --calendar-email owner@example.invalid --calendar-password-stdin)
    ;;
  esac
  case "$letters" in *m*)
    input+="$MAIL_LINE"$'\n'
    args+=(--email-provider gmail --email-address a@gmail.com --email-password-stdin)
    ;;
  esac
  with_input "$input"
  run_install "${args[@]}" "$@"
  clear_input
}

# Each line reached only its own place, and the sign-in password went nowhere on a run over an existing instance.
assert_lines_landed() { # letters first|again
  local letters=$1 label="$1 ($2)"
  assert_rc 0
  case "$letters" in
    *t*) assert_eq "$(file_value .env NEBIUS_API_KEY)" "$TF_LINE" "$label Token Factory key" ;;
  esac
  case "$letters" in
    *c*) assert_eq "$(file_value .env.calendar CALDAV_PASSWORD)" "$CAL_LINE" "$label calendar app password" ;;
    *) assert_no_path "$AMAN_HOME/instances/main/.env.calendar" ;;
  esac
  case "$letters" in
    *m*)
      assert_eq "$(account_value MCP_EMAIL_SERVER_PASSWORD)" "'$MAIL_LINE'" "$label email app password"
      assert_eq "$(sed -n 5p "$SB_STATE/imap_stdin")" "$MAIL_LINE" "$label the sign-in check got the email app password"
      ;;
    *) assert_eq "$(account_value MCP_EMAIL_SERVER_PASSWORD)" "" "$label no email app password saved" ;;
  esac
  if [ "$2" = first ]; then
    assert_eq "$(cat "$SB_STATE/hash_stdin")" "$SIGNIN_PW" "$label sign-in password"
  else
    assert_tree_lacks "$AMAN_HOME" "$SIGNIN_PW"
    assert_not_contains "$(cat "$SB_STATE/imap_stdin" 2>/dev/null || true)" "$SIGNIN_PW" "$label the sign-in password never reached the mail server"
  fi
  assert_not_contains "$OUT$ERR" "$SIGNIN_PW" "$label output"
}

test_rerun_keeps_the_sign_in_password_away_from_email() {
  t_begin "a run over an existing instance with the sign-in and email lines saves the email line as the app password"
  sandbox_new
  install_python_stub
  install_machine
  with_input "SIGNIN-PW-xyz
EMAIL-PW-abc
"
  run_install --yes --password-stdin --email-provider gmail --email-address a@gmail.com --email-password-stdin
  clear_input
  assert_rc 0
  assert_eq "$(account_value MCP_EMAIL_SERVER_PASSWORD)" "'EMAIL-PW-abc'"
  assert_eq "$(sed -n 5p "$SB_STATE/imap_stdin")" "EMAIL-PW-abc" "the mail server gets the email line"
  assert_tree_lacks "$AMAN_HOME" "SIGNIN-PW-xyz"
  assert_not_contains "$(cat "$SB_STATE/imap_stdin")" "SIGNIN-PW-xyz" "the sign-in password never reaches the mail server"
  sandbox_drop
}

test_rerun_keeps_the_sign_in_password_away_from_the_calendar() {
  t_begin "a run over an existing instance with the sign-in and calendar lines saves the calendar line as the app password"
  sandbox_new
  install_machine
  with_input "SIGNIN-PW-xyz
CAL-PW-abc
"
  run_install --yes --password-stdin --calendar-provider fastmail --calendar-email owner@example.invalid --calendar-password-stdin
  clear_input
  assert_rc 0
  assert_eq "$(file_value .env.calendar CALDAV_PASSWORD)" "CAL-PW-abc"
  assert_tree_lacks "$AMAN_HOME" "SIGNIN-PW-xyz"
  sandbox_drop
}

test_first_install_with_every_line() {
  t_begin "a first install with all four lines puts each one in its own place"
  sandbox_new
  install_python_stub
  run_with_lines ptcm --email owner@example.invalid
  assert_lines_landed ptcm first
  sandbox_drop
}

test_first_install_subsets() {
  t_begin "a first install takes the lines of only the options given, in the same order"
  local letters
  for letters in p pt pc pm ptc ptm pcm; do
    sandbox_new
    install_python_stub
    run_with_lines "$letters" --email owner@example.invalid
    assert_lines_landed "$letters" first
    sandbox_drop
  done
}

test_rerun_subsets() {
  t_begin "a run over an existing instance takes the lines of only the options given, in the same order"
  local letters
  for letters in t c m tc tm cm tcm p pt pc pm ptc ptm pcm ptcm; do
    sandbox_new
    install_python_stub
    install_machine
    rm -f "$SB_STATE/imap_stdin"
    run_with_lines "$letters"
    assert_lines_landed "$letters" again
    sandbox_drop
  done
}

test_rerun_keeps_the_sign_in_password_away_from_email
test_rerun_keeps_the_sign_in_password_away_from_the_calendar
test_first_install_with_every_line
test_first_install_subsets
test_rerun_subsets
tests_finish
