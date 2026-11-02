# shellcheck shell=bash
# Docker detection, access (group, sudo), supported-runtime checks and the Linux install offer.

# Vendor repository signing key; the installer refuses the repository on any other fingerprint.
DOCKER_APT_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
DOCKER_MIN_ENGINE_MAJOR=23
DOCKER_MIN_COMPOSE_MAJOR=2

AMAN_DOCKER_MODE=direct
DOCKER_STATE=ok
DOCKER_DETAIL=
NEEDS_SIGNOUT=0

# Runs docker the way this run was granted access: directly, through the docker group for this
# process only (sg), or through sudo. BuildKit is required by Dockerfile.dev.
D() {
  as_docker_user env DOCKER_BUILDKIT=1 docker "$@"
}

# Runs any command with the Docker access of this run, so the doctor sees what the installer sees.
as_docker_user() {
  case "$AMAN_DOCKER_MODE" in
    direct) "$@" ;;
    sudo) sudo "$@" ;;
    sg)
      local cmd='' arg
      for arg in "$@"; do
        cmd="${cmd:+$cmd }$(printf '%q' "$arg")"
      done
      sg docker -c "$cmd"
      ;;
    *) die "internal error: unknown docker mode $AMAN_DOCKER_MODE" ;;
  esac
}

# Classifies what `docker info` says without changing anything.
docker_probe() {
  local out
  AMAN_DOCKER_MODE=direct
  DOCKER_STATE=ok
  DOCKER_DETAIL=
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_STATE=missing
    return 0
  fi
  if out=$(docker info 2>&1); then
    return 0
  fi
  DOCKER_DETAIL=$(printf '%s' "$out" | grep -Ei 'permission denied|cannot connect|error' | head -n 1 || true)
  case "$out" in
    # The Docker Desktop shim inside a WSL distro it is not connected to:
    # docker exists but answers with this advice instead of the daemon.
    *"WSL 2 distro"* | *"WSL integration"*) DOCKER_STATE=wsl ;;
    *[Pp]ermission\ denied*) DOCKER_STATE=denied ;;
    *"Cannot connect"* | *"Is the docker daemon running"* | *"error during connect"*) DOCKER_STATE=down ;;
    *) DOCKER_STATE=error ;;
  esac
}

current_user() { id -un; }

# Membership in the group database, which can be newer than this login session.
user_in_docker_group_db() {
  getent group docker 2>/dev/null | cut -d: -f4 | tr ',' '\n' | grep -qx "$(current_user)"
}

# With a docker group the session lacks, sg grants it for the commands of this run only.
docker_works_via_sg() {
  command -v sg >/dev/null 2>&1 && sg docker -c 'docker info' >/dev/null 2>&1
}

# Read-only: how docker would be reached. Sets DOCKER_ACCESS to
# direct, sg, sudo, add-group (needs root), install (needs root), or blocked.
docker_plan_access() {
  DOCKER_ACCESS=blocked
  docker_probe
  case "$DOCKER_STATE" in
    ok) DOCKER_ACCESS=direct ;;
    missing)
      if docker_install_supported; then
        DOCKER_ACCESS=install
      fi
      ;;
    denied)
      if user_in_docker_group_db && docker_works_via_sg; then
        DOCKER_ACCESS=sg
      elif [ "$(uname -s)" = Linux ] && command -v sudo >/dev/null 2>&1; then
        DOCKER_ACCESS=add-group
      fi
      ;;
  esac
}

docker_install_supported() {
  [ "$(uname -s)" = Linux ] && [ -n "$(os_release_value ID | grep -E '^(debian|ubuntu)$' || true)" ] &&
    command -v apt-get >/dev/null 2>&1
}

os_release_value() {
  local file=${AMAN_OS_RELEASE:-/etc/os-release}
  [ -r "$file" ] || return 0
  sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$file" | head -n 1
}

run_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Asks for the password once, before the first root change, so a refused password stops the run with nothing half
# done and later sudo calls of this run do not ask again. $1 says what was left as it was.
root_ready() {
  [ "$(id -u)" != 0 ] || return 0
  command -v sudo >/dev/null 2>&1 || die "This needs administrator rights, and this computer has no way to ask for them, so $1. Run the same command again from an administrator account."
  sudo -n true 2>/dev/null && return 0
  # sudo reads the password from the terminal, so a run without one cannot be asked.
  (: </dev/tty) 2>/dev/null ||
    die "This needs your computer password, which can only be typed in a terminal window, so $1. Run the same command again in a terminal window."
  ui_event_admin "A step that changes this computer needs administrator rights, so your computer will ask for your password now."
  sudo -v ||
    die "The password was not accepted, so $1. Type the password you use to log in to this computer, then run the same command again."
}

# Shell function the root steps run on the downloaded key. The file must hold exactly one primary key
# and its fingerprint must be the pinned one; subkey fingerprints belong to that primary key, so only
# the fingerprint that follows each pub record is compared.
docker_key_check_snippet() {
  cat <<'SNIPPET'
docker_key_ok() {
  gpg --show-keys --with-colons "$1" | awk -F: -v want="$2" '
    $1 == "pub" { keys++; primary = 1; next }
    $1 == "sub" { primary = 0; next }
    $1 == "fpr" && primary { primary = 0; if ($10 != want) bad = 1 }
    END { if (keys == 1 && !bad) exit 0; exit 1 }'
}
SNIPPET
}

# The exact root steps. Printed before they run; the convenience script is never used.
docker_root_steps_script() {
  local distro codename arch user
  distro=$(os_release_value ID)
  codename=$(os_release_value UBUNTU_CODENAME)
  [ -n "$codename" ] || codename=$(os_release_value VERSION_CODENAME)
  arch=$(dpkg --print-architecture)
  user=$(current_user)
  cat <<STEPS
set -eu
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$distro/gpg -o /etc/apt/keyrings/docker.asc.download
$(docker_key_check_snippet)
if ! docker_key_ok /etc/apt/keyrings/docker.asc.download $DOCKER_APT_KEY_FPR; then
  echo "The downloaded Docker repository key is not the pinned key $DOCKER_APT_KEY_FPR, or holds other keys" >&2
  rm -f /etc/apt/keyrings/docker.asc.download
  exit 1
fi
mv /etc/apt/keyrings/docker.asc.download /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$distro $codename stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker $user
STEPS
}

print_root_steps() {
  if docker_install_supported; then
    say "Root steps to install Docker Engine (run as root; the download key must be $DOCKER_APT_KEY_FPR):"
    docker_root_steps_script | sed 's/^/    /'
  else
    say "This computer does not use apt, so the installer cannot install Docker for you."
    say "Install Docker Engine (Linux) or Docker Desktop (macOS, Windows) by hand, then run this again."
  fi
}

# Execute phase: install Docker when asked, add the user to the group, and pick an access mode that
# works right now without a new login. NEEDS_SIGNOUT remembers that other terminals need one.
docker_prepare() {
  docker_plan_access
  case "$DOCKER_ACCESS" in
    install)
      ui_phase "Installing Docker"
      ui_line "Docker is not installed. Installing it needs administrator rights (sudo) and changes this computer."
      print_root_steps
      ui_hint "Being able to use Docker is as powerful as being an administrator of this computer."
      if ! consent_root "Install Docker Engine now?" "$OPT_INSTALL_DOCKER"; then
        die "Docker is needed, and nothing was installed. Run install.sh again and answer yes, or pass --install-docker. --yes alone never installs software."
      fi
      run_root sh -c "$(docker_root_steps_script)" || die "The Docker install steps failed. Nothing else was changed."
      NEEDS_SIGNOUT=1
      docker_plan_access
      ;;
  esac
  if [ "$DOCKER_ACCESS" = add-group ]; then
    ui_phase "Docker access"
    ui_line "Your user cannot use Docker yet. Giving it access needs administrator rights (sudo)."
    ui_hint "Being able to use Docker is as powerful as being an administrator of this computer."
    if ! consent_root "Add $(current_user) to the docker group?" "$OPT_ADD_DOCKER_GROUP"; then
      die "Docker access was not granted, so nothing was changed. Run install.sh again and answer yes, or pass --add-docker-group. --yes alone never changes groups."
    fi
    run_root usermod -aG docker "$(current_user)" || die "Giving your user Docker access failed. Add your user to the docker group by hand, then run this again."
    NEEDS_SIGNOUT=1
    if docker_works_via_sg; then
      DOCKER_ACCESS=sg
    elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
      # Only reached after the yes above, for this run only.
      warn "Using sudo for Docker during this run only"
      DOCKER_ACCESS=sudo
    fi
  fi
  case "$DOCKER_ACCESS" in
    direct) AMAN_DOCKER_MODE=direct ;;
    sg)
      AMAN_DOCKER_MODE=sg
      NEEDS_SIGNOUT=1
      ;;
    sudo) AMAN_DOCKER_MODE=sudo ;;
    *) docker_fail_message ;;
  esac
  docker_runtime_check
}

# Sets DB_HEAD to what is wrong and DB_NEXT to what to do, for the state docker_probe found.
docker_blocked_parts() {
  case "$DOCKER_STATE" in
    missing)
      DB_HEAD="Docker is not installed"
      DB_NEXT=$(docker_install_hint)
      ;;
    down)
      DB_HEAD="Docker is installed but not running"
      DB_NEXT="Start it (macOS and Windows: open Docker Desktop; Linux: run install.sh docker), then run install.sh again."
      ;;
    denied)
      DB_HEAD="Your user cannot use Docker yet"
      DB_NEXT="Run install.sh docker to give it access (it asks before using admin rights), then run install.sh again."
      ;;
    wsl)
      DB_HEAD="Docker Desktop is not connected to this WSL distro"
      DB_NEXT="Open Docker Desktop and choose Settings, then Resources, then WSL Integration. Turn on this distro, choose Apply & Restart, then run install.sh again."
      ;;
    *)
      DB_HEAD="Docker did not answer"
      DB_NEXT="Check that Docker is running, then run this again."
      ;;
  esac
}

docker_blocked_text() {
  docker_blocked_parts
  echo "$DB_HEAD. $DB_NEXT${DOCKER_DETAIL:+ ($DOCKER_DETAIL)}"
}

docker_fail_message() { die "$(docker_blocked_text)"; }

docker_install_hint() {
  if docker_install_supported; then
    echo "Run install.sh again and answer yes to install it, or see the steps with install.sh --print-root-steps."
  else
    echo "Install Docker Engine with Compose v2 or newer (Linux) or Docker Desktop (macOS, Windows), then run this again."
  fi
}

# Sets RUNTIME_PROBLEM to one plain sentence when the runtime cannot be used, empty when it can.
# Rootless Docker and Podman are unsupported: the stack relies on loopback publishing and shared namespaces.
docker_runtime_problem() {
  local info version engine compose major secopts
  RUNTIME_PROBLEM=
  if ! info=$(D info 2>&1); then
    RUNTIME_PROBLEM="Docker did not answer: $(printf '%s' "$info" | head -n 1)"
    return 0
  fi
  version=$(D version 2>&1 || true)
  if printf '%s\n%s' "$info" "$version" | grep -qi 'podman'; then
    RUNTIME_PROBLEM="Podman is not supported. Install Docker Engine (Linux) or Docker Desktop, then run this again."
    return 0
  fi
  secopts=$(D info --format '{{.SecurityOptions}}' 2>/dev/null || true)
  if printf '%s\n%s' "$secopts" "$info" | grep -Eqi 'name=rootless|^[[:space:]]*rootless[[:space:]]*$'; then
    RUNTIME_PROBLEM="Rootless Docker is not supported. Install the standard Docker Engine, then run this again."
    return 0
  fi
  engine=$(D version --format '{{.Server.Version}}' 2>/dev/null || true)
  major=${engine%%.*}
  case "$major" in
    '' | *[![:digit:]]*)
      RUNTIME_PROBLEM="Could not read the Docker Engine version."
      return 0
      ;;
  esac
  if [ "$major" -lt "$DOCKER_MIN_ENGINE_MAJOR" ]; then
    RUNTIME_PROBLEM="Docker Engine $engine is too old. Update it to version $DOCKER_MIN_ENGINE_MAJOR or newer, then run this again."
    return 0
  fi
  if docker_engine_leaks_loopback "$engine" "$(D info --format '{{.OperatingSystem}}' 2>/dev/null || true)"; then
    RUNTIME_PROBLEM=$(docker_leaks_loopback_text "$engine")
    return 0
  fi
  compose=$(D compose version --short 2>/dev/null || true)
  compose=${compose#v}
  if [[ ! $compose =~ ^([[:digit:]]+)\.[[:digit:]]+ ]]; then
    RUNTIME_PROBLEM="Docker Compose is missing; version $DOCKER_MIN_COMPOSE_MAJOR is needed. Run install.sh docker to install it, then run this again."
    return 0
  fi
  if [ "$((10#${BASH_REMATCH[1]}))" -lt "$DOCKER_MIN_COMPOSE_MAJOR" ]; then
    RUNTIME_PROBLEM="Docker Compose $compose is too old; version $DOCKER_MIN_COMPOSE_MAJOR is needed. Run install.sh docker to update it, then run this again."
    return 0
  fi
  DOCKER_ENGINE_VERSION=$engine
  DOCKER_COMPOSE_VERSION=$compose
}

docker_runtime_check() {
  docker_runtime_problem
  if [ -n "$RUNTIME_PROBLEM" ]; then
    die "$RUNTIME_PROBLEM"
  fi
}

# Read-only variant for the plan: the blocker is reported instead of exiting.
docker_plan_runtime() {
  local saved=$AMAN_DOCKER_MODE
  PLAN_BLOCKER=
  case "$DOCKER_ACCESS" in
    direct | sg)
      AMAN_DOCKER_MODE=$DOCKER_ACCESS
      docker_runtime_problem
      PLAN_BLOCKER=$RUNTIME_PROBLEM
      AMAN_DOCKER_MODE=$saved
      ;;
  esac
}

docker_image_exists() { D image inspect "$1" >/dev/null 2>&1; }
docker_volume_exists() { D volume inspect "$1" >/dev/null 2>&1; }

# Dry runs and plans only look: the access mode is set from what already works.
docker_attach() {
  if [ "$DRY_RUN" != 1 ]; then
    docker_prepare
    return 0
  fi
  docker_plan_access
  case "$DOCKER_ACCESS" in
    direct | sg) AMAN_DOCKER_MODE=$DOCKER_ACCESS ;;
    *) docker_fail_message ;;
  esac
}

# ---- aman doctor docker --fix -----------------------------------------------------------------

# Installs the Compose plugin where the system's packages have it; every sudo is asked about first.
docker_install_compose() {
  if ! docker_install_supported; then
    die "Docker Compose 2 is needed. Docker Desktop includes it: update Docker Desktop, then run aman doctor."
  fi
  ui_line "Docker Compose 2 is missing or too old. Installing it needs administrator rights (sudo)."
  consent_root "Install Docker Compose now?" 0 ||
    die "Docker Compose was not installed. Run aman doctor docker --fix again and answer yes."
  run_root apt-get install -y docker-compose-plugin || die "Installing Docker Compose failed. Nothing else was changed."
}

# Starts the Docker engine where it is a service of this computer.
docker_start_engine() {
  if [ "$(uname -s)" != Linux ] || ! command -v systemctl >/dev/null 2>&1; then
    die "Docker is not running. Open Docker Desktop and wait until it says it is running, then run aman doctor."
  fi
  ui_line "Docker is installed but not running. Starting it needs administrator rights (sudo)."
  consent_root "Start Docker now?" 0 || die "Docker was not started. Run aman doctor docker --fix again and answer yes."
  run_root systemctl start docker || die "Docker did not start. Nothing else was changed."
}

# Installs or starts Docker, gives this user access, and brings Compose up to date, asking before each sudo.
docker_fix() {
  local compose major
  docker_probe
  if [ "$DOCKER_STATE" = down ]; then
    docker_start_engine
    docker_probe
  fi
  case "$DOCKER_STATE" in
    missing | denied) docker_prepare ;;
    error | wsl) die "$(docker_blocked_text)" ;;
  esac
  compose=$(D compose version --short 2>/dev/null || true)
  compose=${compose#v}
  major=${compose%%.*}
  if [[ ! $major =~ ^[[:digit:]]+$ ]] || [ "$major" -lt "$DOCKER_MIN_COMPOSE_MAJOR" ]; then
    docker_install_compose
  fi
  docker_runtime_check
  ui_ok "Docker is ready"
  if [ "$NEEDS_SIGNOUT" = 1 ]; then ui_line "Open a new terminal window so every terminal can use Docker."; fi
}
