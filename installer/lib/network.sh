# shellcheck shell=bash
# Where an instance can be opened from. By default Aman answers on this computer's own address on the local network
# as well as on 127.0.0.1, so a phone or another computer (on the home network or over Tailscale) can reach it.
# A plain http sign-in address is only allowed for private addresses; a public address needs https.

# The IPv4 address this computer uses to reach the network (the source of its default route); nothing when it has none.
network_primary_ip() {
  local ip='' iface
  case "$(uname -s)" in
    Darwin)
      iface=$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')
      if [ -n "$iface" ]; then ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true); fi
      ;;
    *)
      if command -v ip >/dev/null 2>&1; then
        ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
      fi
      if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
        ip=$(hostname -I 2>/dev/null | awk '{ print $1 }')
      fi
      ;;
  esac
  valid_ipv4 "$ip" || ip=''
  printf '%s' "$ip"
}

# Loopback, RFC 1918, link-local and the 100.64.0.0/10 range Tailscale uses.
private_ipv4() {
  local a b
  valid_ipv4 "$1" || return 1
  IFS=. read -r a b _ <<<"$1"
  a=$((10#$a))
  b=$((10#$b))
  [ "$a" = 10 ] && return 0
  [ "$a" = 127 ] && return 0
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 0
  [ "$a" = 169 ] && [ "$b" = 254 ] && return 0
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 0
  return 1
}

# A private address, or a name that only resolves on a private network: .local, .ts.net, or a single label.
private_host() {
  local host
  host=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  if matches_whole "$host" '^[0-9.]+$'; then
    private_ipv4 "$host"
    return
  fi
  case "$host" in
    *.local | *.ts.net) return 0 ;;
    *.*) return 1 ;;
    *) matches_whole "$host" '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' ;;
  esac
}

# The host of an http(s) origin: no scheme, port or path.
origin_host() {
  local rest=${1#*://}
  rest=${rest%%/*}
  printf '%s' "${rest%%:*}"
}
