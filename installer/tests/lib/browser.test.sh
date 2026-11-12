#!/usr/bin/env bash
# Aman's own browser: on in every instance, with a secret of its own and a walled-off network.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

compose_file() { printf '%s' "$AMAN_HOME/instances/main/compose.yaml"; }
# The list entries under one service's networks key, as one line.
service_networks() { # service
  awk -v svc="  $1:" '$0==svc{f=1;next} /^  [a-z]/{f=0} f && /^    networks:/{n=1;next} f && n && /^      [a-z-]+:?/{sub(/^      (- )?/,"");sub(/:.*/,"");print;next} f && n && /^    [a-z]/{n=0}' "$(compose_file)" | tr '\n' ' '
}
browser_secret() { sed -n 's/^BROWSER_SECRET=//p' "$AMAN_HOME/instances/main/.env"; }

test_a_new_instance_has_the_browser_on() {
  t_begin "a new instance builds the browser and starts it with the app turned on to use it"
  sandbox_new
  install_machine
  assert_log_has "docker build -t aman-browser:"
  assert_log_has "docker build -f $REPO/ops/browser-sidecar/Dockerfile.gateway -t aman-browser-gateway:"
  assert_contains "$(cat "$(compose_file)")" "BROWSER_ENABLED: 'true'"
  assert_contains "$(cat "$(compose_file)")" "BROWSER_URL: http://browser-relay:8792"
  assert_contains "$(cat "$(compose_file)")" "image: aman-browser:"
  assert_contains "$(cat "$(compose_file)")" "image: aman-browser-gateway:"
  assert_not_contains "$(cat "$(compose_file)")" "profiles: [" "nothing waits for a Compose profile"
  assert_contains "$(cat "$AMAN_HOME/release/release.json")" '"browser_image": "aman-browser:'
  assert_contains "$(cat "$AMAN_HOME/release/release.json")" '"browser_gateway_image": "aman-browser-gateway:'
  sandbox_drop
}

test_the_secret_is_made_once_and_kept_out_of_the_compose_file() {
  t_begin "the app and the gateway share one secret through the settings file, made once"
  sandbox_new
  install_machine
  local first
  first=$(browser_secret)
  assert_eq "${#first}" 64 "a random secret of 64 characters is made"
  assert_not_contains "$(cat "$(compose_file)")" "$first" "the compose file never holds the secret"
  assert_contains "$(cat "$(compose_file)")" "BROWSER_SECRET: \${BROWSER_SECRET:?missing from .env}"
  assert_eq "$(awk '/^  browser:/{f=1;next} /^  [a-z]/{f=0} f' "$(compose_file)" | grep -c BROWSER_SECRET || true)" 0 "the browser itself never gets it"
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(browser_secret)" "$first" "a later run never changes the secret"
  assert_mode "$AMAN_HOME/instances/main/.env" 600
  sandbox_drop
}

test_the_browser_is_walled_off() {
  t_begin "the browser shares a network only with its gateway, and the app reaches only the gateway"
  sandbox_new
  install_machine
  assert_eq "$(service_networks browser)" "browser-internal " "the browser joins only its internal network"
  assert_eq "$(service_networks browser-gateway)" "browser-internal browser-control browser-egress " "the gateway"
  assert_contains "$(service_networks loopback)" "browser-control" "the app's network holder reaches the gateway's relay"
  assert_not_contains "$(service_networks loopback)" "browser-internal" "but not the browser"
  assert_contains "$(awk '/^  browser-internal:/{f=1;next} /^  [a-z]/{f=0} f' "$(compose_file)")" "internal: true"
  assert_contains "$(awk '/^  browser-control:/{f=1;next} /^  [a-z]/{f=0} f' "$(compose_file)")" "internal: true"
  assert_contains "$(cat "$(compose_file)")" "seccomp=./browser-seccomp.json"
  assert_eq "$(cat "$AMAN_HOME/instances/main/browser-seccomp.json")" "$(cat "$REPO/ops/browser-sidecar/seccomp_profile.json")" "the sandbox profile sits beside the compose file"
  assert_contains "$(cat "$(compose_file)")" "name: aman_main_browser_profiles"
  sandbox_drop
}

test_removing_an_instance_says_the_browser_sign_ins_are_kept_and_purging_deletes_them() {
  t_begin "removing an instance names every volume it keeps, the browser's sign-ins too, and purging deletes them"
  sandbox_new
  install_machine
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_main_browser_profiles"
  run_install instance remove main
  assert_rc 0
  assert_flat_contains "$OUT" "aman_main_browser_profiles"
  assert_flat_contains "$OUT" "aman_main_data"
  assert_flat_contains "$OUT" "That includes the sites Aman's browser is signed in to."
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_main_browser_profiles" "a plain removal keeps them"
  run_install instance remove main --purge-data --confirm-name main
  assert_rc 0
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_main_browser_profiles"
  assert_contains "$(cat "$SB_STATE/volumes_removed")" "aman_main_browser_profiles"
  sandbox_drop
}

test_a_short_secret_below_the_managed_part_is_dropped() {
  t_begin "a short browser secret someone added below the managed part is dropped, so the app can start"
  sandbox_new
  install_machine
  local env=$AMAN_HOME/instances/main/.env first
  first=$(browser_secret)
  printf 'BROWSER_SECRET=short\n' >>"$env"
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(grep -c '^BROWSER_SECRET=' "$env")" 1 "one line is left"
  assert_eq "$(browser_secret)" "$first" "the managed value is kept"
  assert_mode "$env" 600
  sandbox_drop
}

# The subnet of one network in the instance's compose file.
network_subnet() { # network
  awk -v net="  $1:" '$0==net{f=1;next} /^  [a-z]/{f=0} f && /subnet:/{print $NF}' "$(compose_file)"
}

test_the_instance_networks_take_small_free_blocks() {
  t_begin "the instance's networks take small blocks clear of Docker's networks and this computer's routes"
  sandbox_new
  mkdir -p "$SB_STATE"
  printf 'bridge 172.17.0.0/16\nother_net 172.16.0.0/28\n' >"$SB_STATE/network_subnets"
  cp "$TESTS_DIR/stubs/ip" "$SB_BIN/ip"
  STUB_ROUTES="172.16.0.16/28 10.0.0.0/8 0.0.0.0/1"
  install_machine
  STUB_ROUTES=
  assert_eq "$(network_subnet default)" 172.16.0.32/27 "past a Docker network and a route, on a block of its own size"
  assert_eq "$(network_subnet link)" 172.16.0.64/28
  assert_eq "$(network_subnet calendar)" 172.16.0.80/28
  assert_eq "$(network_subnet browser-internal)" 172.16.0.96/28
  assert_eq "$(network_subnet browser-control)" 172.16.0.112/28
  assert_eq "$(network_subnet browser-egress)" 172.16.0.128/28
  printf 'aman-main_default 172.18.0.0/16\naman-main_browser-internal 172.20.0.0/16\n' >>"$SB_STATE/network_subnets"
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(network_subnet default)" 172.18.0.0/16 "a network that exists keeps its addresses"
  assert_eq "$(network_subnet browser-internal)" 172.20.0.0/16
  sandbox_drop
}

test_a_mac_reads_its_routes_from_netstat() {
  t_begin "on a computer with no ip command, the instance's networks still skip this computer's routes, read from netstat"
  sandbox_new
  cp "$TESTS_DIR/stubs/netstat" "$SB_BIN/netstat"
  STUB_NETSTAT_ROUTES="172.16.0/27 172.16.0.40 127 0/1"
  install_machine
  STUB_NETSTAT_ROUTES=
  assert_eq "$(network_subnet default)" 172.16.0.64/27 "past a short-form block and a single address"
  assert_eq "$(network_subnet link)" 172.16.0.48/28 "a smaller block also skips the single address"
  sandbox_drop
}

test_the_plan_has_one_row_for_the_browser() {
  t_begin "the plan shows the browser as one build step, and as done once both images are built"
  sandbox_new
  run_install --dry-run --email owner@example.invalid
  assert_eq "$(printf '%s\n' "$OUT" | grep -c "Build Aman's browser" || true)" 1 "one row to build it"
  assert_eq "$(printf '%s\n' "$OUT" | grep -c "gateway" || true)" 0 "no row of its own for the gateway"
  install_machine
  run_install --dry-run
  assert_flat_contains "$OUT" "done Aman's browser is built"
  sandbox_drop
}

test_a_plan_step_with_no_image_name_stops() {
  t_begin "a plan step whose image tags came out empty stops the run instead of reading as done"
  sandbox_new
  local out rc=0
  out=$(PATH=$SB_BIN "$SB_BIN/bash" -c ". '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/plan.sh'; plan_image ' ' \"Aman's browser is built\" \"Build Aman's browser\"" 2>&1) || rc=$?
  if [ "$rc" != 0 ]; then t_pass; else t_fail "the step read as done"; fi
  assert_flat_contains "$out" "The installer could not name the images for this step: Build Aman's browser."
  sandbox_drop
}

test_a_new_instance_has_the_browser_on
test_the_plan_has_one_row_for_the_browser
test_a_plan_step_with_no_image_name_stops
test_a_short_secret_below_the_managed_part_is_dropped
test_removing_an_instance_says_the_browser_sign_ins_are_kept_and_purging_deletes_them
test_the_secret_is_made_once_and_kept_out_of_the_compose_file
test_the_browser_is_walled_off
test_the_instance_networks_take_small_free_blocks
tests_finish
