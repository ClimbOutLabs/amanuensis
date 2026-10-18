#!/usr/bin/env bash
# What Aman calls the person: asked after the email, recorded, shown by the sign-in service, and used by import.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

EMAIL=robin@example.invalid

reg_value() { sed -n "s/^$2=//p" "$AMAN_HOME/state/instances/$1.conf" | head -n 1; }
env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
dex_yaml() { cat "$AMAN_HOME/instances/$1/dex.yaml"; }

# Checks the name everywhere it is kept for instance NAME: the record, the app settings and the sign-in service.
assert_called() { # instance, name
  assert_eq "$(reg_value "$1" owner_name)" "$2" "the record keeps the name"
  assert_eq "$(env_value "$1" OWNER_NAME)" "$2" "the app is told the name"
  assert_contains "$(dex_yaml "$1")" "username: '$2'"
  assert_contains "$(dex_yaml "$1")" "userID: 'owner'"
  assert_not_contains "$(dex_yaml "$1")" "username: 'owner'"
}

# Answers the first-install questions on a terminal with REPLY to "What should Aman call you?".
install_answering() { # reply...
  local replies='' reply
  for reply in "$@"; do replies="$replies"$'\n'"What should Aman call you?=>$reply"; done
  run_install_tty "Instance name=>
Your email=>$EMAIL$replies
Back up automatically=>y
Go ahead?=>y
Enter a password for $EMAIL=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD" --local-only
}

install_yes() { # extra args...
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email "$EMAIL" --local-only "$@"
  clear_input
}

test_enter_takes_the_start_of_the_email() {
  t_begin "the question comes after the email, and Enter takes the part of the email before the @"
  sandbox_new
  install_answering ""
  assert_eq "$RC" 0
  assert_contains "$OUT" "What should Aman call you? [robin]"
  local email_at name_at
  email_at=$(printf '%s\n' "$OUT" | grep -n 'Your email' | head -n 1 | cut -d: -f1)
  name_at=$(printf '%s\n' "$OUT" | grep -n 'What should Aman call you' | head -n 1 | cut -d: -f1 || true)
  if [ -n "$name_at" ] && [ "$email_at" -lt "$name_at" ]; then t_pass; else t_fail "the name ($name_at) was asked before the email ($email_at)"; fi
  assert_called main robin
  sandbox_drop
}

test_a_typed_name_is_used() {
  t_begin "a typed name is used as given, spaces and all"
  sandbox_new
  install_answering "Robin Lee"
  assert_eq "$RC" 0
  assert_called main "Robin Lee"
  assert_flat_contains "$OUT" "Instance main for Robin Lee ($EMAIL)"
  sandbox_drop
}

test_a_bad_name_is_asked_again() {
  t_begin "a name with a character that is not allowed is refused with the reason, then asked again"
  sandbox_new
  install_answering "Robin; Lee" "Robin"
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "The name contains a character that is not allowed."
  assert_eq "$(printf '%s\n' "$OUT" | grep -c 'What should Aman call you?')" 2 "asked twice"
  assert_called main Robin
  sandbox_drop
}

test_yes_takes_the_default_without_asking() {
  t_begin "--yes takes the start of the email and asks nothing"
  sandbox_new
  install_yes
  assert_rc 0
  assert_not_contains "$OUT$ERR" "What should Aman call you"
  assert_called main robin
  sandbox_drop
}

test_the_flag_names_the_person() {
  t_begin "--your-name sets the name for a scripted install and for instance add"
  sandbox_new
  install_yes --your-name "Robin Lee"
  assert_rc 0
  assert_called main "Robin Lee"
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email sam@example.invalid --local-only --your-name=Sam
  clear_input
  assert_rc 0
  assert_called second Sam
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add third --yes --password-stdin --email kim@example.invalid --local-only
  clear_input
  assert_rc 0
  assert_called third kim
  sandbox_drop
}

test_the_flag_is_checked() {
  t_begin "--your-name is checked like an answer and only applies where the question is asked"
  sandbox_new
  install_yes --your-name "$(printf 'r%.0s' $(seq 1 81))"
  assert_rc 2
  assert_flat_contains "$ERR" "The name is longer than 80 characters. Type a shorter one."
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  install_yes --your-name ""
  assert_rc 2
  assert_flat_contains "$ERR" "The name is empty. Type the name Aman should call you."
  run_install backup --your-name Robin
  assert_rc 2
  assert_flat_contains "$ERR" "--your-name applies to install and instance add"
  sandbox_drop
}

# The sign-in service of an instance installed before the question, with nothing recorded.
make_old_instance() { # username
  install_yes
  sed -i '/^owner_name=/d' "$AMAN_HOME/state/instances/main.conf"
  sed -i '/^OWNER_NAME=/d' "$AMAN_HOME/instances/main/.env"
  sed -i "s/^    username: .*/    username: '$1'/" "$AMAN_HOME/instances/main/dex.yaml"
}

test_upgrade_fills_in_an_old_instance() {
  t_begin "upgrade of an instance with no recorded name asks nothing and replaces the old 'owner'"
  sandbox_new
  make_old_instance owner
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_not_contains "$OUT$ERR" "What should Aman call you"
  assert_called main robin
  sandbox_drop
}

test_refresh_keeps_a_name_set_by_hand() {
  t_begin "refresh of an instance with no recorded name keeps the name its sign-in service already shows"
  sandbox_new
  make_old_instance "Robin Lee"
  run_install instance refresh main
  assert_rc 0
  assert_not_contains "$OUT$ERR" "What should Aman call you"
  assert_called main "Robin Lee"
  sandbox_drop
}

test_import_uses_the_recorded_name() {
  t_begin "instance import uses the recorded name without asking, and --display-name still wins"
  sandbox_new
  install_yes --your-name "Robin Lee"
  EXPORT_FILE=$SB/aman-export.zip
  printf 'PK-not-really-a-zip' >"$EXPORT_FILE"
  run_install_tty "" instance import main "$EXPORT_FILE"
  assert_eq "$RC" 0
  assert_not_contains "$OUT" "Your name, as imported chats show it"
  assert_contains "$(cat "$SB_STATE/import_runs")" "import $EMAIL Robin Lee"
  run_install instance import main "$EXPORT_FILE" --display-name Rob
  assert_rc 0
  assert_contains "$(tail -n 1 "$SB_STATE/import_runs")" "import $EMAIL Rob"
  sandbox_drop
}

test_enter_takes_the_start_of_the_email
test_a_typed_name_is_used
test_a_bad_name_is_asked_again
test_yes_takes_the_default_without_asking
test_the_flag_names_the_person
test_the_flag_is_checked
test_upgrade_fills_in_an_old_instance
test_refresh_keeps_a_name_set_by_hand
test_import_uses_the_recorded_name
tests_finish
