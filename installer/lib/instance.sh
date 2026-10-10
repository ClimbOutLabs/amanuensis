# shellcheck shell=bash
# Machine services and per-instance stacks: render, start, list, remove.

APP_EXPECTED_CONTAINERS=3

instance_dir() { printf '%s/%s' "$INSTANCES_DIR" "$1"; }

# Docker Compose for one instance project.
dc() {
  local name=$1 dir
  shift
  dir=$(instance_dir "$name")
  D compose --project-name "aman-$name" --project-directory "$dir" -f "$dir/compose.yaml" --env-file "$dir/.env" "$@"
}

dcm() {
  D compose --project-name aman-machine --project-directory "$MACHINE_DIR" -f "$MACHINE_DIR/compose.yaml" --env-file "$MACHINE_DIR/.env" "$@"
}

stt_threads() {
  local n
  n=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
  case "$n" in '' | *[!0-9]*) n=4 ;; esac
  if [ "$n" -gt 4 ]; then n=4; fi
  if [ "$n" -lt 1 ]; then n=1; fi
  printf '%s' "$n"
}

machine_render() {
  ensure_private_dir "$MACHINE_DIR"
  render_template "$TEMPLATES_DIR/machine/compose.yaml.tpl" "STT_IMAGE=$1" | write_if_changed "$MACHINE_DIR/compose.yaml" 644 || true
  if [ ! -f "$MACHINE_DIR/.env" ]; then
    render_template "$TEMPLATES_DIR/machine/env.tpl" "STT_THREADS=$(stt_threads)" | write_if_changed "$MACHINE_DIR/.env" 600 || true
  fi
}

# up -d is a no-op when nothing changed. The speech model loads in the background, so this does not wait on it.
machine_up() {
  machine_render "$1"
  dcm up -d || die "could not start the shared speech-to-text service"
}

machine_running() {
  [ -n "$(D ps -q --filter label=com.docker.compose.project=aman-machine --filter status=running 2>/dev/null || true)" ]
}

# Rewrites compose.yaml and dex.yaml from the registry and the given images. Both hold no secrets.
instance_render() {
  local name=$1 app_image=$2 dex_image=$3 dir app_port login_port public_url login_url email client_id
  dir=$(instance_dir "$name")
  app_port=$(reg_get "$name" app_port)
  login_port=$(reg_get "$name" login_port)
  public_url=$(reg_get "$name" public_url)
  login_url=$(reg_get "$name" login_url)
  email=$(reg_get "$name" owner_email)
  client_id=$(reg_get "$name" client_id)
  ensure_private_dir "$dir"
  render_template "$TEMPLATES_DIR/instance/compose.yaml.tpl" \
    "NAME=$name" "APP_IMAGE=$app_image" "DEX_IMAGE=$dex_image" "APP_PORT=$app_port" \
    "LOGIN_PORT=$login_port" "DEX_TELEMETRY_PORT=$DEX_TELEMETRY_PORT" | write_if_changed "$dir/compose.yaml" 644 || true
  render_template "$TEMPLATES_DIR/instance/dex.yaml.tpl" \
    "ISSUER=$login_url/dex" "LOGIN_PORT=$login_port" "DEX_TELEMETRY_PORT=$DEX_TELEMETRY_PORT" \
    "OWNER_EMAIL=$email" "CLIENT_ID=$client_id" "PUBLIC_URL=$public_url" | write_if_changed "$dir/dex.yaml" 644 || true
}

# running, partial or stopped, from the containers Compose labelled for the project.
instance_state() {
  local count
  count=$(D ps -q --filter "label=com.docker.compose.project=aman-$1" --filter status=running 2>/dev/null | wc -l | tr -d ' ' || true)
  count=${count:-0}
  if [ "$count" -ge "$APP_EXPECTED_CONTAINERS" ]; then
    echo running
  elif [ "$count" -gt 0 ]; then
    echo partial
  else
    echo stopped
  fi
}

instance_up() {
  local name=$1
  say "Starting instance $name and waiting for it to become healthy"
  if ! dc "$name" up -d --wait --wait-timeout 240; then
    warn "instance $name did not become healthy. Look at: docker compose -p aman-$name logs --tail 50"
    return 1
  fi
}

doctor_shim() { printf '%s/bin/amanuensis' "$AMAN_HOME"; }

install_doctor_shim() {
  local src="$INSTALLER_DIR/doctor/amanuensis"
  if [ ! -f "$src" ]; then
    warn "doctor shim not found at installer/doctor/amanuensis; doctor will be unavailable"
    return 0
  fi
  ensure_private_dir "$AMAN_HOME/bin"
  write_if_changed "$AMAN_HOME/bin/amanuensis" 755 <"$src" || true
}

# Runs the doctor shim with a time bound; prints nothing when it is not installed.
run_doctor() {
  [ -x "$(doctor_shim)" ] || return 127
  if command -v timeout >/dev/null 2>&1; then
    AMANUENSIS_HOME="$AMAN_HOME" timeout 60 "$(doctor_shim)" doctor "$@"
  else
    AMANUENSIS_HOME="$AMAN_HOME" "$(doctor_shim)" doctor "$@"
  fi
}

doctor_status() {
  local out
  [ -x "$(doctor_shim)" ] || {
    echo n/a
    return 0
  }
  out=$(run_doctor --json --instance "$1" 2>/dev/null || true)
  if printf '%s' "$out" | grep -Eq '"state"[[:space:]]*:[[:space:]]*"fail"'; then
    echo fail
  elif printf '%s' "$out" | grep -Eq '"state"[[:space:]]*:[[:space:]]*"warn"'; then
    echo warn
  elif [ -n "$out" ]; then
    echo ok
  else
    echo n/a
  fi
}

# ---- inputs -----------------------------------------------------------------------------------

# Fills I_* from flags and prompts. Plan-time calls (dry run) never prompt.
instance_collect() {
  local name_default=${1:-main}
  I_NAME=${OPT_NAME:-}
  I_EMAIL=${OPT_EMAIL:-}
  I_PUBLIC_URL=${OPT_PUBLIC_URL:-}
  I_LOGIN_URL=${OPT_LOGIN_URL:-}
  I_MODEL=${OPT_MODEL_ENDPOINT:-}
  ask I_NAME "Instance name" "$name_default"
  valid_name "$I_NAME" || usage_die "instance name must be 1-24 lowercase letters, digits or hyphens, start with a letter, and not be 'machine'"
  if [ "$DRY_RUN" = 1 ] && [ -z "$I_EMAIL" ]; then
    I_EMAIL="owner@example.invalid"
  fi
  ask I_EMAIL "Owner email" ""
  valid_email "$I_EMAIL" || usage_die "a valid owner email is required"
  ask I_PUBLIC_URL "Public https URL for the reverse proxy (empty keeps it local-only on loopback)" ""
  if [ -n "$I_PUBLIC_URL" ]; then
    valid_origin "$I_PUBLIC_URL" || usage_die "the public URL must be an origin such as https://aman.example.com with no path"
    case "$I_PUBLIC_URL" in https://*) ;; *) usage_die "a public URL must be https" ;; esac
    ask I_LOGIN_URL "Public https URL for the login service (its own origin, never a path)" ""
    valid_origin "$I_LOGIN_URL" || usage_die "the login URL must be an origin such as https://login.example.com with no path"
    case "$I_LOGIN_URL" in https://*) ;; *) usage_die "the login URL must be https" ;; esac
    [ "$I_LOGIN_URL" != "$I_PUBLIC_URL" ] || usage_die "the app and the login service need two different origins"
  elif [ -n "$I_LOGIN_URL" ]; then
    usage_die "--login-url needs --public-url"
  fi
  ask I_MODEL "Model server endpoint (optional, e.g. http://host.docker.internal:11434/v1)" ""
  if [ -n "$I_MODEL" ]; then
    printf '%s' "$I_MODEL" | grep -Eq '^https?://[A-Za-z0-9._:/-]+$' || usage_die "the model endpoint must be an http(s) URL"
  fi
}

# Picks ports and derives URLs. Read-only: nothing is written, so the plan can show the result.
instance_derive() {
  local reserved_app reserved_login all_reserved
  reserved_app=$(reg_all app_port)
  reserved_login=$(reg_all login_port)
  all_reserved="$reserved_app $reserved_login"
  if [ -n "${OPT_PORT:-}" ]; then
    check_port_usable "$OPT_PORT" "$all_reserved" "--port"
    I_PORT=$OPT_PORT
  else
    I_PORT=$(pick_port 8791 "$all_reserved") || die "no free loopback port found for the app near 8791"
  fi
  if [ -n "${OPT_LOGIN_PORT:-}" ]; then
    check_port_usable "$OPT_LOGIN_PORT" "$all_reserved $I_PORT" "--login-port"
    I_LOGIN_PORT=$OPT_LOGIN_PORT
  else
    I_LOGIN_PORT=$(pick_port 5556 "$all_reserved $I_PORT") || die "no free loopback port found for login near 5556"
  fi
  if [ -z "$I_PUBLIC_URL" ]; then
    I_PUBLIC_URL="http://127.0.0.1:$I_PORT"
    I_LOGIN_URL="http://127.0.0.1:$I_LOGIN_PORT"
  fi
  I_ISSUER="$I_LOGIN_URL/dex"
}

# An http issuer is only allowed on loopback; anything else must be https.
issuer_check() {
  case "$1" in
    https://*) ;;
    *) is_loopback_origin "${1%/dex}" || die "an http login issuer is only allowed on loopback; use an https URL" ;;
  esac
}

# ---- create / list / remove -------------------------------------------------------------------

instance_create() {
  local dir cookie client_id client_secret api_key hash created
  dir=$(instance_dir "$I_NAME")
  if reg_exists "$I_NAME"; then
    say "Instance $I_NAME already exists; making sure it is running"
    instance_render "$I_NAME" "$REL_APP_TAG" "$REL_DEX_IMAGE"
    instance_up "$I_NAME"
    return
  fi
  issuer_check "$I_ISSUER"
  rm -rf "$dir"
  ensure_private_dir "$dir"
  cookie=$(rand_hex 4)
  while printf '%s' " $(reg_all cookie_suffix) " | grep -Fq " $cookie "; do
    cookie=$(rand_hex 4)
  done
  client_id="amanuensis-$(rand_hex 4)"
  client_secret=$(rand_hex 32)
  api_key=$(rand_hex 32)
  hash=$(hash_password "$REL_APP_TAG")
  render_template "$TEMPLATES_DIR/instance/env.tpl" \
    "PUBLIC_URL=$I_PUBLIC_URL" "COOKIE_SUFFIX=$cookie" "ISSUER=$I_ISSUER" "CLIENT_ID=$client_id" \
    "CLIENT_SECRET=$client_secret" "OWNER_EMAIL=$I_EMAIL" "API_KEY=$api_key" "PASSWORD_HASH=$hash" |
    write_if_changed "$dir/.env" 600 || true
  created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  reg_write "$I_NAME" "name=$I_NAME" "app_port=$I_PORT" "login_port=$I_LOGIN_PORT" "public_url=$I_PUBLIC_URL" \
    "login_url=$I_LOGIN_URL" "owner_email=$I_EMAIL" "cookie_suffix=$cookie" "client_id=$client_id" \
    "model_endpoint=$I_MODEL" "created=$created"
  instance_render "$I_NAME" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  if docker_volume_exists "aman_${I_NAME}_data"; then
    warn "reusing the existing data volume aman_${I_NAME}_data from an earlier instance with this name"
  fi
  log_event "instance $I_NAME created"
  instance_up "$I_NAME"
}

print_proxy_requirements() {
  say "Requirements for your reverse proxy (nothing is configured for you):"
  say "  - One https origin for the app and a separate one for login. Never a path prefix."
  say "      $1  ->  forward to http://127.0.0.1:$2"
  say "      $3  ->  forward to http://127.0.0.1:$4"
  say "  - Forward the original Host header unchanged."
  say "  - Do not buffer responses: chat replies stream. Allow read timeouts of at least 10 minutes."
  say "  - Allow request bodies of at least 36 MiB."
  say "  - Containers on this machine must resolve both names and trust their certificates;"
  say "    the app contacts the login origin from inside its container."
}

print_instance_summary() {
  local name=$1
  say ""
  say "Instance $name"
  say "  Open:     $(reg_get "$name" public_url)"
  say "  Sign in:  $(reg_get "$name" owner_email) with the password you chose"
  say "  Login:    $(reg_get "$name" login_url)/dex"
  say "  Data:     Docker volumes aman_${name}_data and aman_${name}_dex"
  if is_loopback_origin "$(reg_get "$name" public_url)"; then
    say "  Use 127.0.0.1 in the browser, not localhost; the login redirect depends on the exact name."
    say "  To reach it from other devices later, see: install.sh --print-proxy-requirements"
  else
    print_proxy_requirements "$(reg_get "$name" public_url)" "$(reg_get "$name" app_port)" "$(reg_get "$name" login_url)" "$(reg_get "$name" login_port)"
  fi
  if [ -n "$(reg_get "$name" model_endpoint)" ]; then
    say "  Model:    enter $(reg_get "$name" model_endpoint) under Settings > Models"
  fi
  say "  Run code and attachment extraction are off in this version."
}

# Everything an installed machine already has: the recorded release and the shared network owner.
require_installed() {
  [ -f "$RELEASE_DIR/release.json" ] && [ -d "$MACHINE_DIR" ] ||
    die "this machine is not set up yet; run install.sh first"
}

load_installed_release() {
  release_load "$RELEASE_DIR/release.json" || die "the recorded release is unreadable; run install.sh again"
  REL_APP_TAG=$CUR_APP_TAG
  REL_STT_TAG=$CUR_STT_TAG
  REL_DEX_IMAGE=$CUR_DEX_IMAGE
  docker_image_exists "$REL_APP_TAG" || die "image $REL_APP_TAG is missing; run install.sh to rebuild it"
}

cmd_instance_add() {
  [ -n "${OPT_NAME:-}" ] || usage_die "usage: install.sh instance add <name> [--email ...]"
  valid_name "$OPT_NAME" || usage_die "instance name must be 1-24 lowercase letters, digits or hyphens, start with a letter, and not be 'machine'"
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  I_NAME=$OPT_NAME
  if reg_exists "$I_NAME"; then
    instance_create
    print_instance_summary "$I_NAME"
    return 0
  fi
  instance_collect "$OPT_NAME"
  instance_derive
  if [ "$DRY_RUN" = 1 ]; then
    say "Would create instance $I_NAME for $I_EMAIL: app $I_PUBLIC_URL (loopback port $I_PORT), login $I_LOGIN_URL (loopback port $I_LOGIN_PORT). Nothing was changed."
    return 0
  fi
  AMAN_PASSWORD=
  ask_password AMAN_PASSWORD
  machine_running || machine_up "$REL_STT_TAG"
  instance_create
  AMAN_PASSWORD=
  print_instance_summary "$I_NAME"
  print_signout_note
}

cmd_instance_list() {
  local name state
  if [ -z "$(reg_names)" ]; then
    say "No instances yet. Run install.sh or install.sh instance add <name>."
    return 0
  fi
  docker_plan_access
  case "$DOCKER_ACCESS" in
    direct | sg) AMAN_DOCKER_MODE=$DOCKER_ACCESS ;;
    *) warn "Docker is not reachable, so the states below are unknown" ;;
  esac
  printf '%-14s %-6s %-6s %-10s %-9s %-7s %s\n' NAME APP LOGIN STATE DOCTOR OWNER URL
  for name in $(reg_names); do
    state=unknown
    case "$DOCKER_ACCESS" in direct | sg) state=$(instance_state "$name") ;; esac
    printf '%-14s %-6s %-6s %-10s %-9s %-7s %s\n' "$name" "$(reg_get "$name" app_port)" "$(reg_get "$name" login_port)" \
      "$state" "$(doctor_status "$name")" "$(reg_get "$name" owner_email)" "$(reg_get "$name" public_url)"
  done
}

cmd_instance_remove() {
  local name=${OPT_NAME:-} typed=
  [ -n "$name" ] || usage_die "usage: install.sh instance remove <name> [--purge-data]"
  valid_name "$name" || usage_die "invalid instance name"
  if ! reg_exists "$name" && [ ! -d "$(instance_dir "$name")" ]; then
    say "Instance $name does not exist; nothing to do."
    return 0
  fi
  if [ "${OPT_PURGE:-0}" = 1 ]; then
    typed=${OPT_CONFIRM_NAME:-}
    if [ -z "$typed" ]; then
      printf 'This permanently deletes the data of instance %s. Type its name to confirm: ' "$name" >&2
      read -r typed || true
    fi
    [ "$typed" = "$name" ] || die "the typed name did not match; nothing was removed"
  fi
  docker_prepare
  lock_acquire
  if [ -f "$(instance_dir "$name")/compose.yaml" ] && [ -f "$(instance_dir "$name")/.env" ]; then
    dc "$name" down || warn "could not stop the stack cleanly; continuing with the removal"
  fi
  rm -rf "$(instance_dir "$name")"
  reg_remove "$name"
  log_event "instance $name removed"
  if [ "${OPT_PURGE:-0}" = 1 ]; then
    D volume rm -f "aman_${name}_data" "aman_${name}_dex" >/dev/null 2>&1 || true
    say "Removed instance $name and its data volumes."
  else
    say "Removed instance $name. Its data is kept in the volumes aman_${name}_data and aman_${name}_dex."
    say "To delete the data too: install.sh instance remove $name --purge-data"
  fi
}
