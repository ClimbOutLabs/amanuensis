# shellcheck shell=bash
# The sandbox slots of an instance: preflight, plan lines, and running the slot setup. The setup logic has one
# owner, packages/trueforge/scripts/sandbox-slots (also behind `pnpm sandbox:slots`); the installer takes a
# copy of it out of the app image it just built and runs it on the host, because loading the AppArmor profile and
# mounting disks cannot be done from inside a container. It runs on a pinned Node.js the installer downloads (the
# host needs only Docker and git), or on the host's own Node.js when the owner passes --use-host-node. This file
# decides when to run it and asks before any sudo.

SLOT_IMAGE=amanuensis-sandbox-slot:local
SLOT_COUNT=4
SLOT_DISK_ROOT=/var/lib/aman-slots
SLOT_DISK_GB=16
SLOT_MIN_FREE_KB=$((20 * 1024 * 1024))
SLOT_APPARMOR_FILE=/etc/apparmor.d/aman-sandbox-slot
SANDBOX_DOCKER_BOOT_CHECKED=0
SANDBOX_NODE_MAJOR=22
SANDBOX_NODE_MINOR=14
SANDBOX_BUNDLE_IN_IMAGE=/app/packages/trueforge/dist/sandbox-slots.js
SANDBOX_VERIFY_FAILED=0

# The doctor is not on PATH, so every repair line names it by its path.
sandbox_repair_command() { printf '%s doctor sandbox --fix' "$(doctor_shim)"; }

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
  echo "--use-host-node needs Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer on this computer, and it has none. Leave the option out and the installer downloads its own copy, or install Node.js (https://nodejs.org)."
}

# The pinned runtime lives apart from any Node.js the owner has, and only runs the sandbox setup.
sandbox_runtime_node() { printf '%s/runtime/node/bin/node' "$AMAN_HOME"; }

# linux-x64, linux-arm64, darwin-x64 or darwin-arm64; empty where nodejs.org has no official build.
sandbox_node_platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) return 0 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 0 ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

sandbox_use_host_node() { [ "$OPT_HOST_NODE" = 1 ] && sandbox_node_ok; }

# The Node.js that runs the setup: the host's when the owner opted in and it is new enough, else the pinned one.
sandbox_node() {
  if sandbox_use_host_node; then
    command -v node
  else
    sandbox_runtime_node
  fi
}

sandbox_runtime_present() {
  local node pinned
  node=$(sandbox_runtime_node)
  pinned=$(json_get "$PINS_FILE" node_version)
  [ -x "$node" ] && [ "$("$node" --version 2>/dev/null || true)" = "v$pinned" ]
}

sandbox_can_download() { command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; }

download_file() {
  local url=$1 dest=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$dest" "$url"
  else
    wget -q --https-only -O "$dest" "$url"
  fi
}

# Downloads the pinned Node.js from nodejs.org and keeps only its binary. The tarball must match the pinned SHA-256
# for this platform before anything is unpacked.
sandbox_runtime_install() {
  local platform version file expected tmp sum member dest
  platform=$(sandbox_node_platform)
  [ -n "$platform" ] || die "nodejs.org has no official Node.js build for this computer ($(uname -s) $(uname -m)). Use --use-host-node with your own Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer, or pass --no-sandbox."
  version=$(json_get "$PINS_FILE" node_version)
  file=node-v$version-$platform.tar.gz
  expected=$(json_get "$PINS_FILE" "node_sha256_${platform//-/_}")
  tmp=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/aman-node.XXXXXX")
  say "Downloading Node.js v$version for $platform from nodejs.org (it only runs the sandbox setup)"
  if ! download_file "https://nodejs.org/dist/v$version/$file" "$tmp/$file"; then
    rm -rf "$tmp"
    die "could not download https://nodejs.org/dist/v$version/$file. Check this computer's network access to nodejs.org (install.sh --print-network lists every host), then run this again."
  fi
  sum=$(sha256_stdin <"$tmp/$file")
  if [ "$sum" != "$expected" ]; then
    rm -rf "$tmp"
    die "the downloaded $file does not match the pinned SHA-256 ($expected, got $sum), so it was not used. Run this again; if it keeps failing, the download is being altered on the way."
  fi
  member=node-v$version-$platform/bin/node
  if ! tar -xzf "$tmp/$file" -C "$tmp" "$member"; then
    rm -rf "$tmp"
    die "could not unpack $file"
  fi
  dest=$(sandbox_runtime_node)
  ensure_private_dir "$AMAN_HOME/runtime"
  ensure_private_dir "$AMAN_HOME/runtime/node"
  ensure_private_dir "$AMAN_HOME/runtime/node/bin"
  mv -f "$tmp/$member" "$dest.new"
  chmod 755 "$dest.new"
  mv -f "$dest.new" "$dest"
  rm -rf "$tmp"
  sandbox_runtime_present || die "the downloaded Node.js does not run on this computer; use --use-host-node with your own Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer, or pass --no-sandbox."
}

sandbox_runtime_ensure() {
  if sandbox_use_host_node; then return 0; fi
  if [ "$OPT_HOST_NODE" = 1 ]; then die "$(sandbox_node_text)"; fi
  sandbox_runtime_present || sandbox_runtime_install
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
  if [ "$OPT_HOST_NODE" = 1 ]; then
    if ! sandbox_node_ok; then plan_add blocked "$(sandbox_node_text)"; fi
  elif ! sandbox_runtime_present; then
    if [ -z "$(sandbox_node_platform)" ]; then
      plan_add blocked "nodejs.org has no official Node.js build for this computer ($(uname -s) $(uname -m)), which the sandbox setup needs. Pass --use-host-node with your own Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer, or --no-sandbox to install without run code."
    elif ! sandbox_can_download; then
      plan_add blocked "Downloading the Node.js the sandbox setup runs on needs curl or wget, and this computer has neither. Install curl, or pass --use-host-node with your own Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer."
    fi
  fi
  if docker_available_for_probes; then
    # The slot agent reads the limits of either cgroup version, so v1 is no blocker; it only reports a different line.
    cgroup=$(D info --format '{{.CgroupVersion}}' 2>/dev/null || true)
    case "$cgroup" in
      1) warn "Docker here uses cgroup v1. The sandbox runs on it; memory limits are read from the v1 files." ;;
      2 | '') ;;
      *) plan_add blocked "Docker reports an unknown cgroup setup ($cgroup), which the sandbox cannot check. Pass --no-sandbox to install without run code." ;;
    esac
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
  if sandbox_use_host_node; then
    plan_add have "Node.js on this computer runs the sandbox setup (--use-host-node)"
  elif sandbox_runtime_present; then
    plan_add have "Pinned Node.js v$(json_get "$PINS_FILE" node_version) for the sandbox setup at $(sandbox_runtime_node)"
  else
    plan_add todo "Download Node.js v$(json_get "$PINS_FILE" node_version) ($(sandbox_node_platform)) from nodejs.org, checked against a pinned SHA-256, into $AMAN_HOME/runtime/node (it only runs the sandbox setup; the host needs no Node.js)"
    dl_add node-runtime
  fi
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
    plan_add root "Sandbox host setup, each part only if not already in place: install the AppArmor profile as $SLOT_APPARMOR_FILE and load it (it loads again at every boot), create $SLOT_COUNT slot disk files of $SLOT_DISK_GB GB under $SLOT_DISK_ROOT (they use real space only as the slots write), add $SLOT_COUNT lines to /etc/fstab and mount them"
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
  as_docker_user env DOCKER_BUILDKIT=1 "$(sandbox_node)" "$(sandbox_bundle)" "$@" \
    --repo-root "$REPO_ROOT" --log-file "$(sandbox_log)" --command-name "$(doctor_shim) doctor sandbox"
}

# Execute phase of the images step: the bundle, then the slot image (cached when nothing changed).
sandbox_images_ensure() {
  sandbox_needed || return 0
  [ "$DRY_RUN" != 1 ] || return 0
  sandbox_runtime_ensure
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
    say "  sudo install -m 0644 $repo/ops/sandbox-slot/apparmor/aman-sandbox-slot $SLOT_APPARMOR_FILE"
    say "  sudo apparmor_parser -r -W $SLOT_APPARMOR_FILE"
    say "    (a file in /etc/apparmor.d is loaded again by the system at every boot)"
  fi
  say "  sudo sh $repo/ops/sandbox-slot/disks/setup-disks.sh setup $SLOT_DISK_ROOT/<instance> $SLOT_DISK_GB $SLOT_COUNT"
  say "    (creates $SLOT_COUNT sparse disk files, adds $SLOT_COUNT lines to /etc/fstab, mounts them; each only if missing)"
}

# Brings up the slots of one instance, with a root step only after a yes. Runs before the instance starts, because
# the app mounts the slots' control volumes. "refresh" starts them even when healthy, so a rebuilt image replaces
# the running slots (an upgrade).
sandbox_ensure() {
  local name=$1 refresh=${2:-} out step='' fix_args=()
  sandbox_runtime_ensure
  [ -f "$(sandbox_bundle)" ] || sandbox_install_bundle
  out=$(sandbox_run --check --json --instance "$name" 2>/dev/null || true)
  if printf '%s' "$out" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    if [ "$refresh" != refresh ]; then
      say "Sandbox slots of instance $name are already healthy"
      return 0
    fi
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
    die "the sandbox slots of instance $name did not come up. The fix: $(sandbox_repair_command)   (build log: $(sandbox_log))"
  sandbox_docker_boot_ensure
}

# The slots restart with Docker (restart: unless-stopped), so Docker itself has to start at boot.
sandbox_docker_boot_ensure() {
  [ "$SANDBOX_DOCKER_BOOT_CHECKED" = 0 ] || return 0
  SANDBOX_DOCKER_BOOT_CHECKED=1
  sandbox_native_linux || return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl cat docker.service >/dev/null 2>&1 || return 0
  if systemctl is-enabled --quiet docker 2>/dev/null; then return 0; fi
  say "Docker does not start at boot here, so the sandbox would stay down after a restart. This needs root:"
  say "  sudo systemctl enable docker"
  if consent_root "Run it now?" "$OPT_SANDBOX_ROOT"; then
    run_root systemctl enable docker || warn "could not enable Docker at boot; run: sudo systemctl enable docker"
  else
    warn "Docker was left as it was; after a restart the sandbox stays down until you run: sudo systemctl enable docker"
  fi
}

# After the instance is up: every slot's attestation, then a real call through the app's own slot driver.
sandbox_verify() {
  local name=$1
  say ""
  say "Sandbox check for instance $name:"
  if ! DOCTOR_TIMEOUT=300 run_doctor sandbox --instance "$name"; then
    SANDBOX_VERIFY_FAILED=1
    warn "the sandbox of instance $name is not ready. The fix: $(sandbox_repair_command)"
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
  if [ ! -f "$(sandbox_bundle)" ] || [ ! -x "$(sandbox_node)" ]; then
    warn "could not stop the sandbox slots of $name (no sandbox setup or Node.js runtime here); stop them with: docker compose -p $name-slots down"
    return 0
  fi
  if [ "$purge" = 1 ]; then args+=(--purge); fi
  sandbox_run "${args[@]}" --instance "$name" || warn "could not stop the sandbox slots of $name; stop them with: docker compose -p $name-slots down"
}
