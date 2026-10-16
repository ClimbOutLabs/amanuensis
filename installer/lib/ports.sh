# shellcheck shell=bash
# Free port selection. Only this machine is looked at, never the network; nothing is scanned.

# Container-side ports that share the instance network namespace and so can never be a host pick.
APP_CONTAINER_PORT=8790
DEX_TELEMETRY_PORT=5558

# The addresses a port is tried on: the wildcard, 127.0.0.1 and each home-network address of this computer. On macOS
# a bind to the wildcard can succeed while another program holds the port on one specific address, so each is tried.
port_bind_addresses() {
  printf '%s\n' 0.0.0.0 127.0.0.1
  if command -v network_ipv4_addresses >/dev/null 2>&1; then
    network_ipv4_addresses 2>/dev/null | while IFS= read -r address; do
      if private_ipv4 "$address"; then printf '%s\n' "$address"; fi
    done
  fi
}

# True when something already holds the port on any of those addresses, since an instance may publish it on each. A bind
# attempt is the real test; the listener table and a loopback connect are fallbacks when python3 is absent.
port_in_use() {
  local port=$1
  if command -v python3 >/dev/null 2>&1; then
    # shellcheck disable=SC2046 # addresses are single words
    if python3 -c 'import errno, socket, sys
for address in sys.argv[2:]:
    s = socket.socket()
    try:
        s.bind((address, int(sys.argv[1])))
    except OSError as error:
        # An address this computer does not have says nothing about the port.
        if error.errno == errno.EADDRINUSE:
            sys.exit(1)
    finally:
        s.close()' "$port" $(port_bind_addresses) 2>/dev/null; then
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

# What holds a port, as "name (process N)", or nothing when it cannot be found (another user's program needs sudo).
port_holder() {
  local port=$1 out pid name
  command -v lsof >/dev/null 2>&1 || return 0
  out=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fpc 2>/dev/null || true)
  pid=$(printf '%s\n' "$out" | sed -n 's/^p//p' | head -n 1)
  name=$(printf '%s\n' "$out" | sed -n 's/^c//p' | head -n 1)
  if [ -n "$pid" ]; then printf '%s (process %s)' "${name:-a program}" "$pid"; fi
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
  local holder
  valid_port "$1" || die "$3 must be a number between 1024 and 65535"
  if port_reserved "$1" "$2"; then
    die "$3 $1 is already used by another instance or by the stack itself"
  fi
  if port_in_use "$1"; then
    holder=$(port_holder "$1")
    die "$3 $1 is already in use on this computer${holder:+ (held by $holder)}. Stop that program, or choose another port with $3, for example $3 $(pick_port $(($1 + 1)) "$2" || echo 8800)."
  fi
}
