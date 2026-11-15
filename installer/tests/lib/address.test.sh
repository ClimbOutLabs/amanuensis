#!/usr/bin/env bash
# aman address: adding an address of this computer to listen on, a name, or the full address of a forward; the lan
# service that listens for other devices; and what is said when this computer no longer has an address it listened on.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
reg_value() { sed -n "s/^$2=//p" "$AMAN_HOME/state/instances/$1.conf" | head -n 1; }
compose() { cat "$AMAN_HOME/instances/main/compose.yaml"; }

# aman address ACTION [VALUE] on instance main: the command hands these words to the installer as they are.
run_address() { run_install instance address main "$@"; }

# The real aman command, the way a person runs it, with the sandbox's tools.
run_aman() {
  build_run_env
  set +e
  env -i "${RUN_ENV[@]}" AMANUENSIS_HOME="$AMAN_HOME" bash "$INSTALLER_DIR/doctor/aman" "$@" </dev/null >"$SB/out" 2>"$SB/err"
  RC=$?
  set -e
  OUT=$(cat "$SB/out")
  ERR=$(cat "$SB/err")
}

test_other_devices_come_in_through_the_lan_service() {
  t_begin "the holder publishes on 127.0.0.1 only, and a lan service of its own listens on each home network address"
  sandbox_new
  fixture_network 192.168.1.20 tailscale0:100.101.102.103
  install_machine
  local file holder lan
  file=$(compose)
  holder=$(printf '%s\n' "$file" | sed -n '/^  loopback:/,/^  [a-z-]*:$/p')
  lan=$(printf '%s\n' "$file" | sed -n '/^  lan:/,/^  [a-z-]*:$/p')
  assert_contains "$holder" "- '127.0.0.1:8791:8790'"
  assert_not_contains "$holder" "192.168.1.20"
  assert_contains "$lan" "- '192.168.1.20:8443:8443'"
  assert_contains "$lan" "- '192.168.1.20:8791:8081'"
  assert_contains "$lan" "PROXY TCP4"
  assert_not_contains "$file" "100.101.102.103"
  assert_eq "$(reg_value main listen_addresses)" "192.168.1.20"
  sandbox_drop
}

test_a_local_instance_has_no_lan_service() {
  t_begin "an instance on this computer only has no lan service and listens nowhere else"
  sandbox_new
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--local-only)
  install_machine
  assert_not_contains "$(compose)" "  lan:"
  assert_eq "$(reg_value main listen_addresses)" ""
  sandbox_drop
}

test_an_added_vpn_address_is_listened_on_and_removed_again() {
  t_begin "aman address add takes an address of this computer on a VPN, listens there, and remove takes it away"
  sandbox_new
  fixture_network 192.168.1.20 tailscale0:100.101.102.103
  install_machine
  run_address add 100.101.102.103
  assert_rc 0
  assert_contains "$(env_value main ALLOWED_ORIGINS)" "https://100.101.102.103:8443"
  assert_contains "$(compose)" "- '100.101.102.103:8443:8443'"
  assert_eq "$(reg_value main listen_addresses)" "192.168.1.20 100.101.102.103"
  run_address list
  assert_rc 0
  assert_contains "$OUT" "Added by you: 100.101.102.103"
  run_address remove 100.101.102.103
  assert_rc 0
  assert_not_contains "$(env_value main ALLOWED_ORIGINS)" "100.101.102.103"
  assert_not_contains "$(compose)" "100.101.102.103"
  sandbox_drop
}

test_a_forward_is_listed_for_sign_in_and_never_listened_on() {
  t_begin "a full address is a forward: sign-in works there, nothing listens there, and the owner is told where to point it"
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  run_address add HTTPS://Box.Example.ts.net:443/
  assert_rc 0
  assert_flat_contains "$OUT" "http://127.0.0.1:8791"
  assert_eq "$(reg_value main forwards)" "https://box.example.ts.net"
  assert_contains "$(env_value main ALLOWED_ORIGINS)" ",https://box.example.ts.net"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "- https://box.example.ts.net/api/v1/auth/callback"
  assert_not_contains "$(compose)" "box.example"
  sandbox_drop
}

test_a_forward_works_on_an_instance_on_this_computer_only() {
  t_begin "an instance on this computer only takes a forward, and lists its own two names beside it"
  sandbox_new
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--local-only)
  install_machine
  run_address add https://box.example.ts.net
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791,https://box.example.ts.net"
  assert_not_contains "$(compose)" "  lan:"
  run_address add 192.168.1.20
  if [ "$RC" != 0 ]; then t_pass; else t_fail "a local-only instance started listening on the network"; fi
  assert_flat_contains "$ERR" "aman address add https://192.168.1.20"
  sandbox_drop
}

test_public_and_unsafe_addresses_are_refused() {
  t_begin "a public address, plain http to a public name, and anything that is not an address are refused, and nothing changes"
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  local before bad
  before=$(env_value main ALLOWED_ORIGINS)
  for bad in 203.0.113.9 https://203.0.113.9 http://aman.example.com 'https://a/b' ftp://box.local; do
    run_address add "$bad"
    if [ "$RC" != 0 ]; then t_pass; else t_fail "accepted: $bad"; fi
  done
  run_address remove https://never.example.ts.net
  if [ "$RC" != 0 ]; then t_pass; else t_fail "removed an address that was never added"; fi
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$before"
  sandbox_drop
}

test_a_gone_address_is_said_on_every_command() {
  t_begin "when this computer no longer has an address Aman listens on, each aman command says so and the network doctor names it"
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  STUB_ADDRS="192.168.1.77"
  run_aman doctor
  assert_flat_contains "$ERR" "This computer's network address changed, so other devices can't reach Aman (instance main). Run: aman doctor network --fix"
  run_aman doctor network
  assert_flat_contains "$OUT$ERR" "It no longer has: 192.168.1.20"
  STUB_ADDRS="192.168.1.20"
  run_aman doctor
  assert_not_contains "$ERR" "network address changed"
  sandbox_drop
}

test_other_devices_come_in_through_the_lan_service
test_a_local_instance_has_no_lan_service
test_an_added_vpn_address_is_listened_on_and_removed_again
test_a_forward_is_listed_for_sign_in_and_never_listened_on
test_a_forward_works_on_an_instance_on_this_computer_only
test_public_and_unsafe_addresses_are_refused
test_a_gone_address_is_said_on_every_command
tests_finish
