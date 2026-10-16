#!/usr/bin/env bash
# --demo and instance demo-seed: DEMO_MODE in the managed block, the seed run inside the app container, and its failures.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

OWNER=owner@example.invalid

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
registry() { cat "$AMAN_HOME/state/instances/main.conf"; }
seed_runs() { cat "$SB_STATE/demo_runs" 2>/dev/null || true; }
seed_count() { seed_runs | grep -c . || true; }

install_demo() {
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email "$OWNER" --demo "$@"
  clear_input
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
  assert_flat_contains "$OUT" "Demo on. Reseed:"
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

test_demo_user_overrides_the_owner() {
  t_begin "--demo-user seeds that email instead of the owner"
  sandbox_new
  install_demo --demo-user judge@demo.invalid
  assert_rc 0
  assert_contains "$(seed_runs)" "--user judge@demo.invalid"
  assert_not_contains "$(seed_runs)" "--user $OWNER"
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
  run_install instance demo-seed --demo-user judge@demo.invalid
  assert_rc 0
  assert_contains "$(seed_runs | tail -n 1)" "--user judge@demo.invalid"
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
  assert_flat_contains "$ERR" "not set up yet"
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
  assert_flat_contains "$ERR" "demo seed failed"
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
  assert_flat_contains "$OUT" "Turn demo mode on for instance main and seed the synthetic demo world for $OWNER"
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
  run_install --demo --demo-user not-an-email
  assert_rc 2
  assert_flat_contains "$ERR" "--demo-user must be an email address"
  run_install --demo-user judge@demo.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "--demo-user applies with --demo"
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
  assert_flat_contains "$OUT" "Demo on. Reseed:"
  assert_eq "$(seed_count)" 1 "a plain re-run does not seed"
  sandbox_drop
}

test_demo_install_turns_demo_mode_on_and_seeds_the_owner
test_install_without_demo_never_seeds
test_demo_user_overrides_the_owner
test_demo_seed_command_reseeds_and_resets
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
tests_finish
