# shellcheck shell=bash
# Shared test helpers. Every test runs the real installer in a throwaway sandbox with docker, sudo and
# the other external commands replaced by stubs; nothing outside the sandbox directory is touched.

TESTS_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INSTALLER_DIR=$(cd -P -- "$TESTS_DIR/.." && pwd)
SENTINEL_PASSWORD="sentinel-pw-7f3a91c2"

# The host's Node.js, which the docker stub uses to run the certificate and code scripts for real.
STUB_REAL_NODE=$(command -v node 2>/dev/null || true)

PASSED=0
FAILED=0
CURRENT_TEST=

# System tools the installer needs. docker, sudo, sg, id and friends are never taken from the host.
TOOLS="bash sh env awk sed grep egrep cut tr od head tail sort uniq wc cat cp mv rm mkdir rmdir chmod mktemp date cmp find
basename dirname uname kill sleep ln install git sha256sum shasum tee readlink ls touch xargs timeout getconf true false python3 diff tar gzip stat"

sandbox_new() {
  SB=$(mktemp -d)
  SB_BIN=$SB/bin
  SB_STATE=$SB/stubstate
  mkdir -p "$SB_BIN" "$SB_STATE" "$SB/user"
  local t path
  for t in $TOOLS; do
    path=$(command -v "$t" 2>/dev/null || true)
    case "$path" in /*) ln -sf "$path" "$SB_BIN/$t" ;; esac
  done
  for t in "$TESTS_DIR"/stubs/*; do
    case "$(basename "$t")" in
      aman-doctor | caddy | systemctl | ip | hostname | tailscale | launchctl) ;;
      *) cp "$t" "$SB_BIN/" ;;
    esac
  done
  # Host Node.js is not part of the machine unless a test adds it: the installer brings its own.
  rm -f "$SB_BIN/node"
  stage_installer
  STUB_REAL_DF=$(command -v df)
  export STUB_LOG=$SB/stub.log STUB_STATE=$SB_STATE STUB_BIN=$SB_BIN STUB_USER=testuser
  export STUB_DOCKER_SRC=$TESTS_DIR/stubs/docker STUB_REAL_DF
  : >"$STUB_LOG"
  AMAN_HOME=$SB/home
  REPO=$SB/repo
  fixture_repo "$REPO"
  fixture_node_runtime
  unset STUB_DOCKER_DENIED STUB_DOCKER_DOWN STUB_ROOTLESS STUB_PODMAN STUB_BUILD_FAIL STUB_BUILD_OOM STUB_DOCKER_MEM_BYTES STUB_UP_FAIL_UNLESS_TAG \
    STUB_DOCKER_ROOT STUB_DOCKER_ROOT_KB AMAN_PASSWORD STUB_BUSY_PORTS STUB_BACKUP_FAIL STUB_VOLUME_RM_FAIL STUB_ENGINE_VERSION STUB_COMPOSE_VERSION STUB_DOCTOR_EXIT STUB_VIA_SG STUB_VIA_SUDO \
    STUB_CURL_FAIL STUB_CURL_CORRUPT STUB_SUDO_SH_FAIL STUB_SUDO_REFUSE STUB_SLOT_DISK_FAIL STUB_APPARMOR STUB_CGROUP STUB_DOCKER_OS STUB_NO_BUNDLE STUB_UP_FAIL_LOG STUB_ADDRS STUB_HOSTNAME STUB_TS_IP STUB_TS_NAME STUB_TS_HANG STUB_NODE_VERSION STUB_PKI_FAIL STUB_SANDBOX_DOCTOR_EXIT STUB_SLOT_BUILD_RC STUB_DEMO_FAIL STUB_IMPORT_FAIL STUB_IMPORT_SIGNAL \
    STUB_MODEL_DOWNLOADING STUB_MODEL_BROKEN STUB_EXPORT_USERS STUB_EXPORT_FAIL STUB_EXPORT_LIST_FAIL STUB_PGDUMP_FAIL STUB_OLD_PG_STOPPED STUB_COPY_SIGNAL STUB_FAIL_ON || true
  STUB_DF_KB=50000000
  INSTALL_EXTRA=()
  RUN_ENV_EXTRA=()
}

# A copy of the installer with the stub doctor in place of the real shim, so install and upgrade runs
# do not depend on what the real doctor makes of the stubbed docker. The real shim is tested on its own.
stage_installer() {
  SB_INSTALLER=$SB/installer
  mkdir -p "$SB_INSTALLER/doctor"
  cp -R "$INSTALLER_DIR/install.sh" "$INSTALLER_DIR/lib" "$INSTALLER_DIR/templates" "$INSTALLER_DIR/release.json" "$INSTALLER_DIR/downloads.txt" "$SB_INSTALLER/"
  cp "$TESTS_DIR/stubs/aman-doctor" "$SB_INSTALLER/doctor/aman"
}

# The pinned Node.js release as tarballs a stub curl can serve, for every platform the installer knows, with the staged
# release.json pointing at their real SHA-256. The "binary" in each is a wrapper around the stub node, so a run that
# uses the downloaded runtime leaves the same log lines as one that uses a host Node.js.
fixture_node_runtime() {
  local version platform dir hash pins=$SB_INSTALLER/release.json key
  version=$(sed -n 's/.*"node_version"[^"]*"\([^"]*\)".*/\1/p' "$INSTALLER_DIR/release.json")
  NODE_PIN_VERSION=$version
  mkdir -p "$SB_STATE/dist"
  for platform in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
    dir=$SB/nodebuild/node-v$version-$platform/bin
    mkdir -p "$dir"
    cat >"$dir/node" <<NODE
#!/usr/bin/env bash
STUB_NODE_VERSION=\${STUB_NODE_VERSION:-v$version}
export STUB_NODE_VERSION
exec bash $TESTS_DIR/stubs/node "\$@"
NODE
    chmod 755 "$dir/node"
    tar -czf "$SB_STATE/dist/node-v$version-$platform.tar.gz" -C "$SB/nodebuild" "node-v$version-$platform"
    hash=$(sha256sum "$SB_STATE/dist/node-v$version-$platform.tar.gz" | cut -d' ' -f1)
    key=node_sha256_${platform//-/_}
    sed "s|\"$key\": \"[a-f0-9]*\"|\"$key\": \"$hash\"|" "$pins" >"$pins.new" && mv "$pins.new" "$pins"
  done
}

# Replaces the system uname with one that reports the given kernel name and machine, for platform selection.
fixture_uname() {
  rm -f "$SB_BIN/uname"
  cat >"$SB_BIN/uname" <<UNAME
#!/usr/bin/env bash
case "\${1:-}" in
  -m) echo $2 ;;
  -r) echo 6.8.0-generic ;;
  *) echo $1 ;;
esac
UNAME
  chmod 755 "$SB_BIN/uname"
}

# Caddy is on the machine; a second call is the same.
fixture_caddy() {
  cp "$TESTS_DIR/stubs/caddy" "$SB_BIN/caddy"
}

# This computer has these network addresses (space separated), so an instance opens on each of them.
fixture_network() {
  cp "$TESTS_DIR/stubs/ip" "$SB_BIN/ip"
  STUB_ADDRS=$*
}

# This computer is called NAME on its network.
fixture_hostname() {
  cp "$TESTS_DIR/stubs/hostname" "$SB_BIN/hostname"
  STUB_HOSTNAME=$1
}

# Tailscale is running here with this address and MagicDNS name.
fixture_tailscale() {
  cp "$TESTS_DIR/stubs/tailscale" "$SB_BIN/tailscale"
  STUB_TS_IP=$1
  STUB_TS_NAME=$2
}

# systemctl only logs; "cat" fails so the installer treats the Caddy unit as absent unless a test needs it.
fixture_systemctl() {
  cp "$TESTS_DIR/stubs/systemctl" "$SB_BIN/systemctl"
}

# The next root script that reaches the sudo stub is run for real inside the sandbox (its paths all sit under
# AMAN_CADDY_ETC), so a test can look at the files it leaves behind.
fixture_run_root_scripts() { : >"$SB_STATE/run_root_sh"; }

# What the DNS check sees: the machine's public address and what a name resolves to (example.com names only).
fixture_public_ip() { printf '%s\n' "$1" >"$SB_STATE/public_ip"; }
fixture_dns() {
  local host=$1
  shift
  mkdir -p "$SB_STATE/dns"
  printf '%s\n' "$@" >"$SB_STATE/dns/$host"
}

# fixture_route URL STATUS BODY [pinned]: what the stub curl answers for a URL; "pinned" is for a request that
# maps the name to this machine with --resolve.
fixture_route() {
  local key=$1
  [ "${4:-}" != pinned ] || key="resolve:$1"
  printf '%s\t%s\t%s\n' "$key" "$2" "$3" >>"$SB_STATE/curl_routes"
}

# Puts a host Node.js (the stub) on the PATH of the installer.
fixture_host_node() {
  cp "$TESTS_DIR/stubs/node" "$SB_BIN/node"
}

sandbox_drop() {
  rm -rf "$SB"
}

# A tiny git checkout standing in for the repository: the build contexts and the slots compose file the doctor looks for.
fixture_repo() {
  mkdir -p "$1/ops/aman-stt" "$1/ops/calendar-sidecar" "$1/ops/compose/mail-email"
  printf 'FROM scratch\n' >"$1/Dockerfile.dev"
  printf 'name: slots\n' >"$1/docker-compose.slots.yml"
  printf 'FROM scratch\n' >"$1/ops/aman-stt/Dockerfile"
  printf 'FROM scratch\n' >"$1/ops/calendar-sidecar/Dockerfile"
  printf '#!/bin/sh\n' >"$1/ops/compose/mail-email/entrypoint.sh"
  (
    cd "$1"
    git init -q .
    git add -A
    git -c user.name=t -c user.email=t@example.invalid commit -q -m fixture
  )
}

repo_commit_change() {
  printf '%s\n' "$1" >>"$REPO/ops/aman-stt/Dockerfile"
  (
    cd "$REPO"
    git add -A
    git -c user.name=t -c user.email=t@example.invalid commit -q -m "change $1"
  )
}

# The environment every installer run gets: nothing from the caller except the stub switches.
build_run_env() {
  RUN_ENV=(PATH="$SB_BIN" HOME="$SB/user" AMAN_HOME="$AMAN_HOME" AMAN_REPO_ROOT="$REPO"
    AMAN_OS_RELEASE="${AMAN_OS_RELEASE:-$SB/os-release}" AMAN_DMI_DIR="${AMAN_DMI_DIR:-$SB/no-dmi}"
    STUB_LOG="$STUB_LOG" STUB_STATE="$STUB_STATE" STUB_BIN="$STUB_BIN" STUB_USER="$STUB_USER"
    STUB_DOCKER_SRC="$STUB_DOCKER_SRC" STUB_REAL_DF="$STUB_REAL_DF"
    STUB_DOCKER_DENIED="${STUB_DOCKER_DENIED:-}" STUB_DOCKER_DOWN="${STUB_DOCKER_DOWN:-}"
    STUB_ROOTLESS="${STUB_ROOTLESS:-}" STUB_PODMAN="${STUB_PODMAN:-}" STUB_BUILD_FAIL="${STUB_BUILD_FAIL:-}"
    STUB_BUILD_OOM="${STUB_BUILD_OOM:-}" STUB_DOCKER_MEM_BYTES="${STUB_DOCKER_MEM_BYTES:-}"
    STUB_UP_FAIL_UNLESS_TAG="${STUB_UP_FAIL_UNLESS_TAG:-}" STUB_DF_KB="${STUB_DF_KB:-}"
    STUB_BUSY_PORTS="${STUB_BUSY_PORTS:-}" STUB_BACKUP_FAIL="${STUB_BACKUP_FAIL:-}" STUB_VOLUME_RM_FAIL="${STUB_VOLUME_RM_FAIL:-}"
    STUB_ENGINE_VERSION="${STUB_ENGINE_VERSION:-}" ${STUB_COMPOSE_VERSION+STUB_COMPOSE_VERSION="$STUB_COMPOSE_VERSION"}
    STUB_CURL_FAIL="${STUB_CURL_FAIL:-}" STUB_CURL_CORRUPT="${STUB_CURL_CORRUPT:-}" STUB_SUDO_SH_FAIL="${STUB_SUDO_SH_FAIL:-}"
    STUB_SUDO_REFUSE="${STUB_SUDO_REFUSE:-}" STUB_SLOT_DISK_FAIL="${STUB_SLOT_DISK_FAIL:-}"
    STUB_APPARMOR="${STUB_APPARMOR:-}" STUB_CGROUP="${STUB_CGROUP:-}" STUB_DOCKER_OS="${STUB_DOCKER_OS:-}" STUB_NO_BUNDLE="${STUB_NO_BUNDLE:-}"
    STUB_UP_FAIL_LOG="${STUB_UP_FAIL_LOG:-}" STUB_ADDRS="${STUB_ADDRS:-}" STUB_HOSTNAME="${STUB_HOSTNAME:-}" STUB_TS_IP="${STUB_TS_IP:-}" STUB_TS_NAME="${STUB_TS_NAME:-}" STUB_TS_HANG="${STUB_TS_HANG:-}" STUB_NODE_VERSION="${STUB_NODE_VERSION:-}" STUB_SANDBOX_DOCTOR_EXIT="${STUB_SANDBOX_DOCTOR_EXIT:-}" STUB_SLOT_BUILD_RC="${STUB_SLOT_BUILD_RC:-}" STUB_DEMO_FAIL="${STUB_DEMO_FAIL:-}" STUB_IMPORT_FAIL="${STUB_IMPORT_FAIL:-}" STUB_IMPORT_SIGNAL="${STUB_IMPORT_SIGNAL:-}"
    STUB_MODEL_DOWNLOADING="${STUB_MODEL_DOWNLOADING:-}" STUB_MODEL_BROKEN="${STUB_MODEL_BROKEN:-}" STUB_EXPORT_USERS="${STUB_EXPORT_USERS:-}"
    STUB_EXPORT_FAIL="${STUB_EXPORT_FAIL:-}" STUB_EXPORT_LIST_FAIL="${STUB_EXPORT_LIST_FAIL:-}" STUB_PGDUMP_FAIL="${STUB_PGDUMP_FAIL:-}" STUB_OLD_PG_STOPPED="${STUB_OLD_PG_STOPPED:-}" STUB_COPY_SIGNAL="${STUB_COPY_SIGNAL:-}" AMAN_IMPORT_POLL_SECONDS=0 STUB_FAIL_ON="${STUB_FAIL_ON:-}"
    STUB_DOCTOR_EXIT="${STUB_DOCTOR_EXIT:-}" STUB_DOCKER_ROOT="${STUB_DOCKER_ROOT:-}" STUB_DOCKER_ROOT_KB="${STUB_DOCKER_ROOT_KB:-}"
    STUB_UI_SH="$INSTALLER_DIR/lib/ui.sh" STUB_REAL_NODE="$STUB_REAL_NODE" STUB_PKI_FAIL="${STUB_PKI_FAIL:-}"
    AMAN_CADDY_ETC="$SB/etc-caddy" AMAN_SYS_NET="$SB/sysnet" AMAN_EDGE_WAIT_TRIES=1 ${RUN_ENV_EXTRA[@]+"${RUN_ENV_EXTRA[@]}"}
    ${AMAN_PASSWORD+AMAN_PASSWORD="$AMAN_PASSWORD"})
}

# run_install [args...] with optional stdin from $INPUT. Output lands in OUT, ERR and RC.
run_install() {
  local out=$SB/out err=$SB/err
  build_run_env
  set +e
  env -i "${RUN_ENV[@]}" bash "$SB_INSTALLER/install.sh" "$@" <"${INPUT_FILE:-/dev/null}" >"$out" 2>"$err"
  RC=$?
  set -e
  OUT=$(cat "$out")
  ERR=$(cat "$err")
}

# run_install_tty "prompt=>reply" lines, then args: runs on a pseudo terminal, so echo behaves as it does for a
# person. The transcript lands in OUT and the exit code in RC.
run_install_tty() {
  local answers=$1
  shift
  build_run_env
  printf '%s\n' "$answers" >"$SB/answers"
  set +e
  OUT=$(python3 "$TESTS_DIR/pty_run.py" "$SB/answers" -- env -i "${RUN_ENV[@]}" TERM=dumb bash "$SB_INSTALLER/install.sh" "$@")
  set -e
  RC=$(printf '%s\n' "$OUT" | sed -n 's/^\[exit \([[:digit:]]*\)\]$/\1/p' | tail -n 1)
  ERR=
}

# Feeds stdin to the next run_install from a string.
with_input() {
  INPUT_FILE=$SB/input
  printf '%s' "$1" >"$INPUT_FILE"
}

clear_input() { INPUT_FILE=; }

# The email sign-in check runs python3 with -c. This stand-in records what it was given and answers with the text in
# imap_answer (ok when absent). Every other python3 call goes to the real one, so the rest of the installer is unchanged.
install_python_stub() {
  local real
  real=$(command -v python3)
  rm -f "$SB_BIN/python3"
  cat >"$SB_BIN/python3" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *imaplib*)
    printf '%s\n' "$*" >>"$STUB_STATE/imap_argv"
    cat >"$STUB_STATE/imap_stdin"
    cat "$STUB_STATE/imap_answer" 2>/dev/null || echo ok
    ;;
  *) exec "$STUB_REAL_PY3" "$@" ;;
esac
STUB
  chmod 755 "$SB_BIN/python3"
  RUN_ENV_EXTRA+=("STUB_REAL_PY3=$real")
}

os_release_ubuntu() {
  printf 'ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n' >"$SB/os-release"
}

# Install with defaults for tests that need an installed machine. Docker stub reachable, one instance "main".
# INSTALL_EXTRA holds extra install.sh arguments for the call, for example (--add-docker-group).
INSTALL_EXTRA=()
# Extra VAR=value settings for the next runs, such as LANG or CLICOLOR_FORCE for the terminal style.
RUN_ENV_EXTRA=()
install_machine() {
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid ${INSTALL_EXTRA[@]+"${INSTALL_EXTRA[@]}"}
  clear_input
  [ "$RC" = 0 ] || {
    printf 'install_machine failed (rc=%s)\n%s\n%s\n' "$RC" "$OUT" "$ERR" >&2
    return 1
  }
}

# ---- assertions ----------------------------------------------------------------------------------

t_begin() { CURRENT_TEST=$1; }

t_fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL: %s: %s\n' "$CURRENT_TEST" "$*" >&2
}

t_pass() { PASSED=$((PASSED + 1)); }

assert_eq() {
  if [ "$1" = "$2" ]; then t_pass; else t_fail "${3:-values differ}: expected [$2] got [$1]"; fi
}

assert_contains() {
  case "$1" in *"$2"*) t_pass ;; *) t_fail "${3:-missing text}: expected to find [$2] in [$(printf '%s' "$1" | head -c 600)]" ;; esac
}

# The text with every run of whitespace collapsed to one space, so a sentence the plan wrapped still matches.
flat() { printf '%s' "$1" | tr '\n' ' ' | tr -s ' '; }

assert_flat_contains() {
  assert_contains "$(flat "$1")" "$2" "${3:-}"
}

assert_not_contains() {
  case "$1" in *"$2"*) t_fail "${3:-unexpected text}: found [$2]" ;; *) t_pass ;; esac
}

assert_rc() {
  if [ "$RC" = "$1" ]; then t_pass; else t_fail "expected exit $1, got $RC; stdout: $OUT; stderr: $ERR"; fi
}

assert_file() {
  if [ -f "$1" ]; then t_pass; else t_fail "missing file $1"; fi
}

assert_no_path() {
  if [ ! -e "$1" ]; then t_pass; else t_fail "unexpected path $1"; fi
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

assert_mode() {
  assert_eq "$(file_mode "$1")" "$2" "mode of $1"
}

# The names directly under a directory, hidden ones included, sorted and space separated with a trailing space.
dir_names() {
  local f
  for f in "$1"/* "$1"/.[!.]*; do
    [ -e "$f" ] || continue
    basename "$f"
  done | sort | tr '\n' ' '
}

log_has() { grep -Fq -- "$1" "$STUB_LOG"; }

assert_log_has() {
  if log_has "$1"; then t_pass; else t_fail "docker log lacks [$1]"; fi
}

assert_log_lacks() {
  if log_has "$1"; then t_fail "docker log has [$1]"; else t_pass; fi
}

log_count() { grep -Fc -- "$1" "$STUB_LOG" || true; }

# True when no file under $1 contains the sentinel.
assert_tree_lacks() {
  if grep -rIl -- "$2" "$1" >/dev/null 2>&1; then
    t_fail "found [$2] under $1: $(grep -rIl -- "$2" "$1" | head -n 3 | tr '\n' ' ')"
  else
    t_pass
  fi
}

tests_finish() {
  printf '%s: %s passed, %s failed\n' "$(basename "$0")" "$PASSED" "$FAILED"
  [ "$FAILED" = 0 ]
}
