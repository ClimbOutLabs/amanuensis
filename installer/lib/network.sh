# shellcheck shell=bash
# Where an instance can be opened from. By default Aman answers at every address this computer has on a private
# network (and its names), and sign-in works from each one. Plain http is only for private addresses and names;
# a public address needs https. Needs lib/shared.sh.

# IPv4 dotted quad, each part 0 to 255 with no leading zeros (010.1.1.1 is not an address Docker or a browser accepts).
valid_ipv4() {
  local ip=$1 part
  [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  for part in ${ip//./ }; do
    [[ $part =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
    [ "$part" -le 255 ] || return 1
  done
}

# Tailscale is here when its command is or its interface exists. Only then is 100.64.0.0/10 a private range.
tailscale_present() {
  command -v tailscale >/dev/null 2>&1 || [ -e "${AMAN_SYS_NET:-/sys/class/net}/tailscale0" ]
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

# Loopback, RFC 1918, link-local, and 100.64.0.0/10 when Tailscale is on this computer (otherwise that range is
# carrier-grade NAT from an internet provider, which is not a private network).
private_ipv4() {
  local a b
  valid_ipv4 "$1" || return 1
  IFS=. read -r a b _ <<<"$1"
  [ "$a" = 10 ] && return 0
  [ "$a" = 127 ] && return 0
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 0
  [ "$a" = 169 ] && [ "$b" = 254 ] && return 0
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && tailscale_present && return 0
  return 1
}

# A private address, or a name that only resolves on a private network: .local, .ts.net, or a single label.
private_host() {
  local host
  host=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  if [[ $host =~ ^[0-9.]+$ ]]; then
    private_ipv4 "$host"
    return
  fi
  case "$host" in
    *.local | *.ts.net) return 0 ;;
    *.*) return 1 ;;
    *) [[ $host =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] ;;
  esac
}

# Every IPv4 address this computer has on a network, one per line, each once. Loopback and container bridges mean
# nothing to another device, so they are left out; Tailscale's address is added when its command is there.
network_ipv4_addresses() {
  local out='' line seen=' '
  case "$(uname -s)" in
    Darwin)
      out=$(ifconfig 2>/dev/null | awk '/^[a-z]/ { iface = $1 } /^[ \t]+inet / && iface !~ /^(lo|bridge|vmnet|docker)/ { print $2 }' || true)
      ;;
    *)
      if command -v ip >/dev/null 2>&1; then
        out=$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|cni|flannel|cali)/ { sub(/\/.*/, "", $4); print $4 }' || true)
      fi
      if [ -z "$out" ] && command -v hostname >/dev/null 2>&1; then
        out=$(hostname -I 2>/dev/null | tr ' ' '\n' || true)
      fi
      ;;
  esac
  if command -v tailscale >/dev/null 2>&1; then
    out="$out"$'\n'$(run_bounded 3 tailscale ip -4 2>/dev/null | head -n 1 || true)
  fi
  while IFS= read -r line; do
    case "$line" in 127.* | 169.254.*) continue ;; esac
    case "$seen" in *" $line "*) continue ;; esac
    if valid_ipv4 "$line"; then
      seen="$seen$line "
      printf '%s\n' "$line"
    fi
  done <<<"$out"
}

# This computer's short name, lowercase, when it is a usable host name.
network_hostname() {
  local name=''
  if command -v hostname >/dev/null 2>&1; then
    name=$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)
  fi
  name=$(lowercase "$name")
  if [[ $name =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then printf '%s' "$name"; fi
}

# This computer's own MagicDNS name when Tailscale is running (for example spark.example.ts.net): the DNSName of
# "Self", never one of the other machines on the tailnet.
network_tailscale_name() {
  local name=''
  if command -v tailscale >/dev/null 2>&1; then
    name=$(run_bounded 3 tailscale status --json 2>/dev/null | awk '/"Self"/ { in_self = 1 } in_self && /"DNSName"/ { print; exit }' |
      sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' || true)
  fi
  name=$(lowercase "${name%.}")
  if [[ $name =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && private_host "$name"; then printf '%s' "$name"; fi
}

# The hosts an instance answers at by default, one per line: this computer's own names, its private addresses and its
# names on the network.
network_default_hosts() {
  local ip name
  printf '%s\n' 127.0.0.1 localhost
  for ip in $(network_ipv4_addresses); do
    if private_ipv4 "$ip"; then printf '%s\n' "$ip"; fi
  done
  name=$(network_hostname)
  if [ -n "$name" ]; then printf '%s\n%s.local\n' "$name" "$name"; fi
  name=$(network_tailscale_name)
  if [ -n "$name" ]; then printf '%s\n' "$name"; fi
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
  local host
  host=$(lowercase "$1")
  if [ -z "$host" ]; then
    echo "An address is needed. Example: --address 192.168.1.20 or --address spark.local"
  elif ! valid_ipv4 "$host" && ! { [[ $host =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && [[ $host != *..* ]] && [[ ! $host =~ ^[0-9.]+$ ]]; }; then
    echo "$1 is not an address or a name. Examples: 192.168.1.20, spark.local"
  elif ! private_host "$host"; then
    echo "$1 is a public address, and signing in over plain http across the internet is not safe. For access from the internet set up HTTPS with --tls caddy (with --public-url and --login-url)."
  fi
}

# The comma-separated origins for PORT: the default hosts plus any extra hosts given, each once, lowercase.
network_origin_list() {
  local port=$1 host list='' origin
  shift
  for host in $(network_default_hosts) "$@"; do
    origin="http://$(lowercase "$host"):$port"
    case ",$list," in *",$origin,"*) continue ;; esac
    list=${list:+$list,}$origin
  done
  printf '%s' "$list"
}

# The addresses to publish the app port on: 127.0.0.1 and each address of this computer that an origin list names,
# one per line. Never a wildcard, never a public address (the list only holds private ones), and never an address that
# belongs to another machine (an --address that only names where this one can be reached).
network_bind_addresses() { # origin list
  local origin host mine seen=' 127.0.0.1 '
  mine=" $(network_ipv4_addresses | tr '\n' ' ')"
  printf '%s\n' 127.0.0.1
  while IFS= read -r origin; do
    host=${origin#http://}
    host=${host%%:*}
    case "$seen" in *" $host "*) continue ;; esac
    case "$mine" in *" $host "*) ;; *) continue ;; esac
    if valid_ipv4 "$host" && private_ipv4 "$host"; then
      seen="$seen$host "
      printf '%s\n' "$host"
    fi
  done < <(printf '%s\n' "$1" | tr ',' '\n')
}
