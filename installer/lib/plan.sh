# shellcheck shell=bash
# The default command: preflight, printed plan, confirmation, then execution.

MIN_FREE_KB=$((10 * 1024 * 1024))
# The frontend and core builds run side by side and peak near 5 GB together.
DOCKER_MEM_BLOCK_BYTES=$((6 * 1024 * 1024 * 1024))
DOCKER_MEM_WARN_BYTES=$((8 * 1024 * 1024 * 1024))

PLAN_LINES=
PLAN_TODO=0
PLAN_ROOT=0
PLAN_BLOCKERS=
DL_TOTAL_MB=0
DL_LINES=
DL_HOSTS=

plan_add() {
  # plan_add STATE TEXT where STATE is have, todo, root or blocked.
  local tag
  case "$1" in
    have) tag='[done]    ' ;;
    todo)
      tag='[will do] '
      PLAN_TODO=$((PLAN_TODO + 1))
      ;;
    root)
      tag='[root]    '
      PLAN_TODO=$((PLAN_TODO + 1))
      PLAN_ROOT=$((PLAN_ROOT + 1))
      ;;
    blocked)
      tag='[blocked]'
      PLAN_BLOCKERS="$PLAN_BLOCKERS
  $2"
      ;;
  esac
  PLAN_LINES="$PLAN_LINES
  $tag $2"
}

# Free space of the filesystem holding a path (nearest existing ancestor), in KB.
free_kb() {
  local path=$1
  local kb
  while [ ! -e "$path" ] && [ "$path" != / ]; do
    path=$(dirname "$path")
  done
  # A directory this user cannot enter (Docker's data root) cannot be measured; its parent is on the
  # same disk unless the data root is a mount of its own.
  while :; do
    kb=$(df -Pk "$path" 2>/dev/null | awk 'NR == 2 {print $4}')
    if [ -n "$kb" ] || [ "$path" = / ]; then
      printf '%s' "$kb"
      return 0
    fi
    path=$(dirname "$path")
  done
}

# The disk holding Docker's data is the one the images, builds and volumes fill, and it is often not the
# one holding the install home. Docker Desktop keeps its data in a virtual machine, so it is skipped there.
preflight_docker_space() {
  local root free
  case "$DOCKER_ACCESS" in direct | sg) ;; *) return 0 ;; esac
  root=$(D info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -z "$root" ] || [ ! -d "$root" ]; then
    return 0
  fi
  free=$(free_kb "$root")
  case "${free:-}" in
    '' | *[!0-9]*) ;;
    *)
      if [ "$free" -lt "$MIN_FREE_KB" ]; then
        plan_add blocked "Less than 10 GB free on the disk holding Docker's data ($root): $((free / 1024 / 1024)) GB free. Free space with: docker system prune"
      fi
      ;;
  esac
}

# The app image build is killed without a clear message when Docker has too little memory.
preflight_docker_memory() {
  local bytes gb
  case "$DOCKER_ACCESS" in direct | sg) ;; *) return 0 ;; esac
  bytes=$(D info --format '{{.MemTotal}}' 2>/dev/null || true)
  case "${bytes:-}" in '' | *[!0-9]*) return 0 ;; esac
  gb=$(awk -v b="$bytes" 'BEGIN {printf "%.1f", b / 1073741824}')
  if [ "$bytes" -lt "$DOCKER_MEM_BLOCK_BYTES" ]; then
    plan_add blocked "Docker has only $gb GB of memory and needs at least 6 GB to build the app. Raise it in Docker Desktop under Settings, Resources, Memory. On Linux, free up memory or add swap."
  elif [ "$bytes" -lt "$DOCKER_MEM_WARN_BYTES" ]; then
    warn "Docker has $gb GB of memory. The first build needs at least 6 GB and may be slow or run out of memory; 8 GB or more is recommended. Raise it in Docker Desktop under Settings, Resources, Memory."
  fi
}

preflight_system() {
  local os arch free
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux | Darwin) ;;
    *) plan_add blocked "Operating system $os is not supported. On Windows, run this inside the WSL2 distribution that Docker Desktop integrates with." ;;
  esac
  case "$arch" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) plan_add blocked "CPU architecture $arch is not supported (x86_64 and arm64 only)." ;;
  esac
  if ! command -v git >/dev/null 2>&1; then
    plan_add blocked "git is required to read the checkout the images are built from."
  fi
  free=$(free_kb "$AMAN_HOME")
  case "${free:-}" in
    '' | *[!0-9]*) ;;
    *)
      if [ "$free" -lt "$MIN_FREE_KB" ]; then
        plan_add blocked "Less than 10 GB free on the disk holding $AMAN_HOME ($((free / 1024 / 1024)) GB free)."
      fi
      ;;
  esac
}

# Adds one download to the plan unless its owner step is already done.
dl_add() {
  local id=$1 mb='' what='' hosts='' found=0 fid fmb fwhat fhosts
  while IFS='|' read -r fid fmb fwhat fhosts; do
    case "$fid" in '' | '#'*) continue ;; esac
    if [ "$fid" = "$id" ]; then
      mb=$fmb
      what=$fwhat
      hosts=$fhosts
      found=1
    fi
  done <"$DOWNLOADS_FILE"
  [ "$found" = 1 ] || return 0
  DL_TOTAL_MB=$((DL_TOTAL_MB + mb))
  DL_LINES="$DL_LINES
  $(printf '%6s MB  %s (%s)' "$mb" "$what" "$hosts")"
  DL_HOSTS="$DL_HOSTS $hosts"
}

print_network_destinations() {
  local line fid hosts all=
  while IFS='|' read -r fid _ _ hosts; do
    case "$fid" in '' | '#'*) continue ;; esac
    all="$all $hosts"
  done <"$DOWNLOADS_FILE"
  say "The installer may contact only these hosts, and the model endpoint you type:"
  for line in $(printf '%s' "$all" | tr ' ' '\n' | sort -u); do
    say "  $line"
  done
  say "Nothing is scanned and nothing is reported to the project."
}

print_plan() {
  local total_gb
  say "Amanuensis install plan"
  say "  state directory: $AMAN_HOME"
  say "  source checkout: $REPO_ROOT (${REL_REF:-unknown})"
  if [ -n "${DOCKER_ENGINE_VERSION:-}" ]; then
    say "  docker:          Engine $DOCKER_ENGINE_VERSION, Compose ${DOCKER_COMPOSE_VERSION:-?} (access: ${DOCKER_ACCESS:-direct})"
  fi
  say ""
  say "Steps:$PLAN_LINES"
  say ""
  say "Images are built on this machine from the checkout. Nothing is pushed to any registry."
  if [ "$PLAN_ROOT" -gt 0 ]; then
    say "Steps marked [root] use sudo and only run if you answer yes when asked (or pass --install-docker / --add-docker-group; --yes alone does not allow them). The docker group is root-equivalent."
  fi
  if [ -n "$DL_LINES" ]; then
    total_gb=$(awk -v mb="$DL_TOTAL_MB" 'BEGIN {printf "%.1f", mb / 1024}')
    say ""
    say "First-run downloads (approximate):$DL_LINES"
    say "  total: about $DL_TOTAL_MB MB ($total_gb GB)"
    say "  sources:$(printf '%s' "$DL_HOSTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')"
  fi
  say ""
  say "Run code and attachment extraction stay off in this version."
}

# Read-only look at what exists, turned into plan lines and download entries.
plan_build() {
  local name have_release=0 expected_app expected_stt
  PLAN_LINES=
  PLAN_TODO=0
  PLAN_ROOT=0
  PLAN_BLOCKERS=
  preflight_system
  docker_plan_access
  case "$DOCKER_ACCESS" in
    direct) plan_add have "Docker is reachable" ;;
    sg) plan_add have "Docker is reachable through the docker group (no re-login needed for this run)" ;;
    install)
      plan_add root "Install Docker Engine from the vendor repository (see: install.sh --print-root-steps)"
      dl_add docker-engine
      ;;
    add-group) plan_add root "Add $(current_user) to the docker group, then use it for this run without a re-login" ;;
    *)
      plan_add blocked "$(docker_blocked_text)"
      ;;
  esac
  docker_plan_runtime
  if [ -n "$PLAN_BLOCKER" ]; then
    plan_add blocked "$PLAN_BLOCKER"
  fi
  case "$DOCKER_ACCESS" in direct | sg) AMAN_DOCKER_MODE=$DOCKER_ACCESS ;; esac
  if [ -z "$PLAN_BLOCKERS" ]; then
    preflight_docker_space
    preflight_docker_memory
  fi

  if [ -f "$RELEASE_DIR/release.json" ]; then
    have_release=1
  fi
  if [ -d "$AMAN_HOME" ] && [ -f "$STATE_DIR/installed" ]; then
    plan_add have "State directory $AMAN_HOME"
  else
    plan_add todo "Create the state directory $AMAN_HOME"
  fi
  if [ "$have_release" = 1 ] && release_load "$RELEASE_DIR/release.json"; then
    expected_app=$CUR_APP_TAG
    expected_stt=$CUR_STT_TAG
    REL_DEX_IMAGE=$CUR_DEX_IMAGE
    if [ "$expected_app" != "$REL_APP_TAG" ]; then
      plan_add have "Installed release $expected_app (the checkout is at $REL_APP_TAG; install.sh upgrade applies it)"
    fi
    REL_APP_TAG=$expected_app
    REL_STT_TAG=$expected_stt
  fi

  plan_image "$REL_APP_TAG" "Build the app image $REL_APP_TAG from Dockerfile.dev" app-base app-deps dockerfile-frontend
  plan_image "$REL_STT_TAG" "Build the speech-to-text image $REL_STT_TAG from ops/aman-stt" stt-base stt-deps
  plan_image "$REL_DEX_IMAGE" "Pull the login image by digest" dex

  if [ -x "$(doctor_shim)" ]; then
    plan_add have "Doctor command $(doctor_shim)"
  elif [ -f "$INSTALLER_DIR/doctor/amanuensis" ]; then
    plan_add todo "Install the doctor command at $(doctor_shim)"
  fi

  if ! docker_available_for_probes; then
    plan_add todo "Start the shared speech-to-text service (one container, no CPU pinning)"
  elif machine_running; then
    plan_add have "Shared speech-to-text service is running"
  else
    plan_add todo "Start the shared speech-to-text service (one container, no CPU pinning)"
  fi
  if ! docker_available_for_probes || ! docker_volume_exists aman_stt_cache; then
    dl_add stt-weights
  fi

  if [ -n "$(reg_names)" ]; then
    for name in $(reg_names); do
      if docker_available_for_probes && [ "$(instance_state "$name")" = running ]; then
        plan_add have "Instance $name is running"
      else
        plan_add todo "Start instance $name"
      fi
    done
  fi
  if need_new_instance; then
    plan_add todo "Create instance $I_NAME for $I_EMAIL: app at $I_PUBLIC_URL (port $I_PORT on this computer), sign-in service on port $I_LOGIN_PORT"
    dl_add embed
  fi
}

docker_available_for_probes() {
  case "$DOCKER_ACCESS" in direct | sg) return 0 ;; *) return 1 ;; esac
}

# plan_image TAG TEXT download-ids...
plan_image() {
  local tag=$1 text=$2 dl
  shift 2
  if docker_available_for_probes && docker_image_exists "$tag"; then
    plan_add have "Image $tag is present"
  else
    plan_add todo "$text"
    for dl in "$@"; do dl_add "$dl"; done
  fi
}

need_new_instance() {
  [ -z "$(reg_names)" ] || { [ -n "$OPT_NAME" ] && ! reg_exists "$OPT_NAME"; }
}

cmd_install() {
  local name
  DL_TOTAL_MB=0
  DL_LINES=
  DL_HOSTS=
  release_resolve
  AMAN_PASSWORD=
  if need_new_instance; then
    read_password_first
    instance_collect main
    instance_derive
  fi
  plan_build
  print_plan
  if [ -n "$PLAN_BLOCKERS" ]; then
    say ""
    say "This machine cannot be set up yet:$PLAN_BLOCKERS" >&2
    exit 1
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say ""
    say "Dry run: nothing was changed."
    exit 0
  fi
  if [ "$PLAN_TODO" = 0 ]; then
    say ""
    say "Nothing to do."
    print_signout_note
    for name in $(reg_names); do
      print_instance_summary "$name"
    done
    exit 0
  fi
  if ! confirm "Go ahead?"; then
    say "Nothing was changed."
    exit 0
  fi
  install_execute
}

install_execute() {
  local name
  ensure_private_dir "$AMAN_HOME"
  lock_acquire
  docker_prepare
  ensure_private_dir "$RELEASE_DIR"
  ensure_private_dir "$MACHINE_DIR"
  ensure_private_dir "$INSTANCES_DIR"
  install_doctor_shim
  if need_new_instance && [ -z "$AMAN_PASSWORD" ]; then
    ask_password AMAN_PASSWORD
  fi
  images_ensure
  release_write
  machine_up "$REL_STT_TAG"
  for name in $(reg_names); do
    if [ "$(instance_state "$name")" != running ]; then
      instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
      instance_up "$name" || exit 1
    fi
  done
  if need_new_instance; then
    instance_create
    AMAN_PASSWORD=
  fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REL_APP_TAG" >"$STATE_DIR/installed"
  log_event "install complete $REL_APP_TAG"
  for name in $(reg_names); do
    print_instance_summary "$name"
  done
  if [ -x "$(doctor_shim)" ]; then
    say ""
    say "Doctor:"
    run_doctor || warn "doctor reported problems; each one lists its fix"
  fi
  say ""
  say "Backups: install.sh backup  (kept in $BACKUPS_DIR). Upgrade after pulling new source: install.sh upgrade"
  print_signout_note
}
