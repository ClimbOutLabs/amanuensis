#!/usr/bin/env bash
# The local model bridge: aman local-model names a port of this computer, and the instance reaches the model there
# through two small services of its own, at aman-local-model, never through one of this computer's network addresses.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

compose_file() { printf '%s' "$AMAN_HOME/instances/main/compose.yaml"; }
# The lines of one service in the compose file.
service_block() { awk -v svc="  $1:" '$0==svc{f=1;next} /^  [a-z]/{f=0} f' "$(compose_file)"; }
env_file() { printf '%s' "$AMAN_HOME/instances/main/.env"; }
# Every LOCAL_MODEL_ENDPOINTS line of the instance's settings file, values only.
endpoint_lines() { sed -n 's/^LOCAL_MODEL_ENDPOINTS=//p' "$(env_file)"; }

test_no_port_named_means_no_bridge() {
  t_begin "an instance with no port named has no bridge"
  sandbox_new
  install_machine
  assert_not_contains "$(cat "$(compose_file)")" "local-model-host:"
  assert_not_contains "$(cat "$(compose_file)")" "local-model-link:"
  assert_not_contains "$(cat "$(compose_file)")" "LOCAL_MODEL_PORTS"
  sandbox_drop
}

test_naming_a_port_starts_the_bridge() {
  t_begin "aman local-model PORT puts the two bridge services in the instance and tells the address to use"
  sandbox_new
  install_machine
  run_install instance local-model main 30031
  assert_rc 0
  assert_flat_contains "$OUT" "give the model the address http://aman-local-model:30031/v1"
  assert_eq "$(sed -n 's/^local_models=//p' "$AMAN_HOME/state/instances/main.conf")" 30031 "the port is recorded"
  assert_contains "$(service_block local-model-host)" "LOCAL_MODEL_PORTS: '30031'"
  assert_contains "$(service_block local-model-host)" "network_mode: host" "native Docker shares this computer's network"
  assert_contains "$(service_block local-model-host)" "LOCAL_MODEL_TARGET: '127.0.0.1'"
  assert_not_contains "$(service_block local-model-host)" "ports:" "the host side publishes nothing"
  assert_contains "$(service_block local-model-link)" "- aman-local-model"
  assert_not_contains "$(service_block local-model-link)" "ports:" "the link side publishes nothing"
  assert_contains "$(service_block loopback)" "- local-model" "the app's network holder reaches the link side"
  assert_contains "$(awk '/^  local-model:/{f=1;next} /^  [a-z]/{f=0} f' "$(compose_file)")" "internal: true"
  assert_contains "$(cat "$(compose_file)")" "name: aman_main_local_model"
  assert_eq "$(cat "$AMAN_HOME/instances/main/local-model-bridge.mjs")" "$(cat "$REPO/ops/compose/local-model/bridge.mjs")" "the bridge script sits beside the compose file"
  run_install instance local-model main 127.0.0.1:11434
  assert_rc 0
  assert_eq "$(sed -n 's/^local_models=//p' "$AMAN_HOME/state/instances/main.conf")" 30031,11434 "a second port is added"
  run_install instance refresh main
  assert_rc 0
  assert_contains "$(service_block local-model-link)" "LOCAL_MODEL_PORTS: '30031,11434'" "a refresh keeps the ports"
  sandbox_drop
}

test_docker_desktop_dials_the_host_name() {
  t_begin "under Docker Desktop the host side dials host.docker.internal from a network of its own"
  sandbox_new
  STUB_DOCKER_OS="Docker Desktop"
  install_machine
  run_install instance local-model main 11434
  assert_rc 0
  assert_contains "$(service_block local-model-host)" "LOCAL_MODEL_TARGET: 'host.docker.internal'"
  assert_contains "$(service_block local-model-host)" "- local-model-egress"
  assert_not_contains "$(service_block local-model-host)" "network_mode: host"
  STUB_DOCKER_OS=
  sandbox_drop
}

test_removing_the_last_port_takes_the_bridge_away() {
  t_begin "--remove takes a port away, and the bridge goes with the last one"
  sandbox_new
  install_machine
  run_install instance local-model main 30031
  run_install instance local-model main 30031 --remove
  assert_rc 0
  assert_flat_contains "$OUT" "no longer carries port 30031"
  assert_not_contains "$(cat "$AMAN_HOME/state/instances/main.conf")" "local_models="
  assert_not_contains "$(cat "$(compose_file)")" "local-model-host:"
  run_install instance local-model main 30031 --remove
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "does not carry port 30031"
  sandbox_drop
}

test_only_a_port_of_this_computer_is_taken() {
  t_begin "an address of another machine, or a port outside 1024 to 65535, is refused before anything changes"
  sandbox_new
  install_machine
  for bad in 192.168.1.30:8000 spark.example.ts.net:443 80 70000 abc; do
    run_install instance local-model main "$bad"
    assert_rc 2
    assert_flat_contains "$OUT$ERR" "is not a port on this computer"
  done
  assert_not_contains "$(cat "$AMAN_HOME/state/instances/main.conf")" "local_models="
  sandbox_drop
}

test_an_app_image_from_before_the_bridge_is_refused() {
  t_begin "an installed app image from before the bridge is refused with the one step to take, and nothing changes"
  sandbox_new
  install_machine
  STUB_OLD_APP_IMAGE=1
  run_install instance local-model main 30031
  STUB_OLD_APP_IMAGE=
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "The installed Aman is older than the local model bridge, so nothing changed. Run aman upgrade"
  assert_not_contains "$(cat "$AMAN_HOME/state/instances/main.conf")" "local_models="
  sandbox_drop
}

test_the_bridge_endpoint_is_listed_for_the_app() {
  t_begin "aman local-model adds the bridge's endpoint to the owner's LOCAL_MODEL_ENDPOINTS and --remove takes it out"
  sandbox_new
  install_machine
  printf '%s\n' "# my own model" "LOCAL_MODEL_ENDPOINTS=localhost:11434" "OTHER_SETTING=kept" >>"$(env_file)"
  run_install instance local-model main 30031
  assert_rc 0
  assert_flat_contains "$OUT" "Aman started again, so the change is in use now."
  assert_eq "$(endpoint_lines)" "localhost:11434,aman-local-model:30031" "the entry is added beside the owner's own"
  assert_contains "$(cat "$(env_file)")" "OTHER_SETTING=kept"
  run_install instance local-model main 30031
  assert_rc 0
  assert_eq "$(endpoint_lines)" "localhost:11434,aman-local-model:30031" "a port named twice is listed once"
  run_install instance local-model main 11434
  assert_rc 0
  assert_eq "$(endpoint_lines)" "localhost:11434,aman-local-model:30031,aman-local-model:11434" "a second port is added"
  run_install instance local-model main 30031 --remove
  assert_rc 0
  assert_flat_contains "$OUT" "Aman started again, so the change is in use now."
  assert_eq "$(endpoint_lines)" "localhost:11434,aman-local-model:11434" "only that port's entry is taken out"
  run_install instance local-model main 11434 --remove
  assert_rc 0
  assert_eq "$(endpoint_lines)" "localhost:11434" "the owner's own entry stays"
  assert_eq "$(stat -c %a "$(env_file)" 2>/dev/null || stat -f %Lp "$(env_file)")" 600 "the settings file stays private"
  sandbox_drop
}

test_the_endpoint_line_is_added_and_dropped_when_the_owner_has_none() {
  t_begin "with no LOCAL_MODEL_ENDPOINTS line, one is added below the managed block and dropped when its list empties"
  sandbox_new
  install_machine
  run_install instance local-model main 30031
  assert_rc 0
  assert_eq "$(endpoint_lines)" "aman-local-model:30031"
  assert_eq "$(awk '/^# <<< end of managed block/{e=NR} /^LOCAL_MODEL_ENDPOINTS=/{l=NR} END{print (l>e)}' "$(env_file)")" 1 "the line sits below the managed block"
  run_install instance local-model main 30031 --remove
  assert_rc 0
  assert_eq "$(endpoint_lines)" "" "an empty list leaves no line"
  sandbox_drop
}

test_the_bridge_network_is_one_of_the_instance_networks() {
  t_begin "the bridge's network is learned into CONTAINER_NETWORK_RANGES, so only a listed endpoint on it is reached"
  sandbox_new
  install_machine
  printf '%s\n' "aman-main_default 172.30.0.0/16" "aman-main_local-model 172.33.0.0/16" >"$SB_STATE/network_subnets"
  run_install instance local-model main 30031
  assert_rc 0
  assert_contains ",$(sed -n 's/^CONTAINER_NETWORK_RANGES=//p' "$(env_file)" | head -n 1)," ",172.33.0.0/16,"
  sandbox_drop
}

test_no_port_named_means_no_bridge
test_an_app_image_from_before_the_bridge_is_refused
test_naming_a_port_starts_the_bridge
test_docker_desktop_dials_the_host_name
test_removing_the_last_port_takes_the_bridge_away
test_only_a_port_of_this_computer_is_taken
test_the_bridge_endpoint_is_listed_for_the_app
test_the_endpoint_line_is_added_and_dropped_when_the_owner_has_none
test_the_bridge_network_is_one_of_the_instance_networks
tests_finish
