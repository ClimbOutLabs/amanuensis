#!/usr/bin/env bash
# instance add-user, remove-user and list-users: Dex users, the app's allowed emails, passwords and re-render safety.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

OWNER=owner@example.invalid

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
dex_yaml() { cat "$AMAN_HOME/instances/main/dex.yaml"; }
dex_env() { cat "$AMAN_HOME/instances/main/dex.env"; }
registry() { cat "$AMAN_HOME/state/instances/main.conf"; }
restarts() { log_count "up -d --force-recreate --no-deps --wait --wait-timeout 240 dex app"; }

# add_user NAME EMAIL [args...]: generated password.
add_user() {
  local name=$1 email=$2
  shift 2
  run_install instance add-user "$name" --email "$email" "$@"
}

# add_user_stdin NAME EMAIL PASSWORD [args...]
add_user_stdin() {
  local name=$1 email=$2 password=$3
  shift 3
  with_input "$password
"
  run_install instance add-user "$name" --email "$email" --password-stdin "$@"
  clear_input
}

generated_password() { printf '%s\n' "$OUT" | sed -n 's/^  Password:  //p' | head -n 1; }

test_add_user_generates_a_password_and_wires_dex_and_the_app() {
  t_begin "add-user writes the Dex user, its hash and the allowlist, and shows a generated password once"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  assert_rc 0
  local password
  password=$(generated_password)
  assert_eq "${#password}" 27 "a generated password of four groups"
  assert_eq "$(printf '%s' "$OUT" | grep -Fc -- "$password")" 1 "printed exactly once"
  assert_contains "$OUT" "judge1@demo.invalid"
  assert_contains "$(dex_yaml)" "  - email: 'judge1@demo.invalid'"
  assert_contains "$(dex_yaml)" "hashFromEnv: DEX_USER_PASSWORD_HASH_JUDGE1"
  assert_contains "$(dex_yaml)" "username: 'judge1'"
  assert_contains "$(dex_yaml)" "hashFromEnv: DEX_USER_PASSWORD_HASH"
  assert_contains "$(dex_env)" "DEX_USER_PASSWORD_HASH_JUDGE1='\$2a\$10\$"
  assert_contains "$(dex_env)" "DEX_USER_PASSWORD_HASH='\$2a\$10\$" "the owner hash stays"
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER,judge1@demo.invalid"
  assert_eq "$(env_value main OIDC_ADMIN_ROLE_VALUE)" "$OWNER" "only the owner is admin"
  assert_eq "$(env_value main OIDC_USER_ROLE_CLAIM)" email
  assert_contains "$(registry)" "user_judge1=member:judge1@demo.invalid"
  assert_mode "$AMAN_HOME/instances/main/dex.env" 600
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  assert_mode "$AMAN_HOME/state/instances/main.conf" 600
  assert_eq "$(restarts)" 1 "the login service and the app restart once"
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$password" "the password reached the hashing step on stdin"
  sandbox_drop
}

test_generated_password_is_kept_nowhere() {
  t_begin "a generated password is in no file, argv, child environment or log, and the registry holds no hash"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  local password hash
  password=$(generated_password)
  assert_tree_lacks "$AMAN_HOME" "$password"
  assert_not_contains "$(cat "$STUB_LOG")" "$password" "docker argv log"
  assert_not_contains "$(cat "$SB_STATE/hash_env")" "$password" "child environment"
  assert_not_contains "$ERR" "$password" "stderr"
  hash=$(sed -n "s/^DEX_USER_PASSWORD_HASH_JUDGE1='\(.*\)'$/\1/p" "$AMAN_HOME/instances/main/dex.env")
  assert_not_contains "$(registry)" "$hash" "registry"
  assert_not_contains "$(dex_yaml)" "$hash" "dex.yaml"
  assert_not_contains "$(cat "$AMAN_HOME/state/install.log")" "$password" "install log"
  assert_not_contains "$(cat "$AMAN_HOME/state/install.log")" "$hash" "install log"
  assert_not_contains "$(env_value main OIDC_ALLOWED_EMAILS)" "$hash" ".env"
  sandbox_drop
}

test_password_from_stdin_is_used_and_never_echoed() {
  t_begin "--password-stdin hashes the given password and prints nothing secret"
  sandbox_new
  install_machine
  add_user_stdin judge2 judge2@demo.invalid "typed-pw-81c4d0aa"
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "typed-pw-81c4d0aa"
  assert_not_contains "$OUT$ERR" "typed-pw-81c4d0aa"
  assert_tree_lacks "$AMAN_HOME" "typed-pw-81c4d0aa"
  assert_not_contains "$(cat "$STUB_LOG")" "typed-pw-81c4d0aa"
  assert_contains "$OUT" "read from stdin"
  sandbox_drop
}

test_short_stdin_password_is_refused_before_any_change() {
  t_begin "a too-short stdin password changes nothing"
  sandbox_new
  install_machine
  local env_before
  env_before=$(cat "$AMAN_HOME/instances/main/.env")
  add_user_stdin judge1 judge1@demo.invalid "short"
  assert_rc 2
  assert_contains "$ERR" "at least 8 characters"
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$env_before"
  assert_not_contains "$(registry)" "user_judge1"
  assert_not_contains "$(dex_env)" "JUDGE1"
  sandbox_drop
}

test_two_users_get_their_own_hash_and_entry() {
  t_begin "two users have distinct hash variables and both are in the allowlist"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  add_user judge-two judge2@demo.invalid
  assert_rc 0
  local h1 h2
  h1=$(sed -n "s/^DEX_USER_PASSWORD_HASH_JUDGE1=//p" "$AMAN_HOME/instances/main/dex.env")
  h2=$(sed -n "s/^DEX_USER_PASSWORD_HASH_JUDGE_TWO=//p" "$AMAN_HOME/instances/main/dex.env")
  if [ -n "$h1" ] && [ -n "$h2" ] && [ "$h1" != "$h2" ]; then t_pass; else t_fail "hashes [$h1] [$h2]"; fi
  assert_contains "$(dex_yaml)" "hashFromEnv: DEX_USER_PASSWORD_HASH_JUDGE_TWO"
  assert_contains "$(dex_yaml)" "userID: 'judge-two'"
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER,judge2@demo.invalid,judge1@demo.invalid" "members in name order"
  sandbox_drop
}

test_add_user_is_idempotent() {
  t_begin "adding the same user again changes nothing, keeps the password and restarts nothing"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  local dex_env_before yaml_before env_before reg_before hashes restarted
  dex_env_before=$(dex_env)
  yaml_before=$(dex_yaml)
  env_before=$(cat "$AMAN_HOME/instances/main/.env")
  reg_before=$(registry)
  hashes=$(log_count 'aman hash-password')
  restarted=$(restarts)
  add_user judge1 judge1@demo.invalid
  assert_rc 0
  assert_contains "$OUT" "already exists"
  assert_not_contains "$OUT" "Password:"
  assert_eq "$(dex_env)" "$dex_env_before"
  assert_eq "$(dex_yaml)" "$yaml_before"
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$env_before"
  assert_eq "$(registry)" "$reg_before"
  assert_eq "$(log_count 'aman hash-password')" "$hashes" "no second hash"
  assert_eq "$(restarts)" "$restarted" "no second restart"
  sandbox_drop
}

test_conflicting_adds_are_refused() {
  t_begin "a taken name with another email, and an email already in use in any case, are refused"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  add_user judge1 other@demo.invalid
  assert_rc 1
  assert_contains "$ERR" "different email"
  add_user judge3 Judge1@Demo.Invalid
  assert_rc 1
  assert_contains "$ERR" "already signs in as judge1"
  add_user judge3 OWNER@example.invalid
  assert_rc 1
  assert_contains "$ERR" "already signs in as owner"
  assert_not_contains "$(registry)" "judge3"
  sandbox_drop
}

test_input_validation() {
  t_begin "bad names, emails and roles are refused without touching the instance"
  sandbox_new
  install_machine
  local env_before
  env_before=$(cat "$AMAN_HOME/instances/main/.env")
  add_user owner x@demo.invalid
  assert_rc 2
  add_user Judge1 x@demo.invalid
  assert_rc 2
  add_user judge1 '*@demo.invalid'
  assert_rc 2
  add_user judge1 'a@demo.invalid,b@demo.invalid'
  assert_rc 2
  add_user judge1 not-an-email
  assert_rc 2
  add_user judge1 x@demo.invalid --role admin
  assert_rc 2
  assert_contains "$ERR" "only admin"
  add_user judge1 x@demo.invalid --role viewer
  assert_rc 2
  run_install instance add-user judge1
  assert_rc 2
  assert_contains "$ERR" "usage"
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$env_before"
  assert_not_contains "$(registry)" "user_"
  assert_eq "$(log_count 'aman hash-password')" 1 "only the owner was ever hashed"
  sandbox_drop
}

test_the_member_role_is_accepted_explicitly() {
  t_begin "--role member is the default and can be passed"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid --role member
  assert_rc 0
  assert_contains "$(registry)" "user_judge1=member:"
  sandbox_drop
}

test_rerender_keeps_users() {
  t_begin "a re-install, an instance add of the same name and an upgrade keep every user and hash"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  add_user judge2 judge2@demo.invalid
  local yaml_before dex_env_before allowed
  yaml_before=$(dex_yaml)
  dex_env_before=$(dex_env)
  allowed=$(env_value main OIDC_ALLOWED_EMAILS)
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_eq "$(dex_yaml)" "$yaml_before" "dex.yaml after a re-install"
  assert_eq "$(dex_env)" "$dex_env_before" "dex.env after a re-install"
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$allowed"
  run_install instance add main
  assert_rc 0
  assert_eq "$(dex_yaml)" "$yaml_before" "dex.yaml after instance add main"
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_eq "$(dex_yaml)" "$yaml_before" "dex.yaml after an upgrade"
  assert_eq "$(dex_env)" "$dex_env_before" "dex.env after an upgrade"
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$allowed"
  assert_contains "$(registry)" "user_judge2=member:judge2@demo.invalid"
  sandbox_drop
}

test_a_stale_dex_yaml_is_rebuilt_from_the_registry() {
  t_begin "a dex.yaml that lost the users is rebuilt from the registry and dex.env on the next render"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  local yaml_before
  yaml_before=$(dex_yaml)
  sed -i.bak '/judge1/,+3d' "$AMAN_HOME/instances/main/dex.yaml"
  rm -f "$AMAN_HOME/instances/main/dex.yaml.bak"
  assert_not_contains "$(dex_yaml)" "judge1"
  run_install instance add main
  assert_rc 0
  assert_eq "$(dex_yaml)" "$yaml_before"
  sandbox_drop
}

test_a_user_without_a_hash_does_not_break_the_login() {
  t_begin "a registry user whose hash is gone is left out of dex.yaml with a warning"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  add_user judge2 judge2@demo.invalid
  sed -i.bak '/^DEX_USER_PASSWORD_HASH_JUDGE1=/d' "$AMAN_HOME/instances/main/dex.env"
  rm -f "$AMAN_HOME/instances/main/dex.env.bak"
  run_install instance add main
  assert_rc 0
  assert_contains "$ERR" "user judge1"
  assert_not_contains "$(dex_yaml)" "JUDGE1"
  assert_contains "$(dex_yaml)" "JUDGE2"
  sandbox_drop
}

test_owner_settings_below_the_managed_block_survive() {
  t_begin "add-user and remove-user leave the owner's own .env lines alone"
  sandbox_new
  install_machine
  printf 'MY_OWN_SETTING=keep-me\nLOG_LEVEL=debug\n' >>"$AMAN_HOME/instances/main/.env"
  add_user judge1 judge1@demo.invalid
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "MY_OWN_SETTING=keep-me"
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "LOG_LEVEL=debug"
  assert_eq "$(grep -c '^OIDC_ALLOWED_EMAILS=' "$AMAN_HOME/instances/main/.env")" 1 "one allowlist line"
  run_install instance remove-user judge1
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "MY_OWN_SETTING=keep-me"
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER"
  sandbox_drop
}

test_dex_env_from_before_users_existed() {
  t_begin "a dex.env without the user block gets one, and the owner hash is untouched"
  sandbox_new
  install_machine
  local owner_line begin_fresh
  owner_line=$(grep '^DEX_USER_PASSWORD_HASH=' "$AMAN_HOME/instances/main/dex.env")
  begin_fresh=$(grep '^# >>> sign-in users' "$AMAN_HOME/instances/main/dex.env")
  printf '# >>> managed by the installer: written once, read only by the login container\n%s\n# <<< end of managed block\n' "$owner_line" >"$AMAN_HOME/instances/main/dex.env"
  add_user judge1 judge1@demo.invalid
  assert_rc 0
  assert_contains "$(dex_env)" "$owner_line"
  assert_contains "$(dex_env)" "DEX_USER_PASSWORD_HASH_JUDGE1="
  assert_eq "$(grep -c 'end of user hashes' "$AMAN_HOME/instances/main/dex.env")" 1
  assert_eq "$(grep '^# >>> sign-in users' "$AMAN_HOME/instances/main/dex.env")" "$begin_fresh" "same header as a fresh install"
  add_user judge2 judge2@demo.invalid
  assert_eq "$(grep -c 'end of user hashes' "$AMAN_HOME/instances/main/dex.env")" 1 "the block is not added twice"
  assert_eq "$(grep -c '^DEX_USER_PASSWORD_HASH_JUDGE' "$AMAN_HOME/instances/main/dex.env")" 2
  sandbox_drop
}

test_remove_user() {
  t_begin "remove-user drops the user from Dex, the hash env, the registry and the allowlist, keeping the others"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  add_user judge2 judge2@demo.invalid
  local restarted
  restarted=$(restarts)
  run_install instance remove-user judge1
  assert_rc 0
  assert_not_contains "$(dex_yaml)" "judge1"
  assert_not_contains "$(dex_env)" "JUDGE1"
  assert_not_contains "$(registry)" "judge1"
  assert_contains "$(dex_yaml)" "judge2@demo.invalid"
  assert_contains "$(dex_env)" "DEX_USER_PASSWORD_HASH_JUDGE2="
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER,judge2@demo.invalid"
  assert_eq "$(restarts)" "$((restarted + 1))" "the app restarts so the allowlist applies at once"
  assert_contains "$(dex_yaml)" "hashFromEnv: DEX_USER_PASSWORD_HASH" "the owner stays"
  run_install instance remove-user judge2
  assert_rc 0
  assert_not_contains "$(dex_yaml)" "staticPasswords: []"
  assert_not_contains "$(dex_yaml)" "judge"
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER"
  sandbox_drop
}

test_remove_user_edge_cases() {
  t_begin "removing an unknown user is a no-op; the owner cannot be removed"
  sandbox_new
  install_machine
  local restarted
  restarted=$(restarts)
  run_install instance remove-user nobody
  assert_rc 0
  assert_contains "$OUT" "does not exist"
  assert_eq "$(restarts)" "$restarted"
  run_install instance remove-user owner
  assert_rc 2
  run_install instance remove-user
  assert_rc 2
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER"
  sandbox_drop
}

test_removed_user_can_be_added_again_with_a_new_password() {
  t_begin "remove-user then add-user gives a fresh password and hash"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  local first second
  first=$(generated_password)
  run_install instance remove-user judge1
  add_user judge1 judge1@demo.invalid
  second=$(generated_password)
  if [ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ]; then t_pass; else t_fail "passwords [$first] [$second]"; fi
  assert_eq "$(grep -c '^DEX_USER_PASSWORD_HASH_JUDGE1=' "$AMAN_HOME/instances/main/dex.env")" 1
  sandbox_drop
}

test_list_users() {
  t_begin "list-users shows names, emails and roles and never a hash"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  add_user judge2 judge2@demo.invalid
  run_install instance list-users
  assert_rc 0
  assert_contains "$OUT" "NAME"
  assert_contains "$OUT" "ROLE"
  assert_contains "$OUT" "owner   owner@example.invalid  admin"
  assert_contains "$OUT" "judge1  judge1@demo.invalid    member"
  assert_contains "$OUT" "judge2  judge2@demo.invalid    member"
  assert_not_contains "$OUT$ERR" "\$2a"
  assert_not_contains "$OUT$ERR" "HASH"
  sandbox_drop
}

test_list_users_needs_no_docker() {
  t_begin "list-users reads only the registry"
  sandbox_new
  install_machine
  add_user judge1 judge1@demo.invalid
  : >"$STUB_LOG"
  run_install instance list-users
  assert_rc 0
  assert_eq "$(cat "$STUB_LOG")" "" "no docker call"
  sandbox_drop
}

test_stopped_instance_is_not_started_by_a_user_change() {
  t_begin "a stopped instance gets the change on its next start, not a restart now"
  sandbox_new
  install_machine
  rm -f "$SB_STATE/up/aman-main"
  add_user judge1 judge1@demo.invalid
  assert_rc 0
  assert_contains "$OUT" "stopped; the change applies when it starts"
  assert_eq "$(restarts)" 0
  assert_contains "$(dex_yaml)" "judge1@demo.invalid"
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER,judge1@demo.invalid"
  sandbox_drop
}

test_several_instances_need_a_choice() {
  t_begin "with several instances --instance picks one and the others are untouched"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email second@example.invalid
  clear_input
  add_user judge1 judge1@demo.invalid
  assert_rc 2
  assert_contains "$ERR" "--instance"
  add_user judge1 judge1@demo.invalid --instance second
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/state/instances/second.conf")" "user_judge1="
  assert_not_contains "$(registry)" "user_judge1"
  assert_eq "$(env_value main OIDC_ALLOWED_EMAILS)" "$OWNER"
  assert_eq "$(env_value second OIDC_ALLOWED_EMAILS)" "second@example.invalid,judge1@demo.invalid"
  add_user judge1 judge1@demo.invalid --instance nope
  assert_rc 1
  sandbox_drop
}

test_user_commands_before_install_are_refused() {
  t_begin "add-user on an uninstalled machine says to install first"
  sandbox_new
  add_user judge1 judge1@demo.invalid
  assert_rc 1
  assert_contains "$ERR" "not set up yet"
  sandbox_drop
}

test_add_user_generates_a_password_and_wires_dex_and_the_app
test_generated_password_is_kept_nowhere
test_password_from_stdin_is_used_and_never_echoed
test_short_stdin_password_is_refused_before_any_change
test_two_users_get_their_own_hash_and_entry
test_add_user_is_idempotent
test_conflicting_adds_are_refused
test_input_validation
test_the_member_role_is_accepted_explicitly
test_rerender_keeps_users
test_a_stale_dex_yaml_is_rebuilt_from_the_registry
test_a_user_without_a_hash_does_not_break_the_login
test_owner_settings_below_the_managed_block_survive
test_dex_env_from_before_users_existed
test_remove_user
test_remove_user_edge_cases
test_removed_user_can_be_added_again_with_a_new_password
test_list_users
test_list_users_needs_no_docker
test_stopped_instance_is_not_started_by_a_user_change
test_several_instances_need_a_choice
test_user_commands_before_install_are_refused
tests_finish
