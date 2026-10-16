#!/usr/bin/env bash
# The aman command: on the path of new terminals, kept current by an upgrade, and the run that finds nothing to do.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

BLOCK_BEGIN='# >>> amanuensis (managed by the installer) >>>'
home_dir() { printf '%s/user' "$SB"; }
block_count() { grep -cF "$BLOCK_BEGIN" "$1" 2>/dev/null || true; }

test_the_path_line_is_managed_once() {
  t_begin "a managed line puts aman on the path in bash, once, keeping the file's other lines and mode"
  sandbox_new
  printf 'alias ll="ls -l"\n' >"$(home_dir)/.bashrc"
  chmod 600 "$(home_dir)/.bashrc"
  RUN_ENV_EXTRA=(SHELL=/bin/bash)
  install_machine
  assert_eq "$(block_count "$(home_dir)/.bashrc")" 1
  assert_contains "$(cat "$(home_dir)/.bashrc")" 'alias ll="ls -l"'
  assert_contains "$(cat "$(home_dir)/.bashrc")" 'export PATH="'
  assert_mode "$(home_dir)/.bashrc" 600
  assert_no_path "$(home_dir)/.zshrc"
  assert_mode "$AMAN_HOME/bin/aman" 755
  run_install upgrade
  assert_rc 0
  assert_eq "$(block_count "$(home_dir)/.bashrc")" 1 "a second run adds nothing"
  sandbox_drop
}

test_zsh_gets_its_own_profile() {
  t_begin "a zsh user gets the line in .zshrc"
  sandbox_new
  RUN_ENV_EXTRA=(SHELL=/bin/zsh)
  install_machine
  assert_eq "$(block_count "$(home_dir)/.zshrc")" 1
  assert_no_path "$(home_dir)/.bash_profile"
  sandbox_drop
}

test_the_plan_names_the_command_row() {
  t_begin "the plan offers 'Install the aman command' with the profile it edits, and later shows it done"
  sandbox_new
  RUN_ENV_EXTRA=(SHELL=/bin/bash)
  run_install --dry-run --email owner@example.invalid
  assert_flat_contains "$OUT" "Install the aman command"
  assert_flat_contains "$OUT" ".bashrc"
  install_machine
  run_install --dry-run
  assert_flat_contains "$OUT" "The aman command is installed"
  assert_not_contains "$OUT" "Install the aman command"
  sandbox_drop
}

test_upgrade_restores_the_command_and_its_files() {
  t_begin "upgrade puts back an altered command and helper file, and the path line"
  sandbox_new
  RUN_ENV_EXTRA=(SHELL=/bin/bash)
  install_machine
  printf '#!/bin/sh\nexit 9\n' >"$AMAN_HOME/bin/aman"
  printf 'broken\n' >"$AMAN_HOME/lib/schedule.sh"
  : >"$(home_dir)/.bashrc"
  run_install upgrade
  assert_rc 0
  assert_eq "$(cmp -s "$SB_INSTALLER/doctor/aman" "$AMAN_HOME/bin/aman" && echo same)" same
  assert_eq "$(cmp -s "$SB_INSTALLER/lib/schedule.sh" "$AMAN_HOME/lib/schedule.sh" && echo same)" same
  assert_eq "$(block_count "$(home_dir)/.bashrc")" 1
  sandbox_drop
}

test_the_command_subcommand_puts_the_files_back() {
  t_begin "install.sh command restores a missing shim and helper files and touches nothing else"
  sandbox_new
  install_machine
  rm -f "$AMAN_HOME/bin/aman" "$AMAN_HOME/lib/shared.sh" "$AMAN_HOME/lib/network.sh"
  local builds
  builds=$(log_count "docker build")
  run_install command
  assert_rc 0
  assert_flat_contains "$OUT" "The aman command is installed"
  assert_eq "$(cmp -s "$SB_INSTALLER/doctor/aman" "$AMAN_HOME/bin/aman" && echo same)" same
  assert_eq "$(cmp -s "$SB_INSTALLER/lib/shared.sh" "$AMAN_HOME/lib/shared.sh" && echo same)" same
  assert_eq "$(cmp -s "$SB_INSTALLER/lib/network.sh" "$AMAN_HOME/lib/network.sh" && echo same)" same
  assert_eq "$(log_count "docker build")" "$builds"
  sandbox_drop
}

test_a_rerun_with_nothing_to_do_still_checks_run_code() {
  t_begin "a run with nothing to change still checks Run code, says it is not ready, and exits 1"
  sandbox_new
  install_machine
  STUB_SANDBOX_DOCTOR_EXIT=1
  run_install --yes --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$OUT" "Run code not ready: aman doctor sandbox --fix"
  assert_flat_contains "$OUT" "Nothing to change, but the checks found a problem"
  unset STUB_SANDBOX_DOCTOR_EXIT
  run_install --yes --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT" "Run code"
  assert_flat_contains "$OUT" "on, in a sandbox"
  sandbox_drop
}

test_a_busy_port_moves_the_instance() {
  t_begin "an install takes the next free port when something already listens on the first"
  sandbox_new
  python3 -c 'import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 8791))
s.listen(1)
time.sleep(120)' &
  local holder=$!
  local waited=0
  while ! python3 -c 'import socket,sys
s=socket.socket()
sys.exit(0 if s.connect_ex(("127.0.0.1",8791))==0 else 1)' 2>/dev/null && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  install_machine || true
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/state/instances/main.conf")" "app_port=8792"
  sandbox_drop
}

test_the_proxy_requirements_belong_to_public_urls() {
  t_begin "a default install does not print reverse proxy requirements (the --public-url install does: instance tests)"
  sandbox_new
  install_machine
  assert_not_contains "$OUT$ERR" "Requirements for your reverse proxy"
  assert_not_contains "$OUT$ERR" "reverse proxy"
  sandbox_drop
}

test_the_path_line_is_managed_once
test_zsh_gets_its_own_profile
test_the_plan_names_the_command_row
test_upgrade_restores_the_command_and_its_files
test_the_command_subcommand_puts_the_files_back
test_a_rerun_with_nothing_to_do_still_checks_run_code
test_a_busy_port_moves_the_instance
test_the_proxy_requirements_belong_to_public_urls
tests_finish
