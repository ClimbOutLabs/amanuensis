#!/usr/bin/env bash
# --demo and instance demo-seed: DEMO_MODE in the managed block, the seed run inside the app container, and its failures.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

OWNER=owner@example.invalid
TAVILY_KEY="tvly-sentinel-demo-key-4c8d2f"
NEW_TAVILY_KEY="tvly-sentinel-rotated-key-9e1b"

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
registry() { cat "$AMAN_HOME/state/instances/main.conf"; }
seed_runs() { cat "$SB_STATE/demo_runs" 2>/dev/null || true; }
seed_count() { seed_runs | grep -c . || true; }

# The calendar account as the connector's account agent saved it, in the named volume the stub models.
calendar_value() { sed -n "s/^$1=//p" "$STUB_STATE/calendar-account-aman-main" 2>/dev/null | head -n 1; }

# The email account as the connector's account agent saved it, in the named volume the stub models.
account_value() { sed -n "s/^$1=//p" "$STUB_STATE/mail-account-aman-main" 2>/dev/null | head -n 1; }

install_demo() {
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email "$OWNER" --demo "$@"
  clear_input
}

install_demo_with_tavily() {
  with_input "$SENTINEL_PASSWORD
$TAVILY_KEY
"
  run_install --yes --password-stdin --email "$OWNER" --demo --tavily-key-stdin "$@"
  clear_input
}

test_demo_install_with_a_tavily_key() {
  t_begin "install --demo --tavily-key-stdin puts SEARCH_PROVIDER and the key in the managed block and nowhere else"
  sandbox_new
  install_demo_with_tavily
  assert_rc 0
  assert_eq "$(env_value main SEARCH_PROVIDER)" tavily
  assert_eq "$(env_value main TAVILY_API_KEY)" "$TAVILY_KEY"
  local env managed found
  env=$(cat "$AMAN_HOME/instances/main/.env")
  managed=${env%%# <<< end of managed block*}
  assert_contains "$managed" "SEARCH_PROVIDER=tavily" "inside the managed block"
  assert_contains "$managed" "TAVILY_API_KEY=$TAVILY_KEY" "inside the managed block"
  found=$(grep -rIl -- "$TAVILY_KEY" "$AMAN_HOME" "$STUB_LOG" 2>/dev/null | sort | tr '\n' ' ' || true)
  assert_eq "$found" "$AMAN_HOME/instances/main/.env " "files holding the key"
  assert_not_contains "$OUT$ERR" "$TAVILY_KEY" "the key is never printed"
  assert_eq "$(env_value main DEMO_MODE)" true
  assert_eq "$(seed_count)" 1 "the seed still ran"
  assert_eq "$(log_count 'force-recreate')" 1 "one restart, for the search settings"
  assert_flat_contains "$OUT" "now searches the web with Tavily"
  sandbox_drop
}

test_demo_install_without_a_tavily_key_leaves_search_alone() {
  t_begin "install --demo without --tavily-key-stdin writes no search provider and no key"
  sandbox_new
  install_demo
  assert_rc 0
  assert_eq "$(env_value main SEARCH_PROVIDER)" ""
  assert_eq "$(env_value main TAVILY_API_KEY)" ""
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "TAVILY" "no Tavily line in the settings"
  assert_eq "$(log_count 'force-recreate')" 0 "no restart for search settings"
  sandbox_drop
}

test_demo_install_with_every_stdin_line() {
  t_begin "a demo install with all five stdin lines puts each one in its own place, the Tavily key last"
  sandbox_new
  install_python_stub
  with_input "$SENTINEL_PASSWORD
v1.sentinel-order-tf-key_3b7c
sentinel-order-cal-pw-58
sentinel-order-mail-pw-94
$TAVILY_KEY
"
  run_install --yes --password-stdin --token-factory-key-stdin \
    --calendar-provider fastmail --calendar-email owner@example.invalid --calendar-password-stdin \
    --email-provider gmail --email-address a@gmail.com --email-password-stdin \
    --email "$OWNER" --demo --tavily-key-stdin
  clear_input
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/hash_stdin")" "$SENTINEL_PASSWORD" "sign-in password"
  assert_eq "$(env_value main NEBIUS_API_KEY)" "v1.sentinel-order-tf-key_3b7c" "Token Factory key"
  assert_eq "$(calendar_value CALDAV_PASSWORD)" "sentinel-order-cal-pw-58" "calendar app password"
  assert_eq "$(account_value MCP_EMAIL_SERVER_PASSWORD)" "'sentinel-order-mail-pw-94'" "email app password"
  assert_eq "$(env_value main TAVILY_API_KEY)" "$TAVILY_KEY" "Tavily key"
  assert_eq "$(env_value main SEARCH_PROVIDER)" tavily
  assert_eq "$(env_value main DEMO_MODE)" true
  assert_eq "$(seed_count)" 1 "the seed ran"
  assert_tree_lacks "$AMAN_HOME" "$SENTINEL_PASSWORD"
  sandbox_drop
}

test_tavily_key_needs_demo() {
  t_begin "--tavily-key-stdin without --demo is a usage error"
  sandbox_new
  run_install --yes --tavily-key-stdin --email "$OWNER"
  assert_rc 2
  assert_flat_contains "$ERR" "--tavily-key-stdin goes with --demo"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_tavily_key_is_never_taken_from_argv() {
  t_begin "a Tavily key on the command line is refused without being printed"
  sandbox_new
  local form
  for form in "--tavily-key=$TAVILY_KEY" "--tavily-key"; do
    run_install --yes --demo --email "$OWNER" "$form" "$TAVILY_KEY"
    assert_rc 2
    assert_flat_contains "$ERR" "never taken from the command line"
    assert_not_contains "$ERR" "$TAVILY_KEY"
    assert_not_contains "$OUT" "$TAVILY_KEY"
  done
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_bad_tavily_keys_are_refused_without_echoing_them() {
  t_begin "a bad or empty Tavily key line is refused; the key is never quoted back"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
short key
"
  run_install --yes --password-stdin --email "$OWNER" --demo --tavily-key-stdin
  clear_input
  assert_rc 2
  assert_flat_contains "$ERR" "length or characters a key never has"
  assert_not_contains "$ERR" "short key"
  with_input "$SENTINEL_PASSWORD

"
  run_install --yes --password-stdin --email "$OWNER" --demo --tavily-key-stdin
  clear_input
  assert_rc 2
  assert_flat_contains "$ERR" "The Tavily key line of the input was empty. Put the key on its own line"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_tavily_key_in_the_callers_environment_is_ignored() {
  t_begin "AMAN_TAVILY_KEY and TAVILY_API_KEY in the caller's environment are not used"
  sandbox_new
  build_run_env
  with_input "$SENTINEL_PASSWORD
"
  set +e
  env -i "${RUN_ENV[@]}" AMAN_TAVILY_KEY="$TAVILY_KEY" TAVILY_API_KEY="$TAVILY_KEY" bash "$SB_INSTALLER/install.sh" --yes --password-stdin --email "$OWNER" --demo <"$INPUT_FILE" >"$SB/out" 2>"$SB/err"
  RC=$?
  set -e
  clear_input
  assert_rc 0
  assert_eq "$(env_value main DEMO_MODE)" true "the demo install ran"
  assert_eq "$(env_value main SEARCH_PROVIDER)" "" "no provider was written"
  assert_eq "$(env_value main TAVILY_API_KEY)" "" "no key was written"
  assert_tree_lacks "$AMAN_HOME" "$TAVILY_KEY"
  sandbox_drop
}

test_demo_on_an_existing_instance_with_a_tavily_key() {
  t_begin "install --demo --tavily-key-stdin on an existing instance sets the search, turns demo mode on and seeds"
  sandbox_new
  install_machine
  with_input "$TAVILY_KEY
"
  run_install --yes --demo --tavily-key-stdin
  clear_input
  assert_rc 0
  assert_eq "$(env_value main DEMO_MODE)" true
  assert_eq "$(env_value main SEARCH_PROVIDER)" tavily
  assert_eq "$(env_value main TAVILY_API_KEY)" "$TAVILY_KEY"
  assert_eq "$(seed_count)" 1
  assert_eq "$(log_count 'force-recreate')" 2 "one restart for the search settings, one for demo mode"
  sandbox_drop
}

test_a_tavily_key_on_a_rerun_replaces_the_old_one() {
  t_begin "a new Tavily key on a --demo re-run replaces the old one and restarts the app; the same key restarts nothing"
  sandbox_new
  install_demo_with_tavily
  assert_eq "$(log_count 'force-recreate')" 1
  with_input "$NEW_TAVILY_KEY
"
  run_install --yes --demo --tavily-key-stdin
  clear_input
  assert_rc 0
  assert_eq "$(env_value main TAVILY_API_KEY)" "$NEW_TAVILY_KEY"
  assert_tree_lacks "$AMAN_HOME" "$TAVILY_KEY"
  assert_not_contains "$OUT$ERR" "$NEW_TAVILY_KEY" "the new key is never printed"
  assert_eq "$(log_count 'force-recreate')" 2 "one more restart for the new key"
  assert_eq "$(seed_count)" 2 "a --demo re-run that changes something seeds again, as it does for any change"
  with_input "$NEW_TAVILY_KEY
"
  run_install --yes --demo --tavily-key-stdin
  clear_input
  assert_rc 0
  assert_eq "$(env_value main TAVILY_API_KEY)" "$NEW_TAVILY_KEY"
  assert_eq "$(log_count 'force-recreate')" 2 "the same key again restarts nothing"
  sandbox_drop
}

test_demo_dry_run_with_a_tavily_key_plans_it() {
  t_begin "install --demo --tavily-key-stdin --dry-run plans the Tavily step and writes nothing"
  sandbox_new
  with_input "$TAVILY_KEY
"
  run_install --dry-run --demo --tavily-key-stdin --email "$OWNER"
  clear_input
  assert_rc 0
  assert_flat_contains "$OUT" "Use Tavily for web search on instance main"
  assert_flat_contains "$OUT" "The key is saved only in the settings file of this instance."
  assert_not_contains "$OUT$ERR" "$TAVILY_KEY"
  assert_no_path "$AMAN_HOME/instances"
  sandbox_drop
}

test_demo_install_turns_demo_mode_on_and_seeds_the_owner() {
  t_begin "install --demo sets DEMO_MODE in the managed block and seeds the owner after the app is up"
  sandbox_new
  install_demo
  assert_rc 0
  assert_eq "$(env_value main DEMO_MODE)" true
  local env managed
  env=$(cat "$AMAN_HOME/instances/main/.env")
  managed=${env%%# <<< end of managed block*}
  assert_contains "$managed" "DEMO_MODE=true" "inside the managed block"
  assert_contains "$(registry)" "demo=1"
  assert_eq "$(seed_count)" 1 "one seed run"
  assert_contains "$(seed_runs)" "-T app aman demo-seed --user $OWNER"
  assert_contains "$(cat "$STUB_LOG")" "--project-name aman-main" "run through the instance project"
  assert_not_contains "$(seed_runs)" "--reset"
  assert_flat_contains "$OUT" "Demo on. Fill again:"
  assert_flat_contains "$OUT" "instance demo-seed --instance main"
  local up_line seed_line
  up_line=$(grep -n 'up -d --wait' "$STUB_LOG" | tail -n 1 | cut -d: -f1)
  seed_line=$(grep -n 'aman demo-seed' "$STUB_LOG" | head -n 1 | cut -d: -f1)
  if [ "$seed_line" -gt "$up_line" ]; then t_pass; else t_fail "the seed ran before the instance was up ($seed_line <= $up_line)"; fi
  assert_eq "$(log_count 'force-recreate')" 0 "a new demo instance needs no restart"
  sandbox_drop
}

test_install_without_demo_never_seeds() {
  t_begin "install without --demo leaves DEMO_MODE out and runs no seed"
  sandbox_new
  install_machine
  assert_eq "$(env_value main DEMO_MODE)" ""
  assert_contains "$(registry)" "demo=0"
  assert_eq "$(seed_count)" 0
  assert_not_contains "$OUT" "Demo:"
  sandbox_drop
}

test_demo_user_is_not_an_option() {
  t_begin "--demo-user is gone: the demo world is always the owner's"
  sandbox_new
  install_demo --demo-user judge@demo.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "unknown option --demo-user"
  assert_eq "$(seed_count)" 0
  install_demo
  assert_rc 0
  run_install instance demo-seed --demo-user judge@demo.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "unknown option --demo-user"
  assert_eq "$(seed_count)" 1 "only the install seeded"
  assert_not_contains "$(seed_runs)" "judge@demo.invalid"
  run_install --help
  assert_not_contains "$OUT" "--demo-user"
  sandbox_drop
}

test_demo_seed_command_reseeds_and_resets() {
  t_begin "instance demo-seed reseeds the owner, and --reset passes --reset"
  sandbox_new
  install_demo
  run_install instance demo-seed
  assert_rc 0
  assert_eq "$(seed_count)" 2
  run_install instance demo-seed --reset --instance main
  assert_rc 0
  assert_contains "$(seed_runs | tail -n 1)" "aman demo-seed --user $OWNER --reset"
  sandbox_drop
}

test_demo_seed_fresh_passes_through() {
  t_begin "instance demo-seed --fresh passes --fresh to the app, in plain words, and never combines with --reset"
  sandbox_new
  install_demo
  run_install instance demo-seed --fresh --instance main
  assert_rc 0
  assert_eq "$(seed_count)" 2
  assert_contains "$(seed_runs | tail -n 1)" "aman demo-seed --user $OWNER --fresh"
  assert_not_contains "$(seed_runs | tail -n 1)" "--reset"
  assert_flat_contains "$OUT" "Removing everything $OWNER made on instance main"
  run_install instance demo-seed --fresh --reset
  assert_rc 2
  assert_flat_contains "$ERR" "either --fresh or --reset"
  assert_eq "$(seed_count)" 2 "the refused run started nothing"
  run_install --help
  assert_flat_contains "$OUT" "--fresh"
  sandbox_drop
}

test_demo_seed_fresh_refuses_a_non_demo_instance() {
  t_begin "instance demo-seed --fresh on an instance without demo mode refuses in plain words and removes nothing"
  sandbox_new
  install_machine
  run_install instance demo-seed --fresh
  assert_rc 1
  assert_flat_contains "$ERR" "Start fresh only works on a demo instance"
  assert_flat_contains "$ERR" "Nothing was removed"
  assert_flat_contains "$ERR" "install.sh --demo --name main"
  assert_eq "$(seed_count)" 0
  sandbox_drop
}

test_demo_seed_fresh_can_run_twice() {
  t_begin "instance demo-seed --fresh twice in a row passes --fresh both times"
  sandbox_new
  install_demo
  run_install instance demo-seed --fresh
  assert_rc 0
  run_install instance demo-seed --fresh
  assert_rc 0
  assert_eq "$(seed_runs | grep -c -- '--fresh' || true)" 2
  sandbox_drop
}

test_demo_seed_refuses_a_non_demo_instance() {
  t_begin "instance demo-seed on an instance without demo mode points to install.sh --demo and runs nothing"
  sandbox_new
  install_machine
  run_install instance demo-seed
  assert_rc 1
  assert_flat_contains "$ERR" "not a demo instance"
  assert_flat_contains "$ERR" "install.sh --demo --name main"
  assert_eq "$(seed_count)" 0
  sandbox_drop
}

test_demo_seed_before_install_is_refused() {
  t_begin "instance demo-seed before install points to install.sh"
  sandbox_new
  run_install instance demo-seed
  assert_rc 1
  assert_flat_contains "$ERR" "not set up on this computer yet"
  sandbox_drop
}

test_demo_seed_needs_a_running_instance() {
  t_begin "instance demo-seed on a stopped instance says so and fails"
  sandbox_new
  install_demo
  rm -f "$SB_STATE/up/aman-main"
  run_install instance demo-seed
  assert_rc 1
  assert_flat_contains "$ERR" "is not running"
  assert_eq "$(seed_count)" 1 "only the install seed"
  sandbox_drop
}

test_demo_on_an_existing_instance() {
  t_begin "install --demo on an existing instance turns demo mode on, restarts the app once and seeds"
  sandbox_new
  install_machine
  run_install --yes --demo
  assert_rc 0
  assert_eq "$(env_value main DEMO_MODE)" true
  assert_contains "$(registry)" "demo=1"
  assert_eq "$(log_count 'up -d --force-recreate --no-deps --wait --wait-timeout 240 app')" 1
  assert_eq "$(seed_count)" 1
  assert_contains "$(seed_runs)" "--user $OWNER"
  run_install --yes --demo
  assert_rc 0
  assert_contains "$OUT" "Nothing to do"
  assert_eq "$(seed_count)" 1 "a second run does not reseed; instance demo-seed does"
  sandbox_drop
}

test_demo_keeps_owner_settings_below_the_block() {
  t_begin "turning demo mode on keeps the owner's own lines below the managed block"
  sandbox_new
  install_machine
  printf 'MY_SETTING=kept\n' >>"$AMAN_HOME/instances/main/.env"
  run_install --yes --demo
  assert_rc 0
  assert_eq "$(env_value main MY_SETTING)" kept
  assert_eq "$(env_value main DEMO_MODE)" true
  sandbox_drop
}

test_seed_failure_fails_the_run_and_names_the_command() {
  t_begin "a failed seed leaves the instance installed, exits 1 and names the one command to retry"
  sandbox_new
  export STUB_DEMO_FAIL=1
  install_demo
  unset STUB_DEMO_FAIL
  assert_rc 1
  assert_flat_contains "$ERR" "Adding the example data failed"
  assert_flat_contains "$ERR" "instance demo-seed --instance main"
  assert_contains "$OUT" "Instance main"
  assert_eq "$(env_value main DEMO_MODE)" true
  run_install instance demo-seed
  assert_rc 0
  sandbox_drop
}

test_demo_dry_run_changes_nothing() {
  t_begin "install --demo --dry-run lists the demo step and writes nothing"
  sandbox_new
  run_install --dry-run --demo --email "$OWNER"
  assert_rc 0
  assert_flat_contains "$OUT" "Turn demo mode on for instance main and fill it with example data for $OWNER"
  assert_no_path "$AMAN_HOME/instances"
  assert_eq "$(seed_count)" 0
  sandbox_drop
}

test_instance_add_demo() {
  t_begin "instance add --demo makes a second demo instance and seeds its owner"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email second@example.invalid --demo
  clear_input
  assert_rc 0
  assert_eq "$(env_value second DEMO_MODE)" true
  assert_eq "$(env_value main DEMO_MODE)" "" "the first instance is untouched"
  assert_contains "$(grep "aman demo-seed" "$STUB_LOG")" "--project-name aman-second"
  assert_contains "$(seed_runs)" "--user second@example.invalid"
  sandbox_drop
}

test_option_validation() {
  t_begin "demo options are refused where they do not apply"
  sandbox_new
  install_machine
  run_install --reset
  assert_rc 2
  assert_flat_contains "$ERR" "--reset applies to instance demo-seed"
  run_install backup --demo
  assert_rc 2
  assert_flat_contains "$ERR" "--demo applies to install and instance add"
  run_install instance demo-seed --demo
  assert_rc 2
  run_install --fresh
  assert_rc 2
  assert_flat_contains "$ERR" "--fresh applies to instance demo-seed"
  run_install instance demo-seed extra
  assert_rc 2
  assert_eq "$(seed_count)" 0
  sandbox_drop
}

test_several_instances_need_a_choice() {
  t_begin "instance demo-seed with several instances asks for --instance"
  sandbox_new
  install_demo
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email second@example.invalid
  clear_input
  run_install instance demo-seed
  assert_rc 2
  assert_flat_contains "$ERR" "--instance"
  run_install instance demo-seed --instance main
  assert_rc 0
  sandbox_drop
}

test_demo_install_summary_survives_a_rerun() {
  t_begin "a demo instance shows its demo line in the summary on a plain re-run"
  sandbox_new
  install_demo
  rm -f "$SB_STATE/up/aman-main"
  run_install --yes
  assert_rc 0
  assert_flat_contains "$OUT" "Demo on. Fill again:"
  assert_eq "$(seed_count)" 1 "a plain re-run does not seed"
  sandbox_drop
}

test_demo_install_turns_demo_mode_on_and_seeds_the_owner
test_install_without_demo_never_seeds
test_demo_user_is_not_an_option
test_demo_seed_command_reseeds_and_resets
test_demo_seed_fresh_passes_through
test_demo_seed_fresh_refuses_a_non_demo_instance
test_demo_seed_fresh_can_run_twice
test_demo_seed_refuses_a_non_demo_instance
test_demo_seed_before_install_is_refused
test_demo_seed_needs_a_running_instance
test_demo_on_an_existing_instance
test_demo_keeps_owner_settings_below_the_block
test_seed_failure_fails_the_run_and_names_the_command
test_demo_dry_run_changes_nothing
test_instance_add_demo
test_option_validation
test_several_instances_need_a_choice
test_demo_install_summary_survives_a_rerun
test_demo_install_with_a_tavily_key
test_demo_install_without_a_tavily_key_leaves_search_alone
test_demo_install_with_every_stdin_line
test_tavily_key_needs_demo
test_tavily_key_is_never_taken_from_argv
test_bad_tavily_keys_are_refused_without_echoing_them
test_tavily_key_in_the_callers_environment_is_ignored
test_demo_on_an_existing_instance_with_a_tavily_key
test_a_tavily_key_on_a_rerun_replaces_the_old_one
test_demo_dry_run_with_a_tavily_key_plans_it
tests_finish
