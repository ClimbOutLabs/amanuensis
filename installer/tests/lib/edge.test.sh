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

test_dry_run_plans_the_front_end() {
  t_begin "a dry run checks DNS, lists the Caddy root steps and the firewall hint, and changes nothing"
  sandbox_new
  dns_ready
  run_install --dry-run --email owner@example.invalid "${TLS_ARGS[@]}"
  assert_rc 0
  assert_contains "$OUT" "[done]     DNS: aman.example.com and login.example.com resolve to this computer's public address $PUBLIC_IP"
  assert_contains "$OUT" "[root]     Install Caddy from the Ubuntu package archive"
  assert_contains "$OUT" "[root]     Apply the Caddyfile for aman.example.com and login.example.com under"
  assert_contains "$OUT" "exactly those two names"
  assert_contains "$OUT" "Open only TCP 443"
  assert_contains "$OUT" "port 80 can stay closed"
  assert_contains "$OUT" "--tls-root"
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
  assert_contains "$OUT" "[done]     Caddy is installed"
  assert_not_contains "$OUT" "Install Caddy from the Ubuntu package archive"
  assert_contains "$OUT" "[root]     Apply the Caddyfile"
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
  assert_contains "$ERR" "login.example.com does not resolve yet"
  assert_contains "$ERR" "A record for it pointing at $PUBLIC_IP"
  assert_contains "$ERR" "Nothing was requested from Let's Encrypt"
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
  assert_contains "$ERR" "aman.example.com resolves to 203.0.113.9, but this computer's public address is $PUBLIC_IP"
  assert_contains "$ERR" "Nothing was requested from Let's Encrypt"
  sandbox_drop
}

test_public_address_lookup_failure_and_override() {
  t_begin "an unreachable lookup service is explained, and --public-ip replaces it"
  sandbox_new
  fixture_dns aman.example.com "$PUBLIC_IP"
  fixture_dns login.example.com "$PUBLIC_IP"
  run_install --dry-run --email owner@example.invalid "${TLS_ARGS[@]}"
  assert_rc 1
  assert_contains "$ERR" "Could not find this computer's public address"
  assert_contains "$ERR" "--public-ip ADDRESS"
  : >"$STUB_LOG"
  run_install --dry-run --email owner@example.invalid "${TLS_ARGS[@]}" --public-ip "$PUBLIC_IP"
  assert_rc 0
  assert_contains "$OUT" "resolve to this computer's public address $PUBLIC_IP"
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
  script=$(grep -A80 '^sudo sh -c' "$STUB_LOG" | head -n 40)
  assert_contains "$script" "apt-get install -y caddy"
  assert_contains "$script" "install -m 0644 $AMAN_HOME/instances/main/Caddyfile $SB/etc-caddy/aman.d/main.caddyfile"
  assert_contains "$script" "import $SB/etc-caddy/aman.d/*.caddyfile"
  assert_contains "$script" "caddy validate --config $SB/etc-caddy/Caddyfile"
  assert_contains "$script" "systemctl reload-or-restart caddy"
  assert_contains "$OUT" "Root steps for HTTPS with Caddy" "the steps were printed before they ran"
  assert_contains "$OUT" "HTTPS answers at $APP_URL"
  assert_contains "$OUT" "HTTPS:    Caddy on this computer serves $APP_URL and $LOGIN_URL"
  assert_contains "$OUT" "Open only TCP 443"
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
  assert_contains "$(cat "$file")" "reverse_proxy 127.0.0.1:15556"
  assert_contains "$(cat "$file")" "flush_interval -1"
  assert_contains "$(cat "$file")" "max_size 40MB"
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
  assert_contains "$ERR" "HTTPS for instance main is not set up"
  assert_contains "$ERR" "--tls-root"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  assert_log_has "compose --project-name aman-main"
  sandbox_drop
}

test_answering_yes_on_a_terminal() {
  t_begin "on a terminal the Caddy steps run after a yes"
  sandbox_new
  dns_ready
  run_install_tty "Instance name=>
Owner email=>owner@example.invalid
Token Factory key=>
Model server address=>
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD
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
  run_install_tty "Instance name=>
Owner email=>owner@example.invalid
Token Factory key=>
Model server address=>
Go ahead?=>y
Password for the owner account=>$SENTINEL_PASSWORD
Repeat the password=>$SENTINEL_PASSWORD
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
  assert_contains "$ERR" "aman.example.com resolves to 203.0.113.9"
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
  assert_contains "$ERR" "the Caddy steps failed"
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
  assert_contains "$ERR" "did not answer over https yet"
  assert_contains "$ERR" "journalctl -u caddy"
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
  fixture_caddy
  : >"$STUB_LOG"
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid
  clear_input
  assert_rc 0
  assert_contains "$OUT" "[done]     HTTPS for instance main: Caddy serves aman.example.com and login.example.com"
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

test_usage_errors() {
  t_begin "--tls needs both https addresses without ports, names rather than addresses, and a known mode"
  sandbox_new
  run_install --dry-run --email owner@example.invalid --tls caddy
  assert_rc 2
  assert_contains "$ERR" "--tls caddy needs --public-url and --login-url"
  run_install --dry-run --email owner@example.invalid --public-url "$APP_URL" --login-url "$LOGIN_URL" --tls nginx
  assert_rc 2
  assert_contains "$ERR" "--tls takes caddy"
  run_install --dry-run --email owner@example.invalid --public-url https://aman.example.com:8443 --login-url "$LOGIN_URL" --tls caddy
  assert_rc 2
  assert_contains "$ERR" "cannot carry a port"
  run_install --dry-run --email owner@example.invalid --public-url "$APP_URL" --login-url https://203.0.113.5 --tls caddy
  assert_rc 2
  assert_contains "$ERR" "login address cannot carry a port or be an IP address"
  run_install --dry-run --email owner@example.invalid --public-url "$APP_URL" --login-url "$LOGIN_URL" --tls caddy --public-ip 999.1.1.1
  assert_rc 2
  assert_contains "$ERR" "--public-ip must be an IPv4 address"
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
test_usage_errors
test_root_steps_can_be_printed
test_network_list_names_the_hosts
tests_finish
