# shellcheck shell=bash
# HTTPS front end for an instance (--tls caddy): the Caddy package from the Ubuntu archive on this computer serves
# exactly the instance's two https origins and proxies them to its loopback ports. The root steps are printed
# and only run with consent; Let's Encrypt is contacted by Caddy only after the DNS check passes.

CADDY_ETC=${AMAN_CADDY_ETC:-/etc/caddy}
EDGE_IP_URL=https://api.ipify.org
EDGE_WAIT_TRIES=${AMAN_EDGE_WAIT_TRIES:-24}
EDGE_DECLINED=0
EDGE_IN_PLAN=0
EDGE_DNS_PROBLEM=
EDGE_PUBLIC_IP=

edge_wanted() { [ "$(reg_get "$1" tls)" = caddy ]; }
edge_host() {
  local rest=${1#https://}
  printf '%s' "${rest%%/*}"
}
edge_file() { printf '%s/Caddyfile' "$(instance_dir "$1")"; }
edge_installed_file() { printf '%s/aman.d/%s.caddyfile' "$CADDY_ETC" "$1"; }
# The main Caddyfile is the installer's minimal one, not the package's default site.
edge_main_managed() { grep -q 'Managed by the Amanuensis installer' "$CADDY_ETC/Caddyfile" 2>/dev/null; }

valid_ipv4() {
  local ip=$1 part
  matches_whole "$ip" '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
  for part in ${ip//./ }; do
    [ "$((10#$part))" -le 255 ] || return 1
  done
}

# A DNS name Let's Encrypt can issue for: dotted labels, no port, not an address.
valid_edge_host() {
  matches_whole "$1" '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' && ! matches_whole "$1" '^[0-9.]+$'
}

# Writes the Caddyfile of an instance from the registry. It holds no secrets.
edge_render() {
  local name=$1
  render_template "$TEMPLATES_DIR/edge/Caddyfile.tpl" \
    "NAME=$name" "APP_HOST=$(edge_host "$(reg_get "$name" public_url)")" "LOGIN_HOST=$(edge_host "$(reg_get "$name" login_url)")" \
    "APP_PORT=$(reg_get "$name" app_port)" "LOGIN_PORT=$(reg_get "$name" login_port)" | write_if_changed "$(edge_file "$name")" 644 || true
}

# Caddy runs as its own user and cannot read the private install directory, so the file is copied, not linked.
# The Ubuntu package's own main Caddyfile (a :80 welcome site) is replaced by one that only imports aman.d, after
# being kept once as Caddyfile.aman-orig. The new site file is checked as part of the combined configuration under
# a temporary name first; a rejected file never replaces the previous good one.
edge_root_script() {
  local name=$1 src dest main dir
  src=$(printf '%q' "$(edge_file "$name")")
  dest=$(printf '%q' "$(edge_installed_file "$name")")
  main=$(printf '%q' "$CADDY_ETC/Caddyfile")
  dir=$(printf '%q' "$CADDY_ETC/aman.d")
  cat <<STEPS
set -eu
export DEBIAN_FRONTEND=noninteractive
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y caddy
fi
install -d -m 0755 $dir
site_new=$dest.new
main_new=$main.aman-new
check=\$(mktemp)
trap 'rm -f "\$site_new" "\$main_new" "\$check"' EXIT
global_block() { printf '{\n\tadmin localhost:2019\n}\n'; }
install -m 0644 $src "\$site_new"
{
  printf '# Managed by the Amanuensis installer. The package original is kept as Caddyfile.aman-orig.\n'
  global_block
  printf 'import %s\n' '$CADDY_ETC/aman.d/*.caddyfile'
} >"\$main_new"
chmod 0644 "\$main_new"
{
  global_block
  for other in $dir/*.caddyfile; do
    if [ -e "\$other" ] && [ "\$other" != $dest ]; then printf 'import %s\n' "\$other"; fi
  done
  printf 'import %s\n' "\$site_new"
} >"\$check"
if ! out=\$(caddy validate --config "\$check" --adapter caddyfile 2>&1); then
  echo "\$out" >&2
  echo "Caddy rejected the generated configuration, so nothing was replaced; Caddy keeps running as before" >&2
  exit 1
fi
mv -f "\$site_new" $dest
if ! cmp -s "\$main_new" $main; then
  if [ -e $main ] && [ ! -e $main.aman-orig ] && ! grep -q 'Managed by the Amanuensis installer' $main; then
    cp -p $main $main.aman-orig
  fi
  mv -f "\$main_new" $main
fi
systemctl enable caddy
systemctl reload-or-restart caddy
STEPS
}

# Stops serving an instance whose site file was installed by edge_root_script.
edge_remove_script() {
  local dest
  dest=$(printf '%q' "$(edge_installed_file "$1")")
  cat <<STEPS
set -eu
rm -f $dest
systemctl reload-or-restart caddy
STEPS
}

edge_print_firewall_hint() {
  say "  Firewall: the installer changes none. Open only TCP 443 to the internet, plus SSH (22) from your own address;"
  say "            port 80 can stay closed. In a cloud this is the security group of the machine."
}

edge_print_root_steps() {
  say "Root steps for HTTPS with Caddy (Ubuntu package archive; the Caddyfile for instance $1 is written by the installer):"
  edge_root_script "$1" | sed 's/^/    /'
}

edge_public_ip() {
  local ip
  if [ -n "${OPT_PUBLIC_IP:-}" ]; then
    printf '%s' "$OPT_PUBLIC_IP"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || return 1
  ip=$(curl -fsS --max-time 10 --proto '=https' --tlsv1.2 "$EDGE_IP_URL" 2>/dev/null | tr -d '[:space:]') || return 1
  valid_ipv4 "$ip" || return 1
  printf '%s' "$ip"
}

edge_resolve() {
  getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true
}

# Both names must resolve to this computer's public address. Sets EDGE_DNS_PROBLEM (empty when fine).
edge_dns_check() {
  local host got
  EDGE_DNS_PROBLEM=
  EDGE_PUBLIC_IP=
  if ! EDGE_PUBLIC_IP=$(edge_public_ip); then
    EDGE_DNS_PROBLEM="Could not find this computer's public address (no answer from $EDGE_IP_URL). Pass it with --public-ip ADDRESS. Nothing was requested from Let's Encrypt."
    return 0
  fi
  for host in "$@"; do
    got=$(edge_resolve "$host")
    got=${got% }
    if [ -z "$got" ]; then
      EDGE_DNS_PROBLEM="$host does not resolve yet. Create an A record for it pointing at $EDGE_PUBLIC_IP, wait until it resolves, then run this again. Nothing was requested from Let's Encrypt."
      return 0
    fi
    if [ "$got" != "$EDGE_PUBLIC_IP" ]; then
      EDGE_DNS_PROBLEM="$host resolves to $got, but this computer's public address is $EDGE_PUBLIC_IP. Point its A record at $EDGE_PUBLIC_IP, wait until it resolves, then run this again (if the address the VM is reached on is another one, pass it with --public-ip ADDRESS). Nothing was requested from Let's Encrypt."
      return 0
    fi
  done
}

# True when Caddy is installed, running, and already serves the current Caddyfile of the instance.
edge_in_place() {
  local name=$1
  command -v caddy >/dev/null 2>&1 || return 1
  edge_main_managed || return 1
  [ -f "$(edge_installed_file "$name")" ] && cmp -s "$(edge_file "$name")" "$(edge_installed_file "$name")" || return 1
  if command -v systemctl >/dev/null 2>&1 && systemctl cat caddy.service >/dev/null 2>&1; then
    systemctl is-active --quiet caddy
  fi
}

# Plan lines for an instance that gets (or already has) the Caddy front end: name, app origin, login origin.
plan_edge_instance() {
  local name=$1 app=$2 login=$3 app_host login_host
  app_host=$(edge_host "$app")
  login_host=$(edge_host "$login")
  EDGE_IN_PLAN=1
  if reg_exists "$name" && edge_in_place "$name"; then
    plan_add have "HTTPS for instance $name: Caddy serves $app_host and $login_host"
    return 0
  fi
  edge_dns_check "$app_host" "$login_host"
  if [ -n "$EDGE_DNS_PROBLEM" ]; then
    plan_add blocked "$EDGE_DNS_PROBLEM"
  else
    plan_add have "DNS: $app_host and $login_host resolve to this computer's public address $EDGE_PUBLIC_IP"
  fi
  if command -v caddy >/dev/null 2>&1; then
    plan_add have "Caddy is installed"
  else
    plan_add root "Install Caddy from the Ubuntu package archive" "apt-get install caddy; see: install.sh --print-root-steps --tls caddy"
    dl_add caddy
  fi
  plan_add root "Apply the Caddyfile for $app_host and $login_host" "It goes under $CADDY_ETC/aman.d. Caddy is checked and reloaded, then asks Let's Encrypt for certificates for exactly those two names."
}

plan_edge() {
  local name
  if need_new_instance && [ "${I_TLS:-}" = caddy ]; then
    plan_edge_instance "$I_NAME" "$I_PUBLIC_URL" "$I_LOGIN_URL"
  fi
  for name in $(reg_names); do
    if edge_wanted "$name"; then
      plan_edge_instance "$name" "$(reg_get "$name" public_url)" "$(reg_get "$name" login_url)"
    fi
  done
}

# After a reload Caddy needs a moment to get its certificates; the doctor right after would otherwise fail.
edge_wait_ready() {
  local url=$1 i=0
  say "Waiting for the certificates (Caddy asks Let's Encrypt for exactly these two names)"
  while [ "$i" -lt "$EDGE_WAIT_TRIES" ]; do
    if curl -fsS --max-time 8 -o /dev/null "$url/healthz" 2>/dev/null; then
      say "HTTPS answers at $url"
      return 0
    fi
    i=$((i + 1))
    [ "$i" -lt "$EDGE_WAIT_TRIES" ] && sleep 5
  done
  warn "$url did not answer over https yet. Caddy keeps trying; read why with: sudo journalctl -u caddy --no-pager -n 50"
  return 0
}

# Execute phase for one instance, after it is up. Root steps need an explicit yes or --tls-root.
edge_ensure() {
  local name=$1
  edge_wanted "$name" || return 0
  edge_render "$name"
  if edge_in_place "$name"; then
    say "HTTPS for instance $name is already set up (Caddy)"
    return 0
  fi
  edge_dns_check "$(edge_host "$(reg_get "$name" public_url)")" "$(edge_host "$(reg_get "$name" login_url)")"
  [ -z "$EDGE_DNS_PROBLEM" ] || die "$EDGE_DNS_PROBLEM"
  say ""
  edge_print_root_steps "$name"
  if ! consent_root "Install Caddy and apply this configuration now?" "$OPT_TLS_ROOT"; then
    EDGE_DECLINED=1
    warn "HTTPS for instance $name is not set up: the root steps were not approved. The instance runs on this computer only. Run this installer again and answer yes, or pass --tls-root (--yes alone never uses sudo)."
    return 0
  fi
  run_root sh -c "$(edge_root_script "$name")" ||
    die "the Caddy steps failed, so HTTPS for instance $name is not set up (the instance itself runs). Fix what is reported above, then run this installer again."
  log_event "caddy configured for instance $name"
  edge_wait_ready "$(reg_get "$name" public_url)"
}

# instance remove: the site file is only removed with the same consent as the install steps. Declining leaves the
# instance removed and says how to finish; Caddy then keeps answering for the names with a bad gateway.
edge_remove() {
  local name=$1
  edge_wanted "$name" || return 0
  [ -f "$(edge_installed_file "$name")" ] || return 0
  say ""
  say "Root steps to stop serving instance $name with Caddy:"
  edge_remove_script "$name" | sed 's/^/    /'
  if ! consent_root "Remove the Caddy site for instance $name now?" "$OPT_TLS_ROOT"; then
    warn "Caddy still serves the addresses of instance $name. Run the root steps above, or run this command again with --tls-root (--yes alone never uses sudo)."
    return 0
  fi
  if run_root sh -c "$(edge_remove_script "$name")"; then
    log_event "caddy site removed for instance $name"
  else
    warn "the Caddy steps failed, so Caddy may still serve the addresses of instance $name. Run the root steps above by hand."
  fi
}

edge_finish() {
  if [ "$EDGE_DECLINED" = 1 ]; then
    exit 1
  fi
}
