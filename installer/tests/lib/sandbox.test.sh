#!/usr/bin/env bash
# The gVisor sandbox slots: preflight, the plan, the root steps, the rendered wiring and the check at the end.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

first_line_of() { grep -Fn -- "$1" "$STUB_LOG" | head -n 1 | cut -d: -f1; }

test_dry_run_plans_the_sandbox() {
  t_begin "the dry-run plan lists the slot image, the slots, the root steps and the sandbox wording, and starts nothing"
  sandbox_new
  STUB_APPARMOR=1
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  assert_contains "$OUT" "Build the sandbox slot image amanuensis-sandbox-slot:local"
  assert_contains "$OUT" "Start the 4 sandbox slots of instance main"
  assert_contains "$OUT" "[root]"
  assert_contains "$OUT" "load the AppArmor profile aman-sandbox-slot"
  assert_contains "$OUT" "4 slot disk files of 16 GB under /var/lib/aman-slots"
  assert_contains "$OUT" "--sandbox-root"
  assert_contains "$OUT" "Run code (Python, shell, files) runs in the gVisor sandbox"
  assert_contains "$OUT" "Sandbox slot image: base images, Ubuntu packages"
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
  assert_contains "$OUT" "Start the 4 sandbox slots of instance main"
  assert_not_contains "$OUT" "[root]"
  sandbox_drop
}

test_missing_node_blocks_before_any_prompt() {
  t_begin "without Node.js the sandbox is a blocker named in plain words, before any prompt, with the way out"
  sandbox_new
  rm -f "$SB_BIN/node"
  run_install_tty "Instance name=>
Owner email=>owner@example.invalid
"
  assert_eq "$RC" 1
  assert_contains "$OUT" "This machine cannot be set up yet"
  assert_contains "$OUT" "Node.js 22.14 or newer"
  assert_contains "$OUT" "--no-sandbox"
  assert_not_contains "$OUT" "Instance name"
  assert_log_lacks "docker build"
  sandbox_drop
}

test_old_node_blocks() {
  t_begin "Node.js older than 22.14 is a blocker"
  sandbox_new
  STUB_NODE_VERSION=v22.13.1
  run_install --dry-run --email owner@example.invalid
  assert_rc 1
  assert_contains "$ERR" "Node.js 22.14 or newer"
  STUB_NODE_VERSION=v22.14.0
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  STUB_NODE_VERSION=v24.1.0
  run_install --dry-run --email owner@example.invalid
  assert_rc 0
  sandbox_drop
}

test_cgroup_v1_and_low_disk_block() {
  t_begin "cgroup v1 and too little disk for the slot disks are blockers that name --no-sandbox"
  sandbox_new
  STUB_CGROUP=1
  run_install --dry-run --email owner@example.invalid
  assert_rc 1
  assert_contains "$ERR" "cgroup v2"
  assert_contains "$ERR" "--no-sandbox"
  STUB_CGROUP=2
  STUB_DF_KB=$((15 * 1024 * 1024))
  run_install --dry-run --email owner@example.invalid
  assert_rc 1
  assert_contains "$ERR" "Less than 20 GB free for the sandbox slot disks under /var/lib/aman-slots"
  run_install --dry-run --no-sandbox --email owner@example.invalid
  assert_rc 0
  assert_not_contains "$OUT" "sandbox slot"
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
  assert_contains "$OUT" "Sandbox check for instance main:"
  assert_log_has "doctor sandbox --instance main"
  assert_contains "$OUT" "Run code: on, in the gVisor sandbox"
  assert_contains "$OUT" "aman doctor sandbox --fix"
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
  rm -f "$SB_BIN/node"
  INSTALL_EXTRA=(--no-sandbox)
  install_machine
  assert_eq "$RC" 0
  assert_log_lacks "node "
  assert_log_lacks "--entrypoint cat"
  assert_no_path "$AMAN_HOME/bin/aman-sandbox.mjs"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "SANDBOX_BACKEND"
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "slot_ctl"
  assert_eq "$(sed -n 's/^sandbox=//p' "$AMAN_HOME/state/instances/main.conf")" off
  assert_contains "$OUT" "installed with --no-sandbox"
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
  assert_contains "$ERR" "root steps that were not approved"
  assert_contains "$ERR" "--sandbox-root"
  assert_contains "$OUT" "sudo apparmor_parser -r -W $REPO/ops/sandbox-slot/apparmor/aman-sandbox-slot"
  assert_contains "$OUT" "setup-disks.sh setup /var/lib/aman-slots/<instance> 16 4"
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
Owner email=>owner@example.invalid
Address you will use=>
Model server address=>
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD
Run these root steps now?=>y"
  assert_eq "$RC" 0
  assert_contains "$OUT" "The sandbox needs these steps as root"
  assert_contains "$OUT" "setup-disks.sh setup /var/lib/aman-slots/<instance> 16 4"
  assert_not_contains "$OUT" "apparmor_parser" "only the missing part is listed"
  assert_log_has "--fix --yes"
  sandbox_drop
}

test_root_steps_declined_on_a_terminal() {
  t_begin "on a terminal a no leaves the instance uncreated and the run stops with the options"
  sandbox_new
  printf 'needs_apparmor\n' >"$SB_STATE/slots_state"
  run_install_tty "Instance name=>
Owner email=>owner@example.invalid
Address you will use=>
Model server address=>
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD
Run these root steps now?=>n"
  assert_eq "$RC" 1
  assert_contains "$OUT" "were not approved"
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
  assert_contains "$OUT" "Sandbox slots of instance main are already healthy"
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
  assert_contains "$ERR" "the sandbox slot image build failed"
  assert_contains "$ERR" "$AMAN_HOME/state/sandbox.log"
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
  assert_contains "$ERR" "has no sandbox setup"
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
  assert_contains "$ERR" "the sandbox of instance main is not ready. The fix: aman doctor sandbox --fix"
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
  assert_contains "$OUT" "Start the 4 sandbox slots of instance main"
  run_install --yes
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "SANDBOX_BACKEND: slots"
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --instance main --repo-root $REPO"
  run_install --yes
  assert_contains "$OUT" "Sandbox slots of instance main are running"
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
  sandbox_drop
}

test_node_calls_use_the_docker_access_of_the_run() {
  t_begin "the setup runs through the same Docker access as the rest of the run (sg here)"
  sandbox_new
  STUB_DOCKER_DENIED=1
  printf 'testuser\n' >"$SB_STATE/group_members"
  install_machine
  assert_log_has "sg docker -c env DOCKER_BUILDKIT=1 node $AMAN_HOME/bin/aman-sandbox.mjs --build-only"
  assert_log_has "sg docker -c env DOCKER_BUILDKIT=1 node $AMAN_HOME/bin/aman-sandbox.mjs --check --json"
  sandbox_drop
}

test_dry_run_plans_the_sandbox
test_plan_has_no_root_line_in_docker_desktop
test_missing_node_blocks_before_any_prompt
test_old_node_blocks
test_cgroup_v1_and_low_disk_block
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
tests_finish
