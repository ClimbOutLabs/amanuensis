# shellcheck shell=bash
# Https for an instance opened on the network, with a certificate from an authority made on this computer. Nothing here
# needs administrator rights or a package on the host: the authority and the certificate are made by Node.js inside the
# app image, and a pinned web front end in the instance's own project serves them.

# The ports the front end listens on inside the instance; the published ports are the instance's own.
TLS_HTTP_IN=8081
TLS_HTTPS_IN=8443

tls_dir() { printf '%s/tls' "$AMAN_HOME"; }
tls_ca_dir() { printf '%s/ca' "$(tls_dir)"; }
tls_leaf_dir() { printf '%s/leaf/%s' "$(tls_dir)" "$1"; }
tls_trust_dir() { printf '%s/trust/%s' "$(tls_dir)" "$1"; }
tls_image() { json_get "$PINS_FILE" caddy_image; }

# An instance is served over https when its record says so and it has a port for it.
tls_active() { [ "$(reg_get "$1" tls)" = local ] && [ -n "$(reg_get "$1" tls_port)" ]; }

# What a re-run wants for an instance opened on the network: the flag, else what it has, else https.
tls_target() { # name; prints local or off
  case "${OPT_TLS:-}" in
    local | off) printf '%s' "$OPT_TLS" ;;
    *)
      case "$(reg_get "$1" tls)" in
        local | off) reg_get "$1" tls ;;
        *) printf local ;;
      esac
      ;;
  esac
}

# Every host of an origin list, one per line, each once: the names the certificate must carry.
tls_names() {
  local origin host seen=' '
  while IFS= read -r origin; do
    host=$(origin_host "$origin")
    case "$seen" in *" $host "*) continue ;; esac
    seen="$seen$host "
    printf '%s\n' "$host"
  done < <(printf '%s\n' "$1" | tr ',' '\n')
}

# The app image's Node.js runs the authority script with only the tls folder visible and no network.
tls_node() { # app_image shell_command
  D run --rm --network none --user "$(id -u):$(id -g)" -v "$(tls_dir):/tls" -v "$INSTALLER_DIR/lib/pki.mjs:/pki.mjs:ro" \
    --entrypoint sh "$1" -c "$2"
}

# Makes the authority (once for this computer) and the certificate for the instance's addresses (again when they
# change or it is close to its end). Prints nothing; a failure is fatal because the instance would be unreachable.
tls_issue() { # name app_image
  local name=$1 names
  names=$(tls_names "$(reg_get "$name" origins)" | tr '\n' ' ')
  ensure_private_dir "$(tls_dir)"
  ensure_private_dir "$(tls_dir)/leaf"
  ensure_private_dir "$(tls_leaf_dir "$name")"
  # shellcheck disable=SC2086 # the names are checked hosts without spaces
  tls_node "$2" "node /pki.mjs ensure-ca /tls/ca && node /pki.mjs issue /tls/ca /tls/leaf/$name $names" >/dev/null ||
    die "The certificate for instance $name could not be made. Run: aman doctor tls --fix"
}

# The files a device downloads to trust this computer, and the page that explains it, next to the front end.
tls_publish_trust() { # name
  local name=$1 dir cert uuid open_url
  dir=$(tls_trust_dir "$name")
  cert="$(tls_ca_dir)/root.crt"
  [ -f "$cert" ] || return 0
  ensure_private_dir "$(tls_dir)/trust"
  ensure_private_dir "$dir"
  write_if_changed "$dir/ca.crt" 644 <"$cert" || true
  uuid=$(sha256_stdin <"$cert")
  render_template "$TEMPLATES_DIR/tls/aman.mobileconfig.tpl" \
    "CERT_BASE64=$(sed '/-----/d' "$cert" | tr -d '\n')" \
    "UUID_CERTIFICATE=$(uuid_from_hex "${uuid:0:32}")" "UUID_PROFILE=$(uuid_from_hex "${uuid:32:32}")" |
    write_if_changed "$dir/aman.mobileconfig" 644 || true
  open_url=$(tls_open_url "$name")
  render_template "$TEMPLATES_DIR/tls/trust.html.tpl" "OPEN_URL=$open_url" | write_if_changed "$dir/index.html" 644 || true
}

# 32 hex digits as a UUID.
uuid_from_hex() { printf '%s-%s-%s-%s-%s' "${1:0:8}" "${1:8:4}" "${1:12:4}" "${1:16:4}" "${1:20:12}"; }

# The https address people should open, the first address of this computer on the network.
tls_open_url() { # name
  local origin
  while IFS= read -r origin; do
    case "$origin" in https://*) printf '%s' "$origin"; return 0 ;; esac
  done < <(origins_display_order "$(reg_get "$1" origins)")
}

# The short link a device opens over plain http to trust this computer.
tls_trust_link() { # name
  local origin host
  origin=$(tls_open_url "$1")
  host=$(origin_host "$origin")
  printf 'http://%s:%s/trust' "$host" "$(reg_get "$1" app_port)"
}

# The instance's front end configuration.
tls_render_caddyfile() { # name
  local name=$1 names first
  names=$(tls_names "$(reg_get "$name" origins)")
  first=$(printf '%s\n' "$names" | head -n 1)
  render_template "$TEMPLATES_DIR/tls/Caddyfile.tpl" \
    "NAME=$name" "DEFAULT_NAME=$first" "HTTPS_IN=$TLS_HTTPS_IN" "HTTP_IN=$TLS_HTTP_IN" "HTTPS_PORT=$(reg_get "$name" tls_port)" |
    write_if_changed "$(instance_dir "$name")/tls.Caddyfile" 644 || true
}

# The front end's image is pulled by its pinned digest once; it is never built.
tls_image_ensure() {
  local image
  image=$(tls_image)
  docker_image_exists "$image" && return 0
  step_begin "pull-tls" "Downloading the https front end"
  D pull "$image" >"$STEP_LOG" 2>&1 || step_fail "The https front end could not be downloaded" "Check this computer's network access to registry-1.docker.io (install.sh --print-network lists every host), then run aman doctor tls --fix."
  step_ok "The https front end is downloaded"
}

# Issues the certificate again for every instance served over https where it is close to its end or its addresses
# changed, and restarts the front end of each that got a new one. Quiet when nothing is due.
tls_renew_all() { # app_image
  local name before after rc=0
  for name in $(reg_names); do
    tls_active "$name" || continue
    before=$(sha256_stdin <"$(tls_leaf_dir "$name")/leaf.crt" 2>/dev/null || true)
    tls_issue "$name" "$1" || { rc=1; continue; }
    after=$(sha256_stdin <"$(tls_leaf_dir "$name")/leaf.crt" 2>/dev/null || true)
    if [ "$before" != "$after" ]; then
      dc "$name" restart tls >/dev/null 2>&1 || rc=1
      log_event "instance $name certificate renewed"
    fi
  done
  return "$rc"
}

# install.sh tls: renews what is due and says so; the one repair behind aman doctor tls --fix.
cmd_tls() {
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  if tls_renew_all "$REL_APP_TAG"; then
    ui_ok "The https certificates are up to date"
  else
    die "A certificate could not be renewed."
  fi
}

# The link as a code a phone can scan, drawn in the terminal; only where colors and UTF-8 are on, since it is drawn with
# black and white blocks. Skipped quietly when the code cannot be made.
tls_print_qr() { # link
  local out
  [ "$UI_COLOR_1" = 1 ] && [ "$UI_UTF8" = 1 ] || return 0
  out=$(D run --rm --network none --user "$(id -u):$(id -g)" -v "$INSTALLER_DIR/lib/qr.mjs:/qr.mjs:ro" --entrypoint node "$REL_APP_TAG" /qr.mjs "$1" 2>/dev/null) || return 0
  [ -n "$out" ] || return 0
  _ui_out ""
  while IFS= read -r line; do
    _ui_out "  $line"
  done <<<"$out"
  _ui_out ""
}

# Everything the front end needs before the instance starts.
tls_prepare() { # name app_image
  tls_image_ensure
  tls_issue "$1" "$2"
  tls_render_caddyfile "$1"
  tls_publish_trust "$1"
}
