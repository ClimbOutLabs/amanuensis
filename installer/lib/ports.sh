# shellcheck shell=bash
# Free port selection. Only this machine is looked at, never the network; nothing is scanned.

# Container-side ports that share the instance network namespace and so can never be a host pick.
APP_CONTAINER_PORT=8790
DEX_TELEMETRY_PORT=5558

# True when something already holds the port on any address, since an instance may publish it on every interface. A bind attempt is the real test; the
# listener table and a loopback connect are fallbacks when python3 is absent.
port_in_use() {
  local port=$1
  if command -v python3 >/dev/null 2>&1; then
    if python3 -c 'import socket, sys
s = socket.socket()
s.bind(("0.0.0.0", int(sys.argv[1])))' "$port" 2>/dev/null; then
      return 1
    fi
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk 'NR > 1 {print $4}' | grep -Eq "[:.]${port}\$"
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    [ -n "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" ]
    return
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

port_reserved() {
  local port=$1 taken
  case "$port" in
    "$APP_CONTAINER_PORT" | "$DEX_TELEMETRY_PORT") return 0 ;;
  esac
  for taken in $2; do
    [ "$taken" = "$port" ] && return 0
  done
  return 1
}

# pick_port START "reserved ports": first free port at or above START that no instance owns.
pick_port() {
  local start=$1 reserved=$2 port limit
  port=$start
  limit=$((start + 300))
  while [ "$port" -lt "$limit" ] && [ "$port" -le 65535 ]; do
    if ! port_reserved "$port" "$reserved" && ! port_in_use "$port"; then
      printf '%s\n' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  return 1
}

# check_port_usable PORT "reserved ports" LABEL: explicit --port values are never silently moved.
check_port_usable() {
  valid_port "$1" || die "$3 must be a number between 1024 and 65535"
  if port_reserved "$1" "$2"; then
    die "$3 $1 is already used by another instance or by Aman itself"
  fi
  if port_in_use "$1"; then
    die "$3 $1 is already in use on this computer"
  fi
}
