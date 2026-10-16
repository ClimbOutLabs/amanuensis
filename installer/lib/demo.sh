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

demo_plan_text() {
  printf 'Turn demo mode on for instance %s and seed the synthetic demo world for %s' "$1" "$2"
}

# Sets DEMO_MODE=true in the managed block and restarts the app when that changed it.
demo_enable() {
  local name=$1 env
  env="$(instance_dir "$name")/.env"
  reg_set "$name" demo 1
  demo_env_on "$name" && return 0
  env_managed_set "$env" DEMO_MODE true
  log_event "demo mode turned on for instance $name"
  say "Demo mode on for instance $name; restarting the app"
  dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 240 app || {
    warn "The app of instance $name did not restart healthy. Run: aman doctor instance --fix"
    return 1
  }
}

# demo_seed_run NAME USER RESET: runs the CLI inside the running app container, which has the instance database and memory.
demo_seed_run() {
  local name=$1 user=$2 reset=$3 args
  args=(demo-seed --user "$user")
  if [ "$reset" = 1 ]; then args+=(--reset); fi
  if [ "$(instance_state "$name")" != running ]; then
    warn "instance $name is not running, so the demo world was not seeded. Start it with install.sh, then run: $(demo_seed_command "$name")"
    return 1
  fi
  say "Seeding the demo world for $user on instance $name"
  dc "$name" exec -T app aman "${args[@]}" || {
    warn "the demo seed failed. Run it again with: $(demo_seed_command "$name")"
    return 1
  }
  log_event "demo seed ${args[*]:2} on instance $name"
}

demo_seed_command() {
  printf '%s instance demo-seed --instance %s' "$INSTALLER_DIR/install.sh" "$1"
}

# After the instance is healthy: turn demo mode on and seed. A failure is reported and fails the run at its end.
demo_install_apply() {
  local name=$1
  { demo_enable "$name" && demo_seed_run "$name" "$(reg_get "$name" owner_email)" 0; } || DEMO_FAILED=1
}

# The one instance demo-seed targets: --instance, else the only one.
demo_seed_instance() {
  local name=${OPT_INSTANCE:-} names
  if [ -z "$name" ]; then
    names=$(reg_names)
    case "$names" in
      '') die "no instance exists yet; run install.sh first" ;;
      *$'\n'*) usage_die "several instances exist ($(printf '%s' "$names" | tr '\n' ' ')); say which with --instance NAME" ;;
    esac
    name=$names
  fi
  valid_name "$name" || usage_die "invalid instance name"
  reg_exists "$name" || die "instance $name does not exist"
  printf '%s' "$name"
}

# The demo world is always the owner's: an instance has one account.
cmd_instance_demo_seed() {
  local name
  [ -z "${OPT_NAME:-}" ] || usage_die "usage: install.sh instance demo-seed [--reset] [--instance NAME]"
  require_installed
  name=$(demo_seed_instance)
  demo_env_on "$name" ||
    die "instance $name is not a demo instance. Turn demo mode on and seed it with: install.sh --demo --name $name"
  docker_prepare
  lock_acquire
  demo_seed_run "$name" "$(reg_get "$name" owner_email)" "$OPT_RESET" || exit 1
}
