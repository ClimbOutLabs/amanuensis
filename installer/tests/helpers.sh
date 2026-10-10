# shellcheck shell=bash
# Shared test helpers. Every test runs the real installer in a throwaway sandbox with docker, sudo and
# the other external commands replaced by stubs; nothing outside the sandbox directory is touched.

TESTS_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INSTALLER_DIR=$(cd -P -- "$TESTS_DIR/.." && pwd)
SENTINEL_PASSWORD="sentinel-pw-7f3a91c2"

PASSED=0
FAILED=0
CURRENT_TEST=

# System tools the installer needs. docker, sudo, sg, id and friends are never taken from the host.
TOOLS="bash sh env awk sed grep egrep cut tr od head tail sort uniq wc cat cp mv rm mkdir rmdir chmod mktemp date cmp find
basename dirname uname kill sleep ln git sha256sum shasum tee readlink ls touch xargs timeout getconf true false python3 diff tar stat"

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
      amanuensis-doctor) ;;
      *) cp "$t" "$SB_BIN/" ;;
    esac
  done
  stage_installer
  STUB_REAL_DF=$(command -v df)
  export STUB_LOG=$SB/stub.log STUB_STATE=$SB_STATE STUB_BIN=$SB_BIN STUB_USER=testuser
  export STUB_DOCKER_SRC=$TESTS_DIR/stubs/docker STUB_REAL_DF
  : >"$STUB_LOG"
  AMAN_HOME=$SB/home
  REPO=$SB/repo
  fixture_repo "$REPO"
  unset STUB_DOCKER_DENIED STUB_DOCKER_DOWN STUB_ROOTLESS STUB_PODMAN STUB_BUILD_FAIL STUB_UP_FAIL_UNLESS_TAG \
    STUB_DOCKER_ROOT STUB_DOCKER_ROOT_KB AMAN_PASSWORD STUB_BUSY_PORTS STUB_BACKUP_FAIL STUB_VOLUME_RM_FAIL STUB_ENGINE_VERSION STUB_COMPOSE_VERSION STUB_DOCTOR_EXIT STUB_VIA_SG STUB_VIA_SUDO || true
  STUB_DF_KB=50000000
  INSTALL_EXTRA=()
}

# A copy of the installer with the stub doctor in place of the real shim, so install and upgrade runs
# do not depend on what the real doctor makes of the stubbed docker. The real shim is tested on its own.
stage_installer() {
  SB_INSTALLER=$SB/installer
  mkdir -p "$SB_INSTALLER/doctor"
  cp -R "$INSTALLER_DIR/install.sh" "$INSTALLER_DIR/lib" "$INSTALLER_DIR/templates" "$INSTALLER_DIR/release.json" "$INSTALLER_DIR/downloads.txt" "$SB_INSTALLER/"
  cp "$TESTS_DIR/stubs/amanuensis-doctor" "$SB_INSTALLER/doctor/amanuensis"
}

sandbox_drop() {
  rm -rf "$SB"
}

# A tiny git checkout standing in for the repository: the installer only needs the two build contexts.
fixture_repo() {
  mkdir -p "$1/ops/aman-stt"
  printf 'FROM scratch\n' >"$1/Dockerfile.dev"
  printf 'FROM scratch\n' >"$1/ops/aman-stt/Dockerfile"
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
    AMAN_OS_RELEASE="${AMAN_OS_RELEASE:-$SB/os-release}"
    STUB_LOG="$STUB_LOG" STUB_STATE="$STUB_STATE" STUB_BIN="$STUB_BIN" STUB_USER="$STUB_USER"
    STUB_DOCKER_SRC="$STUB_DOCKER_SRC" STUB_REAL_DF="$STUB_REAL_DF"
    STUB_DOCKER_DENIED="${STUB_DOCKER_DENIED:-}" STUB_DOCKER_DOWN="${STUB_DOCKER_DOWN:-}"
    STUB_ROOTLESS="${STUB_ROOTLESS:-}" STUB_PODMAN="${STUB_PODMAN:-}" STUB_BUILD_FAIL="${STUB_BUILD_FAIL:-}"
    STUB_UP_FAIL_UNLESS_TAG="${STUB_UP_FAIL_UNLESS_TAG:-}" STUB_DF_KB="${STUB_DF_KB:-}"
    STUB_BUSY_PORTS="${STUB_BUSY_PORTS:-}" STUB_BACKUP_FAIL="${STUB_BACKUP_FAIL:-}" STUB_VOLUME_RM_FAIL="${STUB_VOLUME_RM_FAIL:-}"
    STUB_ENGINE_VERSION="${STUB_ENGINE_VERSION:-}" STUB_COMPOSE_VERSION="${STUB_COMPOSE_VERSION:-}"
    STUB_DOCTOR_EXIT="${STUB_DOCTOR_EXIT:-}" STUB_DOCKER_ROOT="${STUB_DOCKER_ROOT:-}" STUB_DOCKER_ROOT_KB="${STUB_DOCKER_ROOT_KB:-}"
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
  RC=$(printf '%s\n' "$OUT" | sed -n 's/^\[exit \([0-9]*\)\]$/\1/p' | tail -n 1)
  ERR=
}

# Feeds stdin to the next run_install from a string.
with_input() {
  INPUT_FILE=$SB/input
  printf '%s' "$1" >"$INPUT_FILE"
}

clear_input() { INPUT_FILE=; }

os_release_ubuntu() {
  printf 'ID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n' >"$SB/os-release"
}

# Install with defaults for tests that need an installed machine. Docker stub reachable, one instance "main".
# INSTALL_EXTRA holds extra install.sh arguments for the call, for example (--add-docker-group).
INSTALL_EXTRA=()
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
