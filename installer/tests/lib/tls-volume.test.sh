#!/usr/bin/env bash
# The volume-backed branch of the instance compose template: on a PC whose state lives in the aman_home
# volume (Windows), the https folders are mounted from inside the volume, because a host folder the
# daemon could read does not exist there. Everywhere else the rendering is the host folder rendering,
# unchanged. The branch is rendered here through the installer's own template renderer, and the picker
# is asked against the stub Docker.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# Renders the instance compose template the way instance.sh does for an instance served over https,
# with the two branch flags set as the caller says.
render_compose() { # if_tls_host if_tls_volume
  (
    set -euo pipefail
    # shellcheck source=../../lib/common.sh
    . "$INSTALLER_DIR/lib/common.sh"
    # shellcheck source=../../lib/templates.sh
    . "$INSTALLER_DIR/lib/templates.sh"
    render_template "$INSTALLER_DIR/templates/instance/compose.yaml.tpl" \
      "NAME=main" "IF_CALENDAR=0" "CALENDAR_IMAGE=" "IF_EMAIL=0" "MAIL_EMAIL_IMAGE=" \
      "STT_NETWORK=aman_main_stt" "APP_IMAGE=aman-app:test" "DEX_IMAGE=dex:test" \
      "IF_SANDBOX=0" "IF_EDGE=0" "LOGIN_HOST=" "LOGIN_PORT=5556" "DEX_TELEMETRY_PORT=5557" \
      "APP_PORTS=      - '127.0.0.1:8791:8790'" \
      "IF_TLS=1" "IF_TLS_HOST=$1" "IF_TLS_VOLUME=$2" "CADDY_IMAGE=caddy:test" "TLS_USER=1000:1000" \
      "TLS_LEAF_DIR=/home/person/.amanuensis/tls/leaf/main" \
      "TLS_TRUST_DIR=/home/person/.amanuensis/tls/trust/main" "TLS_HTTP_IN=8081"
  )
}

# Asks the branch picker with a given home and a given answer from the stub Docker about the volume.
home_in_volume() { # home volume_present
  (
    set -euo pipefail
    # shellcheck source=../../lib/common.sh
    . "$INSTALLER_DIR/lib/common.sh"
    # shellcheck source=../../lib/docker.sh
    . "$INSTALLER_DIR/lib/docker.sh"
    # shellcheck source=../../lib/tls.sh
    . "$INSTALLER_DIR/lib/tls.sh"
    export PATH="$SB_BIN:/usr/bin:/bin"
    AMAN_HOME=$1
    if [ "$2" = 1 ]; then printf 'aman_home\n' >>"$STUB_STATE/volumes"; fi
    tls_home_in_volume
  )
}

# Removes the lines only one branch has, and every blank line, so the two renderings can be compared on
# everything else they share.
shared_lines() {
  grep -v -e "tls/leaf/main:/certs:ro" -e "tls/trust/main:/srv/trust:ro" \
    -e "- type: volume" -e "source: aman_home" -e "target: /certs" -e "target: /srv/trust" \
    -e "read_only: true" -e "^        volume:$" -e "subpath: tls/" \
    -e "The state volume itself" -e "The setup that put" -e "^  aman_home:$" -e "name: aman_home" \
    -e "external: true" -e "^$" || true
}

test_the_host_rendering_mounts_the_home_folders() {
  t_begin "with a folder home the https folders are mounted from the home folder, as before"
  sandbox_new
  local out
  out=$(render_compose 1 0)
  assert_contains "$out" "      - /home/person/.amanuensis/tls/leaf/main:/certs:ro"
  assert_contains "$out" "      - /home/person/.amanuensis/tls/trust/main:/srv/trust:ro"
  assert_not_contains "$out" "subpath" "no volume subpaths in a folder rendering"
  assert_not_contains "$out" "aman_home" "the state volume is not named in a folder rendering"
  sandbox_drop
}

test_the_volume_rendering_mounts_from_inside_the_volume() {
  t_begin "with a volume home the https folders are mounted from inside the state volume"
  sandbox_new
  local out
  out=$(render_compose 0 1)
  assert_contains "$out" "        source: aman_home"
  assert_contains "$out" "        target: /certs"
  assert_contains "$out" "          subpath: tls/leaf/main"
  assert_contains "$out" "        target: /srv/trust"
  assert_contains "$out" "          subpath: tls/trust/main"
  assert_contains "$out" "  aman_home:"
  assert_contains "$out" "    name: aman_home"
  assert_contains "$out" "    external: true"
  assert_not_contains "$out" ":/certs:ro" "no host folder mount for the certificate folder"
  assert_not_contains "$out" ":/srv/trust:ro" "no host folder mount for the trust folder"
  assert_not_contains "$out" "@@" "no unfilled placeholder"
  sandbox_drop
}

test_the_two_renderings_differ_only_in_the_branch() {
  t_begin "the volume rendering and the folder rendering are the same compose file outside the branch"
  sandbox_new
  local host_render volume_render
  host_render=$(render_compose 1 0)
  volume_render=$(render_compose 0 1)
  assert_eq "$(printf '%s\n' "$host_render" | shared_lines)" "$(printf '%s\n' "$volume_render" | shared_lines)" \
    "everything but the branch lines is identical"
  sandbox_drop
}

test_the_picker_takes_the_container_home_with_the_volume() {
  t_begin "the branch is picked for the container home when the state volume is there"
  sandbox_new
  if home_in_volume /root/.amanuensis 1; then t_pass; else t_fail "the container home with the volume is picked"; fi
  sandbox_drop
}

test_the_picker_refuses_the_container_home_without_the_volume() {
  t_begin "the branch is not picked for the container home when the state volume is not there"
  sandbox_new
  if home_in_volume /root/.amanuensis 0; then t_fail "no volume, no branch"; else t_pass; fi
  sandbox_drop
}

test_the_picker_refuses_a_folder_home_with_the_volume() {
  t_begin "the branch is not picked for a folder home even when the state volume is there"
  sandbox_new
  if home_in_volume "$SB/home" 1; then t_fail "a folder home keeps the folder branch"; else t_pass; fi
  sandbox_drop
}

test_the_host_rendering_mounts_the_home_folders
test_the_volume_rendering_mounts_from_inside_the_volume
test_the_two_renderings_differ_only_in_the_branch
test_the_picker_takes_the_container_home_with_the_volume
test_the_picker_refuses_the_container_home_without_the_volume
test_the_picker_refuses_a_folder_home_with_the_volume
tests_finish
