# shellcheck shell=bash
# The sandbox slots of an instance: preflight, plan lines, and running the slot setup. The setup logic has one
# owner, packages/trueforge/scripts/sandbox-slots (also behind `pnpm sandbox:slots`); the installer takes a
# copy of it out of the app image it just built and runs it on the host, because loading the AppArmor profile and
# mounting disks cannot be done from inside a container. It runs on a pinned Node.js the installer downloads (the
# host needs only Docker and git), or on the host's own Node.js when the owner passes --use-host-node. This file
# decides when to run it and asks before any sudo.

SLOT_IMAGE=amanuensis-sandbox-slot:local
SLOT_COUNT=2
# Installs from before had four slots; the slot setup removes the ones past SLOT_COUNT.
SLOT_RETIRED='3 4'
# The slot setup always uses /var/lib/aman-slots; the override only lets tests point the checks here elsewhere.
SLOT_DISK_ROOT=${AMAN_SLOT_DISK_ROOT:-/var/lib/aman-slots}
SLOT_DISK_GB=16
SLOT_APPARMOR_FILE=/etc/apparmor.d/aman-sandbox-slot
SANDBOX_DOCKER_BOOT_CHECKED=0
SANDBOX_BUNDLE_IN_IMAGE=/app/packages/trueforge/dist/sandbox-slots.js
SANDBOX_VERIFY_FAILED=0
SANDBOX_FAILED_NAMES=''

sandbox_repair_command() { printf 'aman doctor sandbox --fix'; }

sandbox_bundle() { printf '%s/bin/aman-sandbox.mjs' "$AMAN_HOME"; }
sandbox_log() { printf '%s/sandbox.log' "$STATE_DIR"; }

# An instance keeps the sandbox unless it was installed with --no-sandbox.
instance_sandbox_wanted() { [ "$(reg_get "$1" sandbox)" != off ]; }

# True when this run turns the sandbox on for an existing instance that was installed without it. Asking for the
# sandbox again is the default, so only --no-sandbox leaves such an instance as it is.
sandbox_enable_wanted() {
  [ "$OPT_NO_SANDBOX" != 1 ] && [ -n "${OPT_NAME:-}" ] && reg_exists "$OPT_NAME" && ! instance_sandbox_wanted "$OPT_NAME"
}

# True when any instance, existing or about to be created, gets the sandbox.
sandbox_needed() {
  local name
  for name in $(reg_names); do
    if instance_sandbox_wanted "$name"; then return 0; fi
  done
  if sandbox_enable_wanted; then return 0; fi
  need_new_instance && [ "$OPT_NO_SANDBOX" != 1 ]
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
  step_begin node-download "Downloading Node.js v$version for $platform (only the sandbox setup uses it)"
  if ! download_file "https://nodejs.org/dist/v$version/$file" "$tmp/$file" 2>"$STEP_LOG"; then
    rm -rf "$tmp"
    UI_FD=2 ui_step_end fail "Node.js could not be downloaded from nodejs.org"
    die "Could not download https://nodejs.org/dist/v$version/$file. Check that this computer can reach nodejs.org, then run this again."
  fi
  sum=$(sha256_stdin <"$tmp/$file")
  if [ "$sum" != "$expected" ]; then
    rm -rf "$tmp"
    die "The downloaded $file does not match the expected checksum ($expected, got $sum), so it was not used. Run this again. If it keeps failing, the download is being altered on the way."
  fi
  member=node-v$version-$platform/bin/node
  if ! tar -xzf "$tmp/$file" -C "$tmp" "$member"; then
    rm -rf "$tmp"
    die "Could not unpack $file."
  fi
  dest=$(sandbox_runtime_node)
  ensure_private_dir "$AMAN_HOME/runtime"
  ensure_private_dir "$AMAN_HOME/runtime/node"
  ensure_private_dir "$AMAN_HOME/runtime/node/bin"
  mv -f "$tmp/$member" "$dest.new"
  chmod 755 "$dest.new"
  mv -f "$dest.new" "$dest"
  rm -rf "$tmp"
  sandbox_runtime_present || die "The downloaded Node.js does not run on this computer. Use --use-host-node with your own Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer, or pass --no-sandbox."
  step_ok "Downloaded Node.js v$version for $platform"
}

sandbox_runtime_ensure() {
  if sandbox_use_host_node; then return 0; fi
  if [ "$OPT_HOST_NODE" = 1 ]; then die "$(sandbox_node_text)"; fi
  sandbox_runtime_present || sandbox_runtime_install
}

# Native Docker on Linux: the slots get disks of their own and may need the AppArmor profile loaded.
sandbox_native_linux() {
  local os=''
  if docker_available_for_probes; then
    os=$(D info --format '{{.OperatingSystem}}' 2>/dev/null || true)
  fi
  docker_native_linux "$os"
}

preflight_sandbox() {
  local cgroup free need_gb
  sandbox_needed || return 0
  if [ "$OPT_HOST_NODE" = 1 ]; then
    if ! sandbox_node_ok; then
      split_problem "$(sandbox_node_text)"
      check_block "$SPLIT_HEAD" "$SPLIT_NEXT"
    fi
  elif ! sandbox_runtime_present; then
    if [ -z "$(sandbox_node_platform)" ]; then
      check_block "nodejs.org has no official Node.js build for this computer ($(uname -s) $(uname -m)), which the sandbox setup needs" "Pass --use-host-node with your own Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer, or --no-sandbox to install without run code."
    elif ! sandbox_can_download; then
      check_block "Downloading the Node.js the sandbox setup runs on needs curl or wget, and this computer has neither" "Install curl, or pass --use-host-node with your own Node.js $SANDBOX_NODE_MAJOR.$SANDBOX_NODE_MINOR or newer."
    fi
  fi
  if docker_available_for_probes; then
    # The slot agent reads the limits of either cgroup version, so v1 is no blocker; it only reports a different line.
    cgroup=$(D info --format '{{.CgroupVersion}}' 2>/dev/null || true)
    case "$cgroup" in
      1) check_warn "Docker here uses an older memory-limit setup. The sandbox runs on it; its limits are read from the older files" ;;
      2 | '') ;;
      *) check_block "Docker reports an unknown memory-limit setup ($cgroup), which the sandbox cannot check" "Pass --no-sandbox to install without run code." ;;
    esac
  fi
  if sandbox_native_linux; then
    need_gb=$(sandbox_disks_need_gb)
    if [ "$need_gb" -gt 0 ]; then need_gb=$((need_gb + $(sandbox_docker_share_gb))); fi
    free=$(free_kb "$SLOT_DISK_ROOT")
    case "${free:-}" in
      '' | *[![:digit:]]*) ;;
      *)
        if [ "$need_gb" -gt 0 ] && [ "$free" -lt $((need_gb * 1024 * 1024)) ]; then
          check_block "Less than $need_gb GB free for the sandbox disks under $SLOT_DISK_ROOT ($((free / 1024 / 1024)) GB free)" "Make room there, or pass --no-sandbox to install without run code."
        fi
        ;;
    esac
    if [ "$(id -u)" != 0 ] && ! command -v sudo >/dev/null 2>&1; then
      check_block "The sandbox setup needs administrator rights, and sudo is not installed" "Run the installer as root, or pass --no-sandbox to install without run code."
    fi
  fi
}

# The filesystem a path is on, named by df; two paths with the same name share one disk's free space.
sandbox_filesystem_of() {
  local path=$1
  while [ ! -e "$path" ] && [ "$path" != / ]; do path=$(dirname "$path"); done
  df -Pk "$path" 2>/dev/null | awk 'NR == 2 {print $1}'
}

# Docker's own room (the 10 GB the Docker data check asks for) counts against the sandbox disks too when
# Docker's data is on the same disk: on their own each check would pass on the same free space.
sandbox_docker_share_gb() {
  local root root_fs slot_fs
  root=$(D info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -n "$root" ] && [ -d "$root" ] || { printf '0'; return 0; }
  root_fs=$(sandbox_filesystem_of "$root")
  slot_fs=$(sandbox_filesystem_of "$SLOT_DISK_ROOT")
  if [ -n "$root_fs" ] && [ "$root_fs" = "$slot_fs" ]; then
    printf '10'
  else
    printf '0'
  fi
}

# Room the sandbox disks still to be made need: each may fill completely, so the slot setup wants its full size free
# for every disk it creates (setup-disks.sh checks the same). Disks that already exist are not counted again.
sandbox_disks_need_gb() {
  local name slot need=0
  for name in $(printf '%s\n' $(reg_names) "$(sandbox_first_instance)" | sort -u); do
    if reg_exists "$name"; then
      instance_sandbox_wanted "$name" || continue
    elif [ "$OPT_NO_SANDBOX" = 1 ]; then
      continue
    fi
    slot=1
    while [ "$slot" -le "$SLOT_COUNT" ]; do
      [ -f "$(sandbox_disk_dir "$name")/ws-$slot.img" ] || need=$((need + SLOT_DISK_GB))
      slot=$((slot + 1))
    done
  done
  printf '%s' "$need"
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
    plan_add have "Node.js on this computer sets up the sandbox (--use-host-node)"
  elif sandbox_runtime_present; then
    plan_add have "Node.js v$(json_get "$PINS_FILE" node_version) for the sandbox setup is downloaded" "At $(ui_path "$(sandbox_runtime_node)")"
  else
    plan_add todo "Download Node.js v$(json_get "$PINS_FILE" node_version) ($(sandbox_node_platform)) from nodejs.org" "Checked before use. Only the sandbox setup uses it; nothing is installed system-wide."
    dl_add node-runtime
  fi
  plan_image "$SLOT_IMAGE" "The sandbox is built" "Build the sandbox" slot-image
  for name in $(reg_names); do
    instance_sandbox_wanted "$name" || continue
    if docker_available_for_probes && sandbox_slots_running "$name" && instance_sandbox_wired "$name" &&
      sandbox_slots_use_current_image "$name"; then
      plan_add have "The $SLOT_COUNT sandboxes of instance $name are running"
      if [ "$OPT_NO_SANDBOX" = 1 ] && [ "$name" = "${OPT_NAME:-}" ]; then
        plan_add have "Instance $name keeps its sandbox" "--no-sandbox only applies to a new instance."
      fi
    else
      pending=1
      plan_add todo "Start $SLOT_COUNT sandboxes for $name" "Run code (Python, shell and files) uses them."
    fi
  done
  if sandbox_enable_wanted; then
    pending=1
    plan_add todo "Turn on the sandbox for instance $OPT_NAME (run code, PDF and image reading)" \
      "Its chats, memory and files are kept. The app restarts once."
  fi
  if need_new_instance && [ "$OPT_NO_SANDBOX" != 1 ]; then
    pending=1
    plan_add todo "Start $SLOT_COUNT sandboxes for $I_NAME" "Run code (Python, shell and files) uses them."
  fi
  if [ "$pending" = 1 ] && sandbox_native_linux; then
    plan_add root "Set up the sandbox on this computer" \
      "Needs admin. Adds a security rule for the sandbox and sets up $SLOT_COUNT disks of up to $SLOT_DISK_GB GB that use space only as they fill." \
      "Each part is skipped if it is already in place."
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
    die "The app ($REL_APP_TAG) has no sandbox setup in it. Run install.sh again to build it again."
  fi
  write_if_changed "$dest" 644 <"$tmp" || true
  rm -f "$tmp"
  record_source_checkout
}

# Runs the slot setup with the Docker access of this run. Build output goes to a log file, progress lines to the
# terminal; --embedded keeps its title, phase headers and closing block out, since this run prints its own.
sandbox_run() {
  as_docker_user env DOCKER_BUILDKIT=1 "$(sandbox_node)" "$(sandbox_bundle)" "$@" \
    --repo-root "$REPO_ROOT" --log-file "$(sandbox_log)" --command-name "aman doctor sandbox" --embedded
}

# Brings the sandbox up for an existing instance installed without it and records that it has it. The compose file is
# rendered and the app recreated by the caller; named volumes are never touched.
sandbox_enable() {
  local name=$1
  sandbox_ensure "$name"
  reg_set "$name" sandbox slots
  log_event "instance $name sandbox turned on"
}

# Execute phase of the images step: the bundle, then the slot image (cached when nothing changed).
sandbox_images_ensure() {
  sandbox_needed || return 0
  [ "$DRY_RUN" != 1 ] || return 0
  sandbox_runtime_ensure
  sandbox_install_bundle
  sandbox_run --build-only --instance "$(sandbox_first_instance)" ||
    die "Building the sandbox failed. The log is at $(ui_path "$(sandbox_log)"). Fix what it says and run install.sh again, or pass --no-sandbox to install without run code."
}

sandbox_first_instance() {
  local name
  if [ -n "${I_NAME:-}" ] || [ -n "${OPT_NAME:-}" ]; then
    printf '%s' "${I_NAME:-$OPT_NAME}"
    return 0
  fi
  name=$(reg_names | head -n 1)
  printf '%s' "${name:-main}"
}

sandbox_print_root_steps() {
  local step=$1
  ui_line "The sandbox needs administrator rights on this computer."
  if [ "$step" = apparmor ]; then
    ui_hint "It adds a security rule for the sandbox, which the system loads again at every start."
  fi
  if [ "$step" = retire ]; then
    ui_hint "It removes the disks of the extra sandboxes an older version of Aman made."
  else
    ui_hint "It sets up $SLOT_COUNT disks of up to $SLOT_DISK_GB GB that use space only as they fill."
  fi
}

# The id Docker has for the slot image now; changes only when a rebuild changed the image.
sandbox_image_id() {
  D image inspect --format '{{.Id}}' "$SLOT_IMAGE" 2>/dev/null | head -n 1 || true
}

# Whether every running slot of an instance was started from the slot image as it is now. True when that cannot be told.
sandbox_slots_use_current_image() {
  local name=$1 current running id
  current=$(sandbox_image_id)
  [ -n "$current" ] || return 0
  running=$(D ps -q --filter "label=com.docker.compose.project=$name-slots" 2>/dev/null || true)
  [ -n "$running" ] || return 0
  # shellcheck disable=SC2086 # one argument per container id
  for id in $(D inspect --format '{{.Image}}' $running 2>/dev/null); do
    [ "$id" = "$current" ] || return 1
  done
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
    # Healthy slots still run the image they started with, so a rebuilt image (new tools, new languages)
    # needs them started again; a run that built nothing new leaves them alone.
    if [ "$refresh" != refresh ] && sandbox_slots_use_current_image "$name"; then
      ui_skip "The sandboxes of instance $name are already running"
      return 0
    fi
  fi
  step=$(printf '%s' "$out" | LC_ALL=C sed -n 's/.*"step"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)
  case "$step" in
    apparmor | disk)
      sandbox_print_root_steps "$step"
      if ! consent_root "Set up the sandbox now?" "$OPT_SANDBOX_ROOT"; then
        die "The sandbox needs administrator rights that were not given, so instance $name was not started. Run this again and answer yes, pass --sandbox-root, or pass --no-sandbox to install without run code. --yes alone never uses admin rights."
      fi
      root_ready "instance $name was not started"
      fix_args=(--fix --yes)
      ;;
    retire)
      # Removing the extra sandboxes of an older version is cleanup, not setup: a no never stops the
      # instance (or rolls an upgrade back). The disks stay, and the doctor keeps reporting them.
      sandbox_print_root_steps "$step"
      if consent_root "Set up the sandbox now?" "$OPT_SANDBOX_ROOT"; then
        root_ready "instance $name was not started"
        fix_args=(--fix --yes)
      else
        warn "The extra sandboxes of an older version were left in place. Their chats were kept. Remove them with: $(sandbox_repair_command) --fix"
      fi
      ;;
  esac
  sandbox_run --instance "$name" ${fix_args[@]+"${fix_args[@]}"} ||
    die "The sandboxes of instance $name did not start. Run: $(sandbox_repair_command). The log is at $(ui_path "$(sandbox_log)")."
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
  ui_line "Docker does not start when this computer does, so the sandbox would stay down after a restart. Changing that needs administrator rights."
  if consent_root "Make Docker start with this computer?" "$OPT_SANDBOX_ROOT"; then
    run_root systemctl enable docker || warn "Could not make Docker start with this computer. Run: aman doctor sandbox --fix"
  else
    warn "Docker was left as it was, so after a restart the sandbox stays down until you run: aman doctor sandbox --fix"
  fi
}

# After the instance is up: every slot's attestation, then a real call through the app's own slot driver.
# Quiet when the sandbox answers: the doctor summary already shows its row. A failure is told once, in the closing
# table, with the one command that repairs it (and shows the check's output).
sandbox_verify() {
  local name=$1
  if DOCTOR_TIMEOUT=300 run_doctor sandbox --instance "$name" >/dev/null 2>&1; then
    return 0
  fi
  SANDBOX_VERIFY_FAILED=1
  SANDBOX_FAILED_NAMES="$SANDBOX_FAILED_NAMES $name"
}

sandbox_finish() {
  if [ "$SANDBOX_VERIFY_FAILED" = 1 ]; then
    exit 1
  fi
}

sandbox_disk_dir() { printf '%s/%s' "$SLOT_DISK_ROOT" "$1"; }

# Whether any part of the slots of an instance is still on this computer: their disks, containers or volumes.
sandbox_slots_left() {
  local name=$1
  [ ! -d "$(sandbox_disk_dir "$name")" ] || return 0
  [ -z "$(D ps -aq --filter "label=com.docker.compose.project=$name-slots" 2>/dev/null || true)" ] || return 0
  docker_volume_exists "${name}_slot_ctl_1" || docker_volume_exists "${name}_slot_ws_1"
}

# Deleting the slot disks is the one root step of a removal.
sandbox_down_needs_root() {
  local name=$1 purge=$2
  [ "$purge" = 1 ] && [ -d "$(sandbox_disk_dir "$name")" ] && sandbox_native_linux
}

# Stops (and with --purge-data deletes) the slots of an instance that is being removed. Stops the run when they could
# not be stopped, so the caller keeps what the same remove command needs to finish the job.
sandbox_down() {
  local name=$1 purge=${2:-0} args=(--down) again="install.sh instance remove $1"
  if [ "$purge" = 1 ]; then
    args+=(--purge)
    again="$again --purge-data"
  fi
  if [ ! -f "$(sandbox_bundle)" ] || [ ! -x "$(sandbox_node)" ]; then
    sandbox_slots_left "$name" || return 0
    die "The sandbox tools are missing, so the sandboxes of $name could not be stopped and the removal was not finished. Run aman upgrade, then run the same command again: $again"
  fi
  sandbox_run "${args[@]}" --instance "$name" ||
    die "The sandboxes of $name could not be stopped, so the removal was not finished. Run the same command again: $again"
}

# The control and mirror volumes of the slots an older install had past SLOT_COUNT. The slot setup removes their
# containers, workspaces and disks, but the app mounts these two until it starts again from its new compose file, so
# they go once it has. Quiet and best effort: a volume something still uses stays for the next start.
sandbox_retired_volumes_remove() {
  local name=$1 slot kind
  for slot in $SLOT_RETIRED; do
    for kind in ctl mirror; do
      if docker_volume_exists "${name}_slot_${kind}_${slot}"; then
        D volume rm "${name}_slot_${kind}_${slot}" >/dev/null 2>&1 || true
      fi
    done
  done
}
