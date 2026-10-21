#!/usr/bin/env bash
# Where an instance opens: at every address of this computer by default, with sign-in from each; 127.0.0.1 only
# behind a proxy or with --local-only; public addresses never over http; and keeping the list right when it changes.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# These tests are about the addresses an instance opens at, so they install it over plain http; https has its own tests.
sandbox_new_plain() {
  sandbox_new
  INSTALL_EXTRA=(--tls off)
}

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
reg_value() { sed -n "s/^$2=//p" "$AMAN_HOME/state/instances/$1.conf" | head -n 1; }

# Runs a snippet with the installer libraries loaded and only the sandbox tools on PATH.
in_lib() {
  STUB_ADDRS="${STUB_ADDRS:-}" STUB_HOSTNAME="${STUB_HOSTNAME:-}" STUB_TS_IP="${STUB_TS_IP:-}" STUB_TS_NAME="${STUB_TS_NAME:-}" STUB_TS_HANG="${STUB_TS_HANG:-}" \
    AMAN_SYS_NET="$SB/sysnet" PATH=$SB_BIN "$SB_BIN/bash" -c "set -euo pipefail; AMAN_HOME='$AMAN_HOME'; . '$INSTALLER_DIR/lib/ui.sh'; . '$INSTALLER_DIR/lib/shared.sh'; . '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/network.sh'; . '$INSTALLER_DIR/lib/tls.sh'; . '$INSTALLER_DIR/lib/instance.sh'; $1"
}

# A computer on a home network with Tailscale: a LAN address, a Tailscale address, its name and its MagicDNS name.
fixture_full_machine() {
  fixture_network 192.168.1.20 tailscale0:100.101.102.103
  fixture_hostname spark
  fixture_tailscale 100.101.102.103 spark.example.ts.net
}

ALL_ORIGINS="http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791,http://100.101.102.103:8791,http://spark:8791,http://spark.local:8791,http://spark.example.ts.net:8791"

test_default_install_answers_at_every_address() {
  t_begin "the app is published on 127.0.0.1 and each private address of this computer, never on a wildcard, and answers at each name"
  sandbox_new_plain
  fixture_full_machine
  install_machine
  assert_rc 0
  local compose
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_contains "$compose" "- '127.0.0.1:8791:8790'"
  assert_contains "$compose" "- '192.168.1.20:8791:8790'"
  assert_contains "$compose" "- '100.101.102.103:8791:8790'"
  assert_not_contains "$compose" "- '8791:8790'" "no wildcard publish"
  assert_not_contains "$compose" "0.0.0.0"
  assert_not_contains "$compose" "[::]"
  assert_eq "$(printf '%s\n' "$compose" | grep -c ":8790'")" 3 "one publish per address, none for the names"
  assert_contains "$compose" "- '127.0.0.1:5556:5556'"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$ALL_ORIGINS"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://127.0.0.1:8791"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "http://127.0.0.1:5556/dex"
  assert_eq "$(reg_value main origins)" "$ALL_ORIGINS"
  assert_eq "$(reg_value main login_url)" "http://127.0.0.1:5556"
  sandbox_drop
}

test_sign_in_service_listens_on_loopback_only_where_the_app_fronts_it() {
  t_begin "the sign-in service listens on 127.0.0.1 when the app passes its pages through, and on every address when a browser reaches it directly"
  sandbox_new_plain
  fixture_full_machine
  install_machine
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "http: 127.0.0.1:5556"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "0.0.0.0"
  sandbox_drop
  sandbox_new_plain
  fixture_full_machine
  INSTALL_EXTRA=(--local-only)
  install_machine
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "http: 0.0.0.0:5556"
  sandbox_drop
}

test_cloud_server_stays_on_this_computer() {
  t_begin "on a cloud server the app is published on 127.0.0.1 only, with a warning, unless --home-network is given"
  sandbox_new_plain
  fixture_full_machine
  mkdir -p "$SB/dmi"
  printf 'Amazon EC2\n' >"$SB/dmi/sys_vendor"
  export AMAN_DMI_DIR="$SB/dmi"
  install_machine
  assert_flat_contains "$OUT$ERR" "This looks like a cloud server"
  assert_flat_contains "$OUT$ERR" "--home-network"
  assert_eq "$(reg_value main origins)" ""
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "192.168.1.20"
  sandbox_drop
  sandbox_new_plain
  fixture_full_machine
  mkdir -p "$SB/dmi"
  printf 'Amazon EC2\n' >"$SB/dmi/sys_vendor"
  export AMAN_DMI_DIR="$SB/dmi"
  INSTALL_EXTRA=(--home-network)
  install_machine
  assert_not_contains "$OUT$ERR" "This looks like a cloud server"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "192.168.1.20"
  unset AMAN_DMI_DIR
  sandbox_drop
}

test_home_machine_is_not_taken_for_a_cloud_server() {
  t_begin "a computer whose hardware names no cloud provider answers on the home network without a warning"
  sandbox_new_plain
  fixture_full_machine
  mkdir -p "$SB/dmi"
  printf 'LENOVO\n' >"$SB/dmi/sys_vendor"
  export AMAN_DMI_DIR="$SB/dmi"
  install_machine
  unset AMAN_DMI_DIR
  assert_not_contains "$OUT$ERR" "This looks like a cloud server"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "192.168.1.20"
  sandbox_drop
}

test_sign_in_is_registered_for_every_address() {
  t_begin "the sign-in service has one fixed internal issuer and a return address for each listed origin, and no other"
  sandbox_new_plain
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
  t_begin "a computer with no network address answers at 127.0.0.1 and localhost, published on 127.0.0.1 only"
  sandbox_new_plain
  install_machine
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '127.0.0.1:8791:8790'"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '8791:8790'"
  sandbox_drop
}

test_public_addresses_are_not_used_over_http() {
  t_begin "a public address of this computer is left out of the list, and the plan says so and points to --tls caddy"
  sandbox_new_plain
  fixture_network 192.168.1.20 203.0.113.9
  run_install --dry-run --email owner@example.invalid --tls off
  assert_rc 0
  assert_flat_contains "$OUT" "203.0.113.9"
  assert_flat_contains "$OUT" "--tls caddy"
  install_machine
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "203.0.113.9"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "203.0.113.9" "a public address is never published on"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '8791:8790'"
  sandbox_drop
}

test_address_flag_adds_names_and_is_checked() {
  t_begin "--address is repeatable, adds private names and addresses, and refuses public or malformed ones before any work"
  sandbox_new_plain
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--tls off --address nas.local --address 10.9.8.7)
  install_machine
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791,http://nas.local:8791,http://10.9.8.7:8791"
  assert_eq "$(reg_value main extra_hosts)" "nas.local 10.9.8.7"
  sandbox_drop
  local bad
  for bad in 203.0.113.9 aman.example.com 8.8.8.8 "not a host" "-x" "a..b"; do
    sandbox_new_plain
    run_install --dry-run --yes --email owner@example.invalid --address "$bad"
    assert_rc 2 "address $bad"
    assert_flat_contains "$ERR" "address" "address $bad"
    assert_not_contains "$(ls "$AMAN_HOME" 2>/dev/null || true)" instances
    sandbox_drop
  done
  sandbox_new_plain
  run_install --dry-run --yes --email owner@example.invalid --address 203.0.113.9
  assert_flat_contains "$ERR" "--tls caddy"
  sandbox_drop
}

test_address_flag_conflicts() {
  t_begin "--address cannot be combined with --local-only or --public-url"
  sandbox_new_plain
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
  sandbox_new_plain
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
  sandbox_new_plain
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
  sandbox_new_plain
  local ok bad
  for ok in http://127.0.0.1:5556/dex http://localhost:5556/dex https://login.example.com/dex; do
    if in_lib "issuer_check '$ok'" >/dev/null 2>&1; then t_pass; else t_fail "refused: $ok"; fi
  done
  for bad in http://192.168.1.20:5556/dex http://10.1.2.3:5556/dex http://spark.local:5556/dex http://100.64.0.1:5556/dex http://203.0.113.9:5556/dex http://login.example.com:5556/dex; do
    if in_lib "issuer_check '$bad'" >/dev/null 2>&1; then t_fail "accepted over http: $bad"; else t_pass; fi
  done
  sandbox_drop
}

# Reads installer/tests/private-hosts.txt, which the app's own tests read too: "class host" per line.
each_host() { # class... ; prints the hosts of those classes
  local class host
  while read -r class host; do
    case "$class" in '' | '#'*) continue ;; esac
    for want in "$@"; do
      if [ "$class" = "$want" ]; then printf '%s\n' "$host"; fi
    done
  done <"$TESTS_DIR/private-hosts.txt"
}

test_private_and_public_hosts_match_the_shared_list() {
  t_begin "private, carrier-grade and public hosts are told apart as in the list the app's tests read too"
  sandbox_new_plain
  local host
  while read -r host; do
    if in_lib "private_host '$host'"; then t_pass; else t_fail "private host refused: $host"; fi
  done < <(each_host private)
  while read -r host; do
    if in_lib "private_host '$host'"; then t_fail "public host accepted: $host"; else t_pass; fi
  done < <(each_host public cgnat)
  fixture_tailscale 100.101.102.103 spark.example.ts.net
  fixture_network
  while read -r host; do
    STUB_ADDRS="tailscale0:$host"
    if in_lib "private_host '$host'"; then t_pass; else t_fail "100.64.0.0/10 refused on the Tailscale link: $host"; fi
    STUB_ADDRS="eth0:$host"
    if in_lib "private_host '$host'"; then t_fail "100.64.0.0/10 accepted on another link even though Tailscale is here: $host"; else t_pass; fi
  done < <(each_host cgnat)
  STUB_ADDRS=''
  fixture_network
  while read -r host; do
    if in_lib "private_host '$host'"; then t_fail "public host accepted with Tailscale present: $host"; else t_pass; fi
  done < <(each_host public)
  sandbox_drop
}

test_leading_zeros_are_not_an_address() {
  t_begin "an address with a leading zero is refused everywhere, so Docker is never given one it cannot bind"
  sandbox_new_plain
  local bad
  for bad in 010.1.1.1 192.168.01.5 1.2.3.04 01.1.1.1 192.168.1.256 1.2.3 1.2.3.4.5 ''; do
    if in_lib "valid_ipv4 '$bad'"; then t_fail "accepted: $bad"; else t_pass; fi
  done
  for bad in 0.0.0.0 10.0.0.1 192.168.1.20 255.255.255.255; do
    if in_lib "valid_ipv4 '$bad'"; then t_pass; else t_fail "refused: $bad"; fi
  done
  run_install --dry-run --yes --email owner@example.invalid --address 010.1.1.1
  assert_rc 2
  assert_flat_contains "$ERR" "not an address"
  sandbox_drop
}

test_carrier_grade_nat_is_public_without_tailscale() {
  t_begin "100.64.0.0/10 is left out and called public without Tailscale (provider NAT), and used with it"
  sandbox_new_plain
  fixture_network 192.168.1.20 100.64.5.5
  run_install --dry-run --email owner@example.invalid --tls off
  assert_flat_contains "$OUT" "100.64.5.5"
  assert_flat_contains "$OUT" "--tls caddy"
  install_machine
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791,http://192.168.1.20:8791"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "100.64.5.5"
  sandbox_drop
  sandbox_new_plain
  fixture_network 192.168.1.20 tailscale0:100.64.5.5
  fixture_tailscale 100.64.5.5 spark.example.ts.net
  install_machine
  assert_contains "$(env_value main ALLOWED_ORIGINS)" "http://100.64.5.5:8791"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '100.64.5.5:8791:8790'"
  sandbox_drop
}

test_a_name_only_address_is_not_published_on() {
  t_begin "an --address that names another machine is answered at but never bound, since this computer does not have it"
  sandbox_new_plain
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--tls off --address 10.9.8.7 --address 192.168.1.20)
  install_machine
  assert_contains "$(env_value main ALLOWED_ORIGINS)" "http://10.9.8.7:8791"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "10.9.8.7"
  assert_eq "$(env_value main ALLOWED_ORIGINS | tr ',' '\n' | grep -c '192.168.1.20')" 1 "a repeated address is listed once"
  sandbox_drop
}

test_a_wedged_tailscale_cannot_stall_the_install() {
  t_begin "tailscale is asked with a time limit, so a hung tailscaled costs a few seconds and the install still finishes"
  sandbox_new_plain
  fixture_network 192.168.1.20
  fixture_tailscale 100.101.102.103 spark.example.ts.net
  STUB_TS_HANG=1
  local start=$SECONDS
  assert_eq "$(in_lib 'network_default_hosts' | tr '\n' ' ')" "127.0.0.1 localhost 192.168.1.20 "
  if [ $((SECONDS - start)) -lt 15 ]; then t_pass; else t_fail "took $((SECONDS - start)) seconds"; fi
  sandbox_drop
}

test_tailscale_names_and_addresses() {
  t_begin "only this computer's own MagicDNS name is used, and an address that ip and tailscale both report is listed once"
  sandbox_new_plain
  fixture_network 192.168.1.20 tailscale0:100.101.102.103
  fixture_hostname spark
  fixture_tailscale 100.101.102.103 spark.example.ts.net
  assert_eq "$(in_lib 'network_tailscale_name')" "spark.example.ts.net"
  assert_eq "$(in_lib 'network_ipv4_addresses' | grep -c '100.101.102.103')" 1
  assert_not_contains "$(in_lib 'network_default_hosts')" "other.example.ts.net" "a peer's name is never taken"
  sandbox_drop
}

test_summary_lists_the_addresses_and_the_plain_warning() {
  t_begin "the summary lists each address under Open and says sign-in is not encrypted on a home network"
  sandbox_new_plain
  fixture_full_machine
  install_machine
  assert_flat_contains "$OUT" "Open http://192.168.1.20:8791 http://100.101.102.103:8791 http://spark.example.ts.net:8791 http://spark.local:8791 http://spark:8791 http://127.0.0.1:8791 http://localhost:8791"
  assert_flat_contains "$OUT" "Sign-in on your home network is not encrypted. Use the Tailscale address to keep it private."
  assert_flat_contains "$OUT" "Bookmark spark.example.ts.net: it keeps working when this computer's address changes."
  sandbox_drop
  sandbox_new_plain
  INSTALL_EXTRA=(--local-only)
  install_machine
  assert_not_contains "$OUT" "not encrypted"
  sandbox_drop
}

test_no_question_about_the_address() {
  t_begin "the interactive flow asks for a name and an email and never about the address"
  sandbox_new_plain
  fixture_full_machine
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD" --tls off
  assert_eq "$RC" 0
  assert_not_contains "$OUT" "Address you will use"
  assert_not_contains "$OUT" "Address for other devices"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$ALL_ORIGINS"
  sandbox_drop
}

test_the_plan_names_the_addresses() {
  t_begin "the plan lists the addresses the app will answer at and says the port is open to the network"
  sandbox_new_plain
  fixture_full_machine
  run_install --dry-run --email owner@example.invalid --tls off
  assert_rc 0
  assert_flat_contains "$OUT" "It opens on port 8791 at: 127.0.0.1, localhost, 192.168.1.20, 100.101.102.103, spark, spark.local, spark.example.ts.net."
  assert_flat_contains "$OUT" "the port is open to your network"
  sandbox_drop
}

test_a_busy_port_on_any_interface_is_skipped() {
  t_begin "a port held on another interface is skipped, since the instance now publishes on every interface"
  sandbox_new_plain
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
  sandbox_new_plain
  fixture_network 192.168.1.20
  INSTALL_EXTRA=(--tls off --address nas.local)
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
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '192.168.1.77:8791:8790'"
  assert_log_has "--force-recreate"
  sandbox_drop
}

test_refresh_of_a_local_instance_renders_again() {
  t_begin "instance refresh of an instance open on this computer only renders it from its record and adds no addresses"
  sandbox_new_plain
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

# An instance from before the address list existed: no origins record, loopback only.
make_legacy_instance() {
  INSTALL_EXTRA=(--local-only)
  install_machine
  sed -i '/^origins=/d;/^extra_hosts=/d' "$AMAN_HOME/state/instances/main.conf"
  sed -i '/^ALLOWED_ORIGINS=/d' "$AMAN_HOME/instances/main/.env"
}

test_an_existing_instance_opens_on_the_network_on_a_plain_rerun() {
  t_begin "re-running install on an instance from before the address list opens it on the network: no remove, no add, data and secrets kept"
  sandbox_new_plain
  fixture_full_machine
  make_legacy_instance
  local secret
  secret=$(env_value main OIDC_CLIENT_SECRET)
  assert_eq "$(env_value main ALLOWED_ORIGINS)" ""
  : >"$STUB_LOG"
  run_install --yes --tls off
  assert_rc 0
  assert_flat_contains "$OUT" "Open instance main on your network"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$ALL_ORIGINS"
  assert_eq "$(reg_value main origins)" "$ALL_ORIGINS"
  assert_eq "$(env_value main OIDC_CLIENT_SECRET)" "$secret" "secrets stay as they were"
  local dex origin
  dex=$(cat "$AMAN_HOME/instances/main/dex.yaml")
  for origin in ${ALL_ORIGINS//,/ }; do
    assert_contains "$dex" "- $origin/api/v1/auth/callback"
  done
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '192.168.1.20:8791:8790'"
  assert_log_has "--force-recreate"
  assert_not_contains "$(cat "$STUB_LOG")" "volume rm" "no data was removed"
  assert_flat_contains "$OUT" "Open http://192.168.1.20:8791"
  run_install --yes --tls off
  assert_flat_contains "$OUT" "Nothing to do."
  sandbox_drop
}

test_local_only_on_a_rerun_puts_an_instance_back() {
  t_begin "--local-only on a re-run puts an instance that was opened on the network back on this computer only, and keeps it there"
  sandbox_new_plain
  fixture_full_machine
  install_machine
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$ALL_ORIGINS"
  run_install --yes --local-only
  assert_rc 0
  assert_flat_contains "$OUT" "Open instance main on this computer only"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" ""
  assert_eq "$(reg_value main origins)" ""
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '127.0.0.1:8791:8790'"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "192.168.1.20"
  assert_eq "$(printf '%s\n' "$(cat "$AMAN_HOME/instances/main/dex.yaml")" | grep -c 'api/v1/auth/callback')" 1
  run_install --yes --tls off
  assert_flat_contains "$OUT" "Nothing to do." "a plain re-run does not open it again"
  assert_eq "$(reg_value main origins)" ""
  sandbox_drop
}

test_a_legacy_instance_stays_local_with_local_only() {
  t_begin "--local-only on a re-run keeps an instance from before the address list on this computer, and a plain re-run then leaves it"
  sandbox_new_plain
  fixture_full_machine
  make_legacy_instance
  run_install --yes --local-only
  assert_rc 0
  assert_eq "$(reg_value main origins)" ""
  assert_eq "$(grep -c '^origins=' "$AMAN_HOME/state/instances/main.conf")" 1 "the choice is recorded"
  run_install --yes --tls off
  assert_eq "$(env_value main ALLOWED_ORIGINS)" ""
  sandbox_drop
}

fixture_cloud_machine() {
  mkdir -p "$SB/dmi"
  printf 'Amazon EC2\n' >"$SB/dmi/sys_vendor"
  export AMAN_DMI_DIR="$SB/dmi"
}

# Asserts instance main still answers at every address of the full machine, as it was installed.
assert_open_at_every_address() { # label
  assert_eq "$(reg_value main origins)" "$ALL_ORIGINS" "$1: origins record"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$ALL_ORIGINS" "$1: ALLOWED_ORIGINS"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '192.168.1.20:8791:8790'" "$1: LAN publish"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '100.101.102.103:8791:8790'" "$1: Tailscale publish"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "http: 127.0.0.1:5556" "$1: sign-in stays behind the app"
}

test_a_rerun_on_a_cloud_server_keeps_the_recorded_reach() {
  t_begin "on a cloud server a plain re-run keeps an existing instance where it was opened; only a new or unrecorded one stays on this computer"
  sandbox_new_plain
  fixture_full_machine
  fixture_cloud_machine
  INSTALL_EXTRA=(--tls off --home-network)
  install_machine
  assert_open_at_every_address "installed with --home-network"
  run_install --yes
  assert_rc 0
  assert_not_contains "$OUT$ERR" "This looks like a cloud server" "no cloud default for an instance with a recorded reach"
  assert_open_at_every_address "plain re-run"
  unset AMAN_DMI_DIR
  sandbox_drop

  sandbox_new_plain
  fixture_full_machine
  install_machine
  assert_open_at_every_address "installed on a home machine"
  fixture_cloud_machine
  run_install --yes
  assert_rc 0
  assert_open_at_every_address "plain re-run once the machine looks like a cloud server"
  run_install --yes --local-only
  assert_eq "$(reg_value main origins)" "" "--local-only still closes it"
  unset AMAN_DMI_DIR
  sandbox_drop

  sandbox_new_plain
  fixture_full_machine
  make_legacy_instance
  fixture_cloud_machine
  run_install --yes
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "This looks like a cloud server"
  assert_eq "$(reg_value main origins)" "" "an instance with no recorded reach is not opened on a cloud server"
  assert_eq "$(grep -c '^origins=' "$AMAN_HOME/state/instances/main.conf")" 1 "the choice is recorded"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "192.168.1.20"
  unset AMAN_DMI_DIR
  sandbox_drop
}

test_a_hosted_instance_is_never_opened_on_the_network() {
  t_begin "an instance behind its own https address is left alone by a re-run"
  sandbox_new_plain
  fixture_full_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --public-url https://aman.example.invalid --login-url https://login.example.invalid
  clear_input
  assert_rc 0
  run_install --yes --tls off
  assert_not_contains "$OUT" "on your network"
  assert_eq "$(env_value main ALLOWED_ORIGINS)" ""
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- '127.0.0.1:8791:8790'"
  sandbox_drop
}

test_virtual_and_vpn_links_are_never_opened_on() {
  t_begin "addresses on container, virtual-machine and other VPN links are neither bound nor listed, and --print-network names them"
  sandbox_new_plain
  fixture_network eth0:192.168.1.20 docker0:172.17.0.1 virbr0:192.168.122.1 tun0:10.8.0.2 wg0:10.7.0.2 lxdbr0:10.10.10.1 \
    vboxnet0:192.168.56.1 podman0:10.88.0.1 vmnet8:172.16.5.1 utun3:10.20.0.2 br-abc:172.20.0.1
  install_machine
  assert_eq "$(env_value main ALLOWED_ORIGINS | tr ',' '\n' | grep -E '^http://[0-9.]+:' | grep -vc '127.0.0.1')" 1 "only the real network"
  assert_contains "$(env_value main ALLOWED_ORIGINS)" "http://192.168.1.20:8791"
  local compose
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_eq "$(printf '%s\n' "$compose" | grep -c ":8790'")" 2 "127.0.0.1 and the one real address"
  run_install --print-network
  assert_rc 0
  local link
  for link in docker0 virbr0 tun0 wg0 lxdbr0 vboxnet0 podman0 vmnet8 utun3 br-abc; do
    assert_flat_contains "$OUT" "($link)"
  done
  assert_not_contains "$OUT" "(eth0)"
  sandbox_drop
}

test_tailscale_is_used_only_on_its_own_link() {
  t_begin "a 100.64.0.0/10 address counts as private only on tailscale0, or on a utun that tailscale itself names"
  sandbox_new_plain
  fixture_network eth0:192.168.1.20 eth1:100.64.7.7 utun4:100.101.102.103 utun5:100.99.99.99
  fixture_tailscale 100.101.102.103 spark.example.ts.net
  assert_eq "$(in_lib 'network_ipv4_addresses' | tr '\n' ' ')" "192.168.1.20 100.64.7.7 100.101.102.103 "
  assert_eq "$(in_lib 'network_default_hosts' | grep -c '^100\.')" 1 "only Tailscale's own address is a private host"
  assert_contains "$(in_lib 'network_default_hosts')" "100.101.102.103"
  assert_not_contains "$(in_lib 'network_default_hosts')" "100.64.7.7"
  assert_not_contains "$(in_lib 'network_default_hosts')" "100.99.99.99"
  assert_contains "$(in_lib 'network_public_addresses')" "100.64.7.7" "provider NAT on a normal link is public"
  sandbox_drop
}

test_numeric_looking_names_are_not_names() {
  t_begin "a name made of numbers or hex (0x7f, 1e3) is not an address or a name, and is not taken for a private one"
  sandbox_new_plain
  local bad
  for bad in 0x7f 1e3 0x7f.local 1e3.local 0xc0a80114 3232235796 192.168.1 spark.0x7f.local; do
    if in_lib "private_host '$bad'"; then t_fail "taken for private: $bad"; else t_pass; fi
    assert_contains "$(in_lib "address_problem '$bad'")" "$bad" "$bad is refused with words"
  done
  for bad in spark spark.local spark.example.ts.net my-nas3 nas1.local; do
    if in_lib "private_host '$bad'"; then t_pass; else t_fail "refused: $bad"; fi
  done
  sandbox_drop
}

test_default_install_answers_at_every_address
test_sign_in_service_listens_on_loopback_only_where_the_app_fronts_it
test_cloud_server_stays_on_this_computer
test_home_machine_is_not_taken_for_a_cloud_server
test_sign_in_is_registered_for_every_address
test_a_machine_with_only_loopback_still_works
test_public_addresses_are_not_used_over_http
test_address_flag_adds_names_and_is_checked
test_address_flag_conflicts
test_local_only_keeps_one_address
test_public_url_is_unchanged
test_issuer_must_be_loopback_or_https
test_private_and_public_hosts_match_the_shared_list
test_leading_zeros_are_not_an_address
test_carrier_grade_nat_is_public_without_tailscale
test_a_name_only_address_is_not_published_on
test_a_wedged_tailscale_cannot_stall_the_install
test_virtual_and_vpn_links_are_never_opened_on
test_tailscale_is_used_only_on_its_own_link
test_numeric_looking_names_are_not_names
test_tailscale_names_and_addresses
test_an_existing_instance_opens_on_the_network_on_a_plain_rerun
test_local_only_on_a_rerun_puts_an_instance_back
test_a_legacy_instance_stays_local_with_local_only
test_a_rerun_on_a_cloud_server_keeps_the_recorded_reach
test_a_hosted_instance_is_never_opened_on_the_network
test_summary_lists_the_addresses_and_the_plain_warning
test_no_question_about_the_address
test_the_plan_names_the_addresses
test_a_busy_port_on_any_interface_is_skipped
test_refresh_adds_a_new_address
test_refresh_of_a_local_instance_renders_again
tests_finish
