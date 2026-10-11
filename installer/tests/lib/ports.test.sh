#!/usr/bin/env bash
# Free loopback port selection.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Runs a snippet with the installer libraries loaded and only the sandbox tools on PATH.
in_lib() {
  PATH=$SB_BIN STUB_BUSY_PORTS="${BUSY:-}" "$SB_BIN/bash" -c ". '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/ports.sh'; $1"
}

test_picks_first_free_port_with_listener_table() {
  t_begin "ports in use or owned by another instance are skipped"
  sandbox_new
  rm -f "$SB_BIN/python3"
  BUSY="9001 9002"
  assert_eq "$(in_lib 'pick_port 9001 "9003"')" 9004 "busy and reserved skipped"
  BUSY=
  assert_eq "$(in_lib 'pick_port 9001 ""')" 9001 "free port taken as is"
  sandbox_drop
}

test_container_side_ports_are_never_picked() {
  t_begin "ports the stack uses inside its namespace are never handed out"
  sandbox_new
  rm -f "$SB_BIN/python3"
  BUSY=
  assert_eq "$(in_lib 'pick_port 8790 ""')" 8791
  assert_eq "$(in_lib 'pick_port 5558 ""')" 5559
  sandbox_drop
}

test_explicit_port_checks() {
  t_begin "an explicit port is validated, never silently moved"
  sandbox_new
  rm -f "$SB_BIN/python3"
  BUSY="9100"
  if in_lib 'check_port_usable 9100 "" --port' >/dev/null 2>&1; then t_fail "busy port accepted"; else t_pass; fi
  BUSY=
  if in_lib 'check_port_usable 9101 "9101" --port' >/dev/null 2>&1; then t_fail "owned port accepted"; else t_pass; fi
  if in_lib 'check_port_usable 80 "" --port' >/dev/null 2>&1; then t_fail "privileged port accepted"; else t_pass; fi
  if in_lib 'check_port_usable 9102 "" --port' >/dev/null 2>&1; then t_pass; else t_fail "free port refused"; fi
  sandbox_drop
}

test_real_bind_detects_listener() {
  t_begin "a real listener on loopback is detected by the bind test"
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'skip: python3 missing\n'
    return 0
  fi
  sandbox_new
  local port
  # The listener picks its own port and reports it, then waits to be killed.
  python3 -c 'import socket, sys, time
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(1)
print(s.getsockname()[1], flush=True)
time.sleep(30)' >"$SB/listener.out" &
  local pid=$!
  local n=0
  while [ ! -s "$SB/listener.out" ] && [ "$n" -lt 50 ]; do
    sleep 0.1
    n=$((n + 1))
  done
  port=$(head -n 1 "$SB/listener.out")
  if in_lib "port_in_use $port"; then t_pass; else t_fail "listener on $port not detected"; fi
  assert_eq "$(in_lib "pick_port $port \"\"")" "$((port + 1))" "next port after a real listener"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sandbox_drop
}

test_picks_first_free_port_with_listener_table
test_container_side_ports_are_never_picked
test_explicit_port_checks
test_real_bind_detects_listener
tests_finish
