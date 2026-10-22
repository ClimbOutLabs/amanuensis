#!/usr/bin/env bash
# Https on the network: the authority and the certificate made on this computer, the front end in the instance's
# project, the page and files that make a device trust it, and moving an instance between https and plain http.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
reg_value() { sed -n "s/^$2=//p" "$AMAN_HOME/state/instances/$1.conf" | head -n 1; }
lan() {
  fixture_network 192.168.1.20
  fixture_hostname host
}
compose() { cat "$AMAN_HOME/instances/main/compose.yaml"; }
HTTPS_ORIGINS="http://127.0.0.1:8791,http://localhost:8791,https://192.168.1.20:8443,https://host:8443,https://host.local:8443"

# What the authority script says about the root and the certificate of an instance, run with the host's Node.js.
pki_info() { "$STUB_REAL_NODE" "$INSTALLER_DIR/lib/pki.mjs" info "$AMAN_HOME/tls/ca" "$AMAN_HOME/tls/leaf/${1:-main}"; }

test_a_default_install_is_served_over_https() {
  t_begin "by default the app opens over https on each address of this computer, and the plain port only redirects"
  sandbox_new
  lan
  install_machine
  assert_rc 0
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$HTTPS_ORIGINS"
  assert_eq "$(env_value main TRUST_PAGE_URL)" "http://192.168.1.20:8791/trust" "the app is told the trust page address the installer prints"
  assert_eq "$(reg_value main tls)" local
  assert_eq "$(reg_value main tls_port)" 8443
  local file
  file=$(compose)
  assert_contains "$file" "- '127.0.0.1:8791:8790'" "this computer's own name stays plain http, straight to the app"
  assert_contains "$file" "- '127.0.0.1:8443:8443'"
  assert_contains "$file" "- '192.168.1.20:8791:8081'" "the plain port reaches only the front end"
  assert_contains "$file" "- '192.168.1.20:8443:8443'"
  assert_not_contains "$file" "192.168.1.20:8791:8790" "the app itself is not reachable from the network"
  assert_not_contains "$file" "'0.0.0.0:"
  assert_contains "$file" "image: caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9"
  assert_contains "$file" "network_mode: 'service:loopback'"
  assert_contains "$file" "user: '1000:1000'" "the front end runs as the person who installed, so the folders it reads stay theirs"
  local dex origin
  dex=$(cat "$AMAN_HOME/instances/main/dex.yaml")
  for origin in ${HTTPS_ORIGINS//,/ }; do
    assert_contains "$dex" "- $origin/api/v1/auth/callback"
  done
  assert_log_has "pull caddy:2.11.6-alpine@sha256:"
  sandbox_drop
}

test_the_front_end_configuration() {
  t_begin "the front end serves https with the one certificate, sends the plain port to the https port, and serves only the trust page itself"
  sandbox_new
  lan
  install_machine
  local caddyfile
  caddyfile=$(cat "$AMAN_HOME/instances/main/tls.Caddyfile")
  assert_contains "$caddyfile" "tls /certs/leaf.crt /certs/leaf.key"
  assert_contains "$caddyfile" "reverse_proxy 127.0.0.1:8790"
  assert_contains "$caddyfile" "redir https://{http.request.host}:8443{uri} 308"
  assert_contains "$caddyfile" "http://:8081 {"
  assert_contains "$caddyfile" "handle_path /trust/*"
  assert_contains "$caddyfile" "application/x-apple-aspen-config"
  assert_contains "$caddyfile" "application/x-x509-ca-cert"
  assert_contains "$caddyfile" "default_sni 127.0.0.1"
  assert_contains "$caddyfile" "admin off"
  assert_not_contains "$caddyfile" "@@"
  assert_not_contains "$caddyfile" "Permissions-Policy" "the app's own policy for the microphone is left as it is"
  sandbox_drop
}

test_the_authority_and_the_certificate() {
  t_begin "one authority per computer with a private key, and one certificate listing every address, kept private"
  sandbox_new
  lan
  install_machine
  assert_mode "$AMAN_HOME/tls/ca/root.key" 600
  assert_mode "$AMAN_HOME/tls/leaf/main/leaf.key" 600
  local info
  info=$(pki_info)
  assert_contains "$info" '"leaf_names":["127.0.0.1","192.168.1.20","host","host.local","localhost"]'
  assert_contains "$info" '"root_days_left":3'
  local days
  days=$(printf '%s' "$info" | sed -n 's/.*"leaf_days_left":\([[:digit:]]*\).*/\1/p')
  if [ "$days" -ge 396 ] && [ "$days" -le 397 ]; then t_pass; else t_fail "the certificate lasts $days days"; fi
  local key_before
  key_before=$(cat "$AMAN_HOME/tls/ca/root.key")
  run_install --yes
  assert_eq "$(cat "$AMAN_HOME/tls/ca/root.key")" "$key_before" "a re-run keeps the authority, so devices keep trusting it"
  sandbox_drop
}

test_a_second_instance_shares_the_authority() {
  t_begin "a second instance gets its own https port and certificate under the same authority"
  sandbox_new
  lan
  install_machine
  local key_before
  key_before=$(cat "$AMAN_HOME/tls/ca/root.key")
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add second --yes --password-stdin --email second@example.invalid
  clear_input
  assert_rc 0
  assert_eq "$(cat "$AMAN_HOME/tls/ca/root.key")" "$key_before"
  assert_eq "$(reg_value second tls_port)" 8444
  assert_contains "$(env_value second ALLOWED_ORIGINS)" "https://192.168.1.20:8444"
  assert_contains "$(pki_info second)" "192.168.1.20"
  sandbox_drop
}

test_the_trust_page_and_files() {
  t_begin "the page, the profile and the certificate a device downloads are written, with the steps in plain words"
  sandbox_new
  lan
  install_machine
  local dir page
  dir=$AMAN_HOME/tls/trust/main
  assert_eq "$(cmp -s "$AMAN_HOME/tls/ca/root.crt" "$dir/ca.crt" && echo same)" same "the download is the authority's certificate"
  assert_mode "$dir/ca.crt" 644
  local profile
  profile=$(cat "$dir/aman.mobileconfig")
  assert_contains "$profile" "com.apple.security.root"
  assert_contains "$profile" "$(sed '/-----/d' "$AMAN_HOME/tls/ca/root.crt" | tr -d '\n')"
  assert_not_contains "$profile" "@@"
  page=$(cat "$dir/index.html")
  assert_contains "$page" "Make this device trust your home server"
  assert_contains "$page" "You only do this once per device."
  assert_contains "$page" "Open this page in Safari, not inside another app."
  assert_contains "$page" "Open this page in Chrome, not inside another app."
  assert_contains "$page" "within 8 minutes"
  assert_contains "$page" "General, About, Certificate Trust Settings"
  assert_contains "$page" "Install a certificate, then CA certificate, then Install anyway"
  assert_contains "$page" "Always Trust"
  assert_contains "$page" "Trusted Root Certification Authorities"
  assert_contains "$page" "Firefox keeps its own list"
  assert_contains "$page" "If you still see a warning, trust isn't finished. Don't tap through it; finish the steps above."
  assert_contains "$page" 'href="https://192.168.1.20:8443"'
  assert_not_contains "$page" "@@"
  local profile_again
  profile_again=$(cat "$dir/aman.mobileconfig")
  run_install --yes
  assert_eq "$(cat "$dir/aman.mobileconfig")" "$profile_again" "the profile is the same each time, so a device sees one profile"
  sandbox_drop
}

test_the_plan_and_the_summary() {
  t_begin "the plan names the https service and the root certificate; the ending lists https addresses, the trust link and a code, and drops the encryption warning"
  sandbox_new
  lan
  run_install --dry-run --email owner@example.invalid
  assert_flat_contains "$OUT" "Download the https service"
  assert_flat_contains "$OUT" "Make this computer's root certificate"
  assert_flat_contains "$OUT" "It opens over https on port 8443 at: 127.0.0.1, localhost, 192.168.1.20, host, host.local"
  assert_flat_contains "$OUT" "Port 8791 only sends devices to https."
  assert_no_path "$AMAN_HOME"
  RUN_ENV_EXTRA=(CLICOLOR_FORCE=1 LANG=C.UTF-8 TERM=xterm)
  install_machine
  assert_flat_contains "$OUT" "Open https://192.168.1.20:8443"
  assert_flat_contains "$OUT" "follow its steps: http://192.168.1.20:8791/trust"
  assert_flat_contains "$OUT" "browser will first warn that the page is not private. Do not click past the warning."
  assert_flat_contains "$OUT" "install the profile, then turn it on in Settings, General, About, Certificate Trust Settings."
  assert_not_contains "$OUT" "not encrypted"
  assert_contains "$OUT" "▀" "a code a phone can scan"
  assert_log_lacks "sudo "
  RUN_ENV_EXTRA=()
  run_install --yes
  assert_flat_contains "$OUT" "done The https service is downloaded"
  assert_flat_contains "$OUT" "done This computer's root certificate exists"
  sandbox_drop
}

test_no_code_without_colors() {
  t_begin "without colors or UTF-8 the ending still gives the trust link and draws no code"
  sandbox_new
  lan
  RUN_ENV_EXTRA=(LANG=C)
  install_machine
  assert_flat_contains "$OUT" "follow its steps: http://192.168.1.20:8791/trust"
  assert_not_contains "$OUT" "▀"
  assert_no_path "$STUB_STATE/qr_runs"
  sandbox_drop
}

test_tls_off_keeps_plain_http() {
  t_begin "--tls off keeps plain http on each address: no front end, no authority, and the old warning"
  sandbox_new
  lan
  INSTALL_EXTRA=(--tls off)
  install_machine
  assert_eq "$(reg_value main tls)" off
  assert_eq "$(reg_value main tls_port)" ""
  assert_contains "$(env_value main ALLOWED_ORIGINS)" "http://192.168.1.20:8791"
  assert_not_contains "$(env_value main ALLOWED_ORIGINS)" "https://"
  assert_contains "$(compose)" "- '192.168.1.20:8791:8790'"
  assert_not_contains "$(compose)" "caddy"
  assert_no_path "$AMAN_HOME/tls"
  assert_no_path "$STUB_STATE/pki_runs"
  assert_flat_contains "$OUT" "Sign-in on your home network is not encrypted."
  assert_not_contains "$OUT" "follow its steps"
  sandbox_drop
}

test_the_flag_is_checked() {
  t_begin "--tls takes local, off or caddy, and local or off belong to an instance opened on the network"
  sandbox_new
  run_install --dry-run --yes --email owner@example.invalid --tls bogus
  assert_rc 2
  assert_flat_contains "$ERR" "--tls takes local, off or caddy"
  run_install --dry-run --yes --email owner@example.invalid --tls local --local-only
  assert_rc 2
  assert_flat_contains "$ERR" "--local-only keeps Aman on this computer"
  run_install --dry-run --yes --email owner@example.invalid --tls off --public-url https://aman.example.invalid --login-url https://login.example.invalid
  assert_rc 2
  assert_flat_contains "$ERR" "use --tls caddy"
  sandbox_drop
}

test_a_computer_with_no_network_has_nothing_to_serve() {
  t_begin "with only this computer's own names there is nothing to serve over https, so plain http and no front end"
  sandbox_new
  install_machine
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "http://127.0.0.1:8791,http://localhost:8791"
  assert_eq "$(reg_value main tls_port)" ""
  assert_not_contains "$(compose)" "caddy"
  assert_no_path "$STUB_STATE/pki_runs"
  sandbox_drop
}

test_a_busy_https_port_moves_the_instance() {
  t_begin "an install takes the next free port when something listens on 8443"
  sandbox_new
  lan
  python3 -c 'import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 8443))
s.listen(1)
time.sleep(120)' &
  local holder=$! waited=0
  while ! python3 -c 'import socket,sys
s=socket.socket()
sys.exit(0 if s.connect_ex(("127.0.0.1",8443))==0 else 1)' 2>/dev/null && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  install_machine || true
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
  assert_rc 0
  assert_eq "$(reg_value main tls_port)" 8444
  assert_contains "$(env_value main ALLOWED_ORIGINS)" "https://192.168.1.20:8444"
  sandbox_drop
}

test_an_existing_instance_moves_to_https_and_back() {
  t_begin "a re-run moves an instance from before https to https, --tls off moves it back and stays, --tls local moves it on again"
  sandbox_new
  lan
  INSTALL_EXTRA=(--tls off)
  install_machine
  # An instance opened on the network before https existed has no record of the choice.
  sed -i 's/^tls=.*/tls=/' "$AMAN_HOME/state/instances/main.conf"
  local secret
  secret=$(env_value main OIDC_CLIENT_SECRET)
  run_install --dry-run
  assert_flat_contains "$OUT" "Serve instance main over https on your network"
  : >"$STUB_LOG"
  run_install --yes
  assert_rc 0
  assert_eq "$(reg_value main tls)" local
  assert_eq "$(env_value main ALLOWED_ORIGINS)" "$HTTPS_ORIGINS"
  assert_contains "$(compose)" "- '192.168.1.20:8443:8443'"
  assert_eq "$(env_value main OIDC_CLIENT_SECRET)" "$secret" "secrets stay as they were"
  assert_log_has "--force-recreate"
  assert_not_contains "$(cat "$STUB_LOG")" "volume rm" "no data was removed"
  assert_flat_contains "$OUT" "open this page once on that device"
  run_install --yes
  assert_flat_contains "$OUT" "Nothing to do."
  run_install --yes --tls off
  assert_rc 0
  assert_eq "$(reg_value main tls)" off
  assert_eq "$(reg_value main tls_port)" ""
  assert_contains "$(env_value main ALLOWED_ORIGINS)" "http://192.168.1.20:8791"
  assert_not_contains "$(compose)" "caddy"
  run_install --yes
  assert_flat_contains "$OUT" "Nothing to do." "the choice of plain http is kept"
  run_install --yes --tls local
  assert_rc 0
  assert_eq "$(reg_value main tls)" local
  assert_eq "$(reg_value main tls_port)" 8443
  sandbox_drop
}

test_a_new_address_gets_a_new_certificate() {
  t_begin "refresh adds a new address of this computer to the origins and to the certificate, and keeps the authority"
  sandbox_new
  lan
  install_machine
  local key_before
  key_before=$(cat "$AMAN_HOME/tls/ca/root.key")
  STUB_ADDRS="192.168.1.77 192.168.1.20"
  run_install instance refresh main
  assert_rc 0
  assert_contains "$(env_value main ALLOWED_ORIGINS)" "https://192.168.1.77:8443"
  assert_contains "$(pki_info)" "192.168.1.77"
  assert_contains "$(compose)" "- '192.168.1.77:8443:8443'"
  assert_eq "$(cat "$AMAN_HOME/tls/ca/root.key")" "$key_before"
  sandbox_drop
}

test_backups_carry_the_certificate_but_not_the_key() {
  t_begin "a backup holds the authority's certificate and never its private key, and says what a restore does"
  sandbox_new
  lan
  install_machine
  run_install backup
  assert_rc 0
  local dir
  dir=$(find "$AMAN_HOME/backups" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)
  assert_eq "$(cmp -s "$AMAN_HOME/tls/ca/root.crt" "$dir/tls/root.crt" && echo same)" same
  assert_eq "$(find "$dir" -name 'root.key' | wc -l | tr -d ' ')" 0 "no private key anywhere in the backup"
  assert_eq "$(grep -rl 'PRIVATE KEY' "$dir" 2>/dev/null | grep -c 'tls' || true)" 0 "and no key under another name"
  assert_flat_contains "$OUT" "After a restore, each device needs to trust this computer again."
  sandbox_drop
}

test_renewal_issues_what_is_due() {
  t_begin "install.sh tls issues a certificate that is missing and restarts the front end, and does nothing when all is current"
  sandbox_new
  lan
  install_machine
  run_install tls
  assert_rc 0
  assert_flat_contains "$OUT" "The https certificates are up to date"
  : >"$STUB_LOG"
  assert_log_lacks "restart tls"
  rm -f "$AMAN_HOME/tls/leaf/main/leaf.crt" "$AMAN_HOME/tls/leaf/main/leaf.key"
  run_install tls
  assert_rc 0
  assert_file "$AMAN_HOME/tls/leaf/main/leaf.crt"
  assert_log_has "restart tls"
  sandbox_drop
}

test_the_daily_backup_renews() {
  t_begin "the daily backup also renews a certificate that is due"
  sandbox_new
  lan
  install_machine
  rm -f "$AMAN_HOME/tls/leaf/main/leaf.crt" "$AMAN_HOME/tls/leaf/main/leaf.key"
  : >"$STUB_LOG"
  run_install backup
  assert_rc 0
  assert_file "$AMAN_HOME/tls/leaf/main/leaf.crt"
  assert_log_has "restart tls"
  sandbox_drop
}

test_a_failed_certificate_is_said_with_the_one_fix() {
  t_begin "when the certificate cannot be made the install stops and names aman doctor tls --fix"
  sandbox_new
  lan
  STUB_PKI_FAIL=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "aman doctor tls --fix"
  sandbox_drop
}

test_the_front_end_is_a_listed_download() {
  t_begin "--print-network lists the registry the https front end comes from"
  sandbox_new
  run_install --print-network
  assert_contains "$OUT" "registry-1.docker.io"
  sandbox_drop
}

test_the_front_end_is_locked_down() {
  t_begin "the front end drops every privilege, writes only to memory, advertises no http/3, and refuses other names with 421"
  sandbox_new
  lan
  install_machine
  local file caddyfile
  file=$(compose)
  assert_contains "$file" "- ALL"
  assert_contains "$file" "- NET_BIND_SERVICE"
  assert_contains "$file" "no-new-privileges:true"
  assert_contains "$file" "read_only: true"
  assert_contains "$file" "- /tmp"
  caddyfile=$(cat "$AMAN_HOME/instances/main/tls.Caddyfile")
  assert_contains "$caddyfile" "protocols h1 h2"
  assert_contains "$caddyfile" "@known host 127.0.0.1 localhost 192.168.1.20 host host.local"
  assert_contains "$caddyfile" 'respond "This address is not one Aman is set up for." 421'
  assert_contains "$caddyfile" "X-Content-Type-Options nosniff"
  assert_contains "$caddyfile" "default-src 'none'"
  assert_contains "$caddyfile" "frame-ancestors 'none'"
  sandbox_drop
}

test_the_fingerprint_is_shown_where_trust_is_given() {
  t_begin "the fingerprint of the authority is in the ending and in the doctor, and the trust page sends people to compare it there"
  sandbox_new
  lan
  install_machine
  local fingerprint
  fingerprint=$(cat "$AMAN_HOME/tls/ca/root.fingerprint")
  assert_contains "$fingerprint" ":"
  assert_flat_contains "$OUT" "Your device will show a long code called a fingerprint. It must be $fingerprint. If it differs, stop."
  local page
  page=$(cat "$AMAN_HOME/tls/trust/main/index.html")
  assert_not_contains "$page" "$fingerprint" "the plain-http page does not show a value it cannot vouch for"
  assert_not_contains "$page" "<code>$fingerprint"
  assert_contains "$page" "compare the fingerprint your device shows with the one in the terminal"
  assert_contains "$page" "If they do not match, stop and do not trust it."
  assert_eq "$(pki_info | sed -n 's/.*"root_fingerprint":"\([^"]*\)".*/\1/p')" "$fingerprint"
  sandbox_drop
}

test_the_authority_is_limited() {
  t_begin "the authority may vouch only for private addresses and names, and the names are recorded"
  sandbox_new
  lan
  install_machine
  local info
  info=$(pki_info)
  assert_contains "$info" '"root_constrained":true'
  assert_contains "$info" '"root_covers_leaf":true'
  assert_contains "$(cat "$AMAN_HOME/tls/ca/root.names")" '"host"'
  assert_contains "$(cat "$AMAN_HOME/tls/ca/root.names")" '"version":2'
  sandbox_drop
}

test_a_new_name_makes_the_authority_again_and_says_so() {
  t_begin "a name the authority does not cover makes a new authority, every instance gets a certificate under it, and the ending says to trust it again"
  sandbox_new
  lan
  install_machine
  local before
  before=$(cat "$AMAN_HOME/tls/ca/root.fingerprint")
  assert_not_contains "$OUT" "made again"
  run_install instance refresh main --address files
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/tls/ca/root.names")" '"files"'
  assert_eq "$(grep -c "$before" "$AMAN_HOME/tls/ca/root.fingerprint")" 0 "a new authority"
  assert_flat_contains "$OUT" "root certificate was made again"
  assert_flat_contains "$OUT" "each device must trust it again"
  assert_contains "$(pki_info)" '"root_covers_leaf":true'
  assert_not_contains "$(cat "$AMAN_HOME/tls/trust/main/index.html")" "$(cat "$AMAN_HOME/tls/ca/root.fingerprint")" "the page never carries the fingerprint"
  assert_eq "$(cmp -s "$AMAN_HOME/tls/ca/root.crt" "$AMAN_HOME/tls/trust/main/ca.crt" && echo same)" same "and offers the new certificate"
  rm -f "$AMAN_HOME/tls/ca/root.names"
  run_install tls
  assert_rc 0
  assert_flat_contains "$OUT" "open this page once on that device"
  assert_flat_contains "$OUT" "root certificate was made again"
  sandbox_drop
}

test_purging_the_last_instance_keeps_the_authority() {
  t_begin "purging the last instance keeps this computer's authority, and a later install is signed by it, so devices keep trusting it"
  sandbox_new
  lan
  install_machine
  local fp_before key_before
  fp_before=$(cat "$AMAN_HOME/tls/ca/root.fingerprint")
  key_before=$(cat "$AMAN_HOME/tls/ca/root.key")
  run_install instance remove main --purge-data --confirm-name main
  assert_rc 0
  assert_file "$AMAN_HOME/tls/ca/root.crt"
  assert_file "$AMAN_HOME/tls/ca/root.key"
  assert_eq "$(cat "$AMAN_HOME/tls/ca/root.fingerprint")" "$fp_before" "the purge leaves the authority unchanged"
  assert_eq "$(cat "$AMAN_HOME/tls/ca/root.key")" "$key_before"
  assert_no_path "$AMAN_HOME/tls/leaf/main"
  assert_no_path "$AMAN_HOME/tls/trust/main"
  assert_no_path "$AMAN_HOME/instances"
  assert_flat_contains "$OUT" "trust certificate was kept"
  assert_flat_contains "$OUT" "kept in $AMAN_HOME/tls/ca"
  assert_flat_contains "$OUT" "To delete it too: rm -r $AMAN_HOME/tls/ca"
  install_machine
  assert_rc 0
  assert_eq "$(cat "$AMAN_HOME/tls/ca/root.fingerprint")" "$fp_before" "the install after the purge uses the same authority"
  assert_eq "$(cat "$AMAN_HOME/tls/ca/root.key")" "$key_before"
  assert_not_contains "$OUT" "made again"
  sandbox_drop
}

test_a_kept_authority_that_lost_its_key_is_made_again_and_says_so() {
  t_begin "an authority whose private key is gone is made again, and the ending says each device must trust it again"
  sandbox_new
  lan
  install_machine
  local fp_before
  fp_before=$(cat "$AMAN_HOME/tls/ca/root.fingerprint")
  rm -f "$AMAN_HOME/tls/ca/root.key"
  run_install tls
  assert_rc 0
  if [ "$(cat "$AMAN_HOME/tls/ca/root.fingerprint")" != "$fp_before" ]; then
    t_pass
  else
    t_fail "the authority was not made again"
  fi
  assert_flat_contains "$OUT" "root certificate was made again"
  assert_flat_contains "$OUT" "each device must trust it again"
  assert_flat_contains "$OUT" "open this page once on that device"
  sandbox_drop
}

test_an_authority_made_under_older_limits_is_replaced_once() {
  t_begin "an authority whose limits were the public-suffix kind is replaced on the next re-run, and then kept"
  sandbox_new
  lan
  install_machine
  printf '["host"]\n' >"$AMAN_HOME/tls/ca/root.names"
  run_install --dry-run
  assert_flat_contains "$OUT" "Make this computer's root certificate again"
  assert_flat_contains "$OUT" "is valid for more names than it should be"
  run_install --yes
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/tls/ca/root.names")" '"version":2'
  run_install instance refresh main
  assert_not_contains "$OUT" "made again"
  sandbox_drop
}

test_an_authority_from_before_it_had_limits_is_replaced_once() {
  t_begin "an authority from an earlier version, with no limits, is replaced on the next re-run with the one-time note, and then kept"
  sandbox_new
  lan
  install_machine
  rm -f "$AMAN_HOME/tls/ca/root.names"
  run_install --dry-run
  assert_flat_contains "$OUT" "Make this computer's root certificate again"
  run_install --yes
  assert_rc 0
  assert_flat_contains "$OUT" "root certificate was made again"
  assert_file "$AMAN_HOME/tls/ca/root.names"
  run_install instance refresh main
  assert_not_contains "$OUT" "made again"
  sandbox_drop
}

test_a_default_install_is_served_over_https
test_the_front_end_configuration
test_the_front_end_is_locked_down
test_the_fingerprint_is_shown_where_trust_is_given
test_the_authority_is_limited
test_a_new_name_makes_the_authority_again_and_says_so
test_purging_the_last_instance_keeps_the_authority
test_a_kept_authority_that_lost_its_key_is_made_again_and_says_so
test_an_authority_from_before_it_had_limits_is_replaced_once
test_an_authority_made_under_older_limits_is_replaced_once
test_the_authority_and_the_certificate
test_a_second_instance_shares_the_authority
test_the_trust_page_and_files
test_the_plan_and_the_summary
test_no_code_without_colors
test_tls_off_keeps_plain_http
test_the_flag_is_checked
test_a_computer_with_no_network_has_nothing_to_serve
test_a_busy_https_port_moves_the_instance
test_an_existing_instance_moves_to_https_and_back
test_a_new_address_gets_a_new_certificate
test_backups_carry_the_certificate_but_not_the_key
test_renewal_issues_what_is_due
test_the_daily_backup_renews
test_a_failed_certificate_is_said_with_the_one_fix
test_the_front_end_is_a_listed_download
tests_finish
