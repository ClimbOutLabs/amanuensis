# shellcheck shell=bash
# Machine services and per-instance stacks: render, start, list, remove.

APP_EXPECTED_CONTAINERS=3

instance_dir() { printf '%s/%s' "$INSTANCES_DIR" "$1"; }

# The only place an instance directory is deleted. The name must be valid and the resolved path a
# direct child of <home>/instances, so no name or symlink can point the deletion elsewhere.
remove_instance_dir() {
  local name=$1 dir parent resolved
  valid_name "$name" || die "refusing to remove an instance directory for an invalid name"
  dir=$(instance_dir "$name")
  if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then
    return 0
  fi
  [ ! -L "$dir" ] || die "refusing to remove $dir: it is a symbolic link"
  parent=$(cd -P -- "$INSTANCES_DIR" && pwd) || die "cannot resolve $INSTANCES_DIR"
  resolved=$(cd -P -- "$dir" && pwd) || die "cannot resolve $dir"
  [ "$resolved" = "$parent/$name" ] || die "refusing to remove $dir: it is not a direct child of $parent"
  rm -rf -- "$dir"
}

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
  local name
  machine_render "$1"
  dcm up -d || die "could not start the shared speech-to-text service"
  # A recreated speech container loses the extra networks it was connected to, so reconnect them all.
  for name in $(reg_names); do
    if D network inspect "aman_${name}_stt" >/dev/null 2>&1; then
      stt_attach "$name" || true
    fi
  done
}

# Each instance has its own network with only the speech service on it besides itself. The shared
# service is connected to every one of those networks, so no instance has a route to another.
stt_attach() {
  local out
  if out=$(D network connect --alias aman-stt "aman_${1}_stt" aman-stt 2>&1); then
    return 0
  fi
  case "$out" in
    *"already exists"*) return 0 ;;
  esac
  warn "could not connect the speech-to-text service to instance $1: $out"
  return 1
}

stt_detach() {
  D network disconnect -f "aman_${1}_stt" aman-stt >/dev/null 2>&1 || true
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
  if machine_running; then
    stt_attach "$name" || true
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
  local bound=()
  [ -x "$(doctor_shim)" ] || return 127
  if command -v timeout >/dev/null 2>&1; then
    bound=(timeout 60)
  fi
  # Same Docker access as the rest of the run (direct, sg or sudo), so a fresh docker group member
  # does not get a failing report for a problem the run itself worked around.
  as_docker_user env "AMANUENSIS_HOME=$AMAN_HOME" "HOME=$HOME" ${bound[@]+"${bound[@]}"} "$(doctor_shim)" doctor "$@"
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
  ask I_PUBLIC_URL "Address you will use from other devices (press Enter to use this computer only)" ""
  if [ -n "$I_PUBLIC_URL" ]; then
    valid_origin "$I_PUBLIC_URL" || usage_die "the public URL must be an origin such as https://aman.example.com with no path"
    case "$I_PUBLIC_URL" in https://*) ;; *) usage_die "a public URL must be https" ;; esac
    ask I_LOGIN_URL "Address for the sign-in service (its own https address, never a path of the first one)" ""
    valid_origin "$I_LOGIN_URL" || usage_die "the login URL must be an origin such as https://login.example.com with no path"
    case "$I_LOGIN_URL" in https://*) ;; *) usage_die "the login URL must be https" ;; esac
    [ "$I_LOGIN_URL" != "$I_PUBLIC_URL" ] || usage_die "the app and the login service need two different origins"
  elif [ -n "$I_LOGIN_URL" ]; then
    usage_die "--login-url needs --public-url"
  fi
  ask I_MODEL "Model server address (optional; for one on this computer, for example http://host.docker.internal:11434/v1)" ""
  if [ -n "$I_MODEL" ]; then
    valid_model_endpoint "$I_MODEL" || usage_die "the model server address must be an http(s) URL"
    if matches_whole "$I_MODEL" '^https?://(localhost|127\.0\.0\.1|\[::1\])([:/].*)?$'; then
      warn "inside the app, localhost is the app itself, so it cannot reach a model server there. Use host.docker.internal instead of localhost."
    fi
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
    I_PORT=$(pick_port 8791 "$all_reserved") || die "no free port found on this computer for the app near 8791"
  fi
  if [ -n "${OPT_LOGIN_PORT:-}" ]; then
    check_port_usable "$OPT_LOGIN_PORT" "$all_reserved $I_PORT" "--login-port"
    I_LOGIN_PORT=$OPT_LOGIN_PORT
  else
    I_LOGIN_PORT=$(pick_port 5556 "$all_reserved $I_PORT") || die "no free port found on this computer for sign-in near 5556"
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
    *) is_loopback_origin "${1%/dex}" || die "a sign-in address without https is only allowed on this computer; use an https address" ;;
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
  remove_instance_dir "$I_NAME"
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
    "CLIENT_SECRET=$client_secret" "OWNER_EMAIL=$I_EMAIL" "API_KEY=$api_key" |
    write_if_changed "$dir/.env" 600 || true
  render_template "$TEMPLATES_DIR/instance/dex.env.tpl" "PASSWORD_HASH=$hash" | write_if_changed "$dir/dex.env" 600 || true
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

# With --password-stdin the password is the first line of stdin, read before any prompt can take it.
read_password_first() {
  if [ "$PASSWORD_FROM_STDIN" = 1 ] && [ "$DRY_RUN" != 1 ]; then
    ask_password AMAN_PASSWORD
  fi
}

# Next step for the model server. Generic on purpose: no product is named.
print_model_hint() {
  if [ -n "$1" ]; then
    say "  Model:    open Settings > Models and enter $1"
  else
    say "  Model:    not set yet. Next step: open Settings > Models and add your model server address or a provider key."
  fi
  say "            A model server running on this computer must listen on more than 127.0.0.1 to be reachable"
  say "            from the app, which sees this computer as host.docker.internal. Make it listen on all addresses"
  say "            (or on the Docker bridge address), then use http://host.docker.internal:<its port>/v1."
}

print_instance_summary() {
  local name=$1
  say ""
  say "Instance $name"
  say "  Open:     $(reg_get "$name" public_url)"
  say "  Sign in:  $(reg_get "$name" owner_email) with the password you chose"
  say "  Sign-in service (used by the app automatically, not a page to open): $(reg_get "$name" login_url)/dex"
  say "  Data:     Docker volumes aman_${name}_data and aman_${name}_dex"
  if is_loopback_origin "$(reg_get "$name" public_url)"; then
    say "  Use 127.0.0.1 in the browser, not localhost; sign-in depends on the exact name."
    say "  To reach it from other devices later, see: install.sh --print-proxy-requirements"
  else
    print_proxy_requirements "$(reg_get "$name" public_url)" "$(reg_get "$name" app_port)" "$(reg_get "$name" login_url)" "$(reg_get "$name" login_port)"
  fi
  print_model_hint "$(reg_get "$name" model_endpoint)"
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
  AMAN_PASSWORD=
  read_password_first
  instance_collect "$OPT_NAME"
  instance_derive
  if [ "$DRY_RUN" = 1 ]; then
    say "Would create instance $I_NAME for $I_EMAIL: app at $I_PUBLIC_URL (port $I_PORT on this computer), sign-in service port $I_LOGIN_PORT. Nothing was changed."
    return 0
  fi
  [ -n "$AMAN_PASSWORD" ] || ask_password AMAN_PASSWORD
  machine_running || machine_up "$REL_STT_TAG"
  instance_create
  AMAN_PASSWORD=
  print_instance_summary "$I_NAME"
  print_signout_note
}

# Pads tab-separated columns to the widest cell of each, so long names and addresses stay aligned.
align_columns() {
  awk -F'\t' '
    { rows[NR] = $0; for (i = 1; i <= NF; i++) if (length($i) > w[i]) w[i] = length($i); if (NF > n) n = NF }
    END {
      for (r = 1; r <= NR; r++) {
        split(rows[r], cell, "\t"); line = ""
        for (i = 1; i <= n; i++) line = line (i < n ? sprintf("%-" w[i] "s  ", cell[i]) : cell[i])
        print line
      }
    }'
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
  {
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' NAME 'APP PORT' 'SIGN-IN PORT' STATE DOCTOR OWNER ADDRESS
    for name in $(reg_names); do
      state=unknown
      case "$DOCKER_ACCESS" in direct | sg) state=$(instance_state "$name") ;; esac
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$(reg_get "$name" app_port)" "$(reg_get "$name" login_port)" \
        "$state" "$(doctor_status "$name")" "$(reg_get "$name" owner_email)" "$(reg_get "$name" public_url)"
    done
  } | align_columns
}

# Volumes that belong to an instance: those labelled for it plus the two it is named after.
instance_volumes() {
  local name=$1 volume
  {
    D volume ls -q --filter "label=com.amanuensis.instance=$name" 2>/dev/null || true
    for volume in "aman_${name}_data" "aman_${name}_dex"; do
      if docker_volume_exists "$volume"; then
        printf '%s\n' "$volume"
      fi
    done
  } | sort -u
}

# Deletes the given volumes. Every failure is reported and the return code says so.
volumes_purge() {
  local volume failed=
  for volume in "$@"; do
    if ! D volume rm "$volume" >/dev/null 2>&1; then
      failed="$failed $volume"
    fi
  done
  if [ -n "$failed" ]; then
    warn "could not delete the volumes:$failed. Something may still be using them; check docker ps -a, then run the purge again."
    return 1
  fi
}

# Read-only use of Docker for leftovers of an instance that is already gone; no prompts, no sudo.
docker_reach_quietly() {
  docker_plan_access
  case "$DOCKER_ACCESS" in
    direct | sg) AMAN_DOCKER_MODE=$DOCKER_ACCESS ;;
    *) return 1 ;;
  esac
}

confirm_purge_name() {
  local name=$1 typed=${OPT_CONFIRM_NAME:-}
  if [ -z "$typed" ]; then
    printf 'This permanently deletes the data of instance %s. Type its name to confirm: ' "$name" >&2
    read -r typed || true
  fi
  [ "$typed" = "$name" ] || die "the typed name did not match; nothing was removed"
}

cmd_instance_remove() {
  local name=${OPT_NAME:-} exists=0 volumes purge_list
  [ -n "$name" ] || usage_die "usage: install.sh instance remove <name> [--purge-data]"
  valid_name "$name" || usage_die "invalid instance name"
  if reg_exists "$name" || [ -d "$(instance_dir "$name")" ]; then
    exists=1
  fi
  if [ "$exists" = 0 ]; then
    volumes=
    if docker_reach_quietly; then
      volumes=$(instance_volumes "$name" | tr '\n' ' ')
    fi
    if [ -z "${volumes// /}" ]; then
      say "Instance $name does not exist; nothing to do."
      return 0
    fi
    if [ "${OPT_PURGE:-0}" != 1 ]; then
      say "Instance $name is already removed, but its data is still in the volumes: $volumes"
      say "To delete the data: install.sh instance remove $name --purge-data"
      return 0
    fi
  fi
  if [ "${OPT_PURGE:-0}" = 1 ]; then
    confirm_purge_name "$name"
  fi
  docker_prepare
  lock_acquire
  if [ "$exists" = 1 ]; then
    if [ -f "$(instance_dir "$name")/compose.yaml" ] && [ -f "$(instance_dir "$name")/.env" ]; then
      stt_detach "$name"
      dc "$name" down || warn "could not stop the stack cleanly; continuing with the removal"
    fi
    remove_instance_dir "$name"
    reg_remove "$name"
    log_event "instance $name removed"
  fi
  if [ "${OPT_PURGE:-0}" = 1 ]; then
    volumes=$(instance_volumes "$name" | tr '\n' ' ')
    if [ -z "${volumes// /}" ]; then
      say "Removed instance $name. It had no data volumes left to delete."
      return 0
    fi
    read -r -a purge_list <<<"$volumes"
    volumes_purge "${purge_list[@]}" || exit 1
    log_event "instance $name purged"
    say "Removed instance $name and deleted its data volumes: $volumes"
  else
    say "Removed instance $name. Its data is kept in the volumes aman_${name}_data and aman_${name}_dex."
    say "To delete the data too: install.sh instance remove $name --purge-data"
  fi
}
