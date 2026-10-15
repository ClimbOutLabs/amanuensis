#!/usr/bin/env bash
# Where an instance opens: this computer and its network address by default, 127.0.0.1 only behind a proxy,
# which http sign-in addresses are allowed, and keeping the address right when it changes.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
reg_value() { sed -n "s/^$2=//p" "$AMAN_HOME/state/instances/$1.conf" | head -n 1; }

# Runs a snippet with the installer libraries loaded and only the sandbox tools on PATH.
in_lib() {
  PATH=$SB_BIN "$SB_BIN/bash" -c "set -euo pipefail; AMAN_HOME='$AMAN_HOME'; . '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/network.sh'; . '$INSTALLER_DIR/lib/instance.sh'; $1"
}

test_default_install_opens_on_the_network_address() {
  t_begin "with a network address the ports are published on every interface and the app and sign-in use that address"
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  assert_rc 0
  local compose
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_contains "$compose" "- '8791:8790'"
  assert_contains "$compose" "- '5556:5556'"
  assert_not_contains "$compose" "127.0.0.1:8791"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://192.168.1.20:8791"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "http://192.168.1.20:5556/dex"
  assert_eq "$(reg_value main network)" 1
  assert_eq "$(reg_value main public_url)" "http://192.168.1.20:8791"
  assert_eq "$(reg_value main login_url)" "http://192.168.1.20:5556"
  sandbox_drop
}

test_sign_in_is_registered_for_both_addresses() {
  t_begin "the sign-in service accepts the return address of the network address and of 127.0.0.1 and localhost"
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  local dex
  dex=$(cat "$AMAN_HOME/instances/main/dex.yaml")
  assert_contains "$dex" "issuer: http://192.168.1.20:5556/dex"
  assert_contains "$dex" "- http://192.168.1.20:8791/api/v1/auth/callback"
  assert_contains "$dex" "- http://127.0.0.1:8791/api/v1/auth/callback"
  assert_contains "$dex" "- http://localhost:8791/api/v1/auth/callback"
  assert_eq "$(printf '%s\n' "$dex" | grep -c 'api/v1/auth/callback')" 3 "no other return address"
  sandbox_drop
}

test_summary_names_both_addresses_and_the_plain_warning() {
  t_begin "the summary prints both addresses and says sign-in is not encrypted on a home network"
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  assert_flat_contains "$OUT" "Open http://192.168.1.20:8791, from this computer and from other devices on your network or Tailscale"
  assert_flat_contains "$OUT" "Or http://127.0.0.1:8791, on this computer only"
  assert_flat_contains "$OUT" "Sign-in from other devices is not encrypted on a home network; Tailscale encrypts it."
  sandbox_drop
}

test_loopback_only_without_an_address_or_with_local_only() {
  t_begin "no network address, or --local-only, keeps the ports on 127.0.0.1 with one return address"
  sandbox_new
  install_machine
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '127.0.0.1:8791:8790'"
  assert_eq "$(reg_value main network)" 0
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://127.0.0.1:8791"
  assert_eq "$(printf '%s\n' "$(cat "$AMAN_HOME/instances/main/dex.yaml")" | grep -c 'api/v1/auth/callback')" 1
  assert_not_contains "$OUT" "not encrypted on a home network"
  sandbox_drop
  sandbox_new
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--local-only)
  install_machine
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '127.0.0.1:8791:8790'"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://127.0.0.1:8791"
  assert_eq "$(reg_value main network)" 0
  sandbox_drop
}

test_public_url_keeps_the_ports_on_loopback() {
  t_begin "behind your own proxy (--public-url) the raw http ports stay on 127.0.0.1"
  sandbox_new
  fixture_network 192.168.1.20
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --public-url https://aman.example.invalid --login-url https://login.example.invalid
  clear_input
  assert_rc 0
  local compose
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_contains "$compose" "- '127.0.0.1:8791:8790'"
  assert_contains "$compose" "- '127.0.0.1:5556:5556'"
  assert_eq "$(reg_value main network)" 0
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "https://aman.example.invalid"
  assert_eq "$(printf '%s\n' "$(cat "$AMAN_HOME/instances/main/dex.yaml")" | grep -c 'api/v1/auth/callback')" 1
  sandbox_drop
}

test_a_public_address_does_not_open_the_ports() {
  t_begin "a computer whose own address is public stays on 127.0.0.1 and says how to get HTTPS"
  sandbox_new
  fixture_network 203.0.113.9
  install_machine
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '127.0.0.1:8791:8790'"
  assert_eq "$(reg_value main network)" 0
  assert_flat_contains "$OUT$ERR" "203.0.113.9"
  assert_flat_contains "$OUT$ERR" "--public-url"
  sandbox_drop
}

test_private_addresses_may_use_http_and_public_ones_may_not() {
  t_begin "an http sign-in address is allowed for private addresses and refused for public ones"
  sandbox_new
  local ok bad
  for ok in http://10.1.2.3:5556/dex http://172.16.0.1:5556/dex http://172.31.255.254:5556/dex http://192.168.0.9:5556/dex \
    http://100.64.0.1:5556/dex http://100.127.255.254:5556/dex http://169.254.1.1:5556/dex http://127.0.0.1:5556/dex \
    http://spark.local:5556/dex http://spark.example.ts.net:5556/dex http://spark:5556/dex; do
    if in_lib "issuer_check '$ok'" >/dev/null 2>&1; then t_pass; else t_fail "private address refused: $ok"; fi
  done
  for bad in http://8.8.8.8:5556/dex http://203.0.113.9:5556/dex http://172.15.0.1:5556/dex http://172.32.0.1:5556/dex \
    http://100.63.0.1:5556/dex http://100.128.0.1:5556/dex http://example.com:5556/dex http://login.example.com:5556/dex \
    http://spark.local.example.com:5556/dex; do
    if in_lib "issuer_check '$bad'" >/dev/null 2>&1; then t_fail "public address accepted over http: $bad"; else t_pass; fi
  done
  if in_lib "issuer_check 'https://login.example.com/dex'" >/dev/null 2>&1; then t_pass; else t_fail "https refused"; fi
  sandbox_drop
}

test_no_question_about_the_address() {
  t_begin "the interactive flow asks for a name and an email and never about the address"
  sandbox_new
  fixture_network 192.168.1.20
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"
  assert_eq "$RC" 0
  assert_not_contains "$OUT" "Address you will use"
  assert_not_contains "$OUT" "other devices (press"
  assert_not_contains "$OUT" "Address for other devices"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://192.168.1.20:8791"
  sandbox_drop
}

test_the_plan_names_both_addresses() {
  t_begin "the plan says the app also answers on this computer's own loopback address and that both ports are open to the network"
  sandbox_new
  fixture_network 192.168.1.20
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT" "The app opens at http://192.168.1.20:8791, and at http://127.0.0.1:8791 on this computer"
  assert_flat_contains "$OUT" "Both ports are open to your network."
  sandbox_drop
}

test_a_busy_port_on_any_interface_is_skipped() {
  t_begin "a port held on another interface is skipped, since the instance now publishes on every interface"
  sandbox_new
  fixture_network 192.168.1.20
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'skip: python3 missing\n'
    sandbox_drop
    return 0
  fi
  python3 -c 'import socket, sys, time
s = socket.socket()
s.bind(("0.0.0.0", 0))
s.listen(1)
print(s.getsockname()[1], flush=True)
time.sleep(20)' >"$SB/listener.out" &
  local pid=$! n=0 port
  while [ ! -s "$SB/listener.out" ] && [ "$n" -lt 50 ]; do
    sleep 0.1
    n=$((n + 1))
  done
  port=$(head -n 1 "$SB/listener.out")
  assert_eq "$(in_lib "PATH=\$PATH . '$INSTALLER_DIR/lib/ports.sh'; port_in_use $port && echo busy || echo free")" busy
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sandbox_drop
}

test_refresh_moves_a_network_instance_to_the_new_address() {
  t_begin "instance refresh --new-address moves the app and the sign-in service to the current address and restarts them"
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  local secret_before
  secret_before=$(env_value main OIDC_CLIENT_SECRET)
  STUB_PRIMARY_IP=192.168.1.77
  : >"$STUB_LOG"
  run_install instance refresh main --new-address
  assert_rc 0
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://192.168.1.77:8791"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "http://192.168.1.77:5556/dex"
  assert_eq "$(env_value main OIDC_CLIENT_SECRET)" "$secret_before" "secrets stay as they were"
  assert_eq "$(reg_value main public_url)" "http://192.168.1.77:8791"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "issuer: http://192.168.1.77:5556/dex"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "- http://192.168.1.77:8791/api/v1/auth/callback"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "192.168.1.20"
  assert_log_has "--force-recreate"
  sandbox_drop
}

test_refresh_refuses_a_loopback_instance_and_a_missing_address() {
  t_begin "instance refresh --new-address says so for an instance open on this computer only, and without a private address"
  sandbox_new
  install_machine
  run_install instance refresh main --new-address
  assert_rc 1
  assert_flat_contains "$ERR" "open on this computer only"
  sandbox_drop
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  STUB_PRIMARY_IP=
  run_install instance refresh main --new-address
  assert_rc 1
  assert_flat_contains "$ERR" "no private network address"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://192.168.1.20:8791" "nothing was changed"
  sandbox_drop
}

test_refresh_without_the_flag_renders_again_and_keeps_the_address() {
  t_begin "instance refresh without --new-address renders the instance from its record and keeps its address"
  sandbox_new
  fixture_network 192.168.1.20
  install_machine
  rm -f "$AMAN_HOME/instances/main/compose.yaml"
  run_install instance refresh main
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '8791:8790'"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://192.168.1.20:8791"
  sandbox_drop
}

test_default_install_opens_on_the_network_address
test_sign_in_is_registered_for_both_addresses
test_summary_names_both_addresses_and_the_plain_warning
test_loopback_only_without_an_address_or_with_local_only
test_public_url_keeps_the_ports_on_loopback
test_a_public_address_does_not_open_the_ports
test_private_addresses_may_use_http_and_public_ones_may_not
test_no_question_about_the_address
test_the_plan_names_both_addresses
test_a_busy_port_on_any_interface_is_skipped
test_refresh_moves_a_network_instance_to_the_new_address
test_refresh_refuses_a_loopback_instance_and_a_missing_address
test_refresh_without_the_flag_renders_again_and_keeps_the_address
tests_finish
