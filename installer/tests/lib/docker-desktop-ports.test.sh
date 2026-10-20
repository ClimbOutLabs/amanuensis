#!/usr/bin/env bash
# Where Docker publishes on this computer alone (a Mac, Docker Desktop, WSL2), the default addresses stay on loopback.
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

test_mac_publishes_on_loopback_only
test_mac_keeps_extra_addresses_off_the_network
tests_finish
