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

test_a_new_instance_has_the_browser_on
test_the_secret_is_made_once_and_kept_out_of_the_compose_file
test_the_browser_is_walled_off
tests_finish
