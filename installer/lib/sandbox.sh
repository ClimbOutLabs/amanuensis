# shellcheck shell=bash
# The sandbox slots of an instance: preflight, plan lines, and running the slot setup. The setup logic has one
# owner, packages/trueforge/scripts/sandbox-slots (also behind `pnpm sandbox:slots`); the installer takes a
# copy of it out of the app image it just built and runs it on the host with Node, because loading the AppArmor
# profile and mounting disks cannot be done from inside a container. This file decides when to run it and asks
# before any sudo.

SLOT_IMAGE=amanuensis-sandbox-slot:local
SLOT_COUNT=4
SLOT_DISK_ROOT=/var/lib/aman-slots
SLOT_DISK_GB=16
SLOT_MIN_FREE_KB=$((20 * 1024 * 1024))
SANDBOX_NODE_MAJOR=22
SANDBOX_NODE_MINOR=14
SANDBOX_BUNDLE_IN_IMAGE=/app/packages/trueforge/dist/sandbox-slots.js
SANDBOX_REPAIR_COMMAND="aman doctor sandbox --fix"
SANDBOX_VERIFY_FAILED=0

sandbox_bundle() { printf '%s/bin/aman-sandbox.mjs' "$AMAN_HOME"; }
sandbox_log() { printf '%s/sandbox.log' "$STATE_DIR"; }

# An instance keeps the sandbox unless it was installed with --no-sandbox.
instance_sandbox_wanted() { [ "$(reg_get "$1" sandbox)" != off ]; }

# True when any instance, existing or about to be created, gets the sandbox.
sandbox_needed() {
  local name
  for name in $(reg_names); do
    if instance_sandbox_wanted "$name"; then return 0; fi
  done
  need_new_instance && [ "$OPT_NO_SANDBOX" != 1 ]
}

sandbox_node_ok() {
  local v major minor
  command -v node >/dev/null 2>&1 || return 1
  v=$(node --version 2>/dev/null) || return 1
  v=${v#v}
  major=${v%%.*}
  minor=${v#*.}
  minor=${minor%%.*}
  case "$major$minor" in '' | *[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$SANDBOX_NODE_MAJOR" ] || { [ "$major" -eq "$SANDBOX_NODE_MAJOR" ] && [ "$minor" -ge "$SANDBOX_NODE_MINOR" ]; }
}

sandbox_node_text() {
  echo "The sandbox setup runs on Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer, which this computer does not have. Install Node.js (https://nodejs.org or your package manager) and run this again, or pass --no-sandbox to install without run code."
}

# Native Docker on Linux: the slots get disks of their own and may need the AppArmor profile loaded.
sandbox_native_linux() {
  [ "$(uname -s)" = Linux ] || return 1
  case "$(uname -r)" in *[Mm]icrosoft* | *WSL* | *wsl*) return 1 ;; esac
  if docker_available_for_probes; then
    case "$(D info --format '{{.OperatingSystem}}' 2>/dev/null || true)" in *[Dd]ocker\ [Dd]esktop*) return 1 ;; esac
  fi
  return 0
}

preflight_sandbox() {
  local cgroup free
  sandbox_needed || return 0
  if ! sandbox_node_ok; then
    plan_add blocked "$(sandbox_node_text)"
  fi
  if docker_available_for_probes; then
    cgroup=$(D info --format '{{.CgroupVersion}}' 2>/dev/null || true)
    if [ "$cgroup" = 1 ]; then
      plan_add blocked "The sandbox needs cgroup v2 and Docker here uses cgroup v1. Use a distribution with cgroup v2 (Ubuntu 22.04 or newer), then run this again, or pass --no-sandbox to install without run code."
    fi
  fi
  if sandbox_native_linux; then
    free=$(free_kb "$SLOT_DISK_ROOT")
    case "${free:-}" in
      '' | *[!0-9]*) ;;
      *)
        if [ "$free" -lt "$SLOT_MIN_FREE_KB" ]; then
          plan_add blocked "Less than 20 GB free for the sandbox slot disks under $SLOT_DISK_ROOT ($((free / 1024 / 1024)) GB free). Free space, or pass --no-sandbox to install without run code."
        fi
        ;;
    esac
    if [ "$(id -u)" != 0 ] && ! command -v sudo >/dev/null 2>&1; then
      plan_add blocked "The sandbox host setup needs root and sudo is not installed. Run the installer as root, or pass --no-sandbox to install without run code."
    fi
  fi
}

sandbox_slots_running() {
  local count
  count=$(D ps -q --filter "label=com.docker.compose.project=$1-slots" --filter status=running 2>/dev/null | wc -l | tr -d ' ' || true)
  [ "${count:-0}" -ge "$SLOT_COUNT" ]
}

# Plan lines for the image build, the root steps and the slots of each instance that gets the sandbox.
plan_sandbox() {
  local name pending=0
  sandbox_needed || return 0
  plan_image "$SLOT_IMAGE" "Build the sandbox slot image $SLOT_IMAGE from ops/sandbox-slot (gVisor guest, Ubuntu packages)" slot-image
  for name in $(reg_names); do
    instance_sandbox_wanted "$name" || continue
    if docker_available_for_probes && sandbox_slots_running "$name" && instance_sandbox_wired "$name"; then
      plan_add have "Sandbox slots of instance $name are running"
    else
      pending=1
      plan_add todo "Start the $SLOT_COUNT sandbox slots of instance $name and connect its app (run code, Python, shell, files)"
    fi
  done
  if need_new_instance && [ "$OPT_NO_SANDBOX" != 1 ]; then
    pending=1
    plan_add todo "Start the $SLOT_COUNT sandbox slots of instance $I_NAME and connect its app (run code, Python, shell, files)"
  fi
  if [ "$pending" = 1 ] && sandbox_native_linux; then
    plan_add root "Sandbox host setup, each part only if not already in place: load the AppArmor profile aman-sandbox-slot, create $SLOT_COUNT slot disk files of $SLOT_DISK_GB GB under $SLOT_DISK_ROOT (they use real space only as the slots write), add $SLOT_COUNT lines to /etc/fstab and mount them"
  fi
}

# Whether the instance's compose file already connects its app to the slots.
instance_sandbox_wired() {
  grep -q 'SANDBOX_BACKEND: slots' "$(instance_dir "$1")/compose.yaml" 2>/dev/null
}

# Takes the slot setup out of the app image so it matches the release and needs no checkout tooling on the host.
sandbox_install_bundle() {
  local dest tmp
  dest=$(sandbox_bundle)
  ensure_private_dir "$AMAN_HOME/bin"
  tmp=$(umask 077 && mktemp "$dest.XXXXXX")
  if ! D run --rm --entrypoint cat "$REL_APP_TAG" "$SANDBOX_BUNDLE_IN_IMAGE" >"$tmp" 2>/dev/null || [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    die "the app image $REL_APP_TAG has no sandbox setup at $SANDBOX_BUNDLE_IN_IMAGE; run install.sh again to rebuild it"
  fi
  write_if_changed "$dest" 644 <"$tmp" || true
  rm -f "$tmp"
  # The doctor reads the checkout the compose files and the image build context come from.
  printf '%s\n' "$REPO_ROOT" | write_if_changed "$STATE_DIR/source" 600 || true
}

# Runs the slot setup with the Docker access of this run. Build output goes to a log file, progress lines to the terminal.
sandbox_run() {
  as_docker_user env DOCKER_BUILDKIT=1 node "$(sandbox_bundle)" "$@" \
    --repo-root "$REPO_ROOT" --log-file "$(sandbox_log)" --command-name "aman doctor sandbox"
}

# Execute phase of the images step: the bundle, then the slot image (cached when nothing changed).
sandbox_images_ensure() {
  sandbox_needed || return 0
  [ "$DRY_RUN" != 1 ] || return 0
  sandbox_node_ok || die "$(sandbox_node_text)"
  sandbox_install_bundle
  say "Building the sandbox slot image $SLOT_IMAGE (a few minutes the first time; the build log is $(sandbox_log))"
  sandbox_run --build-only --instance "$(sandbox_first_instance)" ||
    die "the sandbox slot image build failed; the build log is $(sandbox_log). Run install.sh again after fixing it, or pass --no-sandbox to install without run code."
}

sandbox_first_instance() {
  local name
  if [ -n "${I_NAME:-}" ]; then
    printf '%s' "$I_NAME"
    return 0
  fi
  name=$(reg_names | head -n 1)
  printf '%s' "${name:-main}"
}

sandbox_print_root_steps() {
  local step=$1 repo=$REPO_ROOT
  say "The sandbox needs these steps as root on this computer:"
  if [ "$step" = apparmor ]; then
    say "  sudo apparmor_parser -r -W $repo/ops/sandbox-slot/apparmor/aman-sandbox-slot"
  fi
  say "  sudo sh $repo/ops/sandbox-slot/disks/setup-disks.sh setup $SLOT_DISK_ROOT/<instance> $SLOT_DISK_GB $SLOT_COUNT"
  say "    (creates $SLOT_COUNT sparse disk files, adds $SLOT_COUNT lines to /etc/fstab, mounts them; each only if missing)"
}

# Brings up the slots of one instance, with a root step only after a yes. Runs before the instance starts, because
# the app mounts the slots' control volumes.
sandbox_ensure() {
  local name=$1 out step='' fix_args=()
  sandbox_node_ok || die "$(sandbox_node_text)"
  [ -f "$(sandbox_bundle)" ] || sandbox_install_bundle
  out=$(sandbox_run --check --json --instance "$name" 2>/dev/null || true)
  if printf '%s' "$out" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    say "Sandbox slots of instance $name are already healthy"
    return 0
  fi
  step=$(printf '%s' "$out" | sed -n 's/.*"step"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)
  case "$step" in
    apparmor | disk)
      sandbox_print_root_steps "$step"
      if ! consent_root "Run these root steps now?" "$OPT_SANDBOX_ROOT"; then
        die "The sandbox needs root steps that were not approved, so instance $name was not started. Answer yes when asked, or pass --sandbox-root (--yes alone never uses sudo), or pass --no-sandbox to install without run code."
      fi
      fix_args=(--fix --yes)
      ;;
  esac
  say "Starting the $SLOT_COUNT sandbox slots of instance $name"
  sandbox_run --instance "$name" ${fix_args[@]+"${fix_args[@]}"} ||
    die "the sandbox slots of instance $name did not come up. The fix: $SANDBOX_REPAIR_COMMAND   (build log: $(sandbox_log))"
}

# After the instance is up: every slot's attestation, then a real call through the app's own slot driver.
sandbox_verify() {
  local name=$1
  say ""
  say "Sandbox check for instance $name:"
  if ! DOCTOR_TIMEOUT=300 run_doctor sandbox --instance "$name"; then
    SANDBOX_VERIFY_FAILED=1
    warn "the sandbox of instance $name is not ready. The fix: $SANDBOX_REPAIR_COMMAND"
  fi
}

sandbox_finish() {
  if [ "$SANDBOX_VERIFY_FAILED" = 1 ]; then
    exit 1
  fi
}

# Stops (and with --purge-data deletes) the slots of an instance that is being removed.
sandbox_down() {
  local name=$1 purge=${2:-0} args=(--down)
  if [ ! -f "$(sandbox_bundle)" ] || ! sandbox_node_ok; then
    warn "could not stop the sandbox slots of $name (no sandbox setup or no Node.js here); stop them with: docker compose -p $name-slots down"
    return 0
  fi
  if [ "$purge" = 1 ]; then args+=(--purge); fi
  sandbox_run "${args[@]}" --instance "$name" || warn "could not stop the sandbox slots of $name; stop them with: docker compose -p $name-slots down"
}
