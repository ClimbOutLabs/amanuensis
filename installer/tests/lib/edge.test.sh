#!/usr/bin/env bash
# --tls caddy: DNS pre-check, root steps and consent, the Caddyfile, the compose host mapping and the firewall hint.
# Names are example.com only; a real domain is only ever given at run time.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

APP_URL=https://aman.example.com
LOGIN_URL=https://login.example.com
PUBLIC_IP=198.51.100.7
TLS_ARGS=(--public-url "$APP_URL" --login-url "$LOGIN_URL" --tls caddy)

# A machine whose two names point at it and whose health route answers once Caddy is configured.
dns_ready() {
  fixture_public_ip "$PUBLIC_IP"
  fixture_dns aman.example.com "$PUBLIC_IP"
  fixture_dns login.example.com "$PUBLIC_IP"
  fixture_route "$APP_URL/healthz" 200 ok
}

install_tls() {
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid "${TLS_ARGS[@]}" "$@"
  clear_input
}

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }
sudo_calls() { grep -c '^sudo sh -c' "$STUB_LOG" || true; }
# Reloads the stub systemctl actually received (the script text in the sudo line mentions the command too).
reloads() { grep -c '^stub-systemctl reload-or-restart caddy' "$STUB_LOG" || true; }

test_dry_run_plans_the_front_end() {
  t_begin "a dry run checks DNS, lists the Caddy root steps and the firewall hint, and changes nothing"
  sandbox_new
  dns_ready
  run_install --dry-run --email owner@example.invalid "${TLS_ARGS[@]}"
  assert_rc 0
  assert_flat_contains "$OUT" "done DNS: aman.example.com and login.example.com resolve to this computer's public address $PUBLIC_IP"
  assert_flat_contains "$OUT" "needs admin Install Caddy from the system package archive"
  assert_flat_contains "$OUT" "needs admin Apply the Caddyfile for aman.example.com and login.example.com"
  assert_flat_contains "$OUT" "exactly those two names"
  assert_flat_contains "$OUT" "Open only port 443"
  assert_flat_contains "$OUT" "Port 80 can stay closed"
  assert_contains "$OUT" "--tls-root"
  run_install --dry-run --verbose --email owner@example.invalid "${TLS_ARGS[@]}"
  assert_contains "$OUT" "archive.ubuntu.com"
  assert_eq "$(sudo_calls)" 0
  assert_no_path "$AMAN_HOME"
  sandbox_drop
}

test_plan_skips_the_install_line_when_caddy_is_there() {
  t_begin "with Caddy already installed the plan only applies the configuration"
  sandbox_new
  dns_ready
  fixture_caddy
  run_install --dry-run --email owner@example.invalid "${TLS_ARGS[@]}"
  assert_rc 0
  assert_flat_contains "$OUT" "done Caddy is installed"
  assert_not_contains "$OUT" "Install Caddy from the system package archive"
  assert_flat_contains "$OUT" "needs admin Apply the Caddyfile"
  sandbox_drop
}

test_dns_not_resolving_stops_before_anything() {
  t_begin "a name that does not resolve is reported plainly and nothing is built or requested"
  sandbox_new
  fixture_public_ip "$PUBLIC_IP"
  fixture_dns aman.example.com "$PUBLIC_IP"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid "${TLS_ARGS[@]}"
  clear_input
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "login.example.com does not resolve yet"
  assert_flat_contains "$OUT$ERR" "A record for it pointing at $PUBLIC_IP"
  assert_flat_contains "$OUT$ERR" "Nothing was requested from Let's Encrypt"
  assert_log_lacks "docker build"
  assert_eq "$(sudo_calls)" 0
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_dns_pointing_elsewhere_stops() {
  t_begin "a name that resolves to another address is reported with both addresses"
  sandbox_new
  dns_ready
  fixture_dns aman.example.com 203.0.113.9
  run_install --dry-run --email owner@example.invalid "${TLS_ARGS[@]}"
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "aman.example.com resolves to 203.0.113.9, but this computer's public address is $PUBLIC_IP"
  assert_flat_contains "$OUT$ERR" "Nothing was requested from Let's Encrypt"
  sandbox_drop
}

test_public_address_lookup_failure_and_override() {
  t_begin "an unreachable lookup service is explained, and --public-ip replaces it"
  sandbox_new
  fixture_dns aman.example.com "$PUBLIC_IP"
  fixture_dns login.example.com "$PUBLIC_IP"
  run_install --dry-run --email owner@example.invalid "${TLS_ARGS[@]}"
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "Could not find this computer's public address"
  assert_flat_contains "$OUT$ERR" "--public-ip ADDRESS"
  : >"$STUB_LOG"
  run_install --dry-run --email owner@example.invalid "${TLS_ARGS[@]}" --public-ip "$PUBLIC_IP"
  assert_rc 0
  assert_flat_contains "$OUT" "resolve to this computer's public address $PUBLIC_IP"
  assert_log_lacks "api.ipify.org"
  sandbox_drop
}

test_install_with_the_flag_runs_the_root_steps() {
  t_begin "--tls-root runs the printed Caddy steps once, with the Caddyfile for exactly the two origins"
  sandbox_new
  dns_ready
  install_tls --tls-root
  assert_rc 0
  assert_eq "$(sudo_calls)" 1 "one root script"
  local script
  script=$(grep -A80 '^sudo sh -c' "$STUB_LOG" | head -n 60)
  assert_contains "$script" "apt-get install -y caddy"
  assert_contains "$script" "install -m 0644 $AMAN_HOME/instances/main/Caddyfile \"\$site_new\""
  assert_contains "$script" "mv -f \"\$site_new\" $SB/etc-caddy/aman.d/main.caddyfile"
  assert_contains "$script" "import %s\\n' '$SB/etc-caddy/aman.d/*.caddyfile'"
  assert_contains "$script" "caddy validate --config \"\$check\""
  assert_contains "$script" "systemctl reload-or-restart caddy"
  assert_contains "$OUT" "Root steps for HTTPS with Caddy" "the steps were printed before they ran"
  assert_contains "$OUT" "HTTPS answers at $APP_URL"
  assert_flat_contains "$OUT" "HTTPS on, with certificates from Let"
  assert_flat_contains "$OUT" "Open only port 443"
  assert_contains "$(grep '^curl' "$STUB_LOG")" "$APP_URL/healthz"
  assert_eq "$(sed -n 's/^tls=//p' "$AMAN_HOME/state/instances/main.conf")" caddy
  sandbox_drop
}

test_the_caddyfile_holds_exactly_the_two_origins() {
  t_begin "the Caddyfile proxies the two hosts to the instance's loopback ports and nothing else"
  sandbox_new
  dns_ready
  install_tls --tls-root --port 18790 --login-port 15556
  assert_rc 0
  local file
  file=$AMAN_HOME/instances/main/Caddyfile
  assert_mode "$file" 644
  assert_eq "$(grep -c '^[^#[:space:]}].* {$' "$file")" 2 "two site blocks"
  assert_contains "$(grep '^[^#[:space:]}].* {$' "$file" | tr '\n' ' ')" "aman.example.com { login.example.com {"
  assert_contains "$(cat "$file")" "reverse_proxy 127.0.0.1:18790 {"
  assert_contains "$(grep -v '{' "$file" | grep 'reverse_proxy')" "reverse_proxy 127.0.0.1:18790" "the login name goes through the app, which limits password guessing"
  assert_not_contains "$(cat "$file")" "15556" "the sign-in service is never exposed directly"
  assert_contains "$(cat "$AMAN_HOME/instances/main/.env")" "LOGIN_UPSTREAM_URL=http://127.0.0.1:15556/dex"
  assert_contains "$(cat "$file")" "flush_interval -1"
  assert_contains "$(cat "$file")" "max_size 40MB"
  assert_not_contains "$(cat "$file")" "encode" "streamed replies are never compressed or buffered"
  assert_not_contains "$(cat "$file")" "@@"
  assert_eq "$(grep -c 'reverse_proxy' "$file")" 2
  sandbox_drop
}

test_compose_maps_the_login_name_to_the_host() {
  t_begin "the app reaches the login name through the host gateway only with --tls caddy"
  sandbox_new
  dns_ready
  install_tls --tls-root
  assert_rc 0
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "- 'login.example.com:host-gateway'"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "$LOGIN_URL/dex"
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "$APP_URL"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "$APP_URL/api/v1/auth/callback"
  sandbox_drop
  sandbox_new
  install_machine
  assert_eq "$(grep -c 'host-gateway' "$AMAN_HOME/instances/main/compose.yaml")" 1
  assert_no_path "$AMAN_HOME/instances/main/Caddyfile"
  sandbox_drop
}

test_yes_alone_never_uses_sudo() {
  t_begin "--yes alone prints the root steps, leaves the instance running and ends with a failure that says how to finish"
  sandbox_new
  dns_ready
  install_tls
  assert_rc 1
  assert_eq "$(sudo_calls)" 0
  assert_contains "$OUT" "apt-get install -y caddy"
  assert_flat_contains "$ERR" "HTTPS for instance main is not set up"
  assert_flat_contains "$ERR" "--tls-root"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  assert_log_has "compose --project-name aman-main"
  sandbox_drop
}

test_answering_yes_on_a_terminal() {
  t_begin "on a terminal the Caddy steps run after a yes"
  sandbox_new
  dns_ready
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD
Install Caddy and apply this configuration now?=>y" "${TLS_ARGS[@]}"
  assert_eq "$RC" 0
  assert_eq "$(sudo_calls)" 1
  assert_contains "$OUT" "HTTPS answers at $APP_URL"
  sandbox_drop
}

test_declining_on_a_terminal() {
  t_begin "on a terminal a no leaves Caddy untouched"
  sandbox_new
  dns_ready
  run_install_tty "Name for this instance=>
Your email=>owner@example.invalid
Connect an email account=>n
Back up automatically=>y
Go ahead?=>y
Enter a password for owner@example.invalid=>$SENTINEL_PASSWORD
Enter password again=>$SENTINEL_PASSWORD
Install Caddy and apply this configuration now?=>n" "${TLS_ARGS[@]}"
  assert_eq "$RC" 1
  assert_eq "$(sudo_calls)" 0
  assert_contains "$OUT" "HTTPS for instance main is not set up"
  sandbox_drop
}

test_a_late_dns_change_stops_before_the_root_steps() {
  t_begin "DNS is checked again right before the root steps"
  sandbox_new
  dns_ready
  # The plan-time lookup passes; the one right before the root steps finds another address.
  printf '203.0.113.9\n' >"$SB_STATE/dns/aman.example.com.later"
  install_tls --tls-root
  assert_rc 1
  assert_flat_contains "$OUT$ERR" "aman.example.com resolves to 203.0.113.9"
  assert_eq "$(sudo_calls)" 0
  sandbox_drop
}

test_a_failing_root_script_is_reported() {
  t_begin "a failing Caddy step names what to do and keeps the instance"
  sandbox_new
  dns_ready
  STUB_SUDO_SH_FAIL=1
  install_tls --tls-root
  assert_rc 1
  assert_flat_contains "$ERR" "The Caddy steps failed"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  unset STUB_SUDO_SH_FAIL
  sandbox_drop
}

test_certificates_slow_to_arrive_only_warn() {
  t_begin "https that does not answer yet is a warning with the log command, not a failure"
  sandbox_new
  fixture_public_ip "$PUBLIC_IP"
  fixture_dns aman.example.com "$PUBLIC_IP"
  fixture_dns login.example.com "$PUBLIC_IP"
  install_tls --tls-root
  assert_rc 0
  assert_flat_contains "$ERR" "did not answer over https yet"
  assert_flat_contains "$ERR" "Run aman doctor to see why"
  sandbox_drop
}

test_rerun_with_everything_in_place() {
  t_begin "a rerun finds Caddy serving the current Caddyfile and does nothing"
  sandbox_new
  dns_ready
  install_tls --tls-root
  assert_rc 0
  mkdir -p "$SB/etc-caddy/aman.d"
  cp "$AMAN_HOME/instances/main/Caddyfile" "$SB/etc-caddy/aman.d/main.caddyfile"
  printf '# Managed by the Amanuensis installer. The package original is kept as Caddyfile.aman-orig.\n' >"$SB/etc-caddy/Caddyfile"
  fixture_caddy
  : >"$STUB_LOG"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_flat_contains "$OUT" "done HTTPS for instance main: Caddy serves aman.example.com and login.example.com"
  assert_contains "$OUT" "Nothing to do"
  assert_eq "$(sudo_calls)" 0
  sandbox_drop
}

test_rerun_after_a_declined_run_finishes_the_job() {
  t_begin "after a declined run, a rerun with --tls-root applies the steps without recreating anything"
  sandbox_new
  dns_ready
  install_tls
  assert_rc 1
  : >"$STUB_LOG"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --tls-root
  clear_input
  assert_rc 0
  assert_eq "$(sudo_calls)" 1
  assert_eq "$(log_count 'aman hash-password')" 0 "the instance was not created again"
  sandbox_drop
}

test_both_sites_send_the_security_headers() {
  t_begin "both site blocks add the four security headers, only where the upstream sent none"
  sandbox_new
  dns_ready
  install_tls --tls-root
  assert_rc 0
  local file block name
  file=$AMAN_HOME/instances/main/Caddyfile
  for block in "aman.example.com {" "login.example.com {"; do
    name=$(awk -v b="$block" '$0 == b {p = 1; next} p && /^}/ {exit} p' "$file")
    assert_contains "$name" 'header ?Strict-Transport-Security "max-age=31536000"' "$block"
    assert_contains "$name" "header ?X-Content-Type-Options nosniff" "$block"
    assert_contains "$name" "header ?Referrer-Policy strict-origin-when-cross-origin" "$block"
    assert_contains "$name" "header ?X-Frame-Options DENY" "$block"
  done
  assert_eq "$(grep -c '^	header ?' "$file")" 8 "four per site, each its own default-only directive"
  assert_eq "$(grep -c '^	header {' "$file")" 0 "a grouped header block would drop all four when the app sets one"
  assert_contains "$(cat "$file")" "flush_interval -1"
  sandbox_drop
}

# A machine whose main Caddyfile is the Ubuntu package's default :80 site, with the root script run for real.
package_default_machine() {
  sandbox_new
  dns_ready
  fixture_caddy
  fixture_systemctl
  fixture_run_root_scripts
  mkdir -p "$SB/etc-caddy"
  printf ':80 {\n\t# Set this path to your site'"'"'s directory.\n\troot * /usr/share/caddy\n\tfile_server\n}\n' >"$SB/etc-caddy/Caddyfile"
}

test_the_package_default_site_is_replaced_once() {
  t_begin "the main Caddyfile only imports aman.d and binds the admin API to localhost; the original is kept once"
  package_default_machine
  install_tls --tls-root
  assert_rc 0
  local main=$SB/etc-caddy/Caddyfile
  assert_contains "$(cat "$main")" "Managed by the Amanuensis installer"
  assert_contains "$(cat "$main")" "admin localhost:2019"
  assert_contains "$(cat "$main")" "import $SB/etc-caddy/aman.d/*.caddyfile"
  assert_not_contains "$(cat "$main")" ":80" "the default welcome site is gone"
  assert_contains "$(cat "$main.aman-orig")" "root * /usr/share/caddy" "the package original"
  assert_eq "$(file_mode "$main")" 644
  assert_eq "$(cmp -s "$AMAN_HOME/instances/main/Caddyfile" "$SB/etc-caddy/aman.d/main.caddyfile" && echo same)" same
  assert_contains "$(cat "$SB_STATE/caddy_check")" "import $SB/etc-caddy/aman.d/main.caddyfile.new" "the new file was validated under its temporary name"
  assert_eq "$(reloads)" 1
  # A second pass over the same steps changes nothing and does not replace the backup with the managed file.
  rm -f "$SB/etc-caddy/aman.d/main.caddyfile"
  : >"$STUB_LOG"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --tls-root
  clear_input
  assert_rc 0
  assert_eq "$(sudo_calls)" 1 "the steps ran again"
  assert_contains "$(cat "$main.aman-orig")" "root * /usr/share/caddy" "the backup still holds the package original"
  assert_eq "$(grep -c 'Managed by the Amanuensis installer' "$main")" 1
  assert_eq "$(dir_names "$SB/etc-caddy")" "Caddyfile Caddyfile.aman-orig aman.d " "no temporary files are left"
  assert_eq "$(dir_names "$SB/etc-caddy/aman.d")" "main.caddyfile "
  sandbox_drop
}

test_an_old_style_main_is_repaired_on_a_rerun() {
  t_begin "a rerun on a machine set up before the minimal main notices the package's default site is still there"
  package_default_machine
  install_tls --tls-root
  assert_rc 0
  # What the earlier installer left: the package file with the import line appended.
  printf ':80 {\n\troot * /usr/share/caddy\n}\nimport %s/aman.d/*.caddyfile\n' "$SB/etc-caddy" >"$SB/etc-caddy/Caddyfile"
  rm -f "$SB/etc-caddy/Caddyfile.aman-orig"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --tls-root
  clear_input
  assert_rc 0
  assert_not_contains "$(cat "$SB/etc-caddy/Caddyfile")" ":80"
  assert_contains "$(cat "$SB/etc-caddy/Caddyfile.aman-orig")" ":80"
  sandbox_drop
}

test_a_rejected_file_never_replaces_the_good_one() {
  t_begin "when caddy validate rejects the combined configuration the previous site file and main file stay as they were"
  package_default_machine
  install_tls --tls-root
  assert_rc 0
  local main=$SB/etc-caddy/Caddyfile site=$SB/etc-caddy/aman.d/main.caddyfile
  printf '# previous good file\n' >"$site"
  cp "$main" "$SB/main.before"
  : >"$STUB_LOG"
  : >"$SB_STATE/caddy_reject"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --tls-root
  clear_input
  assert_rc 1
  assert_flat_contains "$ERR" "unrecognized directive" "Caddy's own reason is shown"
  assert_flat_contains "$ERR" "Caddy rejected the generated configuration"
  assert_eq "$(cat "$site")" "# previous good file"
  assert_eq "$(cmp -s "$main" "$SB/main.before" && echo same)" same
  assert_eq "$(dir_names "$SB/etc-caddy/aman.d")" "main.caddyfile " "no temporary file is left next to it"
  assert_eq "$(dir_names "$SB/etc-caddy")" "Caddyfile Caddyfile.aman-orig aman.d "
  assert_eq "$(reloads)" 0 "Caddy was not reloaded"
  sandbox_drop
}

test_the_check_covers_the_other_instances() {
  t_begin "the combined configuration holds the other instances' site files but not the one being replaced"
  package_default_machine
  mkdir -p "$SB/etc-caddy/aman.d"
  printf 'other.example.com {\n}\n' >"$SB/etc-caddy/aman.d/other.caddyfile"
  printf '# old\n' >"$SB/etc-caddy/aman.d/main.caddyfile"
  install_tls --tls-root
  assert_rc 0
  local check
  check=$(cat "$SB_STATE/caddy_check")
  assert_contains "$check" "import $SB/etc-caddy/aman.d/other.caddyfile"
  assert_contains "$check" "import $SB/etc-caddy/aman.d/main.caddyfile.new"
  assert_not_contains "$check" "import $SB/etc-caddy/aman.d/main.caddyfile
" "the old copy would define the same site twice"
  sandbox_drop
}

# A machine with the Caddy front end really applied, ready for the remove tests.
caddy_instance_applied() {
  package_default_machine
  install_tls --tls-root
  assert_rc 0
  assert_file "$SB/etc-caddy/aman.d/main.caddyfile"
  : >"$STUB_LOG"
}

test_remove_prints_and_runs_the_edge_step_with_the_flag() {
  t_begin "instance remove prints the Caddy removal and, with --tls-root, runs it and reloads"
  caddy_instance_applied
  run_install instance remove main --tls-root
  assert_rc 0
  assert_contains "$OUT" "rm -f $SB/etc-caddy/aman.d/main.caddyfile"
  assert_contains "$OUT" "systemctl reload-or-restart caddy"
  assert_eq "$(sudo_calls)" 1
  assert_no_path "$SB/etc-caddy/aman.d/main.caddyfile"
  assert_eq "$(reloads)" 1
  assert_no_path "$AMAN_HOME/instances/main"
  assert_no_path "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_remove_with_yes_alone_never_uses_sudo() {
  t_begin "--yes alone removes the instance, prints the Caddy steps and leaves the site file with a warning"
  caddy_instance_applied
  run_install instance remove main --yes
  assert_rc 0
  assert_contains "$OUT" "rm -f $SB/etc-caddy/aman.d/main.caddyfile"
  assert_flat_contains "$ERR" "Caddy still serves the addresses of instance main"
  assert_flat_contains "$ERR" "--tls-root"
  assert_eq "$(sudo_calls)" 0
  assert_file "$SB/etc-caddy/aman.d/main.caddyfile"
  assert_no_path "$AMAN_HOME/instances/main"
  sandbox_drop
}

test_remove_asks_on_a_terminal() {
  t_begin "on a terminal the Caddy removal waits for a yes"
  caddy_instance_applied
  run_install_tty "Remove the Caddy site for instance main now?=>n" instance remove main
  assert_eq "$RC" 0
  assert_file "$SB/etc-caddy/aman.d/main.caddyfile"
  assert_eq "$(sudo_calls)" 0
  sandbox_drop
  caddy_instance_applied
  run_install_tty "Remove the Caddy site for instance main now?=>y" instance remove main
  assert_eq "$RC" 0
  assert_no_path "$SB/etc-caddy/aman.d/main.caddyfile"
  assert_eq "$(sudo_calls)" 1
  sandbox_drop
}

test_remove_without_a_caddy_front_end_asks_nothing() {
  t_begin "an instance without the Caddy front end is removed with no root step"
  sandbox_new
  install_machine
  run_install instance remove main
  assert_rc 0
  assert_not_contains "$OUT" "Root steps to stop serving"
  assert_eq "$(sudo_calls)" 0
  sandbox_drop
}

test_usage_errors() {
  t_begin "--tls needs both https addresses without ports, names rather than addresses, and a known mode"
  sandbox_new
  run_install --dry-run --email owner@example.invalid --tls caddy
  assert_rc 2
  assert_flat_contains "$ERR" "--tls caddy needs --public-url and --login-url"
  run_install --dry-run --email owner@example.invalid --public-url "$APP_URL" --login-url "$LOGIN_URL" --tls nginx
  assert_rc 2
  assert_flat_contains "$ERR" "--tls takes local, off or caddy"
  run_install --dry-run --email owner@example.invalid --public-url https://aman.example.com:8443 --login-url "$LOGIN_URL" --tls caddy
  assert_rc 2
  assert_flat_contains "$ERR" "cannot carry a port"
  run_install --dry-run --email owner@example.invalid --public-url "$APP_URL" --login-url https://203.0.113.5 --tls caddy
  assert_rc 2
  assert_flat_contains "$ERR" "login address cannot carry a port or be an IP address"
  run_install --dry-run --email owner@example.invalid --public-url "$APP_URL" --login-url "$LOGIN_URL" --tls caddy --public-ip 999.1.1.1
  assert_rc 2
  assert_flat_contains "$ERR" "--public-ip must be an IPv4 address"
  sandbox_drop
}

test_root_steps_can_be_printed() {
  t_begin "--print-root-steps --tls caddy prints the Caddy steps next to Docker's, and runs nothing"
  sandbox_new
  os_release_ubuntu
  run_install --print-root-steps --tls caddy
  assert_rc 0
  assert_contains "$OUT" "Root steps for HTTPS with Caddy"
  assert_contains "$OUT" "apt-get install -y caddy"
  assert_contains "$OUT" "Caddy rejected the generated configuration"
  assert_eq "$(sudo_calls)" 0
  assert_not_contains "$OUT" "example.com"
  sandbox_drop
}

test_network_list_names_the_hosts() {
  t_begin "--print-network lists the package archive, the certificate authority and the address lookup"
  sandbox_new
  run_install --print-network
  assert_rc 0
  assert_contains "$OUT" "archive.ubuntu.com"
  assert_contains "$OUT" "acme-v02.api.letsencrypt.org"
  assert_contains "$OUT" "api.ipify.org"
  sandbox_drop
}

test_dry_run_plans_the_front_end
test_plan_skips_the_install_line_when_caddy_is_there
test_dns_not_resolving_stops_before_anything
test_dns_pointing_elsewhere_stops
test_public_address_lookup_failure_and_override
test_install_with_the_flag_runs_the_root_steps
test_the_caddyfile_holds_exactly_the_two_origins
test_compose_maps_the_login_name_to_the_host
test_yes_alone_never_uses_sudo
test_answering_yes_on_a_terminal
test_declining_on_a_terminal
test_a_late_dns_change_stops_before_the_root_steps
test_a_failing_root_script_is_reported
test_certificates_slow_to_arrive_only_warn
test_rerun_with_everything_in_place
test_rerun_after_a_declined_run_finishes_the_job
test_both_sites_send_the_security_headers
test_the_package_default_site_is_replaced_once
test_an_old_style_main_is_repaired_on_a_rerun
test_a_rejected_file_never_replaces_the_good_one
test_the_check_covers_the_other_instances
test_remove_prints_and_runs_the_edge_step_with_the_flag
test_remove_with_yes_alone_never_uses_sudo
test_remove_asks_on_a_terminal
test_remove_without_a_caddy_front_end_asks_nothing
test_usage_errors
test_root_steps_can_be_printed
test_network_list_names_the_hosts
tests_finish
