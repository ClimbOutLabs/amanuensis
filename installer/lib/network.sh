# shellcheck shell=bash
# Where an instance can be opened from. By default Aman answers at every address this computer has on a private
# network (and its names), and sign-in works from each one. Plain http is only for private addresses and names;
# a public address needs https. Needs lib/shared.sh.

# IPv4 dotted quad, each part 0 to 255 with no leading zeros (010.1.1.1 is not an address Docker or a browser accepts).
valid_ipv4() {
  local ip=$1 part LC_ALL=C
  [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  for part in ${ip//./ }; do
    [[ $part =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
    [ "$part" -le 255 ] || return 1
  done
}

# Runs a command for at most N seconds, so a wedged helper cannot stall the install or the doctor.
run_bounded() { # seconds command...
  local secs=$1 pid watcher rc=0
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return
  fi
  "$@" &
  pid=$!
  (
    sleep "$secs"
    kill "$pid" 2>/dev/null
  ) &
  watcher=$!
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$rc"
}

# Loopback, RFC 1918 and link-local. 100.64.0.0/10 is not a home network: internet providers and VPNs use it.
private_ipv4() {
  local a b
  valid_ipv4 "$1" || return 1
  IFS=. read -r a b _ <<<"$1"
  [ "$a" = 10 ] && return 0
  [ "$a" = 127 ] && return 0
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 0
  [ "$a" = 169 ] && [ "$b" = 254 ] && return 0
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  return 1
}

# 100.64.0.0/10, shared by internet providers and VPNs; never a home-network address.
shared_address_space() {
  local a b
  valid_ipv4 "$1" || return 1
  IFS=. read -r a b _ <<<"$1"
  [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ]
}

# A label made only of numbers or hex (0x7f, 1e3) is read as part of an address by some systems, so it is not a name.
has_numeric_label() {
  local label LC_ALL=C
  for label in ${1//./ }; do
    if [[ $label =~ ^(0x[0-9a-f]*|[0-9]+(e[0-9]+)?)$ ]]; then return 0; fi
  done
  return 1
}

# A private address, or a name that only resolves on a private network: .local or a single label.
private_host() {
  local host LC_ALL=C
  host=$(lowercase "$1")
  if [[ $host =~ ^[0-9.]+$ ]]; then
    private_ipv4 "$host"
    return
  fi
  if has_numeric_label "$host"; then return 1; fi
  case "$host" in
    *.local) return 0 ;;
    *.*) return 1 ;;
    *) [[ $host =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] ;;
  esac
}

# Every IPv4 address of this computer with the interface that carries it, as "interface address" lines.
network_interface_addresses() {
  local out=''
  case "$(uname -s)" in
    Darwin)
      ifconfig 2>/dev/null | LC_ALL=C awk '/^[a-z]/ { iface = $1; sub(/:$/, "", iface) } /^[ \t]+inet / { print iface, $2 }' || true
      return 0
      ;;
  esac
  if command -v ip >/dev/null 2>&1; then
    out=$(ip -4 -o addr show scope global 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $2, $4 }' || true)
  fi
  if [ -z "$out" ] && command -v hostname >/dev/null 2>&1; then
    out=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk 'NF { print "unknown", $1 }' || true)
  fi
  printf '%s\n' "$out"
}

# Interfaces whose addresses other devices cannot use: loopback, container, virtual-machine and VPN links.
network_interface_skipped() { # interface address
  # 100.64.0.0/10 belongs to providers and VPNs, so an address in it is left out on any link.
  if shared_address_space "$2"; then return 0; fi
  case "$1" in
    lo* | utun* | docker* | br-* | veth* | virbr* | cni* | flannel* | cali* | tun* | tap* | wg* | lxdbr* | lxcbr* | vboxnet* | podman* | vmnet* | bridge* | zt*) return 0 ;;
    *) return 1 ;;
  esac
}

# The addresses left out, as "interface address" lines, so a person can see why one is missing.
network_skipped_addresses() {
  local iface addr
  while read -r iface addr; do
    [ -n "$addr" ] || continue
    if valid_ipv4 "$addr" && network_interface_skipped "$iface" "$addr"; then printf '%s %s\n' "$iface" "$addr"; fi
  done < <(network_interface_addresses)
}

# Every IPv4 address this computer has on a network other devices can reach, one per line, each once.
network_ipv4_addresses() {
  local iface line seen=' '
  while read -r iface line; do
    [ -n "$line" ] || continue
    case "$line" in 127.* | 169.254.*) continue ;; esac
    network_interface_skipped "$iface" "$line" && continue
    case "$seen" in *" $line "*) continue ;; esac
    if valid_ipv4 "$line"; then
      seen="$seen$line "
      printf '%s\n' "$line"
    fi
  done < <(network_interface_addresses)
}

# This computer's short name, lowercase, when it is a usable host name.
network_hostname() {
  local name='' LC_ALL=C
  if command -v hostname >/dev/null 2>&1; then
    name=$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)
  fi
  name=$(lowercase "$name")
  if [[ $name =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then printf '%s' "$name"; fi
}

# The hosts an instance answers at by default, one per line: this computer's own names, its home-network (private)
# addresses and its names on that network. Where Docker cannot publish on a specific address only the first two
# (127.0.0.1 and localhost) are kept.
network_default_hosts() {
  local ip name
  printf '%s\n' 127.0.0.1 localhost
  if network_publishes_on_loopback_only; then return 0; fi
  for ip in $(network_ipv4_addresses); do
    if private_ipv4 "$ip"; then printf '%s\n' "$ip"; fi
  done
  name=$(network_hostname)
  if [ -n "$name" ]; then printf '%s\n%s.local\n' "$name" "$name"; fi
}

# True where Docker runs in a virtual machine (every Mac, Docker Desktop, and WSL2 on Windows). There its port
# forwarding fails when one container publishes on several specific host addresses, and the addresses seen from inside
# WSL2 are the virtual machine's own, not the PC's home-network ones; a wildcard would open Aman on public Wi-Fi. So
# Aman is published on 127.0.0.1 alone, which Windows forwards to its own localhost. Looked up once.
NETWORK_LOOPBACK_ONLY=
network_publishes_on_loopback_only() {
  local os
  if [ -z "$NETWORK_LOOPBACK_ONLY" ]; then
    NETWORK_LOOPBACK_ONLY=0
    if [ "$(uname -s)" = Darwin ]; then
      NETWORK_LOOPBACK_ONLY=1
    elif case "$(uname -r)" in *[Mm]icrosoft* | *WSL* | *wsl*) true ;; *) false ;; esac; then
      NETWORK_LOOPBACK_ONLY=1
    elif command -v docker >/dev/null 2>&1; then
      os=$(run_bounded 8 docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)
      case "$os" in *[Dd]ocker\ [Dd]esktop*) NETWORK_LOOPBACK_ONLY=1 ;; esac
    fi
  fi
  [ "$NETWORK_LOOPBACK_ONLY" = 1 ]
}

# Addresses of this computer that are public: plain http is never used at them and the app is never published there.
network_public_addresses() {
  local ip
  for ip in $(network_ipv4_addresses); do
    if ! private_ipv4 "$ip"; then printf '%s\n' "$ip"; fi
  done
}

# Why a host given with --address cannot be used, as one sentence, or nothing when it is fine.
address_problem() {
  local host LC_ALL=C
  host=$(lowercase "$1")
  if [ -z "$host" ]; then
    echo "An address is needed. Example: --address 192.168.1.20 or --address spark.local"
  elif ! valid_ipv4 "$host" && ! { [[ $host =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && [[ $host != *..* ]] && [[ ! $host =~ ^[0-9.]+$ ]] && ! has_numeric_label "$host"; }; then
    echo "$1 is not an address or a name. Examples: 192.168.1.20, spark.local"
  elif shared_address_space "$host"; then
    echo "$1 is not an address on your home network. Use an address of this computer on your home network, such as 192.168.1.20, or a name ending in .local."
  elif ! private_host "$host"; then
    echo "$1 is a public address, and signing in over plain http across the internet is not safe. For access from the internet set up HTTPS with --tls caddy (with --public-url and --login-url)."
  fi
}

# The host of an origin: http://spark.local:8791 gives spark.local.
origin_host() {
  local host=${1#*://}
  printf '%s' "${host%%[:/]*}"
}

# This computer's own names for itself: they open over plain http on the app port even when other devices use https.
is_loopback_host_name() { case "$1" in 127.0.0.1 | localhost) return 0 ;; *) return 1 ;; esac; }

# The comma-separated origins: the default hosts plus any extra hosts given, each once, lowercase. With a TLS port every
# host but this computer's own names is an https origin on that port; otherwise all are plain http on the app port.
network_origin_list() { # app_port tls_port(empty for plain http) extra_host...
  local port=$1 tls_port=$2 host list='' origin
  shift 2
  for host in $(network_default_hosts) "$@"; do
    host=$(lowercase "$host")
    if ! is_loopback_host_name "$host" && network_publishes_on_loopback_only; then continue; fi
    if [ -n "$tls_port" ] && ! is_loopback_host_name "$host"; then origin="https://$host:$tls_port"; else origin="http://$host:$port"; fi
    case ",$list," in *",$origin,"*) continue ;; esac
    list=${list:+$list,}$origin
  done
  printf '%s' "$list"
}

# True when an origin list has an address or name other devices can open (so a web front end has something to serve).
origins_reach_the_network() {
  local origin
  while IFS= read -r origin; do
    [ -n "$origin" ] || continue
    if ! is_loopback_host_name "$(origin_host "$origin")"; then return 0; fi
  done < <(printf '%s\n' "$1" | tr ',' '\n')
  return 1
}

# The addresses to publish the app on: 127.0.0.1 and each address of this computer that an origin list names, one per
# line. Never a wildcard, never a public address (the list only holds private ones), and never an address that belongs
# to another machine (an --address that only names where this one can be reached).
network_bind_addresses() { # origin list
  local origin host mine seen=' 127.0.0.1 '
  printf '%s\n' 127.0.0.1
  if network_publishes_on_loopback_only; then return 0; fi
  mine=" $(network_ipv4_addresses | tr '\n' ' ')"
  while IFS= read -r origin; do
    host=$(origin_host "$origin")
    case "$seen" in *" $host "*) continue ;; esac
    case "$mine" in *" $host "*) ;; *) continue ;; esac
    if valid_ipv4 "$host" && private_ipv4 "$host"; then
      seen="$seen$host "
      printf '%s\n' "$host"
    fi
  done < <(printf '%s\n' "$1" | tr ',' '\n')
}
