#!/usr/bin/env bash
# Where an instance opens: at every address of this computer by default, with sign-in from each; 127.0.0.1 only
# behind a proxy or with --local-only; public addresses never over http; and keeping the list right when it changes.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
reg_value() { sed -n "s/^$2=//p" "$AMAN_HOME/state/instances/$1.conf" | head -n 1; }

# Runs a snippet with the installer libraries loaded and only the sandbox tools on PATH.
in_lib() {
  STUB_ADDRS="${STUB_ADDRS:-}" PATH=$SB_BIN "$SB_BIN/bash" -c "set -euo pipefail; AMAN_HOME='$AMAN_HOME'; . '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/network.sh'; . '$INSTALLER_DIR/lib/instance.sh'; $1"
}

# A computer on a home network with Tailscale: a LAN address, a Tailscale address, its name and its MagicDNS name.
fixture_full_machine() {
  fixture_network 192.168.1.20 100.101.102.103
  fixture_hostname spark
  fixture_tailscale 100.101.102.103 spark.example.ts.net
}

ALL_ORIGINS="http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791,http://100.101.102.103:8791,http://spark:8791,http://spark.local:8791,http://spark.example.ts.net:8791"

test_default_install_answers_at_every_address() {
  t_begin "the app is published on every interface and answers at each address of this computer and its names"
  sandbox_new
  fixture_full_machine
  install_machine
  assert_rc 0
  local compose
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_contains "$compose" "- '8791:8790'"
  assert_contains "$compose" "- '127.0.0.1:5556:5556'"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$ALL_ORIGINS"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://127.0.0.1:8791"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "http://127.0.0.1:5556/dex"
  assert_eq "$(reg_value main origins)" "$ALL_ORIGINS"
  assert_eq "$(reg_value main login_url)" "http://127.0.0.1:5556"
  sandbox_drop
}

test_sign_in_is_registered_for_every_address() {
  t_begin "the sign-in service has one fixed internal issuer and a return address for each listed origin, and no other"
  sandbox_new
  fixture_full_machine
  install_machine
  local dex origin
  dex=$(cat "$AMAN_HOME/instances/main/dex.yaml")
  assert_contains "$dex" "issuer: http://127.0.0.1:5556/dex"
  for origin in ${ALL_ORIGINS//,/ }; do
    assert_contains "$dex" "- $origin/api/v1/auth/callback"
  done
  assert_eq "$(printf '%s\n' "$dex" | grep -c 'api/v1/auth/callback')" 7 "no other return address"
  sandbox_drop
}

test_a_machine_with_only_loopback_still_works() {
  t_begin "a computer with no network address answers at 127.0.0.1 and localhost, with the app port still on every interface"
  sandbox_new
  install_machine
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '8791:8790'"
  sandbox_drop
}

test_public_addresses_are_not_used_over_http() {
  t_begin "a public address of this computer is left out of the list, and the plan says so and points to --tls caddy"
  sandbox_new
  fixture_network 192.168.1.20 203.0.113.9
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT" "203.0.113.9"
  assert_flat_contains "$OUT" "--tls caddy"
  install_machine
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "203.0.113.9"
  sandbox_drop
}

test_address_flag_adds_names_and_is_checked() {
  t_begin "--address is repeatable, adds private names and addresses, and refuses public or malformed ones before any work"
  sandbox_new
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--address nas.local --address 10.9.8.7)
  install_machine
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791,http://nas.local:8791,http://10.9.8.7:8791"
  assert_eq "$(reg_value main extra_hosts)" "nas.local 10.9.8.7"
  sandbox_drop
  local bad
  for bad in 203.0.113.9 aman.example.com 8.8.8.8 "not a host" "-x" "a..b"; do
    sandbox_new
    run_install --dry-run --yes --email owner@example.invalid --address "$bad"
    assert_rc 2 "address $bad"
    assert_flat_contains "$ERR" "address" "address $bad"
    assert_not_contains "$(ls "$AMAN_HOME" 2>/dev/null || true)" instances
    sandbox_drop
  done
  sandbox_new
  run_install --dry-run --yes --email owner@example.invalid --address 203.0.113.9
  assert_flat_contains "$ERR" "--tls caddy"
  sandbox_drop
}

test_address_flag_conflicts() {
  t_begin "--address cannot be combined with --local-only or --public-url"
  sandbox_new
  run_install --dry-run --yes --email owner@example.invalid --address nas.local --local-only
  assert_rc 2
  assert_flat_contains "$ERR" "opposites"
  run_install --dry-run --yes --email owner@example.invalid --address nas.local --public-url https://aman.example.invalid --login-url https://login.example.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "--public-url"
  sandbox_drop
}

test_local_only_keeps_one_address() {
  t_begin "--local-only keeps the ports on 127.0.0.1, with no list of addresses"
  sandbox_new
  fixture_full_machine
  INSTALL_EXTRA=(--local-only)
  install_machine
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '127.0.0.1:8791:8790'"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" ""
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://127.0.0.1:8791"
  assert_eq "$(reg_value main origins)" ""
  assert_eq "$(printf '%s\n' "$(cat "$AMAN_HOME/instances/main/dex.yaml")" | grep -c 'api/v1/auth/callback')" 1
  sandbox_drop
}

test_public_url_is_unchanged() {
  t_begin "behind your own proxy (--public-url) the ports stay on 127.0.0.1, with one return address and no list"
  sandbox_new
  fixture_full_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --public-url https://aman.example.invalid --login-url https://login.example.invalid
  clear_input
  assert_rc 0
  local compose
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_contains "$compose" "- '127.0.0.1:8791:8790'"
  assert_contains "$compose" "- '127.0.0.1:5556:5556'"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" ""
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "https://aman.example.invalid"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "https://login.example.invalid/dex"
  assert_eq "$(printf '%s\n' "$(cat "$AMAN_HOME/instances/main/dex.yaml")" | grep -c 'api/v1/auth/callback')" 1
  sandbox_drop
}

test_issuer_must_be_loopback_or_https() {
  t_begin "an http issuer is accepted only on this computer; every other address needs https"
  sandbox_new
  local ok bad
  for ok in http://127.0.0.1:5556/dex http://localhost:5556/dex https://login.example.com/dex; do
    if in_lib "issuer_check '$ok'" >/dev/null 2>&1; then t_pass; else t_fail "refused: $ok"; fi
  done
  for bad in http://192.168.1.20:5556/dex http://10.1.2.3:5556/dex http://spark.local:5556/dex http://100.64.0.1:5556/dex http://203.0.113.9:5556/dex http://login.example.com:5556/dex; do
    if in_lib "issuer_check '$bad'" >/dev/null 2>&1; then t_fail "accepted over http: $bad"; else t_pass; fi
  done
  sandbox_drop
}

test_address_helpers() {
  t_begin "private addresses and names are told apart from public ones; container bridges and link-local addresses are left out"
  sandbox_new
  fixture_network 192.168.1.20 docker0:172.17.0.1 169.254.9.9 203.0.113.9
  assert_eq "$(in_lib 'network_default_hosts' | tr '\n' ' ')" "127.0.0.1 localhost 192.168.1.20 "
  assert_eq "$(in_lib 'network_public_addresses')" "203.0.113.9"
  local ok bad
  for ok in 10.1.2.3 172.16.0.1 172.31.255.254 192.168.0.9 100.64.0.1 100.127.255.254 spark spark.local spark.example.ts.net; do
    if in_lib "private_host '$ok'"; then t_pass; else t_fail "private host refused: $ok"; fi
  done
  for bad in 8.8.8.8 203.0.113.9 172.15.0.1 172.32.0.1 100.63.0.1 100.128.0.1 example.com spark.local.example.com; do
    if in_lib "private_host '$bad'"; then t_fail "public host accepted: $bad"; else t_pass; fi
  done
  sandbox_drop
}

test_summary_lists_the_addresses_and_the_plain_warning() {
  t_begin "the summary lists each address under Open and says sign-in is not encrypted on a home network"
  sandbox_new
  fixture_full_machine
  install_machine
  assert_flat_contains "$OUT" "Open http://127.0.0.1:8791 http://localhost:8791 http://192.168.1.20:8791 http://100.101.102.103:8791 http://spark:8791 http://spark.local:8791 http://spark.example.ts.net:8791"
  assert_flat_contains "$OUT" "On your home network sign-in is not encrypted; Tailscale encrypts it."
  sandbox_drop
  sandbox_new
  INSTALL_EXTRA=(--local-only)
  install_machine
  assert_not_contains "$OUT" "not encrypted"
  sandbox_drop
}

test_no_question_about_the_address() {
  t_begin "the interactive flow asks for a name and an email and never about the address"
  sandbox_new
  fixture_full_machine
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD"
  assert_eq "$RC" 0
  assert_not_contains "$OUT" "Address you will use"
  assert_not_contains "$OUT" "Address for other devices"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$ALL_ORIGINS"
  sandbox_drop
}

test_the_plan_names_the_addresses() {
  t_begin "the plan lists the addresses the app will answer at and says the port is open to the network"
  sandbox_new
  fixture_full_machine
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT" "It opens on port 8791 at: 127.0.0.1, localhost, 192.168.1.20, 100.101.102.103, spark, spark.local, spark.example.ts.net."
  assert_flat_contains "$OUT" "the port is open to your network"
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

test_refresh_adds_a_new_address() {
  t_begin "instance refresh reads the addresses again, keeps the names given at install, and restarts without touching secrets"
  sandbox_new
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--address nas.local)
  install_machine
  local secret_before
  secret_before=$(env_value main OIDC_CLIENT_SECRET)
  STUB_ADDRS="192.168.1.77 192.168.1.20"
  : >"$STUB_LOG"
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.77:8791,http://192.168.1.20:8791,http://nas.local:8791"
  assert_eq "$(reg_value main origins)" "$(env_value main ALLOWED_ORIGINS)"
  assert_eq "$(env_value main OIDC_CLIENT_SECRET)" "$secret_before" "secrets stay as they were"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "- http://192.168.1.77:8791/api/v1/auth/callback"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "- http://nas.local:8791/api/v1/auth/callback"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "http://127.0.0.1:5556/dex" "the issuer does not move"
  assert_log_has "--force-recreate"
  sandbox_drop
}

test_refresh_of_a_local_instance_renders_again() {
  t_begin "instance refresh of an instance open on this computer only renders it from its record and adds no addresses"
  sandbox_new
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--local-only)
  install_machine
  rm -f "$AMAN_HOME/instances/main/compose.yaml"
  run_install instance refresh main
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '127.0.0.1:8791:8790'"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" ""
  sandbox_drop
}

test_default_install_answers_at_every_address
test_sign_in_is_registered_for_every_address
test_a_machine_with_only_loopback_still_works
test_public_addresses_are_not_used_over_http
test_address_flag_adds_names_and_is_checked
test_address_flag_conflicts
test_local_only_keeps_one_address
test_public_url_is_unchanged
test_issuer_must_be_loopback_or_https
test_address_helpers
test_summary_lists_the_addresses_and_the_plain_warning
test_no_question_about_the_address
test_the_plan_names_the_addresses
test_a_busy_port_on_any_interface_is_skipped
test_refresh_adds_a_new_address
test_refresh_of_a_local_instance_renders_again
tests_finish
