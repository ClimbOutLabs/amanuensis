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
  local name rc=0
  machine_render "$1"
  step_begin start-machine "Starting the shared speech-to-text service"
  dcm up -d >"$STEP_LOG" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    step_fail "The shared speech-to-text service could not start" "Run install.sh again once the cause in the log is fixed."
  fi
  step_ok "Shared speech-to-text service is running"
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

# Rewrites compose.yaml and dex.yaml from the registry (owner and added users) and the given images. Both hold no secrets.
instance_render() {
  local name=$1 app_image=$2 dex_image=$3 dir app_port login_port public_url login_url email client_id sandbox_on edge_on login_host members members_on=0 network_on=0 bind=127.0.0.1:
  dir=$(instance_dir "$name")
  app_port=$(reg_get "$name" app_port)
  login_port=$(reg_get "$name" login_port)
  public_url=$(reg_get "$name" public_url)
  login_url=$(reg_get "$name" login_url)
  email=$(reg_get "$name" owner_email)
  client_id=$(reg_get "$name" client_id)
  if instance_sandbox_wanted "$name"; then sandbox_on=1; else sandbox_on=0; fi
  # An instance opened on the network publishes its ports on every interface; any other stays on 127.0.0.1.
  if [ "$(reg_get "$name" network)" = 1 ]; then
    network_on=1
    bind=
  fi
  edge_on=0
  login_host=
  if edge_wanted "$name"; then
    edge_on=1
    login_host=$(edge_host "$login_url")
  fi
  ensure_private_dir "$dir"
  render_template "$TEMPLATES_DIR/instance/compose.yaml.tpl" \
    "NAME=$name" "APP_IMAGE=$app_image" "DEX_IMAGE=$dex_image" "APP_PORT=$app_port" "IF_SANDBOX=$sandbox_on" \
    "IF_EDGE=$edge_on" "LOGIN_HOST=$login_host" \
    "LOGIN_PORT=$login_port" "DEX_TELEMETRY_PORT=$DEX_TELEMETRY_PORT" "BIND=$bind" | write_if_changed "$dir/compose.yaml" 644 || true
  if [ "$edge_on" = 1 ]; then edge_render "$name"; fi
  members=$(dex_members_yaml "$name")
  if [ -n "$members" ]; then members_on=1; fi
  render_template "$TEMPLATES_DIR/instance/dex.yaml.tpl" \
    "ISSUER=$login_url/dex" "LOGIN_PORT=$login_port" "DEX_TELEMETRY_PORT=$DEX_TELEMETRY_PORT" \
    "OWNER_EMAIL=$email" "CLIENT_ID=$client_id" "PUBLIC_URL=$public_url" "APP_PORT=$app_port" "IF_NETWORK=$network_on" \
    "IF_MEMBERS=$members_on" "MEMBER_USERS=$members" | write_if_changed "$dir/dex.yaml" 644 || true
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
  local name=$1 rc=0 recreate=()
  if [ "${2:-}" = recreate ]; then recreate=(--force-recreate); fi
  step_begin "start-$name" "Starting instance $name and waiting for it to be healthy"
  dc "$name" up -d ${recreate[@]+"${recreate[@]}"} --wait --wait-timeout 240 >"$STEP_LOG" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    instance_unhealthy "$name"
    return 1
  fi
  if machine_running; then
    stt_attach "$name" || true
  fi
  # From now on the instance may hold data worth backing up; an instance that never got here holds none.
  if reg_exists "$name"; then reg_set "$name" healthy 1; fi
  step_ok "Instance $name is running and healthy"
}

# False only for an instance that was created and never became healthy; a record from before this was kept counts as
# one that did, since its data must not be skipped.
instance_ever_healthy() { [ "$(reg_get "$1" healthy)" != 0 ]; }

# Saves the last 200 lines of every container of an instance and prints the cause in one plain sentence. The person
# is never sent to read container logs; a cause the installer does not know is called a bug and the saved log named.
instance_unhealthy() {
  local name=$1 log id cause fix=
  log="$STATE_DIR/logs/instance-$name.log"
  {
    cat "$STEP_LOG"
    for id in $(D ps -a -q --filter "label=com.docker.compose.project=aman-$name" 2>/dev/null || true); do
      printf '\n== container %s (%s)\n' "$(D inspect --format '{{.Name}}' "$id" 2>/dev/null || true)" "$(D inspect --format '{{.State.Status}} exit {{.State.ExitCode}} oom {{.State.OOMKilled}}' "$id" 2>/dev/null || true)"
      D logs --tail 200 "$id" 2>&1 || true
    done
  } >"$log" 2>&1
  cause=$(container_failure_cause "$log")
  if [ -n "$cause" ] && [ "$(container_failure_kind "$log")" = bug ]; then
    UI_FD=2 ui_step_end fail "Instance $name did not start. $cause" "Update Aman and run install.sh again. If it fails the same way, share the saved log below."
  elif [ -n "$cause" ]; then
    UI_FD=2 ui_step_end fail "Instance $name did not start. $cause" "Fix that, then run install.sh again."
  else
    UI_FD=2 ui_step_end fail "Instance $name did not become healthy, and the cause is not one the installer knows. This looks like a bug in Aman." "Run install.sh again; if it fails the same way, share the log below."
  fi
  UI_FD=2 ui_hint "Last 200 log lines: $(ui_path "$log")"
  return 0
}

doctor_shim() { printf '%s/bin/aman' "$AMAN_HOME"; }

# The doctor reads the checkout the compose files, the image build context and this installer come from.
record_source_checkout() {
  ensure_private_dir "$STATE_DIR"
  printf '%s\n' "$REPO_ROOT" | write_if_changed "$STATE_DIR/source" 600 || true
}

# The shim finds its display and diagnosis helpers at ../lib next to its folder, here and in a checkout alike.
install_doctor_shim() {
  local src="$INSTALLER_DIR/doctor/aman" lib
  if [ ! -f "$src" ]; then
    warn "The doctor command was not found in the installer, so it will be unavailable."
    return 0
  fi
  ensure_private_dir "$AMAN_HOME/bin"
  ensure_private_dir "$AMAN_HOME/lib"
  write_if_changed "$AMAN_HOME/bin/aman" 755 <"$src" || true
  for lib in ui diagnose; do
    write_if_changed "$AMAN_HOME/lib/$lib.sh" 644 <"$INSTALLER_DIR/lib/$lib.sh" || true
  done
  record_source_checkout
}

# Runs the doctor shim with a time bound; prints nothing when it is not installed.
run_doctor() {
  local bound=()
  [ -x "$(doctor_shim)" ] || return 127
  if command -v timeout >/dev/null 2>&1; then
    bound=(timeout "${DOCTOR_TIMEOUT:-60}")
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
  out=$(run_doctor --json --instance "$1" --local 2>/dev/null || true)
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

# Fills I_* from flags and prompts. Plan-time calls (dry run) never prompt. Which address the app answers at is
# decided by flags only; there is no question about it.
instance_collect() {
  local name_default=${1:-main}
  I_NAME=${OPT_NAME:-}
  I_EMAIL=${OPT_EMAIL:-}
  I_PUBLIC_URL=${OPT_PUBLIC_URL:-}
  I_LOGIN_URL=${OPT_LOGIN_URL:-}
  I_TLS=${OPT_TLS:-}
  I_SANDBOX=slots
  if [ "$OPT_NO_SANDBOX" = 1 ]; then I_SANDBOX=off; fi
  ask_valid I_NAME "Instance name (a-z, 0-9, hyphen; starts with a letter)" "$name_default" "Each person or team gets one instance. Example: main" name_problem
  if [ "$DRY_RUN" = 1 ] && [ -z "$I_EMAIL" ]; then
    I_EMAIL="owner@example.invalid"
  fi
  ask_valid I_EMAIL "Your email, used to sign in" "" "Example: you@example.com" email_problem
  if [ -n "$I_PUBLIC_URL" ]; then
    valid_origin "$I_PUBLIC_URL" || usage_die "The public URL must be an origin such as https://aman.example.com, with no path."
    case "$I_PUBLIC_URL" in https://*) ;; *) usage_die "A public URL must be https." ;; esac
    [ -n "$I_LOGIN_URL" ] || usage_die "--public-url needs --login-url, the sign-in service's own https address (never a path of the first one)."
    valid_origin "$I_LOGIN_URL" || usage_die "The login URL must be an origin such as https://login.example.com, with no path."
    case "$I_LOGIN_URL" in https://*) ;; *) usage_die "The login URL must be https." ;; esac
    [ "$I_LOGIN_URL" != "$I_PUBLIC_URL" ] || usage_die "The app and the login service need two different origins."
  elif [ -n "$I_LOGIN_URL" ]; then
    usage_die "--login-url needs --public-url."
  fi
  instance_collect_tls
  instance_collect_token_factory
  ui_ok "Instance $I_NAME for $I_EMAIL"
}

# --tls caddy serves the two public origins on 443 under DNS names Let's Encrypt can issue for.
instance_collect_tls() {
  case "$I_TLS" in
    '') return 0 ;;
    caddy) ;;
    *) usage_die "--tls takes caddy" ;;
  esac
  [ -n "$I_PUBLIC_URL" ] || usage_die "--tls caddy needs --public-url and --login-url (the two https addresses Caddy will serve)"
  [ -z "$OPT_PUBLIC_IP" ] || valid_ipv4 "$OPT_PUBLIC_IP" || usage_die "--public-ip must be an IPv4 address"
  valid_edge_host "$(edge_host "$I_PUBLIC_URL")" || usage_die "--tls caddy serves port 443 under a DNS name: the public address cannot carry a port or be an IP address"
  valid_edge_host "$(edge_host "$I_LOGIN_URL")" || usage_die "--tls caddy serves port 443 under a DNS name: the login address cannot carry a port or be an IP address"
}

# Picks ports and derives URLs. Read-only: nothing is written, so the plan can show the result.
instance_derive() {
  local reserved_app reserved_login all_reserved net_ip
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
  I_NETWORK=0
  if [ -z "$I_PUBLIC_URL" ]; then
    net_ip=
    if [ "$OPT_LOCAL_ONLY" != 1 ]; then net_ip=$(network_primary_ip); fi
    if [ -n "$net_ip" ] && private_ipv4 "$net_ip"; then
      # Open on this computer's own address too, so other devices on the network can use it.
      I_NETWORK=1
      I_PUBLIC_URL="http://$net_ip:$I_PORT"
      I_LOGIN_URL="http://$net_ip:$I_LOGIN_PORT"
    else
      if [ -n "$net_ip" ]; then
        warn "This computer's address ($net_ip) is a public one, so Aman opens only on this computer. To reach it from elsewhere, set up HTTPS with --public-url."
      fi
      I_PUBLIC_URL="http://127.0.0.1:$I_PORT"
      I_LOGIN_URL="http://127.0.0.1:$I_LOGIN_PORT"
    fi
  fi
  I_ISSUER="$I_LOGIN_URL/dex"
}

# An http issuer is only allowed on this computer or a private network; anything else must be https.
issuer_check() {
  case "$1" in
    https://*) ;;
    *)
      is_loopback_origin "${1%/dex}" || private_host "$(origin_host "${1%/dex}")" ||
        die "A sign-in address without https is only allowed on this computer or a private network; use an https address."
      ;;
  esac
}

# ---- create / list / remove -------------------------------------------------------------------

instance_create() {
  local dir cookie client_id client_secret api_key hash created tf_cap_on=0 demo_on=0
  dir=$(instance_dir "$I_NAME")
  if reg_exists "$I_NAME"; then
    say "Instance $I_NAME already exists; making sure it is running"
    if instance_sandbox_wanted "$I_NAME"; then sandbox_ensure "$I_NAME"; fi
    instance_render "$I_NAME" "$REL_APP_TAG" "$REL_DEX_IMAGE"
    instance_up "$I_NAME"
    return
  fi
  issuer_check "$I_ISSUER"
  if [ "$I_SANDBOX" = slots ]; then sandbox_ensure "$I_NAME"; fi
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
  if [ -n "$I_TF_CAP" ]; then tf_cap_on=1; fi
  if [ "$OPT_DEMO" = 1 ]; then demo_on=1; fi
  render_template "$TEMPLATES_DIR/instance/env.tpl" \
    "PUBLIC_URL=$I_PUBLIC_URL" "COOKIE_SUFFIX=$cookie" "ISSUER=$I_ISSUER" "CLIENT_ID=$client_id" \
    "CLIENT_SECRET=$client_secret" "OWNER_EMAIL=$I_EMAIL" "API_KEY=$api_key" \
    "IF_TOKEN_FACTORY=$I_TF" "TF_KEY=$AMAN_TF_KEY" "TF_MODEL=$I_TF_MODEL" "IF_TF_CAP=$tf_cap_on" "TF_CAP=$I_TF_CAP" "IF_DEMO=$demo_on" |
    write_if_changed "$dir/.env" 600 || true
  AMAN_TF_KEY=
  render_template "$TEMPLATES_DIR/instance/dex.env.tpl" "PASSWORD_HASH=$hash" | write_if_changed "$dir/dex.env" 600 || true
  created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  reg_write "$I_NAME" "name=$I_NAME" "app_port=$I_PORT" "login_port=$I_LOGIN_PORT" "public_url=$I_PUBLIC_URL" \
    "login_url=$I_LOGIN_URL" "owner_email=$I_EMAIL" "cookie_suffix=$cookie" "client_id=$client_id" \
    "healthy=0" "network=$I_NETWORK" "sandbox=$I_SANDBOX" "tls=$I_TLS" "token_factory=$I_TF" "tf_model=$I_TF_MODEL" \
    "tf_cap=$I_TF_CAP" "demo=$demo_on" "created=$created"
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

# With --password-stdin the password is the first line of stdin, read before any prompt can take it; with
# --token-factory-key-stdin the key is the next line.
read_password_first() {
  if [ "$PASSWORD_FROM_STDIN" = 1 ] && [ "$DRY_RUN" != 1 ]; then
    ask_password AMAN_PASSWORD
  fi
  if [ "$OPT_TF_KEY_STDIN" = 1 ] && [ "$DRY_RUN" != 1 ]; then
    read_token_factory_key_stdin
  fi
}

# Rows and next steps of one instance, under the closing block's verdict.
print_instance_summary() {
  local name=$1 url count open_line
  url=$(reg_get "$name" public_url)
  count=$(reg_names | wc -l | tr -d ' ')
  if [ "$count" -gt 1 ]; then ui_heading "Instance $name"; fi
  if [ "$(reg_get "$name" network)" = 1 ]; then
    ui_row "Open" "$url, from this computer and from other devices on your network or Tailscale"
    ui_row "Or" "http://127.0.0.1:$(reg_get "$name" app_port), on this computer only"
  else
    ui_row "Open" "$url"
  fi
  ui_row "Sign in" "$(reg_get "$name" owner_email), with the password you chose"
  ui_row "Service" "Sign-in service (used by the app automatically, not a page to open): $(reg_get "$name" login_url)/dex"
  ui_row "Data" "Docker volumes aman_${name}_data and aman_${name}_dex"
  if edge_wanted "$name"; then
    ui_row "HTTPS" "Caddy on this computer serves $url and $(reg_get "$name" login_url), with certificates from Let's Encrypt renewed by Caddy"
  fi
  print_model_row "$name"
  if demo_env_on "$name"; then
    ui_row "Demo" "on (DEMO_MODE=true). Reseed: $(demo_seed_command "$name") [--reset]"
  fi
  if instance_sandbox_wanted "$name"; then
    ui_row "Run code" "on, in the gVisor sandbox (Settings $S_PROMPT Sandbox shows its status). Repair: $(sandbox_repair_command). Attachment extraction is off in this version."
  else
    ui_row "Run code" "off, and so is attachment extraction (installed with --no-sandbox)"
  fi
  ui_heading "Next"
  open_line="Open $url in your browser."
  if [ "$(reg_get "$name" network)" != 1 ] && is_loopback_origin "$url"; then open_line="$open_line Use 127.0.0.1, not localhost."; fi
  if [ "$(reg_get "$name" token_factory)" != 1 ]; then open_line="$open_line Then add a model in Settings $S_PROMPT Models."; fi
  ui_line "$open_line"
  print_model_next "$name"
  if edge_wanted "$name"; then
    edge_print_firewall_hint
  elif [ "$(reg_get "$name" network)" = 1 ]; then
    ui_line "Sign-in from other devices is not encrypted on a home network; Tailscale encrypts it."
  elif is_loopback_origin "$url"; then
    ui_line "To reach it from other devices later, see: install.sh --print-proxy-requirements"
  else
    print_proxy_requirements "$url" "$(reg_get "$name" app_port)" "$(reg_get "$name" login_url)" "$(reg_get "$name" login_port)"
  fi
  ui_line "Back up: install.sh backup (kept in $(ui_path "$BACKUPS_DIR")). Upgrade after pulling new source: install.sh upgrade"
}

# The framed closing block of `instance add`.
print_instance_block() {
  ui_summary ok "Instance $1 is ready."
  print_instance_summary "$1"
  ui_summary_end
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

# Renders an instance again from its record and restarts it, so a change in the record (or in this computer's network
# address, with --new-address) takes effect. The data and the secrets stay as they are.
cmd_instance_refresh() {
  local name=${OPT_NAME:-} ip app_port login_port env
  [ -n "$name" ] || usage_die "usage: install.sh instance refresh <name> [--new-address]"
  valid_name "$name" || usage_die "$(name_problem "$name")"
  reg_exists "$name" || die "Instance $name does not exist."
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  if [ "$OPT_NEW_ADDRESS" = 1 ]; then
    [ "$(reg_get "$name" network)" = 1 ] || die "Instance $name is open on this computer only, so it has no network address to update."
    ip=$(network_primary_ip)
    private_ipv4 "$ip" || die "This computer has no private network address right now. Connect it to your network and run this again."
    app_port=$(reg_get "$name" app_port)
    login_port=$(reg_get "$name" login_port)
    env="$(instance_dir "$name")/.env"
    reg_set "$name" public_url "http://$ip:$app_port"
    reg_set "$name" login_url "http://$ip:$login_port"
    env_managed_set "$env" PUBLIC_BASE_URL "http://$ip:$app_port"
    env_managed_set "$env" OIDC_ISSUER_URL "http://$ip:$login_port/dex"
    log_event "instance $name moved to $ip"
  fi
  instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  instance_up "$name" recreate
  print_instance_block "$name"
}

cmd_instance_add() {
  [ -n "${OPT_NAME:-}" ] || usage_die "usage: install.sh instance add <name> [--email ...]"
  valid_name "$OPT_NAME" || usage_die "$(name_problem "$OPT_NAME")"
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  I_NAME=$OPT_NAME
  if reg_exists "$I_NAME"; then
    tf_rotation_collect
    instance_create
    tf_rotation_apply
    edge_ensure "$I_NAME"
    if [ "$OPT_DEMO" = 1 ]; then demo_install_apply "$I_NAME"; fi
    if instance_sandbox_wanted "$I_NAME"; then sandbox_verify "$I_NAME"; fi
    print_instance_block "$I_NAME"
    sandbox_finish
    edge_finish
    [ "$DEMO_FAILED" = 0 ] || exit 1
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
  edge_ensure "$I_NAME"
  if [ "$OPT_DEMO" = 1 ]; then demo_install_apply "$I_NAME"; fi
  if [ "$I_SANDBOX" = slots ]; then sandbox_verify "$I_NAME"; fi
  print_instance_block "$I_NAME"
  print_signout_note
  sandbox_finish
  edge_finish
  [ "$DEMO_FAILED" = 0 ] || exit 1
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
    if instance_sandbox_wanted "$name"; then sandbox_down "$name" "${OPT_PURGE:-0}"; fi
    edge_remove "$name"
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
