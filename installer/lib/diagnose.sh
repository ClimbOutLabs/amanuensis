# shellcheck shell=bash
# What a failed container log says, in one plain sentence, so a person is never sent to read container logs.
# A log it does not recognise prints nothing and the caller calls it a bug.

# A permission error while the app starts is never something the person can fix on their computer: the image
# decides where the app may write.
PERMISSION_ERROR_PATTERN='EACCES|EPERM|permission denied|read-only file system|EROFS'

# The first address and port Docker could not bind, as "address port", or nothing. Reads text on stdin.
container_failed_bind_stdin() {
  sed -n \
    -e 's/.*Bind for \([^ ]*\):\([0-9][0-9]*\) failed: port is already allocated.*/\1 \2/p' \
    -e 's/.*failed to bind host port \([^ ]*\):\([0-9][0-9]*\)\/tcp.*/\1 \2/p' \
    -e 's/.*listen tcp[46]\{0,1\} \([^ ]*\):\([0-9][0-9]*\): bind: address already in use.*/\1 \2/p' | head -n 1
}

# True when the failure is Docker's own port forwarding failing on a port the instance never asked for (Docker Desktop
# opens a random one itself), so no program on this computer holds anything.
container_failure_is_forwarding() { # log; AMAN_DIAG_PORTS lists the ports the instance publishes
  local bind
  [ -n "${AMAN_DIAG_PORTS:-}" ] || return 1
  grep -Eqi 'driver failed programming external connectivity' "$1" || return 1
  bind=$(container_failed_bind_stdin <"$1")
  [ -n "$bind" ] || return 1
  case " ${AMAN_DIAG_PORTS:-} " in *" ${bind#* } "*) return 1 ;; esac
  return 0
}

# Reads log text on stdin.
container_failure_cause_stdin() {
  local text path bind holder
  text=$(cat)
  path=$(printf '%s\n' "$text" | sed -n "s/.*E\\(ACCES\\|PERM\\): permission denied, mkdir '\\([^']*\\)'.*/\\2/p" | head -n 1)
  if [ -n "$path" ]; then
    echo "The app could not start: it was not allowed to create a folder ($path). This is a bug in Aman, not a problem on your computer."
  elif printf '%s\n' "$text" | grep -Eqi "$PERMISSION_ERROR_PATTERN"; then
    echo "The app could not start: a permission error stopped it. This is a bug in Aman, not a problem on your computer."
  elif [ -n "${AMAN_DIAG_PORTS:-}" ] && printf '%s\n' "$text" | grep -Eqi 'driver failed programming external connectivity' &&
    bind=$(printf '%s\n' "$text" | container_failed_bind_stdin) && [ -n "$bind" ] &&
    case " ${AMAN_DIAG_PORTS:-} " in *" ${bind#* } "*) false ;; *) true ;; esac; then
    echo "Docker could not open Aman on this computer's network addresses, and nothing else on this computer is using the port."
  elif printf '%s\n' "$text" | grep -Eqi 'port is already allocated|address already in use|EADDRINUSE'; then
    bind=$(printf '%s\n' "$text" | container_failed_bind_stdin)
    if [ -n "$bind" ]; then
      holder=
      if command -v port_holder >/dev/null 2>&1; then holder=$(port_holder "${bind#* }"); fi
      echo "Port ${bind#* } on ${bind% *} is already in use on this computer${holder:+ (held by $holder)}."
    else
      echo "A port the app needs is already in use on this computer."
    fi
  elif printf '%s\n' "$text" | grep -Eqi 'no space left on device|ENOSPC'; then
    echo "This computer ran out of disk space."
  elif printf '%s\n' "$text" | grep -Eqi 'oom true|OOMKilled|exit code: 137'; then
    echo "The app was stopped because Docker ran out of memory."
  fi
}

container_failure_cause() { container_failure_cause_stdin <"$1"; }

# The one thing to do about a cause that names a port (a space-separated "port=flag" list says which flag chooses it),
# or nothing for any other cause.
container_failure_port_fix() { # log "port=flag ..."
  local bind port pair flag='' free
  bind=$(container_failed_bind_stdin <"$1")
  [ -n "$bind" ] || return 0
  port=${bind#* }
  if container_failure_is_forwarding "$1"; then
    echo "Run install.sh again with --local-only, which opens Aman on this computer only."
    return 0
  fi
  grep -Eqi 'port is already allocated|address already in use|EADDRINUSE' "$1" || return 0
  for pair in $2; do
    if [ "${pair%%=*}" = "$port" ]; then flag=${pair#*=}; fi
  done
  if [ -n "$flag" ] && command -v pick_port >/dev/null 2>&1; then
    free=$(pick_port $((port + 1)) "") || free=
    echo "Stop that program, or run install.sh again with $flag${free:+ $free}."
  else
    echo "Stop that program, then run install.sh again."
  fi
}

# bug when the log shows a failure only an update of Aman can fix, fixable when the person can act on it.
container_failure_kind() {
  if grep -Eqi "$PERMISSION_ERROR_PATTERN" "$1"; then echo bug; else echo fixable; fi
}
