#!/usr/bin/env bash
# A Mac publishes on this computer alone; Docker Desktop on Linux and WSL2 keep the private addresses, as before.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Runs a network.sh function with `uname -s` answering Darwin, the way a Mac reports itself.
on_mac() {
  local bin=$SB/mac-bin
  mkdir -p "$bin"
  cat >"$bin/uname" <<'UNAME'
#!/usr/bin/env bash
case "${1:-}" in -s) echo Darwin ;; -r) echo 24.0.0 ;; *) echo Darwin ;; esac
UNAME
  chmod 755 "$bin/uname"
  PATH="$bin:$PATH" bash -c 'set -euo pipefail; . "$1/lib/common.sh"; . "$1/lib/shared.sh"; . "$1/lib/network.sh"; shift; "$@"' _ "$INSTALLER_DIR" "$@" </dev/null
}

test_mac_publishes_on_loopback_only() {
  t_begin "on a Mac the default origins are loopback only and no network address is opened"
  sandbox_new
  local origins binds
  origins=$(on_mac network_origin_list 8790 "")
  assert_eq "$origins" "http://127.0.0.1:8790,http://localhost:8790" "default origins on a Mac"
  if on_mac origins_reach_the_network "$origins"; then t_fail "a Mac origin list reached the network"; else t_pass; fi
  binds=$(on_mac network_bind_addresses "$origins")
  assert_eq "$binds" "127.0.0.1" "bind addresses on a Mac"
  sandbox_drop
}

test_mac_keeps_extra_addresses_off_the_network() {
  t_begin "on a Mac an --address on the home network is not opened either"
  sandbox_new
  assert_eq "$(on_mac network_origin_list 8790 "" 192.168.1.20)" "http://127.0.0.1:8790,http://localhost:8790" "--address on a Mac"
  sandbox_drop
}

# Gives the sandbox a kernel release, so the installer sees a Linux computer that runs that kernel.
fixture_kernel() { # kernel release
  rm -f "$SB_BIN/uname"
  cat >"$SB_BIN/uname" <<UNAME
#!/usr/bin/env bash
case "\${1:-}" in
  -s) echo Linux ;;
  -r) echo $1 ;;
  -m) echo x86_64 ;;
  *) echo Linux ;;
esac
UNAME
  chmod 755 "$SB_BIN/uname"
}

test_docker_desktop_on_linux_plans_the_private_addresses() {
  t_begin "Docker Desktop on Linux still opens the app on the private addresses of this computer"
  sandbox_new
  fixture_network eth0:192.168.1.20
  fixture_kernel 6.8.0-generic
  STUB_DOCKER_OS="Docker Desktop" run_install --dry-run --email owner@example.invalid --tls off
  assert_rc 0
  assert_flat_contains "$OUT" "It opens on port 8791 at: 127.0.0.1, localhost, 192.168.1.20."
  assert_flat_contains "$OUT" "the port is open to your network"
  sandbox_drop
}

test_wsl2_plans_the_private_addresses() {
  t_begin "WSL2 still opens the app on the private addresses of this computer"
  sandbox_new
  fixture_network eth0:192.168.1.20
  fixture_kernel 5.15.153.1-microsoft-standard-WSL2
  run_install --dry-run --email owner@example.invalid --tls off
  assert_rc 0
  assert_flat_contains "$OUT" "It opens on port 8791 at: 127.0.0.1, localhost, 192.168.1.20."
  assert_flat_contains "$OUT" "the port is open to your network"
  sandbox_drop
}

test_mac_publishes_on_loopback_only
test_mac_keeps_extra_addresses_off_the_network
test_docker_desktop_on_linux_plans_the_private_addresses
test_wsl2_plans_the_private_addresses
tests_finish
