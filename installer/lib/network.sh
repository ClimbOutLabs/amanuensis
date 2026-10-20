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

# Loopback, RFC 1918, link-local, and 100.64.0.0/10 only where it is Tailscale's own address on this computer
# (otherwise that range is carrier-grade NAT from an internet provider, which is not a private network).
private_ipv4() {
  local a b
  valid_ipv4 "$1" || return 1
  IFS=. read -r a b _ <<<"$1"
  [ "$a" = 10 ] && return 0
  [ "$a" = 127 ] && return 0
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 0
  [ "$a" = 169 ] && [ "$b" = 254 ] && return 0
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && network_tailscale_address "$1" && return 0
  return 1
}

# A label made only of numbers or hex (0x7f, 1e3) is read as part of an address by some systems, so it is not a name.
has_numeric_label() {
  local LC_ALL=C label
  for label in ${1//./ }; do
    if [[ $label =~ ^(0x[0-9a-f]*|[0-9]+(e[0-9]+)?)$ ]]; then return 0; fi
  done
  return 1
}

# A private address, or a name that only resolves on a private network: .local, .ts.net, or a single label.
private_host() {
  local LC_ALL=C host
  host=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  if [[ $host =~ ^[0-9.]+$ ]]; then
    private_ipv4 "$host"
    return
  fi
  if has_numeric_label "$host"; then return 1; fi
  case "$host" in
    *.local | *.ts.net) return 0 ;;
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

# This computer's address on Tailscale as its own command reports it (empty when it is not running).
network_tailscale_ip() {
  command -v tailscale >/dev/null 2>&1 || return 0
  run_bounded 3 tailscale ip -4 2>/dev/null | head -n 1 || true
}

# True for Tailscale's own address here: on its tailscale0 interface, or on a macOS utun that its command names.
network_tailscale_address() { # address
  local iface addr
  while read -r iface addr; do
    [ "$addr" = "$1" ] || continue
    case "$iface" in
      tailscale0) return 0 ;;
      utun*) [ "$1" = "$(network_tailscale_ip)" ] && return 0 ;;
    esac
  done < <(network_interface_addresses)
  return 1
}

# Interfaces whose addresses other devices cannot use: loopback, container, virtual-machine and other VPN links.
# Tailscale's own link is the one exception among them.
network_interface_skipped() { # interface address
  case "$1" in
    tailscale0) return 1 ;;
    utun*) [ "$2" != "$(network_tailscale_ip)" ] ;;
    lo* | docker* | br-* | veth* | virbr* | cni* | flannel* | cali* | tun* | tap* | wg* | lxdbr* | lxcbr* | vboxnet* | podman* | vmnet* | bridge* | zt* | tailscale*) return 0 ;;
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
  local LC_ALL=C name=''
  if command -v hostname >/dev/null 2>&1; then
    name=$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)
  fi
  name=$(lowercase "$name")
  if [[ $name =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then printf '%s' "$name"; fi
}

# This computer's own MagicDNS name when Tailscale is running (for example spark.example.ts.net): the DNSName of
# "Self", never one of the other machines on the tailnet.
network_tailscale_name() {
  local LC_ALL=C name=''
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
  local LC_ALL=C host
  host=$(lowercase "$1")
  if [ -z "$host" ]; then
    echo "An address is needed. Example: --address 192.168.1.20 or --address spark.local"
  elif ! valid_ipv4 "$host" && ! { [[ $host =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && [[ $host != *..* ]] && [[ ! $host =~ ^[0-9.]+$ ]] && ! has_numeric_label "$host"; }; then
    echo "$1 is not an address or a name. Examples: 192.168.1.20, spark.local"
  elif ! private_host "$host"; then
    echo "$1 is a public address, and signing in over plain http from the internet is not safe. For the internet, use --tls caddy with --public-url and --login-url."
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
    if ! is_loopback_host_name "$(origin_host "$origin")"; then return 0; fi
  done < <(printf '%s\n' "$1" | tr ',' '\n')
  return 1
}

# The addresses to publish the app on: 127.0.0.1 and each address of this computer that an origin list names, one per
# line. Never a wildcard, never a public address (the list only holds private ones), and never an address that belongs
# to another machine (an --address that only names where this one can be reached).
network_bind_addresses() { # origin list
  local origin host mine seen=' 127.0.0.1 '
  mine=" $(network_ipv4_addresses | tr '\n' ' ')"
  printf '%s\n' 127.0.0.1
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

# On native Linux, Engine 27 and older let other devices on the network reach ports published to 127.0.0.1 only.
DOCKER_MIN_LINUX_ENGINE_MAJOR=28

# True when Docker runs natively on Linux (not Docker Desktop, not WSL2) with an Engine that publishes loopback-only
# ports to the whole network. Docker Desktop and WSL2 are unaffected. Arguments: engine version, operating system name.
docker_engine_leaks_loopback() {
  local engine=$1 os=$2 major=${1%%.*}
  [ "$(uname -s)" = Linux ] || return 1
  case "$(uname -r)" in *[Mm]icrosoft* | *WSL* | *wsl*) return 1 ;; esac
  case "$os" in *[Dd]ocker\ [Dd]esktop*) return 1 ;; esac
  case "$major" in '' | *[!0-9]*) return 1 ;; esac
  [ "$major" -lt "$DOCKER_MIN_LINUX_ENGINE_MAJOR" ]
}

docker_leaks_loopback_text() {
  echo "Docker Engine $1 lets other devices on your network reach ports meant for this computer only. Install Docker Engine $DOCKER_MIN_LINUX_ENGINE_MAJOR or newer (install.sh --print-root-steps shows the steps), then run this again."
}

# True when this computer's hardware names a well-known cloud provider. A cloud network's private addresses are shared
# with other customers, so they are not a home network. Providers not listed here are not caught.
network_cloud_vm() {
  local dir=${AMAN_DMI_DIR:-/sys/class/dmi/id} field text=''
  for field in sys_vendor product_name board_vendor chassis_asset_tag; do
    [ -r "$dir/$field" ] && text="$text $(cat "$dir/$field" 2>/dev/null)"
  done
  case "$(lowercase "$text")" in
    *"amazon ec2"* | *"google compute engine"* | *digitalocean* | *hetzner* | *vultr* | *linode* | *akamai* | *openstack* | *oraclecloud* | *"alibaba cloud"* | *"tencent cloud"* | *7783-7084-3265-9085-8269-3286-77*) return 0 ;;
    *) return 1 ;;
  esac
}
