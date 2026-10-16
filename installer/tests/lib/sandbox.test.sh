#!/usr/bin/env bash
# The sandbox: preflight, the plan, the root steps, the rendered wiring and the check at the end.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

first_line_of() { grep -Fn -- "$1" "$STUB_LOG" | head -n 1 | cut -d: -f1; }

test_dry_run_plans_the_sandbox() {
  t_begin "the dry-run plan lists the sandbox, its instances, the root steps and the sandbox wording, and starts nothing"
  sandbox_new
  STUB_APPARMOR=1
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT" "Build the sandbox"
  assert_flat_contains "$OUT" "Start 4 sandboxes for main"
  assert_flat_contains "$OUT" "needs admin Set up the sandbox on this computer"
  assert_flat_contains "$OUT" "Needs admin. Adds a security rule for the sandbox and sets up 4 disks of up to 16 GB that use space only as they fill."
  assert_flat_contains "$OUT" "Each part is skipped if it is already in place."
  assert_flat_contains "$OUT" "--sandbox-root"
  assert_flat_contains "$OUT" "Run code (Python, shell, files) runs in a sandbox"
  run_install --dry-run --verbose --email owner@example.invalid
  assert_flat_contains "$OUT" "The sandbox: base images, Ubuntu packages"
  assert_log_lacks "aman-sandbox.mjs"
  assert_log_lacks "docker build"
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_plan_has_no_root_line_in_docker_desktop() {
  t_begin "Docker Desktop has no host disks or profile to set up, so the plan has no root step for the sandbox"
  sandbox_new
  STUB_DOCKER_OS="Docker Desktop"
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT" "Start 4 sandboxes for main"
  assert_not_contains "$OUT" "needs admin"
  sandbox_drop
}

test_no_host_node_is_needed() {
  t_begin "a machine with no Node.js installs: the pinned runtime is downloaded, checked and used"
  sandbox_new
  install_machine
  assert_eq "$RC" 0
  assert_file "$AMAN_HOME/runtime/node/bin/node"
  assert_mode "$AMAN_HOME/runtime/node/bin/node" 755
  assert_mode "$AMAN_HOME/runtime/node" 700
  assert_eq "$("$AMAN_HOME/runtime/node/bin/node" --version)" "v$NODE_PIN_VERSION"
  assert_log_has "curl -fsSL --proto =https --tlsv1.2 -o"
  assert_log_has "https://nodejs.org/dist/v$NODE_PIN_VERSION/node-v$NODE_PIN_VERSION-"
  assert_flat_contains "$OUT$ERR" "Downloading Node.js v$NODE_PIN_VERSION"
  assert_eq "$(log_count 'https://nodejs.org')" 1 "one download"
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --build-only"
  assert_no_path "$SB/user/.node"
  assert_eq "$(find "$AMAN_HOME/runtime" -type f | wc -l | tr -d ' ')" 1 "only the node binary is kept"
  sandbox_drop
}

test_plan_lists_the_runtime_download() {
  t_begin "the plan and --print-network list the Node.js download from nodejs.org, and a present runtime is not downloaded again"
  sandbox_new
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT" "Download Node.js v$NODE_PIN_VERSION ("
  assert_flat_contains "$OUT" "from nodejs.org"
  assert_flat_contains "$OUT" "Checked before use. Only the sandbox setup uses it; nothing is installed system-wide."
  run_install --dry-run --verbose --email owner@example.invalid
  assert_flat_contains "$OUT" "Node.js that sets up the sandbox"
  assert_flat_contains "$OUT" "nodejs.org"
  assert_log_lacks "curl "
  run_install --print-network
  assert_contains "$OUT" "nodejs.org"
  install_machine
  : >"$STUB_LOG"
  run_install --dry-run
  assert_rc 0
  assert_flat_contains "$OUT" "Node.js v$NODE_PIN_VERSION for the sandbox setup is downloaded"
  assert_not_contains "$OUT" "Download Node.js"
  run_install instance add second --yes --password-stdin --email second@example.invalid </dev/null
  assert_log_lacks "https://nodejs.org" "an installed runtime is reused"
  sandbox_drop
}

test_platform_selection() {
  t_begin "the tarball and the pinned hash follow the kernel and CPU: linux and darwin, x64 and arm64"
  local pair os arch plat
  for pair in "Linux x86_64 linux-x64" "Linux aarch64 linux-arm64" "Linux arm64 linux-arm64" "Darwin x86_64 darwin-x64" "Darwin arm64 darwin-arm64"; do
    read -r os arch plat <<<"$pair"
    sandbox_new
    fixture_uname "$os" "$arch"
    run_install --dry-run --email owner@example.invalid
    assert_rc 0
    assert_flat_contains "$OUT" "Download Node.js v$NODE_PIN_VERSION ($plat) from nodejs.org" "$os $arch"
    sandbox_drop
  done
  sandbox_new
  fixture_uname Linux aarch64
  install_machine
  assert_log_has "node-v$NODE_PIN_VERSION-linux-arm64.tar.gz"
  assert_not_contains "$(cat "$STUB_LOG")" "linux-x64"
  sandbox_drop
}

test_unsupported_machine_is_a_blocker() {
  t_begin "a CPU nodejs.org has no build for blocks with the host-Node and no-sandbox ways out"
  sandbox_new
  fixture_uname Linux riscv64
  run_install --dry-run --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "no official Node.js build for this computer (Linux riscv64)"
  assert_flat_contains "$OUT$ERR" "--use-host-node"
  assert_flat_contains "$OUT$ERR" "--no-sandbox"
  assert_log_lacks "curl "
  sandbox_drop
}

test_download_needs_curl_or_wget() {
  t_begin "without curl or wget the download is a blocker before any prompt"
  sandbox_new
  rm -f "$SB_BIN/curl"
  run_install --dry-run --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "needs curl or wget"
  sandbox_drop
}

test_checksum_mismatch_is_refused() {
  t_begin "a tarball that does not match the pinned SHA-256 is refused and nothing is kept"
  sandbox_new
  STUB_CURL_CORRUPT=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "does not match the pinned SHA-256"
  assert_flat_contains "$ERR" "so it was not used"
  assert_no_path "$AMAN_HOME/runtime/node/bin/node"
  assert_log_lacks "aman-sandbox.mjs"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  assert_eq "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'aman-node.*' -newer "$STUB_LOG" 2>/dev/null | wc -l | tr -d ' ')" 0 "the scratch download is removed"
  sandbox_drop
}

test_download_failure_is_explained() {
  t_begin "a failed download names the address and nothing else is changed"
  sandbox_new
  STUB_CURL_FAIL=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "could not download https://nodejs.org/dist/v$NODE_PIN_VERSION/node-v$NODE_PIN_VERSION-"
  assert_no_path "$AMAN_HOME/runtime/node/bin/node"
  sandbox_drop
}

test_host_node_only_by_opt_in() {
  t_begin "a suitable host Node.js is used only with --use-host-node; without the flag the pinned runtime is used"
  sandbox_new
  fixture_host_node
  install_machine
  assert_file "$AMAN_HOME/runtime/node/bin/node" "the host Node.js is ignored by default"
  sandbox_drop
  sandbox_new
  fixture_host_node
  INSTALL_EXTRA=(--use-host-node)
  install_machine
  assert_eq "$RC" 0
  assert_no_path "$AMAN_HOME/runtime"
  assert_log_lacks "https://nodejs.org"
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --build-only"
  assert_not_contains "$OUT" "Download Node.js"
  sandbox_drop
}

test_host_node_opt_in_needs_a_new_enough_node() {
  t_begin "--use-host-node with no Node.js, or one older than 22.14, is a blocker (no silent fallback)"
  sandbox_new
  run_install --dry-run --use-host-node --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "--use-host-node needs Node.js 22.14 or newer"
  fixture_host_node
  STUB_NODE_VERSION=v22.13.1
  run_install --dry-run --use-host-node --email owner@example.invalid
  assert_rc 1
  STUB_NODE_VERSION=v22.14.0
  run_install --dry-run --use-host-node --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT" "Node.js on this computer sets up the sandbox (--use-host-node)"
  STUB_NODE_VERSION=v24.1.0
  run_install --dry-run --use-host-node --email owner@example.invalid
  assert_rc 0
  sandbox_drop
}

test_cgroup_and_low_disk() {
  t_begin "cgroup v1 only warns, an unknown cgroup setup blocks, and too little disk for the slot disks blocks"
  sandbox_new
  STUB_CGROUP=1
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_flat_contains "$OUT$ERR" "cgroup v1"
  STUB_CGROUP=3
  run_install --dry-run --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "unknown cgroup setup"
  assert_flat_contains "$OUT$ERR" "--no-sandbox"
  STUB_CGROUP=2
  STUB_DF_KB=$((15 * 1024 * 1024))
  run_install --dry-run --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "Less than 20 GB free for the sandbox disks under /var/lib/aman-slots"
  run_install --dry-run --no-sandbox --email owner@example.invalid
  assert_rc 0
  assert_not_contains "$OUT" "slot"
  sandbox_drop
}

test_install_builds_then_starts_slots_then_the_instance() {
  t_begin "install builds the slot image with the setup from the app image, starts the slots, then the instance with the wiring"
  sandbox_new
  install_machine
  assert_eq "$RC" 0
  assert_file "$AMAN_HOME/bin/aman-sandbox.mjs"
  assert_eq "$(cat "$AMAN_HOME/bin/aman-sandbox.mjs")" "// stub sandbox setup" "taken from the app image"
  assert_eq "$(cat "$AMAN_HOME/state/source")" "$REPO" "the doctor learns where the compose files are"
  assert_log_has "docker run --rm --entrypoint cat aman-app:"
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --build-only --instance main --repo-root $REPO"
  assert_log_has "--log-file $AMAN_HOME/state/sandbox.log --command-name aman doctor sandbox"
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --check --json --instance main"
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --instance main --repo-root $REPO"
  local build up slots
  build=$(first_line_of "--build-only")
  slots=$(first_line_of "node $AMAN_HOME/bin/aman-sandbox.mjs --instance main")
  up=$(first_line_of "docker compose --project-name aman-main")
  if [ "$build" -lt "$slots" ] && [ "$slots" -lt "$up" ]; then t_pass; else t_fail "order: image build $build, slots $slots, instance $up"; fi
  assert_not_contains "$OUT" "Sandbox check for instance main:" "the check is quiet when the sandbox answers"
  assert_log_has "doctor sandbox --instance main"
  assert_flat_contains "$OUT" "Run code on, in a sandbox"
  assert_eq "$(printf '%s\n' "$OUT" | grep -c 'run_code')" 0 "the sandbox row is not printed twice"
  assert_eq "$(sed -n 's/^sandbox=//p' "$AMAN_HOME/state/instances/main.conf")" slots
  sandbox_drop
}

test_rendered_compose_wires_the_app_to_the_slots() {
  t_begin "the instance compose connects the app to the slots with read-only control volumes and no Docker socket"
  sandbox_new
  install_machine
  local compose
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_contains "$compose" "SANDBOX_BACKEND: slots"
  assert_contains "$compose" "SANDBOX_SLOTS: '4'"
  assert_contains "$compose" "SANDBOX_SLOTS_DIR: /run/aman-slots"
  assert_contains "$compose" "- slot_ctl_1:/run/aman-slots/1:ro"
  assert_contains "$compose" "- slot_ctl_4:/run/aman-slots/4:ro"
  assert_contains "$compose" "name: main_slot_ctl_3"
  assert_not_contains "$compose" "docker.sock"
  assert_not_contains "$compose" "slot_ws_"
  assert_not_contains "$compose" "@@"
  assert_contains "$(cat "$SB_STATE/volumes")" "main_slot_ctl_1" "the slots project created the volumes the app mounts"
  sandbox_drop
}

test_install_without_sandbox() {
  t_begin "--no-sandbox installs without node, the wiring or any slot step, and says run code is off"
  sandbox_new
  INSTALL_EXTRA=(--no-sandbox)
  install_machine
  assert_eq "$RC" 0
  assert_log_lacks "node "
  assert_log_lacks "--entrypoint cat"
  assert_log_lacks "https://nodejs.org" "no runtime is downloaded for an install without the sandbox"
  assert_no_path "$AMAN_HOME/runtime"
  assert_no_path "$AMAN_HOME/bin/aman-sandbox.mjs"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "SANDBOX_BACKEND"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "slot_ctl"
  assert_eq "$(sed -n 's/^sandbox=//p' "$AMAN_HOME/state/instances/main.conf")" off
  assert_flat_contains "$OUT" "installed with --no-sandbox"
  assert_log_lacks "doctor sandbox"
  # A second run does not bring the sandbox back for that instance.
  run_install --yes
  assert_rc 0
  assert_contains "$OUT" "Nothing to do"
  sandbox_drop
}

test_root_steps_need_consent_yes_is_not_enough() {
  t_begin "--yes alone never runs the root steps: it stops before the instance exists and names the way to approve"
  sandbox_new
  printf 'needs_apparmor\n' >"$SB_STATE/slots_state"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "administrator rights that were not given"
  assert_flat_contains "$ERR" "--sandbox-root"
  assert_flat_contains "$OUT" "The sandbox needs administrator rights on this computer."
  assert_flat_contains "$OUT" "adds a security rule for the sandbox"
  assert_flat_contains "$OUT" "sets up 4 disks of up to 16 GB that use space only as they fill"
  assert_not_contains "$OUT" "setup-disks.sh"
  assert_log_lacks "--fix"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  assert_log_lacks "docker compose --project-name aman-main"
  assert_no_path "$AMAN_HOME/state/lock"
  sandbox_drop
}

test_root_steps_with_the_flag() {
  t_begin "--sandbox-root approves the printed root steps and passes --fix --yes to the setup"
  sandbox_new
  printf 'needs_apparmor\n' >"$SB_STATE/slots_state"
  INSTALL_EXTRA=(--sandbox-root)
  install_machine
  assert_eq "$RC" 0
  assert_log_has "--instance main --repo-root $REPO --log-file $AMAN_HOME/state/sandbox.log --command-name aman doctor sandbox"
  assert_log_has "--fix --yes"
  assert_eq "$(cat "$SB_STATE/slots_state")" ready
  sandbox_drop
}

test_root_steps_answered_yes_on_a_terminal() {
  t_begin "on a terminal the root steps are shown and run after a yes"
  sandbox_new
  printf 'needs_disk\n' >"$SB_STATE/slots_state"
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>y
Password for owner@example.invalid=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD
Set up the sandbox now?=>y"
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "The sandbox needs administrator rights on this computer."
  assert_flat_contains "$OUT" "sets up 4 disks of up to 16 GB"
  assert_not_contains "$OUT" "loads again at every start" "only the missing part is listed"
  assert_log_has "--fix --yes"
  sandbox_drop
}

test_root_steps_declined_on_a_terminal() {
  t_begin "on a terminal a no leaves the instance uncreated and the run stops with the options"
  sandbox_new
  printf 'needs_apparmor\n' >"$SB_STATE/slots_state"
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
Back up automatically=>y
Go ahead?=>y
Password for owner@example.invalid=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD
Set up the sandbox now?=>n"
  assert_eq "$RC" 1
  assert_flat_contains "$OUT$ERR" "administrator rights that were not given"
  assert_log_lacks "--fix --yes"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_healthy_slots_need_no_root() {
  t_begin "slots that already pass their check are reused with no root step and no start"
  sandbox_new
  mkdir -p "$SB_STATE/up"
  : >"$SB_STATE/up/main-slots"
  printf 'main_slot_ctl_1\nmain_slot_ctl_2\nmain_slot_ctl_3\nmain_slot_ctl_4\n' >"$SB_STATE/volumes"
  printf 'ready\n' >"$SB_STATE/slots_state"
  install_machine
  assert_contains "$OUT" "The sandboxes of instance main are already healthy"
  assert_log_lacks "--fix"
  sandbox_drop
}

test_slot_image_failure_stops_before_anything_runs() {
  t_begin "a failed slot image build stops the install with the log path and starts no instance"
  sandbox_new
  STUB_SLOT_BUILD_RC=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "Building the sandbox failed"
  assert_flat_contains "$ERR" "$AMAN_HOME/state/sandbox.log"
  assert_log_lacks "docker compose --project-name aman-main"
  sandbox_drop
}

test_image_without_the_setup_is_explained() {
  t_begin "an app image that lacks the sandbox setup says to run the installer again"
  sandbox_new
  STUB_NO_BUNDLE=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "has no sandbox setup"
  sandbox_drop
}

test_failed_verification_fails_the_install_with_the_repair() {
  t_begin "when the final sandbox check fails the install exits non-zero and names aman doctor sandbox --fix"
  sandbox_new
  STUB_SANDBOX_DOCTOR_EXIT=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$OUT" "Run code not ready: aman doctor sandbox --fix"
  assert_flat_contains "$OUT" "Running, but the checks found a problem"
  assert_contains "$OUT" "Instance main" "the summary was still printed"
  sandbox_drop
}

test_second_instance_gets_its_own_slots() {
  t_begin "instance add gives the new instance its own slots project and volumes"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email second@example.invalid
  clear_input
  assert_rc 0
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --instance second --repo-root $REPO"
  assert_contains "$(cat "$AMAN_HOME/instances/second/compose.yaml")" "name: second_slot_ctl_1"
  assert_not_contains "$(cat "$AMAN_HOME/instances/second/compose.yaml")" "main_slot"
  assert_log_has "doctor sandbox --instance second"
  sandbox_drop
}

test_instance_add_without_the_sandbox() {
  t_begin "instance add --no-sandbox leaves that instance without slots while the first keeps them"
  sandbox_new
  install_machine
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add plain --yes --no-sandbox --password-stdin --email plain@example.invalid
  clear_input
  assert_rc 0
  assert_not_contains "$(cat "$AMAN_HOME/instances/plain/compose.yaml")" "SANDBOX_BACKEND"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "SANDBOX_BACKEND: slots"
  assert_log_lacks "doctor sandbox --instance plain"
  sandbox_drop
}

test_remove_stops_the_slots() {
  t_begin "removing an instance stops its slots, and --purge-data purges them"
  sandbox_new
  install_machine
  run_install instance remove main
  assert_rc 0
  assert_log_has "aman-sandbox.mjs --down --instance main"
  assert_log_lacks "--down --purge"
  install_machine
  run_install instance remove main --purge-data --confirm-name main
  assert_rc 0
  assert_log_has "aman-sandbox.mjs --down --purge --instance main"
  sandbox_drop
}

test_existing_instance_without_wiring_gets_it() {
  t_begin "an instance from before the sandbox gets the slots and the wiring on the next run"
  sandbox_new
  INSTALL_EXTRA=(--no-sandbox)
  install_machine
  sed -i '/^sandbox=/d' "$AMAN_HOME/state/instances/main.conf"
  run_install --dry-run
  assert_rc 0
  assert_contains "$OUT" "Start 4 sandboxes for main"
  run_install --yes
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "SANDBOX_BACKEND: slots"
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --instance main --repo-root $REPO"
  run_install --yes
  assert_contains "$OUT" "The 4 sandboxes of instance main are running"
  sandbox_drop
}

test_upgrade_refreshes_the_setup_and_image() {
  t_begin "an upgrade takes the new setup out of the new app image and rebuilds the slot image"
  sandbox_new
  install_machine
  : >"$STUB_LOG"
  printf 'echo changed\n' >>"$REPO/Dockerfile.dev"
  (cd "$REPO" && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m change)
  run_install upgrade --force
  assert_rc 0
  assert_log_has "--entrypoint cat aman-app:"
  assert_log_has "aman-sandbox.mjs --build-only"
  assert_log_has "aman-sandbox.mjs --instance main --repo-root" "the slots are started again so a rebuilt image replaces them"
  sandbox_drop
}

test_node_calls_use_the_docker_access_of_the_run() {
  t_begin "the setup runs through the same Docker access as the rest of the run (sg here)"
  sandbox_new
  STUB_DOCKER_DENIED=1
  printf 'testuser\n' >"$SB_STATE/group_members"
  install_machine
  assert_log_has "sg docker -c env DOCKER_BUILDKIT=1 $AMAN_HOME/runtime/node/bin/node $AMAN_HOME/bin/aman-sandbox.mjs --build-only"
  assert_log_has "sg docker -c env DOCKER_BUILDKIT=1 $AMAN_HOME/runtime/node/bin/node $AMAN_HOME/bin/aman-sandbox.mjs --check --json"
  sandbox_drop
}

# A systemd host whose docker.service is or is not enabled at boot.
fixture_systemd() {
  local rc=0
  [ "$1" = enabled ] || rc=1
  cat >"$SB_BIN/systemctl" <<SC
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >>"\$STUB_LOG"
case "\${1:-}" in
  cat) exit 0 ;;
  is-enabled) exit $rc ;;
esac
exit 0
SC
  chmod 755 "$SB_BIN/systemctl"
}

test_docker_is_enabled_at_boot_with_consent() {
  t_begin "when Docker does not start at boot the root step is shown and run with --sandbox-root"
  sandbox_new
  fixture_systemd disabled
  INSTALL_EXTRA=(--sandbox-root)
  install_machine
  assert_eq "$RC" 0
  assert_flat_contains "$OUT" "Docker does not start when this computer does"
  assert_not_contains "$OUT" "systemctl"
  assert_log_has "sudo systemctl enable docker"
  sandbox_drop
}

test_docker_boot_needs_consent_but_does_not_stop_the_install() {
  t_begin "--yes alone does not enable Docker at boot; the install finishes and says what a restart would do"
  sandbox_new
  fixture_systemd disabled
  install_machine
  assert_eq "$RC" 0
  assert_log_lacks "sudo systemctl enable docker"
  assert_flat_contains "$ERR$OUT" "after a restart the sandbox stays down until you run: aman doctor sandbox --fix"
  sandbox_drop
}

test_nothing_to_enable_when_docker_starts_at_boot() {
  t_begin "no boot step when Docker is already enabled"
  sandbox_new
  fixture_systemd enabled
  install_machine
  assert_not_contains "$OUT" "does not start at boot"
  assert_log_lacks "sudo systemctl enable docker"
  sandbox_drop
}

test_slots_come_back_after_a_restart() {
  t_begin "the slots and the instance restart with Docker: every service restarts unless stopped"
  sandbox_new
  install_machine
  local compose slots
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_eq "$(printf '%s\n' "$compose" | grep -c 'restart: unless-stopped')" 3 "loopback, app and dex"
  slots=$(cat "$INSTALLER_DIR/../docker-compose.slots.yml")
  assert_contains "$slots" "restart: unless-stopped"
  sandbox_drop
}

test_dry_run_plans_the_sandbox
test_plan_has_no_root_line_in_docker_desktop
test_no_host_node_is_needed
test_plan_lists_the_runtime_download
test_platform_selection
test_unsupported_machine_is_a_blocker
test_download_needs_curl_or_wget
test_checksum_mismatch_is_refused
test_download_failure_is_explained
test_host_node_only_by_opt_in
test_host_node_opt_in_needs_a_new_enough_node
test_cgroup_and_low_disk
test_install_builds_then_starts_slots_then_the_instance
test_rendered_compose_wires_the_app_to_the_slots
test_install_without_sandbox
test_root_steps_need_consent_yes_is_not_enough
test_root_steps_with_the_flag
test_root_steps_answered_yes_on_a_terminal
test_root_steps_declined_on_a_terminal
test_healthy_slots_need_no_root
test_slot_image_failure_stops_before_anything_runs
test_image_without_the_setup_is_explained
test_failed_verification_fails_the_install_with_the_repair
test_second_instance_gets_its_own_slots
test_instance_add_without_the_sandbox
test_remove_stops_the_slots
test_existing_instance_without_wiring_gets_it
test_upgrade_refreshes_the_setup_and_image
test_node_calls_use_the_docker_access_of_the_run
test_docker_is_enabled_at_boot_with_consent
test_docker_boot_needs_consent_but_does_not_stop_the_install
test_nothing_to_enable_when_docker_starts_at_boot
test_slots_come_back_after_a_restart
tests_finish
