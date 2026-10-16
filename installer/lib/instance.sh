# shellcheck shell=bash
# Machine services and per-instance stacks: render, start, list, remove.

APP_EXPECTED_CONTAINERS=3

# Set while a new instance may hold Docker objects but is not saved yet, so a failed run can name its cleanup.
INSTANCE_PENDING=

instance_dir() { printf '%s/%s' "$INSTANCES_DIR" "$1"; }

# The only place an instance directory is deleted. The name must be valid and the resolved path a
# direct child of <home>/instances, so no name or symlink can point the deletion elsewhere.
remove_instance_dir() {
  local name=$1 dir parent resolved
  valid_name "$name" || die "refusing to remove an instance directory for an invalid name"
  # The certificate and trust files of the instance go with it; the authority stays, since other instances use it.
  rm -rf -- "$(tls_leaf_dir "$name")" "$(tls_trust_dir "$name")"
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
  case "$n" in '' | *[![:digit:]]*) n=4 ;; esac
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
  step_begin start-machine "Starting the speech-to-text service"
  dcm up -d >"$STEP_LOG" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    step_fail "The speech-to-text service could not start" "Run install.sh again once the cause in the log is fixed."
  fi
  step_ok "The speech-to-text service is running"
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
  local name=$1 app_image=$2 dex_image=$3 dir app_port login_port public_url login_url email client_id sandbox_on edge_on login_host members members_on=0 origins redirects app_ports tls_on=0 tls_port address
  dir=$(instance_dir "$name")
  app_port=$(reg_get "$name" app_port)
  login_port=$(reg_get "$name" login_port)
  public_url=$(reg_get "$name" public_url)
  login_url=$(reg_get "$name" login_url)
  email=$(reg_get "$name" owner_email)
  client_id=$(reg_get "$name" client_id)
  if instance_sandbox_wanted "$name"; then sandbox_on=1; else sandbox_on=0; fi
  # An instance opened on the network publishes the app on each private address it lists; any other stays on 127.0.0.1.
  origins=$(reg_get "$name" origins)
  redirects="      - $public_url/api/v1/auth/callback"
  app_ports="      - '127.0.0.1:$app_port:8790'"
  if [ -n "$origins" ]; then
    redirects=$(printf '%s\n' "$origins" | tr ',' '\n' | sed 's|^|      - |; s|$|/api/v1/auth/callback|')
    app_ports=$(network_bind_addresses "$origins" | sed "s|^|      - '|; s|\$|:$app_port:8790'|")
    if tls_active "$name"; then
      tls_on=1
      tls_port=$(reg_get "$name" tls_port)
      app_ports=''
      while IFS= read -r address; do
        if [ "$address" = 127.0.0.1 ]; then
          app_ports="${app_ports:+$app_ports$'\n'}      - '127.0.0.1:$app_port:8790'"
        else
          app_ports="${app_ports:+$app_ports$'\n'}      - '$address:$app_port:$TLS_HTTP_IN'"
        fi
        app_ports="$app_ports"$'\n'"      - '$address:$tls_port:$TLS_HTTPS_IN'"
      done < <(network_bind_addresses "$origins")
    fi
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
    "LOGIN_PORT=$login_port" "DEX_TELEMETRY_PORT=$DEX_TELEMETRY_PORT" "APP_PORTS=$app_ports" \
    "IF_TLS=$tls_on" "CADDY_IMAGE=$(tls_image)" "TLS_USER=$(id -u):$(id -g)" "TLS_LEAF_DIR=$(tls_leaf_dir "$name")" \
    "TLS_TRUST_DIR=$(tls_trust_dir "$name")" "TLS_HTTP_IN=$TLS_HTTP_IN" | write_if_changed "$dir/compose.yaml" 644 || true
  if [ "$tls_on" = 1 ]; then tls_prepare "$name" "$app_image"; fi
  if [ "$edge_on" = 1 ]; then edge_render "$name"; fi
  members=$(dex_members_yaml "$name")
  if [ -n "$members" ]; then members_on=1; fi
  render_template "$TEMPLATES_DIR/instance/dex.yaml.tpl" \
    "ISSUER=$login_url/dex" "LOGIN_PORT=$login_port" "DEX_TELEMETRY_PORT=$DEX_TELEMETRY_PORT" \
    "OWNER_EMAIL=$email" "CLIENT_ID=$client_id" "REDIRECT_URIS=$redirects" \
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
  proxy_trust_sync "$name"
}

# A reverse proxy on this computer reaches an instance with a public address through a published port, so the app sees
# its network's gateway as the peer. That address is the one whose X-Forwarded-For the app believes about visitors; the
# app restarts once when it is learned or changes.
proxy_trust_sync() { # name
  local name=$1 gateway env
  reg_exists "$name" || return 0
  [ "$(gateway_flag "$(reg_get "$name" origins)" "$(reg_get "$name" public_url)")" = 1 ] || return 0
  env="$(instance_dir "$name")/.env"
  gateway=$(D network inspect "aman-${name}_default" --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | awk '{ print $1 }')
  valid_ipv4 "$gateway" || return 0
  [ "$(env_get "$env" TRUSTED_PROXY_ADDRESSES)" != "$gateway" ] || return 0
  env_managed_set "$env" TRUSTED_PROXY_ADDRESSES "$gateway"
  dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 120 app >"$STEP_LOG" 2>&1 || warn "The app of instance $name did not restart cleanly; run: aman doctor instance --fix"
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

# The files the aman command is made of: the shim and the helper files it finds at ../lib next to its folder, here and
# in a checkout alike.
AMAN_COMMAND_LIBS="ui shared diagnose network schedule"

aman_command_current() {
  local lib
  [ -x "$(doctor_shim)" ] && cmp -s "$INSTALLER_DIR/doctor/aman" "$(doctor_shim)" || return 1
  for lib in $AMAN_COMMAND_LIBS; do
    cmp -s "$INSTALLER_DIR/lib/$lib.sh" "$AMAN_HOME/lib/$lib.sh" || return 1
  done
  cmp -s "$INSTALLER_DIR/lib/pki.mjs" "$AMAN_HOME/lib/pki.mjs"
}

# Installs or refreshes the aman command and puts it on the path of new terminals.
install_doctor_shim() {
  local src="$INSTALLER_DIR/doctor/aman" lib problem words
  if [ ! -f "$src" ]; then
    warn "The aman command was not found in the installer, so it will be unavailable."
    return 0
  fi
  ensure_private_dir "$AMAN_HOME/bin"
  ensure_private_dir "$AMAN_HOME/lib"
  write_if_changed "$AMAN_HOME/bin/aman" 755 <"$src" || true
  for lib in $AMAN_COMMAND_LIBS; do
    write_if_changed "$AMAN_HOME/lib/$lib.sh" 644 <"$INSTALLER_DIR/lib/$lib.sh" || true
  done
  write_if_changed "$AMAN_HOME/lib/pki.mjs" 644 <"$INSTALLER_DIR/lib/pki.mjs" || true
  record_source_checkout
  install_path_block
  # A checkout made with a permissive umask can be changed by its group, and the command runs this installer for the
  # person later, so it is made private once here instead of asking them to.
  if tighten_checkout "$REPO_ROOT"; then
    ui_ok "Made $(ui_path "$REPO_ROOT") private to you, so only you can change what the installer runs"
  fi
  # What cannot be made right here is said once, in the words the doctor uses, since aman will refuse to run it.
  if problem=$(checkout_problem "$REPO_ROOT"); then
    words=$(checkout_problem_words "$problem")
    warn "${words%%|*} ${words#*|}"
  fi
}

# install.sh command: puts the aman command, its helper files and its path line back, and nothing else.
cmd_command() {
  [ -d "$AMAN_HOME" ] || die "Aman is not set up on this computer yet; run install.sh first"
  install_doctor_shim
  ui_ok "The aman command is installed"
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
  ask_valid I_NAME "Instance name (a-z, 0-9, hyphen; starts with a letter)" "$name_default" "Each person gets a new instance. Example: main" name_problem
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
  instance_collect_addresses
  instance_collect_tls
  instance_collect_token_factory
  ui_ok "Instance $I_NAME for $I_EMAIL"
}

# --address adds a name or address Aman should also answer at; each is checked as it is read, like every other flag.
instance_collect_addresses() {
  if [ -z "$OPT_ADDRESSES" ]; then return 0; fi
  [ -z "$I_PUBLIC_URL" ] || usage_die "--address applies to an instance opened on your network; with --public-url the public address is the only one."
  [ "$OPT_LOCAL_ONLY" != 1 ] || usage_die "--address and --local-only are opposites; pick one."
}

# --tls caddy serves the two public origins on 443 under DNS names Let's Encrypt can issue for. --tls local (the
# default on a network) serves https with a certificate from this computer's own authority; --tls off keeps plain http.
instance_collect_tls() {
  case "$I_TLS" in
    '') return 0 ;;
    local | off)
      [ -z "$I_PUBLIC_URL" ] || usage_die "--tls $I_TLS is for an instance opened on your network; with --public-url use --tls caddy."
      # --tls off asks for what --local-only already gives, so the two are not in conflict.
      [ "$OPT_LOCAL_ONLY" != 1 ] || [ "$I_TLS" = off ] || usage_die "--local-only keeps Aman on this computer, where plain http is fine; --tls does not apply."
      return 0
      ;;
    caddy) ;;
    *) usage_die "--tls takes local, off or caddy" ;;
  esac
  [ -n "$I_PUBLIC_URL" ] || usage_die "--tls caddy needs --public-url and --login-url (the two https addresses Caddy will serve)"
  [ -z "$OPT_PUBLIC_IP" ] || valid_ipv4 "$OPT_PUBLIC_IP" || usage_die "--public-ip must be an IPv4 address"
  valid_edge_host "$(edge_host "$I_PUBLIC_URL")" || usage_die "--tls caddy serves port 443 under a DNS name: the public address cannot carry a port or be an IP address"
  valid_edge_host "$(edge_host "$I_LOGIN_URL")" || usage_die "--tls caddy serves port 443 under a DNS name: the login address cannot carry a port or be an IP address"
}

# Picks ports and derives URLs. Read-only: nothing is written, so the plan can show the result.
instance_derive() {
  local reserved_app reserved_login all_reserved
  reserved_app=$(reg_all app_port)
  reserved_login=$(reg_all login_port)
  all_reserved="$reserved_app $reserved_login $(reg_all tls_port)"
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
  I_ORIGINS=
  I_TLS_PORT=
  I_PUBLIC_ADDRESSES=
  if [ -z "$I_PUBLIC_URL" ]; then
    # The sign-in service is only ever reached on this computer: other devices go through the app.
    I_PUBLIC_URL="http://127.0.0.1:$I_PORT"
    I_LOGIN_URL="http://127.0.0.1:$I_LOGIN_PORT"
    if [ "$OPT_LOCAL_ONLY" = 1 ]; then
      I_TLS=
    else
      I_TLS=${I_TLS:-local}
      # shellcheck disable=SC2086 # OPT_ADDRESSES is a list of checked hosts
      I_ORIGINS=$(network_origin_list "$I_PORT" '' $OPT_ADDRESSES)
      if [ "$I_TLS" = local ] && origins_reach_the_network "$I_ORIGINS"; then
        I_TLS_PORT=$(pick_port 8443 "$all_reserved $I_PORT $I_LOGIN_PORT") || die "no free port found on this computer for https near 8443"
        # shellcheck disable=SC2086
        I_ORIGINS=$(network_origin_list "$I_PORT" "$I_TLS_PORT" $OPT_ADDRESSES)
      fi
      vm_reach_notice
      I_PUBLIC_ADDRESSES=$(network_public_addresses | tr '\n' ' ')
    fi
  fi
  I_ISSUER="$I_LOGIN_URL/dex"
}

# An http issuer is only allowed on this computer; anything else must be https.
issuer_check() {
  case "$1" in
    https://*) ;;
    *) is_loopback_origin "${1%/dex}" || die "A sign-in address without https is only allowed on this computer; use an https address." ;;
  esac
}

# ---- addresses of an existing instance ----------------------------------------------------------

# Said once per run where Docker cannot publish on the home-network address (see network_publishes_on_loopback_only).
VM_NOTICE_SHOWN=0
vm_reach_notice() {
  [ "$VM_NOTICE_SHOWN" = 0 ] || return 0
  [ "$OPT_LOCAL_ONLY" != 1 ] || return 0
  network_publishes_on_loopback_only || return 0
  VM_NOTICE_SHOWN=1
  if [ "$(uname -s)" = Darwin ]; then
    ui_line "On this Mac, Aman opens only on this computer. To reach it from your phone, see \"Opening Aman from another device (Mac and Windows)\" in docs/install.mdx."
  else
    ui_line "Docker here cannot open Aman on your home network, so Aman opens only on this computer. To reach it from your phone, see \"Opening Aman from another device (Mac and Windows)\" in docs/install.mdx."
  fi
}

# True when a recorded origin list has a host the installer no longer opens an instance at: an address in
# 100.64.0.0/10 or a .ts.net name, or, where Docker publishes on 127.0.0.1 alone, any address of the network.
origins_have_dropped_hosts() { # comma list
  local origin host
  while IFS= read -r origin; do
    host=$(origin_host "$origin")
    if shared_address_space "$host"; then return 0; fi
    case "$host" in *.ts.net) return 0 ;; esac
    if ! is_loopback_host_name "$host" && network_publishes_on_loopback_only; then return 0; fi
  done < <(printf '%s\n' "$1" | tr ',' '\n')
  return 1
}

# An instance from before addresses were listed has no `origins` record at all. A plain re-run opens it on the network
# like a new one; --local-only keeps it (or puts it back) on this computer only.
instance_address_change() { # name; prints open, close or nothing
  local name=$1 recorded=0
  grep -q '^origins=' "$(reg_file "$name")" && recorded=1
  is_loopback_origin "$(reg_get "$name" public_url)" || return 0
  if [ "$OPT_LOCAL_ONLY" = 1 ]; then
    if [ -n "$(reg_get "$name" origins)" ] || [ "$recorded" = 0 ]; then printf 'close'; fi
  elif [ "$recorded" = 0 ]; then
    printf 'open'
  elif [ -n "$(reg_get "$name" origins)" ] && { [ "$(tls_target "$name")" != "$(reg_get "$name" tls)" ] || origins_have_dropped_hosts "$(reg_get "$name" origins)"; }; then
    printf 'refresh'
  fi
}

# The given hosts without those the installer no longer opens an instance at (100.64.0.0/10 addresses, .ts.net names).
drop_unsupported_hosts() {
  local host
  for host in "$@"; do
    if shared_address_space "$host"; then continue; fi
    case "$host" in *.ts.net) continue ;; esac
    printf '%s ' "$host"
  done
}

# Writes the list of addresses of an instance into its record and its settings: read again from this computer, plus
# the names given with --address (kept from the first install unless new ones are given). Renders and restarts nothing.
instance_apply_addresses() { # name open|close|refresh
  local name=$1 mode=$2 origins='' extras env tls='' tls_port='' app_port dropped=0
  env="$(instance_dir "$name")/.env"
  app_port=$(reg_get "$name" app_port)
  extras=${OPT_ADDRESSES:-$(reg_get "$name" extra_hosts)}
  if [ -z "$OPT_ADDRESSES" ] && origins_have_dropped_hosts "$(reg_get "$name" origins)"; then
    # shellcheck disable=SC2086 # the extras are checked hosts without spaces
    extras=$(drop_unsupported_hosts $extras)
    extras=${extras% }
    dropped=1
  fi
  if [ "$mode" != close ]; then
    tls=$(tls_target "$name")
    # shellcheck disable=SC2086 # the extras are checked hosts without spaces
    origins=$(network_origin_list "$app_port" '' $extras)
    if [ "$tls" = local ] && origins_reach_the_network "$origins"; then
      tls_port=$(reg_get "$name" tls_port)
      if [ -z "$tls_port" ]; then
        tls_port=$(pick_port 8443 "$(reg_all app_port) $(reg_all login_port) $(reg_all tls_port)") || die "no free port found on this computer for https near 8443"
      fi
      # shellcheck disable=SC2086
      origins=$(network_origin_list "$app_port" "$tls_port" $extras)
    fi
  else
    extras=
  fi
  if [ "$mode" != close ]; then vm_reach_notice; fi
  reg_set "$name" tls "$tls"
  reg_set "$name" tls_port "$tls_port"
  reg_set "$name" origins "$origins"
  reg_set "$name" extra_hosts "$extras"
  env_managed_set "$env" ALLOWED_ORIGINS "$origins"
  log_event "instance $name addresses $mode"
  if [ "$dropped" = 1 ] && [ -n "$origins" ]; then
    say "Instance $name now opens on this computer and your home network."
  fi
}

# ---- create / list / remove -------------------------------------------------------------------

instance_create() {
  local dir cookie client_id client_secret api_key hash created tf_cap_on=0 demo_on=0 network_on=0
  dir=$(instance_dir "$I_NAME")
  if reg_exists "$I_NAME"; then
    say "Instance $I_NAME already exists; making sure it is running"
    if instance_sandbox_wanted "$I_NAME"; then sandbox_ensure "$I_NAME"; fi
    instance_render "$I_NAME" "$REL_APP_TAG" "$REL_DEX_IMAGE"
    instance_up "$I_NAME"
    return
  fi
  issuer_check "$I_ISSUER"
  if [ -n "$I_ORIGINS" ]; then network_on=1; fi
  INSTANCE_PENDING=$I_NAME
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
    "PUBLIC_URL=$I_PUBLIC_URL" "IF_NETWORK=$network_on" "ORIGINS=$I_ORIGINS" "COOKIE_SUFFIX=$cookie" "ISSUER=$I_ISSUER" "CLIENT_ID=$client_id" \
    "IF_GATEWAY=$(gateway_flag "$I_ORIGINS" "$I_PUBLIC_URL")" "LOGIN_PORT=$I_LOGIN_PORT" \
    "CLIENT_SECRET=$client_secret" "OWNER_EMAIL=$I_EMAIL" "API_KEY=$api_key" \
    "IF_TOKEN_FACTORY=$I_TF" "TF_KEY=$AMAN_TF_KEY" "TF_MODEL=$I_TF_MODEL" "IF_TF_CAP=$tf_cap_on" "TF_CAP=$I_TF_CAP" "IF_DEMO=$demo_on" |
    write_if_changed "$dir/.env" 600 || true
  AMAN_TF_KEY=
  render_template "$TEMPLATES_DIR/instance/dex.env.tpl" "PASSWORD_HASH=$hash" | write_if_changed "$dir/dex.env" 600 || true
  created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  reg_write "$I_NAME" "name=$I_NAME" "app_port=$I_PORT" "login_port=$I_LOGIN_PORT" "public_url=$I_PUBLIC_URL" \
    "login_url=$I_LOGIN_URL" "owner_email=$I_EMAIL" "cookie_suffix=$cookie" "client_id=$client_id" \
    "healthy=0" "origins=$I_ORIGINS" "extra_hosts=$OPT_ADDRESSES" "sandbox=$I_SANDBOX" "tls=$I_TLS" "tls_port=$I_TLS_PORT" "token_factory=$I_TF" "tf_model=$I_TF_MODEL" \
    "tf_cap=$I_TF_CAP" "demo=$demo_on" "created=$created"
  INSTANCE_PENDING=
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
  say "      $3  ->  forward to the same http://127.0.0.1:$2 (the app passes sign-in pages through and limits guessing)"
  say "  - Pass on the address people typed in their browser unchanged, and tell the app each visitor's own address."
  if [ "$UI_VERBOSE" = 1 ]; then say "      (forward the Host header unchanged, and set X-Forwarded-For to the visitor's address)"; fi
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

# How an address of the Open row is told apart, so the ones other devices use come first.
origin_kind() { # origin
  local host
  host=$(origin_host "$1")
  case "$host" in
    127.0.0.1 | localhost) echo loopback ;;
    *.local) echo local ;;
    *) if valid_ipv4 "$host"; then echo address; else echo name; fi ;;
  esac
}

# The origins of a comma list, one per line: addresses of this computer on the network first, then its names, then the
# ones that only work on this computer.
origins_display_order() { # comma list
  local kind origin
  for kind in address local name loopback; do
    while IFS= read -r origin; do
      if [ "$(origin_kind "$origin")" = "$kind" ]; then printf '%s\n' "$origin"; fi
    done < <(printf '%s\n' "$1" | tr ',' '\n')
  done
}

# The closing table of one instance: what to open, who signs in, and where the model, sandbox, data and backups stand.
print_instance_summary() {
  local name=$1 url count origin first=1 origins bookmark=
  url=$(reg_get "$name" public_url)
  origins=$(reg_get "$name" origins)
  count=$(reg_names | wc -l | tr -d ' ')
  if [ "$count" -gt 1 ]; then ui_heading "Instance $name"; fi
  while IFS= read -r origin; do
    if [ "$first" = 1 ]; then ui_check_row ok "Open" "$origin"; else ui_check_more "$origin"; fi
    first=0
    case "$(origin_kind "$origin")" in
      local) if [ -z "$bookmark" ]; then bookmark=$(origin_host "$origin"); fi ;;
    esac
  done < <(origins_display_order "${origins:-$url}")
  if tls_active "$name"; then
    ui_line "On this computer open http://localhost:$(reg_get "$name" app_port). The https addresses are for your phone and other devices, once each one trusts this computer (see below)."
  fi
  ui_check_row ok "Sign in" "$(reg_get "$name" owner_email)"
  ui_check_more "click Let's Get Started, then enter this email and your password"
  print_model_row "$name"
  if instance_sandbox_wanted "$name"; then
    case "$SANDBOX_FAILED_NAMES " in
      *" $name "*) ui_check_row warn "Run code" "not ready: $(sandbox_repair_command)" ;;
      *) ui_check_row ok "Run code" "on, in a sandbox" ;;
    esac
  else
    ui_check_row skip "Run code" "off (installed with --no-sandbox)"
  fi
  ui_check_row ok "Data" "saved in Docker"
  print_backups_row
  if edge_wanted "$name"; then
    ui_check_row ok "HTTPS" "on, with certificates from Let's Encrypt"
  fi
  if demo_env_on "$name"; then
    ui_check_row ok "Demo" "on. Reseed: $(demo_seed_command "$name") [--reset]"
  fi
  if edge_wanted "$name"; then
    edge_print_firewall_hint
  elif origins_reach_the_network "$origins"; then
    if tls_active "$name"; then
      print_trust_lines "$name"
    else
      ui_line "Sign-in on your home network is not encrypted. Leave out --tls off to use https."
    fi
    if [ -n "$bookmark" ]; then ui_line "Bookmark $bookmark: it keeps working when this computer's address changes."; fi
  elif ! is_loopback_origin "$url"; then
    print_proxy_requirements "$url" "$(reg_get "$name" app_port)" "$(reg_get "$name" login_url)"
  fi
}

# How a device comes to trust this computer: one short link over plain http, the same link as a code for a phone, and the
# step an iPhone needs after installing.
print_trust_lines() { # name
  local link
  link=$(tls_trust_link "$1")
  ui_line "On a phone or another computer, open this page first and follow its steps: $link"
  ui_line "On an iPhone, open it in Safari, install the profile, then turn it on in Settings, General, About, Certificate Trust Settings."
  ui_line "The page shows a fingerprint; compare it with the one your device shows before you trust it."
  if [ "$TLS_AUTHORITY_REPLACED" = 1 ]; then
    ui_line "This computer's certificate authority was made again (it did not cover a name now in use, or was from an earlier version), so each device must trust it again."
  fi
  tls_print_qr "$link"
}

# The backups row: the daily schedule and how many are kept, or how to turn it on or make one by hand.
print_backups_row() {
  local count=0
  if [ -d "$BACKUPS_DIR" ]; then count=$(find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' '); fi
  case "$(backups_mode)" in
    daily)
      if backup_schedule_present; then
        ui_check_row ok "Backups" "daily, keeps the last $BACKUP_KEEP"
      else
        ui_check_row warn "Backups" "the daily schedule is missing: aman doctor backup --fix"
      fi
      ;;
    off)
      if [ -z "$(backup_scheduler)" ]; then
        ui_check_row skip "Backups" "off. Make one: aman backup"
      else
        ui_check_row skip "Backups" "off. Turn on: aman doctor backup --fix"
      fi
      ;;
    *)
      if [ "$count" -gt 0 ]; then
        ui_check_row ok "Backups" "$count kept"
      else
        ui_check_row todo "Backups" "none yet. Make one: aman backup"
      fi
      ;;
  esac
}

# The last lines of a finished run: how to reach the aman command from this terminal, and how to update later.
print_closing_lines() {
  case ":$PATH:" in
    *":$AMAN_HOME/bin:"*) ;;
    *) ui_line "Open a new terminal window to use the aman command." ;;
  esac
  ui_line "Update later: aman upgrade"
}

# The framed closing block of `instance add`.
print_instance_block() {
  ui_summary ok "Instance $1 is ready."
  print_instance_summary "$1"
  print_closing_lines
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

# 1 for an instance with a public https address: its app then passes the sign-in pages through and limits guessing.
gateway_flag() { # origins public_url
  if [ -z "$1" ] && ! is_loopback_origin "$2"; then printf 1; else printf 0; fi
}

# Puts back the settings an instance's .env lost, from its record and the template that wrote it. A setting that is
# still there is never changed, so existing secrets stay; a lost secret gets a new value that the app and the sign-in
# service both read from this file. The Token Factory key cannot be made again and is skipped.
instance_env_repair() {
  local name=$1 env network_on=0 tf_on=0 tf_cap_on=0 demo_on=0 line key value tf_cap fresh=0 restored=0
  env="$(instance_dir "$name")/.env"
  if [ -n "$(reg_get "$name" origins)" ]; then network_on=1; fi
  tf_cap=$(reg_get "$name" tf_cap)
  if [ -n "$tf_cap" ]; then tf_cap_on=1; fi
  if [ "$(reg_get "$name" demo)" = 1 ]; then demo_on=1; fi
  if [ "$(reg_get "$name" token_factory)" = 1 ]; then tf_on=1; fi
  if [ ! -f "$env" ]; then fresh=1; fi
  while IFS= read -r line; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}
    value=${line#*=}
    [ "$key" = NEBIUS_API_KEY ] && continue
    if [ "$key" = OIDC_ALLOWED_EMAILS ]; then value=$(users_allowed_emails "$name"); fi
    if [ "$fresh" = 1 ]; then
      ensure_private_dir "$(dirname "$env")"
      printf '# >>> managed by the installer: written once, never regenerated by re-runs or upgrades\n# <<< end of managed block; add your own settings below this line\n' | write_if_changed "$env" 600 || true
      fresh=0
    fi
    if ! grep -q "^$key=" "$env"; then
      env_managed_set "$env" "$key" "$value"
      restored=$((restored + 1))
    fi
  done < <(render_template "$TEMPLATES_DIR/instance/env.tpl" \
    "PUBLIC_URL=$(reg_get "$name" public_url)" "IF_NETWORK=$network_on" "ORIGINS=$(reg_get "$name" origins)" \
    "COOKIE_SUFFIX=$(reg_get "$name" cookie_suffix)" "ISSUER=$(reg_get "$name" login_url)/dex" "CLIENT_ID=$(reg_get "$name" client_id)" \
    "IF_GATEWAY=$(gateway_flag "$(reg_get "$name" origins)" "$(reg_get "$name" public_url)")" "LOGIN_PORT=$(reg_get "$name" login_port)" \
    "CLIENT_SECRET=$(rand_hex 32)" "OWNER_EMAIL=$(reg_get "$name" owner_email)" "API_KEY=$(rand_hex 32)" \
    "IF_TOKEN_FACTORY=$tf_on" "TF_KEY=unused" "TF_MODEL=$(reg_get "$name" tf_model)" "IF_TF_CAP=$tf_cap_on" "TF_CAP=$tf_cap" "IF_DEMO=$demo_on")
  if [ "$restored" -gt 0 ]; then ui_ok "Put back $restored lost settings of instance $name"; fi
}

# Renders an instance again from its record and restarts it. For an instance opened on the network the addresses are read
# again first, so a new address of this computer works for sign-in. Data and existing secrets stay as they are.
cmd_instance_refresh() {
  local name=${OPT_NAME:-} change
  [ -n "$name" ] || usage_die "usage: install.sh instance refresh <name>"
  valid_name "$name" || usage_die "$(name_problem "$name")"
  reg_exists "$name" || die "Instance $name does not exist."
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  change=$(instance_address_change "$name")
  if [ -n "$change" ]; then
    instance_apply_addresses "$name" "$change"
  elif [ -n "$(reg_get "$name" origins)" ]; then
    instance_apply_addresses "$name" refresh
  fi
  instance_env_repair "$name"
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
    say "Would create instance $I_NAME for $I_EMAIL: app at ${I_ORIGINS:-$I_PUBLIC_URL} (port $I_PORT on this computer), sign-in service port $I_LOGIN_PORT. Nothing was changed."
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

# Ids of the containers, networks or volumes that Compose labelled with a project.
project_objects() { # containers|networks|volumes project
  case "$1" in
    containers) D ps -aq --filter "label=com.docker.compose.project=$2" 2>/dev/null || true ;;
    networks) D network ls -q --filter "label=com.docker.compose.project=$2" 2>/dev/null || true ;;
    volumes) D volume ls -q --filter "label=com.docker.compose.project=$2" 2>/dev/null || true ;;
  esac
}

# Volumes that belong to an instance: those labelled for it or for its Compose projects, and those named after it
# (found by name too, since an install that failed early may have left them without labels or a saved instance).
instance_volumes() {
  local name=$1 volume
  {
    D volume ls -q --filter "label=com.amanuensis.instance=$name" 2>/dev/null || true
    project_objects volumes "aman-$name"
    project_objects volumes "$name-slots"
    for volume in $(D volume ls -q 2>/dev/null || true); do
      case "$volume" in
        aman_stt_cache | aman_machine) ;;
        "aman_${name}_"* | "${name}_slot_"*) printf '%s\n' "$volume" ;;
      esac
    done
    for volume in "aman_${name}_data" "aman_${name}_dex"; do
      if docker_volume_exists "$volume"; then
        printf '%s\n' "$volume"
      fi
    done
  } | sort -u
}

# The shared speech-to-text project's volumes.
machine_volumes() {
  {
    project_objects volumes aman-machine
    if docker_volume_exists aman_stt_cache; then printf '%s\n' aman_stt_cache; fi
  } | sort -u
}

# Removes the containers and networks of Compose projects, whatever the registry says; counts them in PURGED_CONTAINERS
# and PURGED_NETWORKS. Volumes are left to volumes_purge, which reports each failure.
PURGED_CONTAINERS=0
PURGED_NETWORKS=0
projects_purge() { # project...
  local project ids id
  for project in "$@"; do
    ids=$(project_objects containers "$project")
    for id in $ids; do
      if D rm -f "$id" >/dev/null 2>&1; then PURGED_CONTAINERS=$((PURGED_CONTAINERS + 1)); fi
    done
    ids=$(project_objects networks "$project")
    for id in $ids; do
      if D network rm "$id" >/dev/null 2>&1; then PURGED_NETWORKS=$((PURGED_NETWORKS + 1)); fi
    done
  done
}

# True when Docker still holds anything named for the instance.
instance_has_leftovers() {
  local name=$1 project
  [ -n "$(instance_volumes "$name")" ] && return 0
  for project in "aman-$name" "$name-slots"; do
    [ -z "$(project_objects containers "$project")$(project_objects networks "$project")" ] || return 0
  done
  return 1
}

machine_has_leftovers() {
  [ -d "$MACHINE_DIR" ] && return 0
  [ -n "$(project_objects containers aman-machine)$(project_objects networks aman-machine)$(machine_volumes)" ]
}

# The images this installer built: the app, the speech-to-text service and the sandbox.
aman_images() {
  local image
  while IFS= read -r image; do
    case "$image" in aman-app:* | aman-stt:* | "$SLOT_IMAGE") printf '%s\n' "$image" ;; esac
  done < <(D images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)
}

# Removes the built images; one that is still in use is left and named in a warning.
aman_images_remove() {
  local image failed=
  while IFS= read -r image; do
    [ -n "$image" ] || continue
    D rmi "$image" >/dev/null 2>&1 || failed="$failed $image"
  done < <(aman_images)
  if [ -n "$failed" ]; then
    warn "could not remove the images:$failed. Remove them with: docker rmi$failed"
  fi
}

# After the last instance is purged: the shared speech-to-text project with its volumes, the daily backup job, the aman
# command in the shell profiles, the built images and the installer's own folders. The removal log and the backups
# stay; backups are the person's data.
machine_purge() {
  if [ -f "$MACHINE_DIR/compose.yaml" ] && [ -f "$MACHINE_DIR/.env" ]; then
    dcm down --volumes --remove-orphans >/dev/null 2>&1 || warn "could not stop the speech-to-text service cleanly; continuing with the removal"
  fi
  projects_purge aman-machine
  # shellcheck disable=SC2046 # volume names are single words
  volumes_purge $(machine_volumes) || exit 1
  backup_schedule_disable
  path_profiles_remove
  aman_images_remove
  installer_state_remove
}

# Deletes the installer's folders under the home folder; never anything else, and never through a symbolic link.
installer_state_remove() {
  local entry
  case "$AMAN_HOME" in / | "$HOME" | "") return 0 ;; esac
  [ -d "$STATE_DIR" ] && [ ! -L "$AMAN_HOME" ] && [ ! -L "$STATE_DIR" ] || return 0
  for entry in instances machine tls lib bin release runtime; do
    rm -rf -- "${AMAN_HOME:?}/$entry"
  done
  find "$STATE_DIR" -mindepth 1 -maxdepth 1 ! -name install.log ! -name lock -exec rm -rf -- {} +
}

# On a failed run that may have left parts of a new instance in Docker: the one command that removes them.
instance_pending_notice() {
  [ -n "$INSTANCE_PENDING" ] || return 0
  printf 'Nothing of yours was made yet. Run install.sh again to continue; to remove what this run left behind instead, run: install.sh instance remove %s --purge-data\n' "$INSTANCE_PENDING" >&2
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
  local name=${OPT_NAME:-} exists=0 volumes='' purge_list left=0 machine_left=0 last_one=0 line
  [ -n "$name" ] || usage_die "usage: install.sh instance remove <name> [--purge-data]"
  valid_name "$name" || usage_die "invalid instance name"
  if reg_exists "$name" || [ -d "$(instance_dir "$name")" ]; then
    exists=1
  fi
  if [ "$exists" = 0 ]; then
    if docker_reach_quietly; then
      volumes=$(instance_volumes "$name" | tr '\n' ' ')
      if instance_has_leftovers "$name"; then left=1; fi
    fi
    # The shared speech-to-text service goes with the last instance, so it counts as something left to do.
    if [ "${OPT_PURGE:-0}" = 1 ] && [ -z "$(reg_names)" ] && machine_has_leftovers; then machine_left=1; fi
    if [ "$left" = 0 ] && [ "$machine_left" = 0 ]; then
      say "Instance $name does not exist; nothing to do."
      return 0
    fi
    if [ "${OPT_PURGE:-0}" != 1 ]; then
      if [ -n "${volumes// /}" ]; then
        say "Instance $name is already removed, but its data is still in the volumes: $volumes"
      else
        say "Instance $name is already removed, but Docker still holds parts of it."
      fi
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
  elif [ -f "$(sandbox_bundle)" ] && [ -x "$(sandbox_node)" ]; then
    # Leftovers of an instance that was never saved; the sandbox tools also remove the disk files of its sandboxes.
    sandbox_down "$name" 1
  fi
  [ -n "$(reg_names)" ] || last_one=1
  if [ "${OPT_PURGE:-0}" != 1 ]; then
    say "Removed instance $name. Its data is kept in the volumes aman_${name}_data and aman_${name}_dex."
    if [ "$last_one" = 1 ]; then
      say "The shared speech-to-text service and its downloaded model are kept too."
    fi
    say "To delete everything left: install.sh instance remove $name --purge-data"
    return 0
  fi
  stt_detach "$name"
  projects_purge "aman-$name" "$name-slots"
  volumes=$(instance_volumes "$name" | tr '\n' ' ')
  if [ -n "${volumes// /}" ]; then
    read -r -a purge_list <<<"$volumes"
    volumes_purge "${purge_list[@]}" || exit 1
    line="Removed instance $name and deleted its data volumes: $volumes"
  else
    line="Removed instance $name. It had no data volumes left to delete"
  fi
  log_event "instance $name purged"
  if [ "$PURGED_CONTAINERS" -gt 0 ] || [ "$PURGED_NETWORKS" -gt 0 ]; then
    line="$line; also removed $PURGED_CONTAINERS containers and $PURGED_NETWORKS networks"
  fi
  if [ "$last_one" = 1 ]; then
    machine_purge
    line="$line; this was the last instance, so the shared speech-to-text service with its model and the installer's files in $AMAN_HOME were removed too"
  fi
  say "$line."
  if [ "$last_one" = 1 ] && [ -d "$BACKUPS_DIR" ]; then
    say "Your backups in $BACKUPS_DIR were kept. To delete them: rm -r $BACKUPS_DIR"
  fi
}
