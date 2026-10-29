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
  dcm up -d --remove-orphans >"$STEP_LOG" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    step_fail "The speech-to-text service could not start" "Fix what the log says, then run install.sh again."
  fi
  step_ok "The speech-to-text service is running"
  # A recreated speech container loses the extra networks it was connected to, so reconnect them all.
  for name in $(reg_names); do
    if D network inspect "$(stt_network "$name")" >/dev/null 2>&1; then
      stt_attach "$name" || true
    fi
  done
}

# Each instance has its own internal network with only its speech relay on it besides the speech service. The shared
# service is connected to every one of those networks, so no instance has a route to another, and the service has no
# route into any instance except that relay.
stt_network() { printf 'aman_%s_speech' "$1"; }

stt_attach() {
  local net out
  net=$(stt_network "$1")
  if out=$(D network connect --alias aman-stt-engine "$net" aman-stt 2>&1); then
    return 0
  fi
  case "$out" in
    *"already exists"*)
      # Joined before, perhaps without the name the relay dials; then join again with it.
      if stt_has_alias "$net"; then return 0; fi
      D network disconnect -f "$net" aman-stt >/dev/null 2>&1 || true
      if out=$(D network connect --alias aman-stt-engine "$net" aman-stt 2>&1); then return 0; fi
      ;;
  esac
  warn "The speech-to-text service could not be connected to instance $1: $out"
  return 1
}

stt_has_alias() { # network
  local alias
  for alias in $(D inspect --format "{{with index .NetworkSettings.Networks \"$1\"}}{{join .Aliases \" \"}}{{end}}" aman-stt 2>/dev/null); do
    if [ "$alias" = aman-stt-engine ]; then return 0; fi
  done
  return 1
}

# Earlier releases put an instance on this network with other settings, which Compose cannot change while the speech
# service is joined to it, so the network has a new name.
stt_old_network() { printf 'aman_%s_stt' "$1"; }

stt_detach() {
  D network disconnect -f "$(stt_network "$1")" aman-stt >/dev/null 2>&1 || true
  D network disconnect -f "$(stt_old_network "$1")" aman-stt >/dev/null 2>&1 || true
  stt_forget_old_network "$1"
}

# Removes the old network once nothing but the speech service is left on it.
stt_forget_old_network() {
  local old members member out
  old=$(stt_old_network "$1")
  members=$(D network inspect "$old" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null) || return 0
  for member in $members; do
    [ "$member" = aman-stt ] || return 0
  done
  D network disconnect -f "$old" aman-stt >/dev/null 2>&1 || true
  if out=$(D network rm "$old" 2>&1); then return 0; fi
  case "$out" in *"not found"* | *"No such network"*) return 0 ;; esac
  warn "An old network of the speech-to-text service ($old) could not be removed: $out"
}

machine_running() {
  [ -n "$(D ps -q --filter label=com.docker.compose.project=aman-machine --filter status=running 2>/dev/null || true)" ]
}

# Rewrites compose.yaml and dex.yaml from the registry (the owner) and the given images. Both hold no secrets.
instance_render() {
  local name=$1 app_image=$2 dex_image=$3 dir login_bind=0.0.0.0 app_port login_port public_url login_url email client_id sandbox_on edge_on login_host origins redirects app_ports tls_on=0 tls_host=0 tls_volume=0 tls_port address
  dir=$(instance_dir "$name")
  owner_name_backfill "$name"
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
  # Only the app reaches the sign-in service when it passes the sign-in pages through; a browser that goes to the
  # published sign-in port directly needs the service on every address of the namespace.
  if [ -n "$origins" ] || [ "$(gateway_flag "$origins" "$public_url")" = 1 ]; then login_bind=127.0.0.1; fi
  edge_on=0
  login_host=
  if edge_wanted "$name"; then
    edge_on=1
    login_host=$(edge_host "$login_url")
  fi
  # The calendar connector is part of the compose file only once its image is known.
  local calendar_on=0
  if [ -n "${REL_CALENDAR_TAG:-}" ]; then
    calendar_on=1
    calendar_secret_backfill "$name"
  fi
  # The email connector is part of the compose file only once its image is known. Its wrapper script is copied beside the
  # compose file, because the compose file mounts it from this folder.
  local email_on=0
  [ -n "${REL_MAIL_EMAIL_IMAGE:-}" ] && email_on=1
  ensure_private_dir "$dir"
  if [ "$email_on" = 1 ]; then
    write_if_changed "$dir/mail-email-entrypoint.sh" 644 <"$REPO_ROOT/ops/compose/mail-email/entrypoint.sh" || true
    write_if_changed "$dir/mail-account-agent.py" 644 <"$REPO_ROOT/ops/compose/mail-email/account_agent.py" || true
    write_if_changed "$dir/mail-email-check.py" 644 <"$REPO_ROOT/ops/compose/mail-email/email_check.py" || true
    # No account file is written here: the account lives in the connector's volume, and the
    # installer writes it through the connector's account agent (see email_agent_write).
  fi
  # The https folders are mounted from the home folder itself, except when the home is the state volume
  # (Windows): then the compose file mounts them from inside the volume, because a host folder the
  # daemon could read does not exist there.
  if [ "$tls_on" = 1 ]; then
    if tls_home_in_volume; then tls_volume=1; else tls_host=1; fi
  fi
  render_template "$TEMPLATES_DIR/instance/compose.yaml.tpl" \
    "NAME=$name" "IF_CALENDAR=$calendar_on" "CALENDAR_IMAGE=${REL_CALENDAR_TAG:-}" "IF_EMAIL=$email_on" "MAIL_EMAIL_IMAGE=${REL_MAIL_EMAIL_IMAGE:-}" "STT_NETWORK=$(stt_network "$name")" "APP_IMAGE=$app_image" "DEX_IMAGE=$dex_image" "APP_PORT=$app_port" "IF_SANDBOX=$sandbox_on" \
    "IF_EDGE=$edge_on" "LOGIN_HOST=$login_host" \
    "LOGIN_PORT=$login_port" "DEX_TELEMETRY_PORT=$DEX_TELEMETRY_PORT" "APP_PORTS=$app_ports" \
    "IF_TLS=$tls_on" "IF_TLS_HOST=$tls_host" "IF_TLS_VOLUME=$tls_volume" "CADDY_IMAGE=$(tls_image)" "TLS_USER=$(id -u):$(id -g)" "TLS_LEAF_DIR=$(tls_leaf_dir "$name")" \
    "TLS_TRUST_DIR=$(tls_trust_dir "$name")" "TLS_HTTP_IN=$TLS_HTTP_IN" | write_if_changed "$dir/compose.yaml" 644 || true
  if [ "$tls_on" = 1 ]; then tls_prepare "$name" "$app_image"; fi
  if [ "$edge_on" = 1 ]; then edge_render "$name"; fi
  render_template "$TEMPLATES_DIR/instance/dex.yaml.tpl" \
    "ISSUER=$login_url/dex" "LOGIN_BIND=$login_bind" "LOGIN_PORT=$login_port" "DEX_TELEMETRY_PORT=$DEX_TELEMETRY_PORT" \
    "OWNER_EMAIL=$email" "OWNER_NAME=$(reg_get "$name" owner_name)" "CLIENT_ID=$client_id" "REDIRECT_URIS=$redirects" |
    write_if_changed "$dir/dex.yaml" 644 || true
}

# What Aman calls a person who has not said: the start of their email, cut to the longest name allowed.
owner_name_default() { # email
  local start=${1%%@*}
  printf '%s' "${start:0:80}"
}

# An instance from before the question has no recorded name. It keeps the name its sign-in service already shows,
# unless that is the old fixed 'owner', and then gets the start of its email. Nothing is asked, so refresh and upgrade
# stay unattended. The app reads the name from .env too, to fill Personalization once.
owner_name_backfill() { # name
  local name=$1 current env
  env="$(instance_dir "$name")/.env"
  current=$(reg_get "$name" owner_name)
  if [ -z "$current" ]; then
    current=$(sed -n "s/^ *username: '\(.*\)'\$/\1/p" "$(instance_dir "$name")/dex.yaml" 2>/dev/null | head -n 1)
    if [ "$current" = owner ] || [ -n "$(display_name_problem "$current")" ]; then
      current=$(owner_name_default "$(reg_get "$name" owner_email)")
    fi
    reg_set "$name" owner_name "$current"
  fi
  if [ -f "$env" ] && grep -q '^# >>> managed by the installer' "$env" && ! grep -q '^OWNER_NAME=' "$env"; then
    env_managed_set "$env" OWNER_NAME "$current"
  fi
}

# The secret the app and the calendar connector share, so only the app can use the connector's account port. It is made
# once, in the settings file, and an existing value is never changed. A file without the installer's managed part (an
# older or hand-made one) gets the line at its end, so Compose never stops for the missing value. A missing file gets
# nothing: the instance has no settings to run from, and the instance commands say so.
calendar_secret_backfill() { # name
  local env
  env="$(instance_dir "$1")/.env"
  [ -f "$env" ] || return 0
  grep -q '^CALENDAR_ACCOUNT_SECRET=.\{32,\}' "$env" && return 0
  if grep -q '^# >>> managed by the installer' "$env"; then
    env_managed_set "$env" CALENDAR_ACCOUNT_SECRET "$(rand_hex 32)"
    return 0
  fi
  {
    grep -v '^CALENDAR_ACCOUNT_SECRET=' "$env" || true
    printf 'CALENDAR_ACCOUNT_SECRET=%s\n' "$(rand_hex 32)"
  } | write_if_changed "$env" 600 || true
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
  step_begin "start-$name" "Starting instance $name and waiting until it answers"
  # A whole-project start removes the containers of services the compose file no longer lists (--remove-orphans),
  # so a service dropped from the file, like the https front end when an instance closes back to this computer,
  # does not linger as an orphan. Every whole-project start follows this rule.
  dc "$name" up -d ${recreate[@]+"${recreate[@]}"} --wait --wait-timeout 240 --remove-orphans >"$STEP_LOG" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    instance_unhealthy "$name"
    return 1
  fi
  if machine_running; then
    stt_attach "$name" || true
  fi
  stt_forget_old_network "$name"
  # From now on the instance may hold data worth backing up; an instance that never got here holds none.
  if reg_exists "$name"; then reg_set "$name" healthy 1; fi
  step_ok "Instance $name is running and answering"
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
  dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 120 app >"$STEP_LOG" 2>&1 || warn "The app of instance $name did not start again. Run: aman doctor instance --fix"
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
    UI_FD=2 ui_step_end fail "Instance $name did not start, and the installer cannot tell why. This looks like a bug in Aman." "Run install.sh again. If it fails the same way, share the saved log below."
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
AMAN_COMMAND_LIBS="ui shared diagnose network schedule host-report"

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
    warn "The installer has no aman command in it, so that command will be missing."
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
  [ -d "$AMAN_HOME" ] || die "Aman is not set up on this computer yet. Run install.sh first."
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

# The fail records of a doctor JSON document, one plain detail per line, in order. The doctor prints
# records as {"id", "state", "detail", "fix"} in that order, and the pattern allows escaped characters
# inside a detail, so a detail that quotes something is not cut short.
doctor_fail_details() {
  printf '%s' "$1" |
    grep -oE '"state":"fail","detail":"(([^"\\]|\\.)*)"' |
    sed -e 's/^"state":"fail","detail":"//' -e 's/"$//' -e 's/\\"/"/g' -e 's/\\\\/\\/g' || true
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
  # Without a terminal nobody can answer, so the default name is kept.
  if [ -z "$I_NAME" ] && [ ! -t 0 ]; then I_NAME=$name_default; fi
  ask_valid I_NAME "Name for this instance:" "$name_default" "Each person gets a new instance." name_problem
  if [ "$DRY_RUN" = 1 ] && [ -z "$I_EMAIL" ]; then
    I_EMAIL="you@example.invalid"
  fi
  ask_valid I_EMAIL "Your email, used to sign in" "" "Example: you@example.com" email_problem
  I_OWNER_NAME=${OPT_YOUR_NAME:-}
  # Without a terminal nobody can answer, so the start of the email is kept and the name can be changed later.
  if [ -z "$I_OWNER_NAME" ] && [ ! -t 0 ] && [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ]; then
    I_OWNER_NAME=$(owner_name_default "$I_EMAIL")
    say "Aman will call you $I_OWNER_NAME. You can change that later in Personalization."
  fi
  ask_valid I_OWNER_NAME "What should Aman call you?" "$(owner_name_default "$I_EMAIL")" "" display_name_problem
  if [ -n "$I_PUBLIC_URL" ]; then
    valid_origin "$I_PUBLIC_URL" || usage_die "The public address must look like https://aman.example.com, with nothing after the name."
    case "$I_PUBLIC_URL" in https://*) ;; *) usage_die "The public address must start with https://." ;; esac
    [ -n "$I_LOGIN_URL" ] || usage_die "--public-url needs --login-url, a second https address for the sign-in service."
    valid_origin "$I_LOGIN_URL" || usage_die "The login address must look like https://login.example.com, with nothing after the name."
    case "$I_LOGIN_URL" in https://*) ;; *) usage_die "The login address must start with https://." ;; esac
    [ "$I_LOGIN_URL" != "$I_PUBLIC_URL" ] || usage_die "The app and the sign-in service need two different addresses."
  elif [ -n "$I_LOGIN_URL" ]; then
    usage_die "--login-url needs --public-url."
  fi
  instance_collect_addresses
  instance_collect_tls
  instance_collect_token_factory
  ui_ok "Instance $I_NAME for $I_OWNER_NAME ($I_EMAIL)"
}

# --address adds a name or address Aman should also answer at; each is checked as it is read, like every other flag.
instance_collect_addresses() {
  if [ -z "$OPT_ADDRESSES" ]; then return 0; fi
  [ -z "$I_PUBLIC_URL" ] || usage_die "--address is for an instance opened on your network. With --public-url, that public address is the only one."
  [ "$OPT_LOCAL_ONLY" != 1 ] || usage_die "--address and --local-only are opposites; pick one."
}

# --tls caddy serves the two public origins on 443 under DNS names Let's Encrypt can issue for. --tls local (the
# default on a network) serves https with a certificate from this computer's own authority; --tls off keeps plain http.
instance_collect_tls() {
  case "$I_TLS" in
    '') return 0 ;;
    local | off)
      [ -z "$I_PUBLIC_URL" ] || usage_die "--tls $I_TLS is for an instance opened on your network. With --public-url, use --tls caddy."
      [ "$OPT_LOCAL_ONLY" != 1 ] || usage_die "--local-only keeps Aman on this computer, where plain http is fine, so --tls does not apply."
      return 0
      ;;
    caddy) ;;
    *) usage_die "--tls takes local, off or caddy" ;;
  esac
  [ -n "$I_PUBLIC_URL" ] || usage_die "--tls caddy needs --public-url and --login-url (the two https addresses Caddy will serve)"
  [ -z "$OPT_PUBLIC_IP" ] || valid_ipv4 "$OPT_PUBLIC_IP" || usage_die "--public-ip must be an IPv4 address"
  valid_edge_host "$(edge_host "$I_PUBLIC_URL")" || usage_die "--tls caddy needs names: the public address cannot carry a port or be an IP address"
  valid_edge_host "$(edge_host "$I_LOGIN_URL")" || usage_die "--tls caddy needs names: the login address cannot carry a port or be an IP address"
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
    I_PORT=$(pick_port 8791 "$all_reserved") || die "No free port was found on this computer for the app near 8791."
  fi
  if [ -n "${OPT_LOGIN_PORT:-}" ]; then
    check_port_usable "$OPT_LOGIN_PORT" "$all_reserved $I_PORT" "--login-port"
    I_LOGIN_PORT=$OPT_LOGIN_PORT
  else
    I_LOGIN_PORT=$(pick_port 5556 "$all_reserved $I_PORT") || die "No free port was found on this computer for sign-in near 5556."
  fi
  I_ORIGINS=
  I_TLS_PORT=
  I_PUBLIC_ADDRESSES=
  if [ -z "$I_PUBLIC_URL" ]; then
    # The sign-in service is only ever reached on this computer: other devices go through the app.
    I_PUBLIC_URL="http://127.0.0.1:$I_PORT"
    I_LOGIN_URL="http://127.0.0.1:$I_LOGIN_PORT"
    if reach_default_local; then
      # Plain http is fine on this computer only; a --tls meant for the network side does not apply.
      I_TLS=
    else
      I_TLS=${I_TLS:-local}
      # shellcheck disable=SC2086 # OPT_ADDRESSES is a list of checked hosts
      I_ORIGINS=$(network_origin_list "$I_PORT" '' $OPT_ADDRESSES)
      if [ "$I_TLS" = local ] && origins_reach_the_network "$I_ORIGINS"; then
        I_TLS_PORT=$(pick_port 8443 "$all_reserved $I_PORT $I_LOGIN_PORT") || die "No free port was found on this computer for https near 8443."
        # shellcheck disable=SC2086
        I_ORIGINS=$(network_origin_list "$I_PORT" "$I_TLS_PORT" $OPT_ADDRESSES)
      fi
      I_PUBLIC_ADDRESSES=$(network_public_addresses | tr '\n' ' ')
    fi
  fi
  I_ISSUER="$I_LOGIN_URL/dex"
}

# An http issuer is only allowed on this computer; anything else must be https.
issuer_check() {
  case "$1" in
    https://*) ;;
    *) is_loopback_origin "${1%/dex}" || die "A sign-in address without https only works on this computer. Use an https address." ;;
  esac
}

# ---- addresses of an existing instance ----------------------------------------------------------

# An instance from before addresses were listed has no `origins` record at all.
reach_recorded() { grep -q '^origins=' "$(reg_file "$1")"; }

# Where an instance whose reach is not recorded yet stays on this computer: --local-only, or the cloud server default.
reach_default_local() { [ "$OPT_LOCAL_ONLY" = 1 ] || [ "$CLOUD_DEFAULT_LOCAL" = 1 ]; }

# An unrecorded instance opens on the network like a new one unless it stays on this computer by default. A recorded
# reach changes only when --local-only puts it back on this computer.
instance_address_change() { # name; prints open, close, refresh or nothing
  local name=$1
  is_loopback_origin "$(reg_get "$name" public_url)" || return 0
  if ! reach_recorded "$name"; then
    if reach_default_local; then printf 'close'; else printf 'open'; fi
  elif [ "$OPT_LOCAL_ONLY" = 1 ]; then
    if [ -n "$(reg_get "$name" origins)" ]; then printf 'close'; fi
  elif [ -n "$(reg_get "$name" origins)" ] && [ "$(tls_target "$name")" != "$(reg_get "$name" tls)" ]; then
    printf 'refresh'
  fi
}

# Writes the list of addresses of an instance into its record and its settings: read again from this computer, plus
# the names given with --address (kept from the first install unless new ones are given). Renders and restarts nothing.
instance_apply_addresses() { # name open|close|refresh
  local name=$1 mode=$2 origins='' extras env tls='' tls_port='' app_port
  env="$(instance_dir "$name")/.env"
  app_port=$(reg_get "$name" app_port)
  extras=${OPT_ADDRESSES:-$(reg_get "$name" extra_hosts)}
  if [ "$mode" != close ]; then
    tls=$(tls_target "$name")
    # shellcheck disable=SC2086 # the extras are checked hosts without spaces
    origins=$(network_origin_list "$app_port" '' $extras)
    if [ "$tls" = local ] && origins_reach_the_network "$origins"; then
      tls_port=$(reg_get "$name" tls_port)
      if [ -z "$tls_port" ]; then
        tls_port=$(pick_port 8443 "$(reg_all app_port) $(reg_all login_port) $(reg_all tls_port)") || die "No free port was found on this computer for https near 8443."
      fi
      # shellcheck disable=SC2086
      origins=$(network_origin_list "$app_port" "$tls_port" $extras)
    fi
  else
    extras=
  fi
  reg_set "$name" tls "$tls"
  reg_set "$name" tls_port "$tls_port"
  reg_set "$name" origins "$origins"
  reg_set "$name" extra_hosts "$extras"
  env_managed_set "$env" ALLOWED_ORIGINS "$origins"
  log_event "instance $name addresses $mode"
}

# ---- create / list / remove -------------------------------------------------------------------

instance_create() {
  local dir cookie client_id client_secret api_key hash created tf_cap_on=0 demo_on=0 network_on=0
  dir=$(instance_dir "$I_NAME")
  if reg_exists "$I_NAME"; then
    say "Instance $I_NAME already exists. Making sure it is running."
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
    "CLIENT_SECRET=$client_secret" "OWNER_EMAIL=$I_EMAIL" "OWNER_NAME=$I_OWNER_NAME" "API_KEY=$api_key" \
    "IF_TOKEN_FACTORY=$I_TF" "TF_KEY=$AMAN_TF_KEY" "TF_MODEL=$I_TF_MODEL" "IF_TF_CAP=$tf_cap_on" "TF_CAP=$I_TF_CAP" "IF_DEMO=$demo_on" |
    write_if_changed "$dir/.env" 600 || true
  AMAN_TF_KEY=
  render_template "$TEMPLATES_DIR/instance/dex.env.tpl" "PASSWORD_HASH=$hash" | write_if_changed "$dir/dex.env" 600 || true
  created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  reg_write "$I_NAME" "name=$I_NAME" "app_port=$I_PORT" "login_port=$I_LOGIN_PORT" "public_url=$I_PUBLIC_URL" \
    "login_url=$I_LOGIN_URL" "owner_email=$I_EMAIL" "owner_name=$I_OWNER_NAME" "cookie_suffix=$cookie" "client_id=$client_id" \
    "healthy=0" "origins=$I_ORIGINS" "extra_hosts=$OPT_ADDRESSES" "sandbox=$I_SANDBOX" "tls=$I_TLS" "tls_port=$I_TLS_PORT" "token_factory=$I_TF" "tf_model=$I_TF_MODEL" \
    "tf_cap=$I_TF_CAP" "demo=$demo_on" "created=$created"
  INSTANCE_PENDING=
  instance_render "$I_NAME" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  if docker_volume_exists "aman_${I_NAME}_data"; then
    warn "An earlier instance with this name left data behind (aman_${I_NAME}_data), which this one takes over."
  fi
  log_event "instance $I_NAME created"
  instance_up "$I_NAME"
}

print_proxy_requirements() {
  say "Requirements for your reverse proxy (nothing is configured for you):"
  say "  - One https origin for the app and a separate one for login. Never a path prefix."
  say "      $1  ->  forward to http://127.0.0.1:$2"
  say "      $3  ->  forward to the same http://127.0.0.1:$2 (the app passes sign-in pages through and limits guessing)"
  say "  - Forward the original Host header unchanged, and set X-Forwarded-For to the visitor's address."
  say "  - Do not buffer responses: chat replies stream. Allow read timeouts of at least 10 minutes."
  say "  - Allow request bodies of at least 36 MiB."
  say "  - Containers on this machine must resolve both names and trust their certificates;"
  say "    the app contacts the login origin from inside its container."
}

# The stdin answers were read before any prompt could take one; the sign-in password is checked here.
read_password_first() {
  if [ "$PASSWORD_FROM_STDIN" = 1 ] && [ "$DRY_RUN" != 1 ]; then
    ask_password AMAN_PASSWORD
  fi
}

# How an address of the Open row is told apart, so the ones other devices use come first.
origin_kind() { # origin
  local host
  host=$(origin_host "$1")
  case "$host" in
    127.0.0.1 | localhost) echo loopback ;;
    *.ts.net) echo tailscale ;;
    *.local) echo local ;;
    *) if valid_ipv4 "$host"; then echo address; else echo name; fi ;;
  esac
}

# The origins of a comma list, one per line: addresses of this computer on the network first, then its names, then the
# ones that only work on this computer.
origins_display_order() { # comma list
  local kind origin
  for kind in address tailscale local name loopback; do
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
      tailscale | local) if [ -z "$bookmark" ]; then bookmark=$(origin_host "$origin"); fi ;;
    esac
  done < <(origins_display_order "${origins:-$url}")
  ui_check_row ok "Sign in" "$(reg_get "$name" owner_email)"
  print_model_row "$name"
  if instance_sandbox_wanted "$name"; then
    case "$SANDBOX_FAILED_NAMES " in
      *" $name "*) ui_check_row warn "Run code" "not ready: $(sandbox_repair_command)" ;;
      *) ui_check_row ok "Run code" "on, in a sandbox, with PDF and image reading" ;;
    esac
  else
    ui_check_row skip "Run code" "off, with no PDF or image reading (installed with --no-sandbox)"
  fi
  ui_check_row ok "Data" "saved in Docker"
  print_backups_row
  if edge_wanted "$name"; then
    ui_check_row ok "HTTPS" "on, with certificates from Let's Encrypt"
  fi
  if demo_env_on "$name"; then
    ui_check_row ok "Demo" "on. Fill again: $(demo_seed_command "$name") [--reset]"
  fi
  if edge_wanted "$name"; then
    edge_print_firewall_hint
  elif [ -n "$origins" ]; then
    if tls_active "$name"; then
      print_trust_lines "$name"
    else
      ui_line "Sign-in on your home network is not encrypted. Use the Tailscale address to keep it private."
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
  ui_line "On each device, the browser will first warn that the page is not private. Do not click past the warning."
  ui_line "Instead, open this page once on that device and follow its steps: $link"
  ui_line "On an iPhone: open it in Safari, install the profile, then turn it on in Settings, General, About, Certificate Trust Settings."
  ui_line "Your device will show a long code called a fingerprint. It must be $(tls_fingerprint). If it differs, stop."
  if [ "$TLS_AUTHORITY_REPLACED" = 1 ]; then
    ui_line "This computer's root certificate was made again, so each device must trust it again."
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
        ui_check_row warn "Backups" "not scheduled. Fix: aman doctor backup --fix"
      fi
      ;;
    off) ui_check_row skip "Backups" "off. Turn on: aman doctor backup --fix" ;;
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
  if [ ! -f "$RELEASE_DIR/release.json" ] || [ ! -d "$MACHINE_DIR" ]; then
    die "Aman is not set up on this computer yet. Run install.sh first."
  fi
}

load_installed_release() {
  release_load "$RELEASE_DIR/release.json" || die "The record of the installed version cannot be read. Run install.sh again."
  REL_APP_TAG=$CUR_APP_TAG
  REL_STT_TAG=$CUR_STT_TAG
  REL_CALENDAR_TAG=$CUR_CALENDAR_TAG
  REL_DEX_IMAGE=$CUR_DEX_IMAGE
  REL_MAIL_EMAIL_IMAGE=$CUR_MAIL_EMAIL_IMAGE
  docker_image_exists "$REL_APP_TAG" || die "Part of Aman ($REL_APP_TAG) is missing. Run install.sh to build it again."
}

# The instance commands never build, so they say when this checkout holds newer code than what they run.
warn_if_installed_older() {
  [ "$CUR_APP_TAG" = "$(checkout_app_tag)" ] ||
    warn "The installed Aman is not the same version as this copy of its code. To use this code, run: installer/install.sh upgrade"
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
  # The name is recorded first, so a lost OWNER_NAME is put back with it rather than empty.
  owner_name_backfill "$name"
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
    "CLIENT_SECRET=$(rand_hex 32)" "OWNER_EMAIL=$(reg_get "$name" owner_email)" "OWNER_NAME=$(reg_get "$name" owner_name)" "API_KEY=$(rand_hex 32)" \
    "IF_TOKEN_FACTORY=$tf_on" "TF_KEY=unused" "TF_MODEL=$(reg_get "$name" tf_model)" "IF_TF_CAP=$tf_cap_on" "TF_CAP=$tf_cap" "IF_DEMO=$demo_on")
  if [ "$restored" -gt 0 ]; then ui_ok "Put back $restored lost settings of instance $name"; fi
}

# Removes every sign-in user but the owner from instance NAME, says which and logs it. Returns 1 when there was nothing
# to remove. The order keeps a crash safe: records, then the allowed emails, then dex.yaml with the owner only, and only
# then the hashes dex.env still holds, so Dex never points at a hash that is gone. The caller restarts the instance.
instance_enforce_single_owner() { # name
  local name=$1 dir list key line env
  dir=$(instance_dir "$name")
  env="$dir/.env"
  list=$(extra_sign_in_users "$(reg_file "$name")" "$dir")
  [ -n "$list" ] || return 1
  while IFS= read -r key; do
    reg_unset "$name" "$key"
  done < <(LC_ALL=C sed -n 's/^\(user_[a-z0-9-]*\)=.*/\1/p' "$(reg_file "$name")")
  if [ -f "$env" ]; then
    env_managed_set "$env" OIDC_ALLOWED_EMAILS "$(reg_get "$name" owner_email)"
    env_drop_outside_block "$env" OIDC_ALLOWED_EMAILS
  fi
  instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  if [ -f "$dir/dex.env" ]; then
    {
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          'DEX_USER_PASSWORD_HASH_'* | '# >>> sign-in users added with'* | '# <<< end of user hashes'*) ;;
          *) printf '%s\n' "$line" ;;
        esac
      done <"$dir/dex.env"
    } | write_if_changed "$dir/dex.env" 600 || true
  fi
  say "Removed $list from instance $name."
  log_event "removed $list from instance $name; an upgrade rollback restores the database but not these accounts"
}

# The one instance a command targets: the name after the command, else --instance, else the only one.
instance_pick() {
  local name=${OPT_NAME:-${OPT_INSTANCE:-}} names
  if [ -n "${OPT_NAME:-}" ] && [ -n "${OPT_INSTANCE:-}" ] && [ "$OPT_NAME" != "$OPT_INSTANCE" ]; then
    usage_die "Two different instances were named ($OPT_NAME and $OPT_INSTANCE). Name one."
  fi
  if [ -z "$name" ]; then
    names=$(reg_names)
    case "$names" in
      '') die "No instance exists yet. Run install.sh first." ;;
      *$'\n'*) usage_die "several instances exist ($(printf '%s' "$names" | tr '\n' ' ')); say which with --instance NAME" ;;
    esac
    name=$names
  fi
  valid_name "$name" || usage_die "invalid instance name"
  reg_exists "$name" || die "instance $name does not exist"
  printf '%s' "$name"
}

# Starts the sign-in service again, so a failed step does not leave the instance without sign-in.
instance_dex_up() { # name
  dc "$1" up -d --force-recreate --no-deps --wait --wait-timeout 240 dex >/dev/null 2>&1
}

# Sessions are signed with the sign-in service's keys, which it keeps in its database. Clearing the database while the
# service is stopped makes it start with new keys, and the app starts again so it forgets the old ones: every earlier
# sign-in ends. The volume belongs to the Dex user, so the delete runs as that user in the Dex image. The new hash is
# written only after the delete worked, and a failure before that starts the service again with the old password.
instance_set_password() { # name, new dex.env content, new hash
  local name=$1 content=$2 hash=$3 dir
  dir=$(instance_dir "$name")
  dc "$name" stop dex >/dev/null 2>&1 ||
    die "The sign-in service of instance $name did not stop. Nothing was changed: the old password and the old sign-ins still work. Run: aman doctor instance --fix, then run aman password again."
  if ! D run --rm --network none --user 1001:1001 -v "aman_${name}_dex:/var/dex" --entrypoint sh "$REL_DEX_IMAGE" -c 'rm -f /var/dex/dex.db /var/dex/dex.db-wal /var/dex/dex.db-shm' >/dev/null 2>&1; then
    instance_dex_up "$name" || true
    die "The old sign-ins could not be ended. Nothing was changed: the old password and every old sign-in still work. Run aman password again; if it fails again, run: aman doctor instance --fix"
  fi
  printf '%s\n' "$content" | write_if_changed "$dir/dex.env" 600 || true
  if ! grep -qF -- "$hash" "$dir/dex.env"; then
    instance_dex_up "$name" || true
    die "Everyone was signed out, but the new password could not be saved, so the old password still works. Run aman password again."
  fi
  instance_dex_up "$name" ||
    die "The password was changed and the old sign-ins ended, but the sign-in service did not start again. Run: aman doctor instance --fix"
  dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 240 app >/dev/null 2>&1 ||
    die "The password was changed, but the app of instance $name did not start again, so old sign-ins can keep working for up to ten minutes. Run: aman doctor instance --fix"
}

# Changes the owner's password. Running it on this computer is the proof of ownership; the old password is not asked for.
cmd_instance_password() {
  local name email hash content
  require_installed
  name=$(instance_pick)
  email=$(reg_get "$name" owner_email)
  docker_prepare
  lock_acquire
  load_installed_release
  warn_if_installed_older
  AMAN_PASSWORD=
  ask_password AMAN_PASSWORD "Enter a new password for $email" "Enter the new password again"
  hash=$(hash_password "$REL_APP_TAG")
  AMAN_PASSWORD=
  content=$(render_template "$TEMPLATES_DIR/instance/dex.env.tpl" "PASSWORD_HASH=$hash")
  instance_set_password "$name" "$content" "$hash"
  log_event "owner password changed for instance $name; every sign-in ended"
  say "Everyone is signed out of instance $name."
  say "Password changed. Sign in again with the new password."
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
  warn_if_installed_older
  change=$(instance_address_change "$name")
  if [ -n "$change" ]; then
    instance_apply_addresses "$name" "$change"
  elif [ -n "$(reg_get "$name" origins)" ]; then
    instance_apply_addresses "$name" refresh
  fi
  instance_env_repair "$name"
  instance_enforce_single_owner "$name" || true
  instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  instance_up "$name" recreate
  refresh_report "$name"
  print_instance_block "$name"
}

# Runs the doctor so the app's saved report is current after a refresh; its own result is not used here.
refresh_report() { # name
  [ -x "$(doctor_shim)" ] || return 0
  AMAN_REPORT_COMMAND=refresh DOCTOR_TIMEOUT=180 run_doctor --json --instance "$1" >/dev/null 2>&1 || true
}

# A name typed for a new instance must also be free; naming an existing one is only for re-running instance add on it.
new_instance_name_problem() {
  local problem
  problem=$(name_problem "$1")
  if [ -n "$problem" ]; then
    echo "$problem"
  elif reg_exists "$1"; then
    echo "An instance called $1 already exists. Pick another name."
  fi
}

cmd_instance_add() {
  if [ -z "${OPT_NAME:-}" ]; then
    # Only a person at a terminal can answer; anything else still needs the name on the command line.
    if [ ! -t 0 ] || [ "$ASSUME_YES" = 1 ] || [ "$DRY_RUN" = 1 ]; then
      usage_die "usage: install.sh instance add <name> [--email ...]"
    fi
    require_installed
    ask_valid OPT_NAME "Name for this instance:" "" "" new_instance_name_problem
  fi
  valid_name "$OPT_NAME" || usage_die "$(name_problem "$OPT_NAME")"
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  warn_if_installed_older
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
    say "Would create instance $I_NAME for $I_EMAIL, opening at ${I_ORIGINS:-$I_PUBLIC_URL}. Nothing was changed."
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
  local name state person
  if [ -z "$(reg_names)" ]; then
    say "No instances yet. Run install.sh or install.sh instance add <name>."
    return 0
  fi
  docker_plan_access
  case "$DOCKER_ACCESS" in
    direct | sg) AMAN_DOCKER_MODE=$DOCKER_ACCESS ;;
    *) warn "Docker is not running or not reachable, so the STATE column is unknown" ;;
  esac
  {
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' NAME 'APP PORT' 'SIGN-IN PORT' STATE DOCTOR PERSON ADDRESS
    for name in $(reg_names); do
      state=unknown
      case "$DOCKER_ACCESS" in direct | sg) state=$(instance_state "$name") ;; esac
      person=$(reg_get "$name" owner_name)
      [ -n "$person" ] || person=$(reg_get "$name" owner_email)
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$(reg_get "$name" app_port)" "$(reg_get "$name" login_port)" \
        "$state" "$(doctor_status "$name")" "$person" "$(reg_get "$name" public_url)"
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

# After the last instance is purged: the shared speech-to-text project with its volumes, the daily backup job and
# the installer's own folders. The removal log and the backups stay; backups are the person's data.
machine_purge() {
  if [ -f "$MACHINE_DIR/compose.yaml" ] && [ -f "$MACHINE_DIR/.env" ]; then
    dcm down --volumes --remove-orphans >/dev/null 2>&1 || warn "could not stop the speech-to-text service cleanly; continuing with the removal"
  fi
  projects_purge aman-machine
  # shellcheck disable=SC2046 # volume names are single words
  volumes_purge $(machine_volumes) || exit 1
  backup_schedule_disable
  installer_state_remove
}

# Deletes the installer's folders under the home folder; never anything else, and never through a symbolic link.
installer_state_remove() {
  local entry
  case "$AMAN_HOME" in / | "$HOME" | "") return 0 ;; esac
  # A --home that points at a source checkout must keep its own lib, bin and release folders.
  [ -e "$AMAN_HOME/.git" ] || [ -d "$AMAN_HOME/installer" ] && return 0
  [ -d "$STATE_DIR" ] && [ ! -L "$AMAN_HOME" ] && [ ! -L "$STATE_DIR" ] || return 0
  for entry in instances machine tls lib bin release runtime; do
    rm -rf -- "${AMAN_HOME:?}/$entry"
  done
  find "$STATE_DIR" -mindepth 1 -maxdepth 1 ! -name install.log ! -name lock -exec rm -rf -- {} +
}

# On a failed run that may have left parts of a new instance in Docker: the one command that removes them.
instance_pending_notice() {
  [ -n "$INSTANCE_PENDING" ] || return 0
  printf 'To clean up what this run left behind, run: install.sh instance remove %s --purge-data\n' "$INSTANCE_PENDING" >&2
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
    warn "The data could not be deleted:$failed. Something may still be using it. Stop that, then run the removal with --purge-data again."
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
  [ "$typed" = "$name" ] || die "The name you typed does not match, so nothing was removed."
}

cmd_instance_remove() {
  local name=${OPT_NAME:-} exists=0 slots=0 left=0 machine_left=0 last_one=0 volumes='' purge_list line
  [ -n "$name" ] || usage_die "usage: install.sh instance remove <name> [--purge-data]"
  valid_name "$name" || usage_die "invalid instance name"
  if reg_exists "$name" || [ -d "$(instance_dir "$name")" ]; then
    exists=1
    if instance_sandbox_wanted "$name"; then slots=1; fi
  fi
  if [ "$exists" = 0 ]; then
    if docker_reach_quietly; then
      volumes=$(instance_volumes "$name" | tr '\n' ' ')
      volumes=${volumes% }
      if instance_has_leftovers "$name"; then left=1; fi
    fi
    # A removal that stopped while deleting the sandboxes leaves them behind; the same command finishes it.
    if sandbox_slots_left "$name"; then slots=1; fi
    # The shared speech-to-text service goes with the last instance, so it counts as something left to do.
    if [ "${OPT_PURGE:-0}" = 1 ] && [ -z "$(reg_names)" ] && machine_has_leftovers; then machine_left=1; fi
    if [ "$left" = 0 ] && [ "$slots" = 0 ] && [ "$machine_left" = 0 ]; then
      say "Instance $name does not exist; nothing to do."
      return 0
    fi
    if [ "${OPT_PURGE:-0}" != 1 ]; then
      if [ -n "${volumes// /}" ]; then
        say "Instance $name is already removed, but its data is still here: $volumes"
        say "To delete the data: install.sh instance remove $name --purge-data"
      elif [ "$slots" = 1 ]; then
        say "Instance $name is already removed, but its sandboxes are still on this computer."
        say "To delete them: install.sh instance remove $name --purge-data"
      else
        say "Instance $name is already removed, but Docker still holds parts of it."
        say "To delete them: install.sh instance remove $name --purge-data"
      fi
      return 0
    fi
  fi
  if [ "${OPT_PURGE:-0}" = 1 ]; then
    confirm_purge_name "$name"
  fi
  docker_prepare
  lock_acquire
  if [ "$slots" = 1 ] && sandbox_down_needs_root "$name" "${OPT_PURGE:-0}"; then
    root_ready "nothing was changed"
  fi
  if [ "$exists" = 1 ]; then
    if [ -f "$(instance_dir "$name")/compose.yaml" ] && [ -f "$(instance_dir "$name")/.env" ]; then
      stt_detach "$name"
      dc "$name" down || warn "The instance did not stop cleanly. Removing it anyway."
    fi
    if [ "$slots" = 1 ]; then sandbox_down "$name" "${OPT_PURGE:-0}"; fi
    edge_remove "$name"
    remove_instance_dir "$name"
    reg_remove "$name"
    log_event "instance $name removed"
  elif [ "$slots" = 1 ]; then
    sandbox_down "$name" 1
    log_event "sandboxes of removed instance $name deleted"
  fi
  [ -n "$(reg_names)" ] || last_one=1
  if [ "${OPT_PURGE:-0}" != 1 ]; then
    say "Removed instance $name. Its data is kept (aman_${name}_data and aman_${name}_dex)."
    if [ "$last_one" = 1 ]; then
      say "The shared speech-to-text service and its downloaded model are kept too."
    fi
    say "To delete the data too: install.sh instance remove $name --purge-data"
    return 0
  fi
  stt_detach "$name"
  projects_purge "aman-$name" "$name-slots"
  volumes=$(instance_volumes "$name" | tr '\n' ' ')
  volumes=${volumes% }
  if [ -n "$volumes" ]; then
    read -r -a purge_list <<<"$volumes"
    volumes_purge "${purge_list[@]}" || exit 1
    line="Removed instance $name and deleted its data: $volumes"
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
