#!/usr/bin/env bash
# instance add, list and remove, and the values that must differ between instances.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

add_instance() {
  local name=$1
  shift
  with_input "$SENTINEL_PASSWORD
"
  run_install instance add "$name" --yes --password-stdin --email "$name@example.invalid" "$@"
  clear_input
}

env_value() { sed -n "s/^$2=//p" "$AMAN_HOME/instances/$1/.env" | head -n 1; }

test_three_instances_never_share_values() {
  t_begin "three instances differ in ports, cookie suffix, secrets and volumes"
  sandbox_new
  install_machine
  add_instance second
  assert_rc 0
  add_instance third
  assert_rc 0
  local names="main second third" n ports="" logins="" cookies="" secrets="" keys="" clients=""
  for n in $names; do
    ports="$ports $(env_value "$n" PUBLIC_BASE_URL)"
    logins="$logins $(env_value "$n" OIDC_ISSUER_URL)"
    cookies="$cookies $(env_value "$n" AUTH_COOKIE_SUFFIX)"
    secrets="$secrets $(env_value "$n" OIDC_CLIENT_SECRET)"
    keys="$keys $(env_value "$n" TRUEFORGE_API_KEY)"
    clients="$clients $(env_value "$n" OIDC_CLIENT_ID)"
  done
  local list
  for list in "$ports" "$logins" "$cookies" "$secrets" "$keys" "$clients"; do
    assert_eq "$(printf '%s' "$list" | tr ' ' '\n' | grep -c . )" 3 "three values in [$list]"
    assert_eq "$(printf '%s' "$list" | tr ' ' '\n' | grep . | sort -u | wc -l | tr -d ' ')" 3 "distinct values in [$list]"
  done
  assert_contains "$ports" "127.0.0.1:8791"
  assert_contains "$ports" "127.0.0.1:8792"
  assert_contains "$ports" "127.0.0.1:8793"
  assert_contains "$logins" "127.0.0.1:5556/dex"
  assert_contains "$logins" "127.0.0.1:5557/dex"
  assert_contains "$(cat "$AMAN_HOME/instances/third/compose.yaml")" "name: aman_third_data"
  assert_contains "$(cat "$AMAN_HOME/instances/third/compose.yaml")" "name: aman-third"
  assert_mode "$AMAN_HOME/instances/third/.env" 600
  assert_eq "$(log_count 'aman hash-password')" 3 "one hash per instance"
  assert_tree_lacks "$AMAN_HOME" "$SENTINEL_PASSWORD"
  sandbox_drop
}

test_skips_ports_in_use() {
  t_begin "a busy loopback port is skipped when picking"
  sandbox_new
  rm -f "$SB_BIN/python3"
  printf '#!/usr/bin/env bash\necho "State Recv-Q Send-Q Local Address:Port Peer"\necho "LISTEN 0 1 127.0.0.1:8791 0.0.0.0:*"\necho "LISTEN 0 1 0.0.0.0:5556 0.0.0.0:*"\n' >"$SB_BIN/ss"
  install_machine
  assert_eq "$(env_value main PUBLIC_BASE_URL)" "http://127.0.0.1:8792"
  assert_eq "$(env_value main OIDC_ISSUER_URL)" "http://127.0.0.1:5557/dex"
  sandbox_drop
}

test_explicit_busy_port_is_refused() {
  t_begin "an explicit port that is taken is refused, not moved"
  sandbox_new
  install_machine
  add_instance other --port 8791
  assert_rc 1
  assert_flat_contains "$ERR" "already used by another instance"
  assert_no_path "$AMAN_HOME/state/instances/other.conf"
  sandbox_drop
}

test_add_existing_is_idempotent() {
  t_begin "adding an existing instance changes nothing and asks nothing"
  sandbox_new
  install_machine
  local env_before hashes
  env_before=$(cat "$AMAN_HOME/instances/main/.env")
  hashes=$(log_count 'aman hash-password')
  add_instance main
  assert_rc 0
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$env_before"
  assert_eq "$(log_count 'aman hash-password')" "$hashes"
  sandbox_drop
}

test_list() {
  t_begin "list shows name, ports, state, owner and URL"
  sandbox_new
  install_machine
  add_instance second
  run_install instance list
  assert_rc 0
  assert_contains "$OUT" "NAME"
  assert_contains "$OUT" "main"
  assert_contains "$OUT" "second"
  assert_contains "$OUT" "running"
  assert_contains "$OUT" "8792"
  assert_contains "$OUT" "second@example.invalid"
  rm -f "$SB_STATE/up/aman-second"
  run_install instance list
  assert_contains "$OUT" "stopped"
  sandbox_drop
}

test_remove_keeps_volumes() {
  t_begin "remove stops the stack and keeps the data volumes"
  sandbox_new
  install_machine
  add_instance second
  run_install instance remove second
  assert_rc 0
  assert_no_path "$AMAN_HOME/instances/second"
  assert_no_path "$AMAN_HOME/state/instances/second.conf"
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_second_data"
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_second_dex"
  assert_contains "$OUT" "kept"
  assert_file "$AMAN_HOME/state/instances/main.conf"
  assert_no_path "$SB_STATE/volumes_removed"
  run_install instance remove second
  assert_rc 0
  assert_contains "$OUT" "already removed"
  assert_contains "$OUT" "instance remove second --purge-data"
  run_install instance remove nosuch
  assert_rc 0
  assert_contains "$OUT" "nothing to do"
  sandbox_drop
}

test_purge_after_remove_deletes_the_leftover_volumes() {
  t_begin "the purge the remove message advertises works after the instance is gone"
  sandbox_new
  install_machine
  add_instance second
  run_install instance remove second
  assert_rc 0
  run_install instance remove second --purge-data --confirm-name wrong
  assert_rc 1
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_second_data" "a wrong name deletes nothing"
  assert_no_path "$SB_STATE/volumes_removed"
  run_install instance remove second --purge-data --yes
  assert_rc 1
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_second_data" "--yes does not confirm"
  run_install instance remove second --purge-data --confirm-name second
  assert_rc 0
  assert_contains "$OUT" "deleted its data volumes"
  assert_contains "$(cat "$SB_STATE/volumes_removed")" "aman_second_data"
  assert_contains "$(cat "$SB_STATE/volumes_removed")" "aman_second_dex"
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_second_"
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_main_data" "other instance's data untouched"
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_main_dex"
  run_install instance remove second --purge-data --confirm-name second
  assert_rc 0
  assert_contains "$OUT" "nothing to do"
  sandbox_drop
}

test_purge_failure_is_not_reported_as_success() {
  t_begin "a volume that cannot be deleted fails the purge and is named"
  sandbox_new
  install_machine
  add_instance second
  STUB_VOLUME_RM_FAIL=aman_second_data
  run_install instance remove second --purge-data --confirm-name second
  assert_rc 1
  assert_flat_contains "$ERR" "could not delete the volumes: aman_second_data"
  assert_not_contains "$OUT" "deleted its data volumes"
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_second_data"
  unset STUB_VOLUME_RM_FAIL
  run_install instance remove second --purge-data --confirm-name second
  assert_rc 0
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_second_data"
  sandbox_drop
}

test_purge_needs_typed_name() {
  t_begin "purging data needs the typed instance name"
  sandbox_new
  install_machine
  add_instance second
  run_install instance remove second --purge-data --confirm-name wrong
  assert_rc 1
  assert_file "$AMAN_HOME/state/instances/second.conf"
  assert_no_path "$SB_STATE/volumes_removed"
  with_input "second
"
  run_install instance remove second --purge-data
  clear_input
  assert_rc 0
  assert_no_path "$AMAN_HOME/state/instances/second.conf"
  assert_contains "$(cat "$SB_STATE/volumes_removed")" "aman_second_data"
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_second_data"
  assert_contains "$(cat "$SB_STATE/volumes")" "aman_main_data" "other instance's data untouched"
  sandbox_drop
}

test_yes_does_not_bypass_purge_confirmation() {
  t_begin "--yes does not confirm a purge"
  sandbox_new
  install_machine
  add_instance second
  run_install instance remove second --purge-data --yes
  assert_rc 1
  assert_file "$AMAN_HOME/state/instances/second.conf"
  sandbox_drop
}

test_name_validation() {
  t_begin "unsafe or reserved instance names are rejected"
  sandbox_new
  install_machine
  local bad
  for bad in "UPPER" "has space" "../x" "machine" "-x" "a_b"; do
    run_install instance add "$bad" --yes --password-stdin --email a@example.invalid
    assert_rc 2 "name [$bad]"
  done
  sandbox_drop
}

test_public_url_rules() {
  t_begin "a public URL switches issuer and redirect to https and prints proxy requirements"
  sandbox_new
  install_machine
  add_instance pub --public-url https://aman.example.invalid --login-url https://login.example.invalid
  assert_rc 0
  assert_eq "$(env_value pub PUBLIC_BASE_URL)" "https://aman.example.invalid"
  assert_eq "$(env_value pub OIDC_ISSUER_URL)" "https://login.example.invalid/dex"
  assert_contains "$(cat "$AMAN_HOME/instances/pub/dex.yaml")" "issuer: https://login.example.invalid/dex"
  assert_contains "$(cat "$AMAN_HOME/instances/pub/dex.yaml")" "https://aman.example.invalid/api/v1/auth/callback"
  assert_contains "$OUT" "Requirements for your reverse proxy"
  assert_eq "$(env_value pub TRUSTED_PROXY_ADDRESSES)" "172.30.0.1" "the app believes the proxy that reaches it through the network's gateway"
  assert_contains "$(cat "$STUB_LOG")" "--force-recreate --no-deps --wait --wait-timeout 120 app"
  assert_eq "$(env_value pub LOGIN_UPSTREAM_URL)" "http://127.0.0.1:$(sed -n 's/^login_port=//p' "$AMAN_HOME/state/instances/pub.conf")/dex"
  assert_contains "$OUT" "Never a path prefix"
  assert_contains "$OUT" "Forward the original Host header"
  assert_contains "$OUT" "Do not buffer responses"
  local product
  for product in nginx caddy traefik apache haproxy cloudflare envoy; do
    case "$(printf '%s' "$OUT" | tr '[:upper:]' '[:lower:]')" in *"$product"*) t_fail "names a product: $product" ;; *) t_pass ;; esac
  done
  # Loopback ports are still the only published ones.
  assert_contains "$(cat "$AMAN_HOME/instances/pub/compose.yaml")" "'127.0.0.1:"
  sandbox_drop
}

test_url_validation() {
  t_begin "http, path and half-configured public URLs are refused"
  sandbox_new
  install_machine
  add_instance a --public-url http://aman.example.invalid --login-url https://login.example.invalid
  assert_rc 2
  add_instance b --public-url https://aman.example.invalid/prefix --login-url https://login.example.invalid
  assert_rc 2
  add_instance c --public-url https://aman.example.invalid
  assert_rc 2
  add_instance d --public-url https://aman.example.invalid --login-url http://login.example.invalid
  assert_rc 2
  add_instance e --public-url https://same.example.invalid --login-url https://same.example.invalid
  assert_rc 2
  add_instance f --login-url https://login.example.invalid
  assert_rc 2
  assert_no_path "$AMAN_HOME/state/instances/a.conf"
  sandbox_drop
}

test_a_new_instance_points_to_settings_for_a_model() {
  t_begin "an instance added without a hosted model says to add one in Settings and keeps no model address"
  sandbox_new
  install_machine
  add_instance m
  assert_rc 0
  assert_flat_contains "$OUT" "not set: add one in Settings > Models"
  assert_not_contains "$(cat "$AMAN_HOME/state/instances/m.conf")" "model_endpoint"
  sandbox_drop
}

test_add_before_install_is_refused() {
  t_begin "instance add before the machine is set up points to install.sh"
  sandbox_new
  add_instance x
  assert_rc 1
  assert_flat_contains "$ERR" "run install.sh first"
  sandbox_drop
}

test_instances_are_isolated_and_images_stay_local() {
  t_begin "each instance has its own speech network, shares no network, and never pulls local images"
  sandbox_new
  install_machine
  add_instance second
  local main second machine
  main=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  second=$(cat "$AMAN_HOME/instances/second/compose.yaml")
  machine=$(cat "$AMAN_HOME/machine/compose.yaml")
  assert_contains "$main" "name: aman_main_stt"
  assert_contains "$second" "name: aman_second_stt"
  assert_not_contains "$main" "aman_second" "an instance never names another's networks"
  assert_not_contains "$second" "aman_main_"
  assert_not_contains "$(printf '%s\n' "$main" | sed -n '/^networks:/,$p')" "external: true" "no network is shared with other instances"
  assert_not_contains "$main" "aman_machine"
  assert_contains "$machine" "container_name: aman-stt"
  assert_log_has "network connect --alias aman-stt aman_main_stt aman-stt"
  assert_log_has "network connect --alias aman-stt aman_second_stt aman-stt"
  assert_eq "$(sort "$SB_STATE/network_links" | tr '\n' ',')" "aman_main_stt aman-stt,aman_second_stt aman-stt," "the speech service is the only thing joined to each"
  assert_eq "$(grep -c 'pull_policy: never' "$AMAN_HOME/instances/main/compose.yaml")" 2 "app and holder are never pulled"
  assert_contains "$machine" "pull_policy: never"
  assert_not_contains "$(sed -n '/^  dex:/,/^configs:/p' "$AMAN_HOME/instances/main/compose.yaml")" "pull_policy" "the login image is pulled by digest"
  run_install instance remove second
  assert_rc 0
  assert_log_has "network disconnect -f aman_second_stt aman-stt"
  assert_not_contains "$(cat "$SB_STATE/network_links")" "aman_second_stt"
  sandbox_drop
}

test_app_env_lacks_dex_only_values() {
  t_begin "the app's env file holds no password hash and the login container gets it from its own file"
  sandbox_new
  install_machine
  local compose
  compose=$(cat "$AMAN_HOME/instances/main/compose.yaml")
  assert_not_contains "$(cat "$AMAN_HOME/instances/main/.env")" "DEX_"
  assert_contains "$(sed -n '/^  dex:/,/^configs:/p' <<<"$compose")" "dex.env"
  assert_not_contains "$(sed -n '/^  app:/,/^  dex:/p' <<<"$compose")" "dex.env"
  assert_contains "$(cat "$AMAN_HOME/backups/"*/main/dex.env 2>/dev/null || { run_install backup; cat "$AMAN_HOME"/backups/*/main/dex.env; })" "DEX_USER_PASSWORD_HASH"
  sandbox_drop
}

test_dry_run_instance_add() {
  t_begin "instance add --dry-run reports the plan without writing"
  sandbox_new
  install_machine
  run_install instance add dry --dry-run --email dry@example.invalid
  assert_rc 0
  assert_contains "$OUT" "Would create instance dry"
  assert_no_path "$AMAN_HOME/state/instances/dry.conf"
  sandbox_drop
}

test_refresh_puts_back_lost_settings() {
  t_begin "instance refresh puts back each lost setting, changes no setting that is there, and keeps the file private"
  sandbox_new
  install_machine
  local env="$AMAN_HOME/instances/main/.env" keys key before after other
  keys=$(sed -n 's/^\([A-Z_]*\)=.*/\1/p' "$env")
  assert_contains "$keys" OIDC_CLIENT_SECRET
  for key in $keys; do
    before=$(cat "$env")
    grep -v "^$key=" "$env" >"$SB/env.cut"
    cat "$SB/env.cut" >"$env"
    run_install instance refresh main
    assert_rc 0
    assert_contains "$(cat "$env")" "$key=" "$key is back"
    assert_eq "$(grep -c "^$key=" "$env")" 1 "$key is there once"
    assert_mode "$env" 600
    after=$(cat "$env")
    for other in $keys; do
      [ "$other" = "$key" ] && continue
      assert_eq "$(printf '%s\n' "$after" | grep "^$other=")" "$(printf '%s\n' "$before" | grep "^$other=")" "$other is unchanged"
    done
    case "$key" in
      OIDC_CLIENT_SECRET | TRUEFORGE_API_KEY) ;;
      *) assert_eq "$(printf '%s\n' "$after" | grep "^$key=")" "$(printf '%s\n' "$before" | grep "^$key=")" "$key comes back as it was" ;;
    esac
  done
  sandbox_drop
}

test_refresh_leaves_a_complete_file_alone() {
  t_begin "instance refresh of an instance whose settings are all there rewrites none of them"
  sandbox_new
  install_machine
  local before
  before=$(cat "$AMAN_HOME/instances/main/.env")
  run_install instance refresh main
  assert_rc 0
  assert_eq "$(cat "$AMAN_HOME/instances/main/.env")" "$before"
  assert_not_contains "$OUT$ERR" "Put back"
  assert_eq "$(env_value main LOGIN_UPSTREAM_URL)" "" "an instance opened on this computer has no public sign-in address to limit"
  sandbox_drop
}

test_list_without_docker() {
  t_begin "list still shows registered instances when Docker is down"
  sandbox_new
  install_machine
  STUB_DOCKER_DOWN=1
  run_install instance list
  assert_rc 0
  assert_contains "$OUT" "main"
  assert_contains "$OUT" "unknown"
  sandbox_drop
}

test_dry_run_only_where_it_means_something() {
  t_begin "--dry-run is refused on commands it cannot honor"
  sandbox_new
  install_machine
  run_install backup --dry-run
  assert_rc 2
  run_install instance remove main --dry-run
  assert_rc 2
  assert_file "$AMAN_HOME/state/instances/main.conf"
  sandbox_drop
}

test_three_instances_never_share_values
test_refresh_puts_back_lost_settings
test_refresh_leaves_a_complete_file_alone
test_list_without_docker
test_dry_run_only_where_it_means_something
test_skips_ports_in_use
test_explicit_busy_port_is_refused
test_add_existing_is_idempotent
test_list
test_remove_keeps_volumes
test_instances_are_isolated_and_images_stay_local
test_app_env_lacks_dex_only_values
test_purge_after_remove_deletes_the_leftover_volumes
test_purge_failure_is_not_reported_as_success
test_purge_needs_typed_name
test_yes_does_not_bypass_purge_confirmation
test_name_validation
test_public_url_rules
test_url_validation
test_a_new_instance_points_to_settings_for_a_model
test_add_before_install_is_refused
test_dry_run_instance_add
tests_finish
