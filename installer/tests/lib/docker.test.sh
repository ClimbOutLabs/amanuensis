#!/usr/bin/env bash
# Docker detection, unsupported runtimes, the docker group path and the Linux install offer.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

test_rootless_is_unsupported() {
  t_begin "rootless Docker is reported as unsupported"
  sandbox_new
  STUB_ROOTLESS=1
  run_install --dry-run
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "Rootless Docker is not supported"
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_podman_is_unsupported() {
  t_begin "Podman is reported as unsupported"
  sandbox_new
  STUB_PODMAN=1
  run_install --dry-run
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "Podman is not supported"
  sandbox_drop
}

test_old_engine_and_compose_v1() {
  t_begin "an old Engine or Compose v1 stops the install with a plain reason"
  sandbox_new
  STUB_ENGINE_VERSION=20.10.24
  run_install --dry-run
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "too old"
  unset STUB_ENGINE_VERSION
  STUB_COMPOSE_VERSION=1.29.2
  run_install --dry-run
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "Compose 1.29.2 is too old; v2 or newer is required"
  sandbox_drop
}

test_compose_v2_or_newer_passes() {
  local version
  t_begin "Compose v2 and newer pass, with or without a leading v"
  for version in v5.2.0 5.2.0 2.29.1 v2.40.0 5.2.0-desktop.1; do
    sandbox_new
    STUB_COMPOSE_VERSION=$version
    run_install --dry-run --verbose
    assert_not_contains "$OUT$ERR" "Docker Compose" "$version"
    assert_contains "$OUT" "Compose ${version#v}" "$version"
    sandbox_drop
  done
}

test_unreadable_compose_version_is_named() {
  local version
  t_begin "an empty or garbage Compose version is rejected and named"
  for version in "" garbage "unknown command"; do
    sandbox_new
    STUB_COMPOSE_VERSION=$version
    run_install --dry-run
    assert_rc 1
    assert_flat_contains "$OUT$ERR" "Could not read the Docker Compose version (got '$version')"
    sandbox_drop
  done
}

test_blocker_stops_before_any_prompt() {
  t_begin "a runtime blocker exits non-zero before the instance prompts"
  sandbox_new
  STUB_COMPOSE_VERSION=1.29.2
  run_install_tty "Instance name=>
Your email=>owner@example.invalid
"
  assert_eq "$RC" 1
  assert_contains "$OUT" "Stopped before changing anything"
  assert_flat_contains "$OUT" "Compose 1.29.2 is too old"
  assert_not_contains "$OUT" "Instance name"
  assert_not_contains "$OUT" "Password"
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_daemon_down() {
  t_begin "a stopped daemon gets a start instruction and changes nothing"
  sandbox_new
  STUB_DOCKER_DOWN=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "not running"
  assert_no_path "$AMAN_HOME/state/instances"
  sandbox_drop
}

test_group_member_without_relogin_uses_sg() {
  t_begin "docker group membership without a new login runs through sg and notes the sign-out"
  sandbox_new
  STUB_DOCKER_DENIED=1
  printf 'testuser\n' >"$SB_STATE/group_members"
  install_machine
  assert_contains "$OUT" "Sign out and back in"
  assert_contains "$OUT" "without a re-login"
  assert_log_has "sg docker -c"
  assert_log_lacks "usermod"
  assert_log_lacks "sudo docker"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  assert_contains "$(cat "$STUB_LOG")" "sg docker -c env DOCKER_BUILDKIT=1 docker build"
  assert_tree_lacks "$AMAN_HOME" "$SENTINEL_PASSWORD"
  assert_not_contains "$(cat "$STUB_LOG")" "$SENTINEL_PASSWORD"
  assert_log_has "sg docker -c env AMANUENSIS_HOME=$AMAN_HOME HOME=$SB/user timeout 180 $AMAN_HOME/bin/aman doctor"
  run_install instance list
  assert_rc 0
  assert_log_has "sg docker -c env AMANUENSIS_HOME=$AMAN_HOME HOME=$SB/user timeout 60 $AMAN_HOME/bin/aman doctor --json --instance main --local"
  repo_commit_change "upgrade under sg"
  run_install upgrade
  assert_rc 0
  assert_eq "$(grep -c 'sg docker -c env AMANUENSIS_HOME=.* doctor --json --local --instance main$' "$STUB_LOG")" 1 "the upgrade preflight runs the doctor with the run's access, once per instance that had data"
  assert_eq "$(grep -c '^doctor ' "$STUB_LOG")" "$(grep -c 'sg docker -c env AMANUENSIS_HOME' "$STUB_LOG")" "every doctor call went through sg"
  sandbox_drop
}

test_doctor_follows_sudo_access() {
  t_begin "when the run uses sudo for Docker (after consent), the doctor does too"
  sandbox_new
  STUB_DOCKER_DENIED=1
  : >"$SB_STATE/group_members"
  rm -f "$SB_BIN/sg"
  INSTALL_EXTRA=(--add-docker-group)
  install_machine
  assert_flat_contains "$ERR" "using sudo for Docker during this run only"
  assert_log_has "sudo env AMANUENSIS_HOME=$AMAN_HOME HOME=$SB/user timeout 180 $AMAN_HOME/bin/aman doctor"
  sandbox_drop
}

test_non_member_is_added_then_sg() {
  t_begin "a user outside the docker group is added with consent and continues through sg"
  sandbox_new
  STUB_DOCKER_DENIED=1
  : >"$SB_STATE/group_members"
  INSTALL_EXTRA=(--add-docker-group)
  install_machine
  assert_log_has "sudo usermod -aG docker testuser"
  assert_log_has "sg docker -c"
  assert_contains "$OUT" "Sign out and back in"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_install_offer_declined() {
  t_begin "declining the Docker offer installs nothing"
  sandbox_new
  os_release_ubuntu
  rm -f "$SB_BIN/docker"
  with_input "

y
n
"
  run_install --name main --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$ERR" "nothing was installed"
  assert_log_lacks "sudo "
  assert_no_path "$SB_BIN/docker"
  assert_no_path "$AMAN_HOME/state/instances"
  clear_input
  sandbox_drop
}

test_install_offer_accepted() {
  t_begin "accepting the Docker offer runs the printed root steps and finishes the same run"
  sandbox_new
  os_release_ubuntu
  rm -f "$SB_BIN/docker"
  STUB_DOCKER_DENIED=1
  INSTALL_EXTRA=(--install-docker)
  install_machine
  assert_log_has "sudo sh -c"
  assert_contains "$OUT" "Root steps to install Docker Engine"
  assert_contains "$OUT" "9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
  assert_contains "$OUT" "Sign out and back in"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

# Runs the key check the root steps embed, against a gpg stand-in that prints the given colon records.
key_check() {
  local records=$1
  cat >"$SB_BIN/gpg" <<'GPG'
#!/bin/sh
printf '%s\n' "$GPG_RECORDS"
GPG
  chmod +x "$SB_BIN/gpg"
  GPG_RECORDS=$records PATH=$SB_BIN "$SB_BIN/bash" -c ". '$INSTALLER_DIR/lib/docker.sh'; eval \"\$(docker_key_check_snippet)\"; docker_key_ok /dev/null $PINNED"
}

test_key_fingerprint_is_checked() {
  t_begin "the vendor key is accepted only as exactly one key with the pinned fingerprint"
  sandbox_new
  local PINNED=9DC858229FC7DD38854AE2D88D81803C0EBFCD88 other=0000000000000000000000000000000000000000
  local pub="pub:-:4096:1:8D81803C0EBFCD88:1487788586:::-:::scESC::::::23::0:"
  local good="fpr:::::::::$PINNED:"
  local bad="fpr:::::::::$other:"
  local sub="sub:-:4096:1:7EA0A9C3F273FCD8:1487788586::::::s::::::23:"
  if key_check "$pub
$good
uid:-::::1487788586::X::Docker Release (CE deb) <docker@docker.com>::::::::::0:"; then t_pass; else t_fail "the pinned key was refused"; fi
  if key_check "$pub
$good
$sub
fpr:::::::::$other:"; then t_pass; else t_fail "a subkey of the pinned key was refused"; fi
  if key_check "$pub
$bad"; then t_fail "a wrong fingerprint was accepted"; else t_pass; fi
  if key_check "$pub
$good
$pub
$bad"; then t_fail "a second key was accepted"; else t_pass; fi
  if key_check "$pub
$good
$pub
$good"; then t_fail "two primary keys were accepted even with the same fingerprint"; else t_pass; fi
  if key_check "$pub
$bad
$pub
$good"; then t_fail "a wrong first key was accepted"; else t_pass; fi
  if key_check ""; then t_fail "an empty key file was accepted"; else t_pass; fi
  os_release_ubuntu
  run_install --print-root-steps
  assert_contains "$OUT" "docker_key_ok /etc/apt/keyrings/docker.asc.download $PINNED"
  assert_contains "$OUT" "exit 1"
  sandbox_drop
}

test_group_decline_stops_without_sudo() {
  t_begin "answering no to the docker group stops the run: no sudo, no usermod, clear steps"
  sandbox_new
  STUB_DOCKER_DENIED=1
  : >"$SB_STATE/group_members"
  with_input "

y
n
"
  run_install --name main --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$ERR" "sudo usermod -aG docker testuser"
  assert_flat_contains "$ERR" "nothing was changed"
  assert_log_lacks "usermod -aG"
  assert_log_lacks "sudo docker"
  assert_no_path "$AMAN_HOME/state/instances"
  assert_eq "$(log_count "docker build")" 0 "no builds"
  clear_input
  sandbox_drop
}

test_yes_does_not_consent_to_root_changes() {
  t_begin "--yes alone neither installs Docker nor changes groups; the explicit flags do"
  sandbox_new
  STUB_DOCKER_DENIED=1
  : >"$SB_STATE/group_members"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$ERR" "--add-docker-group"
  assert_log_lacks "usermod"
  assert_log_lacks "sudo "
  clear_input
  sandbox_drop
  sandbox_new
  os_release_ubuntu
  rm -f "$SB_BIN/docker"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  assert_rc 1
  assert_flat_contains "$ERR" "--install-docker"
  assert_log_lacks "sudo "
  assert_no_path "$SB_BIN/docker"
  clear_input
  sandbox_drop
}

test_print_root_steps() {
  t_begin "print-root-steps shows pinned steps and never the convenience script"
  sandbox_new
  os_release_ubuntu
  run_install --print-root-steps
  assert_rc 0
  assert_contains "$OUT" "9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
  assert_contains "$OUT" "download.docker.com/linux/ubuntu"
  assert_contains "$OUT" "noble"
  assert_contains "$OUT" "usermod -aG docker testuser"
  assert_not_contains "$OUT" "get.docker.com"
  assert_not_contains "$OUT" "| sh"
  assert_log_lacks "sudo "
  printf 'ID=fedora\n' >"$SB/os-release"
  run_install --print-root-steps
  assert_contains "$OUT" "cannot install Docker for you"
  sandbox_drop
}

test_rootless_is_unsupported
test_podman_is_unsupported
test_old_engine_and_compose_v1
test_compose_v2_or_newer_passes
test_unreadable_compose_version_is_named
test_blocker_stops_before_any_prompt
test_daemon_down
test_group_member_without_relogin_uses_sg
test_non_member_is_added_then_sg
test_doctor_follows_sudo_access
test_install_offer_declined
test_install_offer_accepted
test_print_root_steps
test_group_decline_stops_without_sudo
test_yes_does_not_consent_to_root_changes
test_key_fingerprint_is_checked
tests_finish
