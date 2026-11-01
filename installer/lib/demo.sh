# shellcheck shell=bash
# Demo instances: DEMO_MODE in the instance .env gates `aman demo-seed`, which the installer runs inside the app container.

DEMO_FAILED=0

# The instance --demo applies to: the one being created, else --name, else the only instance.
demo_target() {
  local names
  if need_new_instance; then
    printf '%s' "$I_NAME"
    return 0
  fi
  if [ -n "${OPT_NAME:-}" ]; then
    printf '%s' "$OPT_NAME"
    return 0
  fi
  names=$(reg_names)
  case "$names" in
    *$'\n'*) usage_die "several instances exist ($(printf '%s' "$names" | tr '\n' ' ')); say which with --name" ;;
  esac
  printf '%s' "$names"
}

demo_env_on() {
  [ "$(env_get "$(instance_dir "$1")/.env" DEMO_MODE)" = true ]
}

# The Tavily key of a demo install: read from stdin, kept in shell memory, and written only to the instance .env.

# The length is counted here, not in the pattern: macOS regex refuses repeat counts above 255.
valid_tavily_key() { [ "${#1}" -ge 16 ] && [ "${#1}" -le 512 ] && matches_whole "$1" '^[A-Za-z0-9._~+/=-]+$'; }

# The key is never echoed in a message, only its problem.
tavily_key_problem() {
  valid_tavily_key "$1" || echo "The Tavily key has a length or characters a key never has."
}

# The --tavily-key-stdin line, from stdin_answers_read.
tavily_key_take() {
  [ -n "$1" ] || usage_die "The Tavily key line of the input was empty. Put the key on its own line, in the order install.sh --help gives."
  [ -z "$(tavily_key_problem "$1")" ] || usage_die "$(tavily_key_problem "$1")"
  AMAN_TAVILY_KEY=$1
}

demo_tavily_on() {
  local env
  env="$(instance_dir "$1")/.env"
  [ "$(env_get "$env" SEARCH_PROVIDER)" = tavily ] && [ "$(env_get "$env" TAVILY_API_KEY)" = "$AMAN_TAVILY_KEY" ]
}

# Sets SEARCH_PROVIDER=tavily and TAVILY_API_KEY in the managed block from the --tavily-key-stdin key, and restarts
# the app when that changed the settings. Without a key it does nothing. The key only passes through shell builtins.
demo_tavily_apply() {
  local name=$1 env
  [ -n "$AMAN_TAVILY_KEY" ] || return 0
  if demo_tavily_on "$name"; then
    AMAN_TAVILY_KEY=
    return 0
  fi
  env="$(instance_dir "$name")/.env"
  env_managed_set "$env" SEARCH_PROVIDER tavily
  env_managed_set "$env" TAVILY_API_KEY "$AMAN_TAVILY_KEY"
  AMAN_TAVILY_KEY=
  log_event "demo instance $name searches the web with Tavily"
  say "Instance $name now searches the web with Tavily. Restarting the app."
  dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 240 app || {
    warn "The app of instance $name did not start again. Run: aman doctor instance --fix"
    return 1
  }
}

demo_plan_text() {
  printf 'Turn demo mode on for instance %s and fill it with example data for %s' "$1" "$2"
}

# Sets DEMO_MODE=true in the managed block and restarts the app when that changed it.
demo_enable() {
  local name=$1 env
  env="$(instance_dir "$name")/.env"
  reg_set "$name" demo 1
  demo_env_on "$name" && return 0
  env_managed_set "$env" DEMO_MODE true
  log_event "demo mode turned on for instance $name"
  say "Demo mode is on for instance $name. Restarting the app."
  dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 240 app || {
    warn "The app of instance $name did not start again. Run: aman doctor instance --fix"
    return 1
  }
}

# demo_seed_run NAME USER RESET [FRESH]: runs the CLI inside the running app container, which has the instance database and memory.
demo_seed_run() {
  local name=$1 user=$2 reset=$3 fresh=${4:-0} args
  args=(demo-seed --user "$user")
  if [ "$reset" = 1 ]; then args+=(--reset); fi
  if [ "$fresh" = 1 ]; then args+=(--fresh); fi
  if [ "$(instance_state "$name")" != running ]; then
    warn "Instance $name is not running, so no example data was added. Start it with install.sh, then run: $(demo_seed_command "$name")"
    return 1
  fi
  if [ "$fresh" = 1 ]; then
    say "Removing everything $user made on instance $name, then adding the example data again"
  else
    say "Adding example data for $user to instance $name"
  fi
  dc "$name" exec -T app aman "${args[@]}" || {
    if [ "$fresh" = 1 ]; then
      warn "Starting fresh did not finish. Check what is left, then run it again with: $(demo_seed_command "$name") --fresh"
    else
      warn "Adding the example data failed. Run it again with: $(demo_seed_command "$name")"
    fi
    return 1
  }
  log_event "demo seed ${args[*]:2} on instance $name"
}

demo_seed_command() {
  printf '%s instance demo-seed --instance %s' "$INSTALLER_DIR/install.sh" "$1"
}

# After the instance is healthy: give it the Tavily key when one was supplied, turn demo mode on and seed.
# A failure is reported and fails the run at its end.
demo_install_apply() {
  local name=$1
  { demo_tavily_apply "$name" && demo_enable "$name" && demo_seed_run "$name" "$(reg_get "$name" owner_email)" 0; } || DEMO_FAILED=1
}

# The demo world is always the owner's.
cmd_instance_demo_seed() {
  local name
  [ -z "${OPT_NAME:-}" ] || usage_die "usage: install.sh instance demo-seed [--reset | --fresh] [--instance NAME]"
  require_installed
  name=$(instance_pick)
  if ! demo_env_on "$name"; then
    [ "$OPT_FRESH" = 1 ] && die "Start fresh only works on a demo instance, and instance $name is not one. Nothing was removed. To make it a demo instance, run: install.sh --demo --name $name"
    die "Instance $name is not a demo instance. Turn demo mode on and add example data with: install.sh --demo --name $name"
  fi
  docker_prepare
  lock_acquire
  demo_seed_run "$name" "$(reg_get "$name" owner_email)" "$OPT_RESET" "$OPT_FRESH" || exit 1
}
