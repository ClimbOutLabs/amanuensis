#!/usr/bin/env bash
# What the installer writes must be what the real doctor shim and the in-image CLI read.
set -euo pipefail
# shellcheck source=helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

# Runs the real doctor shim the way the installer does, against the state an install just wrote.
real_doctor() {
  AMANUENSIS_HOME="$AMAN_HOME" PATH="$SB_BIN" bash "$INSTALLER_DIR/doctor/aman" doctor "$@"
}

test_doctor_reads_what_the_installer_wrote() {
  t_begin "the real doctor shim finds the instance, its app container and the release images"
  sandbox_new
  install_machine
  local out rc=0
  out=$(real_doctor --json --instance main) || rc=$?
  assert_eq "$rc" 0 "doctor exit code on a fresh install"
  assert_contains "$out" '"instances":{"main":[' "instance discovered under instances/"
  assert_contains "$out" '"id":"images","state":"ok","detail":"All 3 images are present' "app_image, dex_image and stt_image read from release.json"
  assert_contains "$out" '"id":"config","state":"ok"' ".env mode 0600 accepted"
  assert_contains "$out" '"id":"containers","state":"ok","detail":"All 3 containers are running.'
  assert_contains "$out" '"id":"backup","state":"ok","detail":"No backup yet' "a fresh install is not warned about backups"
  assert_log_has "docker ps -a --filter label=com.docker.compose.project=aman-main"
  assert_log_has "aman doctor --text"
  assert_log_has "docker exec -e AMAN_HOST_EPOCH="
  assert_no_path "$AMAN_HOME/backups"
  sandbox_drop
}

test_installer_calls_the_shim_as_documented() {
  t_begin "the installer installs bin/aman and calls 'doctor --json --instance NAME'"
  sandbox_new
  install_machine
  assert_file "$AMAN_HOME/bin/aman"
  assert_mode "$AMAN_HOME/bin/aman" 755
  assert_eq "$(cmp -s "$AMAN_HOME/bin/aman" "$SB_INSTALLER/doctor/aman" && echo same)" same
  run_install instance list
  assert_rc 0
  assert_log_has "doctor --json --instance main"
  assert_eq "$(basename "$INSTALLER_DIR/doctor/aman")" aman "the shipped shim carries the name the installer looks for"
  assert_eq "$([ -x "$INSTALLER_DIR/doctor/aman" ] && echo yes)" yes "the shipped shim is executable"
  sandbox_drop
}

test_doctor_sandbox_reads_what_the_installer_wrote() {
  t_begin "the real 'doctor sandbox' finds the setup copy, the checkout and the wired instance the installer left"
  sandbox_new
  install_machine
  local out rc=0
  out=$(real_doctor sandbox) || rc=$?
  assert_eq "$rc" 0 "doctor sandbox exit code right after an install"
  assert_contains "$out" "Instance main"
  assert_log_has "node $AMAN_HOME/bin/aman-sandbox.mjs --instance main --repo-root $REPO"
  assert_log_has "--command-name $AMAN_HOME/bin/aman doctor sandbox --check"
  assert_log_has "aman doctor --text --only run_code"
  sandbox_drop
}

test_doctor_sandbox_fix_uses_the_same_entry() {
  t_begin "'doctor sandbox --fix' runs the same setup copy with --fix --restart"
  sandbox_new
  install_machine
  local rc=0
  real_doctor sandbox --fix --yes >/dev/null || rc=$?
  assert_eq "$rc" 0
  assert_log_has "--fix --restart --yes"
  sandbox_drop
}

test_layout_and_release_record() {
  t_begin "instances/<name>/ and release/release.json have the shape the doctor reads"
  sandbox_new
  install_machine
  local dir=$AMAN_HOME/instances/main release
  assert_file "$dir/compose.yaml"
  assert_file "$dir/.env"
  assert_file "$dir/dex.yaml"
  assert_eq "$(find "$AMAN_HOME/instances" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" 1 "exactly one directory per instance"
  release=$(cat "$AMAN_HOME/release/release.json")
  assert_contains "$release" '"app_image": "aman-app:'
  assert_contains "$release" '"stt_image": "aman-stt:'
  assert_contains "$release" "\"dex_image\": \"$(sed -n 's/.*"dex_image"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALLER_DIR/release.json")\""
  assert_mode "$AMAN_HOME/release/release.json" 600
  sandbox_drop
}

test_compose_service_and_project_names() {
  t_begin "the Compose project is aman-<name> and the app service is named app"
  sandbox_new
  install_machine
  local services
  services=$(awk '/^services:/ {in_s=1; next} /^[^ #]/ {in_s=0} in_s && /^  [a-z][a-z-]*:/ {sub(/:.*/, ""); gsub(/ /, ""); print}' "$AMAN_HOME/instances/main/compose.yaml" | tr '\n' ' ')
  assert_contains "$services" "app "
  assert_contains "$(head -n 3 "$AMAN_HOME/instances/main/compose.yaml")" "name: aman-main"
  assert_log_has "compose --project-name aman-main"
  sandbox_drop
}

test_public_base_url_is_the_host_facing_origin() {
  t_begin "PUBLIC_BASE_URL names the loopback host port, not the container port, when no public URL is given"
  sandbox_new
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --port 18790 --login-port 15556
  clear_input
  assert_rc 0
  local env
  env=$(cat "$AMAN_HOME/instances/main/.env")
  assert_contains "$env" "PORT=8790"
  assert_contains "$env" "PUBLIC_BASE_URL=http://127.0.0.1:18790"
  assert_contains "$env" "OIDC_ISSUER_URL=http://127.0.0.1:15556/dex"
  assert_contains "$(cat "$AMAN_HOME/instances/main/compose.yaml")" "127.0.0.1:18790:8790"
  assert_contains "$(cat "$AMAN_HOME/instances/main/dex.yaml")" "http://127.0.0.1:18790/api/v1/auth/callback"
  sandbox_drop
}

test_token_factory_settings_match_the_server() {
  t_begin "the installer writes the default model and the setting names the server reads"
  local repo=$INSTALLER_DIR/.. defaults config key
  defaults=$(sed -n "s/^export const DEFAULT_TOKEN_FACTORY_MODEL = '\(.*\)';/\1/p" "$repo/packages/trueforge/src/runtime/tokenFactoryDefaults.ts")
  assert_eq "$(sed -n 's/^TF_DEFAULT_MODEL=//p' "$INSTALLER_DIR/lib/tokenfactory.sh")" "$defaults" "default model"
  config=$(cat "$repo/packages/trueforge/src/config.ts")
  for key in NEBIUS_API_KEY TOKEN_FACTORY_MODEL TOKEN_FACTORY_DAILY_TOKEN_CAP; do
    assert_contains "$config" "getEnv('$key'" "the server reads $key"
    assert_contains "$(cat "$INSTALLER_DIR/templates/instance/env.tpl")" "$key=" "the installer writes $key"
  done
}

test_sign_in_settings_match_the_server() {
  t_begin "the installer writes the sign-in settings the server reads, and the doctor counts what add-user wrote"
  local repo=$INSTALLER_DIR/.. config key out
  config=$(cat "$repo/packages/trueforge/src/config.ts")
  for key in OIDC_ALLOWED_EMAILS OIDC_ADMIN_ROLE_VALUE OIDC_USER_ROLE_CLAIM OIDC_USER_REFERENCE_CLAIM; do
    assert_contains "$config" "getEnv('$key'" "the server reads $key"
    assert_contains "$(cat "$INSTALLER_DIR/templates/instance/env.tpl")" "$key=" "the installer writes $key"
  done
  sandbox_new
  install_machine
  run_install instance add-user judge1 --email judge1@demo.invalid
  assert_rc 0
  out=$(real_doctor --json --instance main) || true
  assert_contains "$out" '"id":"config","state":"ok","detail":"The settings files exist and are private to you. 2 sign-in user(s): the owner and 1 member(s)."'
  assert_not_contains "$out" "\$2a"
  sandbox_drop
}

test_image_keeps_app_data_on_the_data_volume() {
  t_begin "the image has no home for its runtime user, so the app data dir is set and sits on the volume the instance mounts at /data"
  local repo=$INSTALLER_DIR/.. dockerfile
  dockerfile=$(cat "$repo/Dockerfile.dev")
  assert_contains "$dockerfile" "USER 10001:10001" "the app runs as the non-root user"
  assert_not_contains "$dockerfile" "useradd --create-home" "the runtime user gets no home"
  assert_contains "$dockerfile" "APP_DATA_DIR=/data/app" "the app data dir is under /data"
  assert_contains "$dockerfile" "mkdir -p /data/memory /data/persona-knowledge /data/app" "the dir exists and is owned by the runtime user"
  assert_contains "$(cat "$repo/packages/trueforge/src/config.ts")" "'APP_DATA_DIR'" "the server reads APP_DATA_DIR"
  assert_contains "$(cat "$INSTALLER_DIR/templates/instance/compose.yaml.tpl")" "      - data:/data" "the instance mounts its data volume at /data"
}

test_in_image_check_ids_match() {
  t_begin "every check the shim relays from the app container is one the app's doctor knows"
  local repo=$INSTALLER_DIR/.. ids id known
  ids=$(sed -n 's/^IN_IMAGE_IDS="\(.*\)"/\1/p' "$INSTALLER_DIR/doctor/aman")
  known=$(awk '/^export const INSTANCE_CHECK_IDS = \[/ {on = 1} on {print} /\] as const;/ {on = 0}' "$repo/packages/trueforge/src/cli/doctor/run.ts" | tr -d "' ,")
  for id in $ids; do
    assert_contains "$known" "$id" "$id is an app check"
  done
}

test_token_factory_settings_match_the_server
test_sign_in_settings_match_the_server
test_image_keeps_app_data_on_the_data_volume
test_in_image_check_ids_match
test_doctor_reads_what_the_installer_wrote
test_installer_calls_the_shim_as_documented
test_doctor_sandbox_reads_what_the_installer_wrote
test_doctor_sandbox_fix_uses_the_same_entry
test_layout_and_release_record
test_compose_service_and_project_names
test_public_base_url_is_the_host_facing_origin
tests_finish
