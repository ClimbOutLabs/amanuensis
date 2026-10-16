#!/usr/bin/env bash
# One sign-in account per instance: the removed user commands, and what an install, upgrade or refresh does to an
# instance that an earlier version gave extra users.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

OWNER=owner@example.invalid

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
dex_yaml() { cat "$AMAN_HOME/instances/main/dex.yaml"; }
dex_env() { cat "$AMAN_HOME/instances/main/dex.env"; }
registry() { cat "$AMAN_HOME/state/instances/main.conf"; }
removal_lines() { printf '%s\n' "$OUT" | grep -c "^Removed .* from instance main" || true; }

# The files an earlier `instance add-user` left for judge1 and judge2: records, hashes, Dex entries, allowed emails.
make_legacy_users() {
  local dir=$AMAN_HOME/instances/main tmp=$SB/legacy
  printf 'user_judge1=member:judge1@demo.invalid\nuser_judge2=member:Judge2@demo.invalid\n' >>"$AMAN_HOME/state/instances/main.conf"
  printf '%s\n' \
    '# >>> sign-in users added with install.sh instance add-user: one password hash each, kept by the installer' \
    "DEX_USER_PASSWORD_HASH_JUDGE1='\$2a\$10\$legacyhashone'" \
    "DEX_USER_PASSWORD_HASH_JUDGE2='\$2a\$10\$legacyhashtwo'" \
    '# <<< end of user hashes' >>"$dir/dex.env"
  awk -v owner="$OWNER" '
    /^OIDC_ALLOWED_EMAILS=/ { print "OIDC_ALLOWED_EMAILS=" owner ",judge2@demo.invalid,judge1@demo.invalid"; next }
    { print }' "$dir/.env" >"$tmp" && cat "$tmp" >"$dir/.env"
  awk '
    { print }
    /^    userID: .owner.$/ {
      print "  - email: '"'"'judge1@demo.invalid'"'"'"
      print "    hashFromEnv: DEX_USER_PASSWORD_HASH_JUDGE1"
      print "    username: '"'"'judge1'"'"'"
      print "    userID: '"'"'judge1'"'"'"
    }' "$dir/dex.yaml" >"$tmp" && cat "$tmp" >"$dir/dex.yaml"
  rm -f "$tmp"
}

assert_single_owner() {
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER" "the owner is the only allowed email"
  assert_eq "$(grep -c '^OIDC_ALLOWED_EMAILS=' "$AMAN_HOME/instances/main/.env")" 1 "one allowlist line"
  assert_eq "$(dex_env | grep -c '^DEX_USER_PASSWORD_HASH')" 1 "one password hash"
  assert_contains "$(dex_env)" "DEX_USER_PASSWORD_HASH='\$2a\$10\$" "the owner hash stays"
  assert_not_contains "$(dex_env)" "JUDGE" "no member hash"
  assert_not_contains "$(dex_env)" "sign-in users added" "no member block"
  assert_not_contains "$(dex_env)" "end of user hashes" "no member block end"
  assert_eq "$(dex_yaml | grep -c 'hashFromEnv')" 1 "one Dex user"
  assert_contains "$(dex_yaml)" "  - email: '$OWNER'"
  assert_not_contains "$(dex_yaml)" "judge"
  assert_not_contains "$(registry)" "user_"
  assert_mode "$AMAN_HOME/instances/main/dex.env" 600
  assert_mode "$AMAN_HOME/instances/main/.env" 600
}

test_user_commands_and_options_are_gone() {
  t_begin "add-user, remove-user, list-users, --role and --demo-user are refused, and the help no longer mentions them"
  sandbox_new
  install_machine
  local command
  for command in add-user remove-user list-users; do
    run_install instance "$command" judge1 --email judge1@demo.invalid
    assert_rc 2
    assert_flat_contains "$ERR" "usage: install.sh instance add|list|remove|demo-seed|refresh"
  done
  run_install instance add second --role member
  assert_rc 2
  assert_flat_contains "$ERR" "unknown option --role"
  run_install --help
  assert_rc 0
  assert_not_contains "$OUT" "One person per instance"
  for command in add-user remove-user list-users --role --demo-user; do
    assert_not_contains "$OUT" "$command"
  done
  assert_no_path "$INSTALLER_DIR/lib/users.sh"
  sandbox_drop
}

test_a_new_instance_has_one_user() {
  t_begin "a new instance has one Dex user, one password hash and the owner as its only allowed email"
  sandbox_new
  install_machine
  assert_single_owner
  assert_eq "$(env_value main OIDC_ADMIN_ROLE_VALUE)" "$OWNER"
  sandbox_drop
}

test_install_rerun_removes_extra_users() {
  t_begin "re-running install removes the extra users, says which emails and why once, logs it, and restarts the instance"
  sandbox_new
  install_machine
  make_legacy_users
  local recreated
  recreated=$(log_count "force-recreate")
  run_install --dry-run
  assert_rc 0
  assert_flat_contains "$OUT" "Remove judge1@demo.invalid, judge2@demo.invalid from instance main"
  assert_contains "$(registry)" "user_judge1="
  assert_contains "$(dex_env)" "DEX_USER_PASSWORD_HASH_JUDGE1"
  run_install --yes
  assert_rc 0
  assert_eq "$(removal_lines)" 1 "one plain line"
  assert_eq "$(printf '%s\n' "$OUT" | grep '^Removed ')" "Removed judge1@demo.invalid, judge2@demo.invalid from instance main." "nothing after the names"
  assert_not_contains "$OUT$ERR" 'legacyhash'
  assert_single_owner
  assert_contains "$(cat "$AMAN_HOME/state/install.log")" "removed judge1@demo.invalid, judge2@demo.invalid from instance main; an upgrade rollback restores the database but not these accounts"
  assert_not_contains "$(cat "$AMAN_HOME/state/install.log")" 'legacyhash'
  if [ "$(log_count "force-recreate")" -gt "$recreated" ]; then t_pass; else t_fail "the instance was not recreated"; fi
  run_install --yes
  assert_rc 0
  assert_eq "$(removal_lines)" 0 "nothing left to say on the next run"
  assert_flat_contains "$OUT" "Nothing to do"
  sandbox_drop
}

test_upgrade_removes_extra_users() {
  t_begin "an upgrade removes the extra users before it restarts the instance on the new image"
  sandbox_new
  install_machine
  make_legacy_users
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_eq "$(removal_lines)" 1
  assert_flat_contains "$OUT" "Removed judge1@demo.invalid, judge2@demo.invalid from instance main"
  assert_single_owner
  assert_contains "$(cat "$AMAN_HOME/state/install.log")" "removed judge1@demo.invalid, judge2@demo.invalid from instance main"
  sandbox_drop
}

test_upgrade_recreates_an_instance_that_lost_users() {
  t_begin "an upgrade force-recreates an instance that lost users, and only that one"
  sandbox_new
  install_machine
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_eq "$(log_count "force-recreate")" 0 "a plain upgrade does not force a recreate"
  sandbox_drop
  sandbox_new
  install_machine
  make_legacy_users
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_log_has "up -d --force-recreate"
  sandbox_drop
}

test_a_late_allowed_emails_line_is_removed() {
  t_begin "an allowed-emails line below the managed block is counted and removed, so the managed value is the one Compose reads"
  sandbox_new
  install_machine
  printf 'MY_OWN_SETTING=keep-me\nOIDC_ALLOWED_EMAILS=%s,late@demo.invalid\n' "$OWNER" >>"$AMAN_HOME/instances/main/.env"
  run_install --dry-run
  assert_flat_contains "$OUT" "Remove late@demo.invalid from instance main"
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(printf '%s\n' "$OUT" | grep '^Removed ')" "Removed late@demo.invalid from instance main."
  assert_single_owner
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "MY_OWN_SETTING=keep-me"
  sandbox_drop
}

test_refresh_removes_extra_users() {
  t_begin "instance refresh, which is the doctor's fix, removes the extra users"
  sandbox_new
  install_machine
  make_legacy_users
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(removal_lines)" 1
  assert_single_owner
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(removal_lines)" 0
  sandbox_drop
}

test_leftover_hashes_without_emails() {
  t_begin "a password hash left without a record or an allowed email is removed with a line that names the user"
  sandbox_new
  install_machine
  printf '%s\n' '# >>> sign-in users added with install.sh instance add-user: one password hash each, kept by the installer' \
    "DEX_USER_PASSWORD_HASH_GHOST='\$2a\$10\$legacyghost'" '# <<< end of user hashes' >>"$AMAN_HOME/instances/main/dex.env"
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(removal_lines)" 1
  assert_eq "$(printf '%s\n' "$OUT" | grep '^Removed ')" "Removed ghost from instance main."
  assert_single_owner
  assert_contains "$(cat "$AMAN_HOME/state/install.log")" "removed ghost from instance main"
  sandbox_drop
}

test_a_hand_edited_allowlist_is_cut_back_to_the_owner() {
  t_begin "a pattern or a second email typed into the allowed emails is cut back to the owner"
  sandbox_new
  install_machine
  local tmp=$SB/edit
  awk -v owner="$OWNER" '/^OIDC_ALLOWED_EMAILS=/ { print "OIDC_ALLOWED_EMAILS=" owner ",*@example.invalid"; next } { print }' \
    "$AMAN_HOME/instances/main/.env" >"$tmp" && cat "$tmp" >"$AMAN_HOME/instances/main/.env"
  run_install instance refresh main
  assert_rc 0
  assert_flat_contains "$OUT" "Removed *@example.invalid from instance main"
  assert_single_owner
  sandbox_drop
}

test_owner_settings_and_other_instances_are_left_alone() {
  t_begin "the owner's own settings below the managed block and another instance are not touched"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email second@example.invalid
  clear_input
  printf 'MY_OWN_SETTING=keep-me\n' >>"$AMAN_HOME/instances/main/.env"
  make_legacy_users
  local second_env second_dex
  second_env=$(cat "$AMAN_HOME/instances/second/.env")
  second_dex=$(cat "$AMAN_HOME/instances/second/dex.env")
  run_install --yes
  assert_rc 0
  assert_single_owner
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "MY_OWN_SETTING=keep-me"
  assert_eq "$(cat "$AMAN_HOME/instances/second/.env")" "$second_env"
  assert_eq "$(cat "$AMAN_HOME/instances/second/dex.env")" "$second_dex"
  assert_eq "$(removal_lines)" 1
  sandbox_drop
}

test_user_commands_and_options_are_gone
test_a_new_instance_has_one_user
test_install_rerun_removes_extra_users
test_upgrade_removes_extra_users
test_upgrade_recreates_an_instance_that_lost_users
test_a_late_allowed_emails_line_is_removed
test_refresh_removes_extra_users
test_leftover_hashes_without_emails
test_a_hand_edited_allowlist_is_cut_back_to_the_owner
test_owner_settings_and_other_instances_are_left_alone
tests_finish
