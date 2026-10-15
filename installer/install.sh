#!/usr/bin/env bash
# Amanuensis installer: plan, local image builds, shared speech-to-text, per-person instances and their sandbox.
# Usage: install.sh [--dry-run] [--yes] [options]
#        install.sh instance add|list|remove <name>
#        install.sh instance add-user|remove-user|list-users
#        install.sh instance demo-seed [--reset]
#        install.sh backup [<name>]
#        install.sh upgrade [--check] [--force]
set -euo pipefail
# Everything written is private unless a file is deliberately made world-readable.
umask 077
# A password or key in the caller's environment is never used and must not reach a child process.
unset AMAN_PASSWORD AMAN_TF_KEY NEBIUS_API_KEY

INSTALLER_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=${AMAN_REPO_ROOT:-$(cd -P -- "$INSTALLER_DIR/.." && pwd)}
TEMPLATES_DIR=$INSTALLER_DIR/templates
PINS_FILE=$INSTALLER_DIR/release.json
DOWNLOADS_FILE=$INSTALLER_DIR/downloads.txt

# shellcheck source=lib/ui.sh
. "$INSTALLER_DIR/lib/ui.sh"
# shellcheck source=lib/common.sh
. "$INSTALLER_DIR/lib/common.sh"
# shellcheck source=lib/diagnose.sh
. "$INSTALLER_DIR/lib/diagnose.sh"
# shellcheck source=lib/docker.sh
. "$INSTALLER_DIR/lib/docker.sh"
# shellcheck source=lib/ports.sh
. "$INSTALLER_DIR/lib/ports.sh"
# shellcheck source=lib/secrets.sh
. "$INSTALLER_DIR/lib/secrets.sh"
# shellcheck source=lib/registry.sh
. "$INSTALLER_DIR/lib/registry.sh"
# shellcheck source=lib/release.sh
. "$INSTALLER_DIR/lib/release.sh"
# shellcheck source=lib/templates.sh
. "$INSTALLER_DIR/lib/templates.sh"
# shellcheck source=lib/sandbox.sh
. "$INSTALLER_DIR/lib/sandbox.sh"
# shellcheck source=lib/tokenfactory.sh
. "$INSTALLER_DIR/lib/tokenfactory.sh"
# shellcheck source=lib/edge.sh
. "$INSTALLER_DIR/lib/edge.sh"
# shellcheck source=lib/instance.sh
. "$INSTALLER_DIR/lib/instance.sh"
# shellcheck source=lib/users.sh
. "$INSTALLER_DIR/lib/users.sh"
# shellcheck source=lib/demo.sh
. "$INSTALLER_DIR/lib/demo.sh"
# shellcheck source=lib/backup.sh
. "$INSTALLER_DIR/lib/backup.sh"
# shellcheck source=lib/upgrade.sh
. "$INSTALLER_DIR/lib/upgrade.sh"
# shellcheck source=lib/plan.sh
. "$INSTALLER_DIR/lib/plan.sh"

AMAN_HOME=${AMAN_HOME:-$HOME/.amanuensis}
ASSUME_YES=0
DRY_RUN=0
PASSWORD_FROM_STDIN=0
OPT_INSTALL_DOCKER=0
OPT_ADD_DOCKER_GROUP=0
OPT_NO_SANDBOX=0
OPT_HOST_NODE=0
OPT_SANDBOX_ROOT=0
OPT_TLS_ROOT=0
OPT_TF_KEY_STDIN=0
PRINT_ROOT_STEPS=0
PRINT_NETWORK=0
PRINT_PROXY=0
OPT_CHECK=0
OPT_FORCE=0
OPT_PURGE=0
OPT_DEMO=0
OPT_RESET=0
OPT_NAME=
OPT_INSTANCE=
OPT_ROLE=
OPT_EMAIL=
OPT_PUBLIC_URL=
OPT_LOGIN_URL=
OPT_PORT=
OPT_LOGIN_PORT=
OPT_TLS=
OPT_PUBLIC_IP=
OPT_TF_MODEL=
OPT_TF_CAP=
OPT_CONFIRM_NAME=
OPT_DEMO_USER=
COMMAND=install
SUBCOMMAND=
LOCK_HELD=0
AMAN_PASSWORD=
AMAN_TF_KEY=
ui_init

usage() {
  cat <<'USAGE'
Amanuensis installer

  install.sh                      plan, build the images locally, start the shared speech service and a first instance
  install.sh --dry-run            print the plan, change nothing
  install.sh instance add <name>  add another person's instance
  install.sh instance list
  install.sh instance remove <name> [--purge-data]
  install.sh instance add-user <name> --email ADDRESS [--role member] [--instance NAME] [--password-stdin]
  install.sh instance remove-user <name> [--instance NAME]
  install.sh instance list-users [--instance NAME]
  install.sh instance demo-seed [--reset] [--instance NAME] [--demo-user ADDRESS]
  install.sh backup [<name>]
  install.sh upgrade [--check] [--force]

Options
  --home DIR            state directory (default ~/.amanuensis)
  --yes                 accept the plan and the defaults without asking (never installs Docker, changes groups or uses sudo)
  --install-docker      let the installer run the printed root steps to install Docker Engine (Debian, Ubuntu)
  --add-docker-group    let the installer add your user to the docker group (needs sudo)
  --sandbox-root        let the installer run the printed root steps for the sandbox (AppArmor profile, slot disks) without asking
  --tls-root            let the installer run the printed root steps for --tls caddy (install Caddy, apply its configuration) without asking
  --no-sandbox          install without the gVisor sandbox (run code stays off)
  --use-host-node       run the sandbox setup on this computer's Node.js 22.14 or newer instead of downloading a pinned copy
  --verbose             show technical details and the full list of downloads
  --dry-run             stop after printing the plan
  --name NAME           first instance name (default main)
  --email ADDRESS       owner email (with add-user: the new user's email)
  --instance NAME       the instance a user command applies to (default: the only one)
  --role member         role of an added user; members chat but cannot change server settings (the only role)
  --password-stdin      read the owner password (with add-user: the new user's password; otherwise one is generated and shown once) from the first line of stdin, before any prompt
  --token-factory-key-stdin  read the Token Factory key from stdin (the line after the password with --password-stdin); the key is never a command-line value
  --token-factory-model ID   Token Factory model the app uses (default nvidia/nemotron-3-super-120b-a12b)
  --token-factory-daily-cap N  stop answering after N Token Factory tokens per day (default: no cap)
  --demo                mark the instance as a demo (DEMO_MODE=true) and seed its synthetic demo world once it is healthy
  --demo-user ADDRESS   the user the demo world is seeded for (default: the owner)
  --reset               with instance demo-seed, remove the synthetic demo records instead of seeding
  --public-url URL      https address you will use from other devices (behind your own reverse proxy)
  --login-url URL       https address for the sign-in service behind the same proxy
  --port N              port on this computer for the app
  --login-port N        port on this computer for the sign-in service
  --tls caddy           serve --public-url and --login-url over https with Caddy on this computer (Ubuntu package, Let's Encrypt)
  --public-ip ADDRESS   this computer's public IPv4 address for the --tls DNS check (default: ask a lookup service)
  --confirm-name NAME   with --purge-data, the instance name typed in advance
  --print-root-steps    print the root steps for installing Docker and stop
  --print-network       print every host the installer may contact and stop
  --print-proxy-requirements  print what a reverse proxy in front of an instance must do and stop
  --help                this text
USAGE
}

set_paths() {
  STATE_DIR=$AMAN_HOME/state
  REG_DIR=$STATE_DIR/instances
  RELEASE_DIR=$AMAN_HOME/release
  MACHINE_DIR=$AMAN_HOME/machine
  INSTANCES_DIR=$AMAN_HOME/instances
  BACKUPS_DIR=$AMAN_HOME/backups
}

parse_args() {
  local arg positional=0
  while [ "$#" -gt 0 ]; do
    arg=$1
    case "$arg" in
      --help | -h)
        usage
        exit 0
        ;;
      --yes | -y)
        ASSUME_YES=1
        UI_ASSUME_YES=1
        ;;
      --verbose) UI_VERBOSE=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --password-stdin) PASSWORD_FROM_STDIN=1 ;;
      --install-docker) OPT_INSTALL_DOCKER=1 ;;
      --add-docker-group) OPT_ADD_DOCKER_GROUP=1 ;;
      --sandbox-root) OPT_SANDBOX_ROOT=1 ;;
      --no-sandbox) OPT_NO_SANDBOX=1 ;;
      --use-host-node) OPT_HOST_NODE=1 ;;
      --print-root-steps) PRINT_ROOT_STEPS=1 ;;
      --print-network) PRINT_NETWORK=1 ;;
      --print-proxy-requirements) PRINT_PROXY=1 ;;
      --tls-root) OPT_TLS_ROOT=1 ;;
      --token-factory-key-stdin) OPT_TF_KEY_STDIN=1 ;;
      --token-factory-key | --token-factory-key=*) usage_die "the Token Factory key is never taken from the command line; use --token-factory-key-stdin" ;;
      --check) OPT_CHECK=1 ;;
      --force) OPT_FORCE=1 ;;
      --purge-data) OPT_PURGE=1 ;;
      --demo) OPT_DEMO=1 ;;
      --reset) OPT_RESET=1 ;;
      --home | --name | --instance | --role | --email | --public-url | --login-url | --port | --login-port | --confirm-name | --tls | --public-ip | --token-factory-model | --token-factory-daily-cap | --demo-user)
        [ "$#" -ge 2 ] || usage_die "$arg needs a value"
        set_option "$arg" "$2"
        shift
        ;;
      --home=* | --name=* | --instance=* | --role=* | --email=* | --public-url=* | --login-url=* | --port=* | --login-port=* | --confirm-name=* | --tls=* | --public-ip=* | --token-factory-model=* | --token-factory-daily-cap=* | --demo-user=*)
        set_option "${arg%%=*}" "${arg#*=}"
        ;;
      -*) usage_die "unknown option $arg" ;;
      *)
        safe_value "$arg" || usage_die "an argument contains a character that is not allowed"
        positional=$((positional + 1))
        case "$positional:$COMMAND" in
          1:install)
            case "$arg" in
              instance | backup | upgrade) COMMAND=$arg ;;
              *) usage_die "unknown command $arg" ;;
            esac
            ;;
          2:instance) SUBCOMMAND=$arg ;;
          3:instance | 2:backup) OPT_NAME=$arg ;;
          *) usage_die "unexpected argument $arg" ;;
        esac
        ;;
    esac
    shift
  done
}

set_option() {
  case "$1" in
    --home) AMAN_HOME=$2 ;;
    --name) OPT_NAME=$2 ;;
    --instance) OPT_INSTANCE=$2 ;;
    --role) OPT_ROLE=$2 ;;
    --email) OPT_EMAIL=$2 ;;
    --public-url) OPT_PUBLIC_URL=$2 ;;
    --login-url) OPT_LOGIN_URL=$2 ;;
    --port) OPT_PORT=$2 ;;
    --login-port) OPT_LOGIN_PORT=$2 ;;
    --confirm-name) OPT_CONFIRM_NAME=$2 ;;
    --tls) OPT_TLS=$2 ;;
    --public-ip) OPT_PUBLIC_IP=$2 ;;
    --token-factory-model) OPT_TF_MODEL=$2 ;;
    --token-factory-daily-cap) OPT_TF_CAP=$2 ;;
    --demo-user) OPT_DEMO_USER=$2 ;;
  esac
  safe_value "$2" || usage_die "$1 contains a character that is not allowed"
}

print_signout_note() {
  if [ "$NEEDS_SIGNOUT" = 1 ]; then
    ui_newline
    ui_warn "Docker access: this run used your new docker group membership without a re-login." "Sign out and back in (or run: newgrp docker) once so docker works in your other terminals."
  fi
}

# --demo and --demo-user belong to install, instance add and instance demo-seed; --reset only to demo-seed.
check_demo_options() {
  local seeding=0
  if [ "$COMMAND:$SUBCOMMAND" = instance:demo-seed ]; then seeding=1; fi
  if [ "$OPT_DEMO" = 1 ] && { [ "$seeding" = 1 ] || { [ "$COMMAND" != install ] && [ "$SUBCOMMAND" != add ]; }; }; then
    usage_die "--demo applies to install and instance add (instance demo-seed reseeds a demo instance)"
  fi
  if [ "$OPT_RESET" = 1 ] && [ "$seeding" != 1 ]; then
    usage_die "--reset applies to instance demo-seed"
  fi
  if [ -n "$OPT_DEMO_USER" ]; then
    [ "$OPT_DEMO" = 1 ] || [ "$seeding" = 1 ] || usage_die "--demo-user applies with --demo or instance demo-seed"
    valid_email "$OPT_DEMO_USER" || usage_die "--demo-user must be an email address"
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT
  AMAN_PASSWORD=
  AMAN_TF_KEY=
  ui_step_abort
  upgrade_on_exit
  lock_release
  exit "$rc"
}

main() {
  parse_args "$@"
  set_paths
  trap on_exit EXIT
  check_demo_options
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "$PRINT_ROOT_STEPS" = 1 ]; then
    print_root_steps
    if [ "$OPT_TLS" = caddy ]; then
      say ""
      edge_print_root_steps "${OPT_NAME:-main}"
    fi
    exit 0
  fi
  if [ "$PRINT_NETWORK" = 1 ]; then
    print_network_destinations
    exit 0
  fi
  if [ "$PRINT_PROXY" = 1 ]; then
    print_proxy_requirements "https://<app-origin>" "<app port>" "https://<login-origin>" "<login port>"
    exit 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    case "$COMMAND:$SUBCOMMAND" in
      install: | upgrade: | instance:add) ;;
      *) usage_die "--dry-run applies to install, upgrade and instance add" ;;
    esac
  fi
  case "$COMMAND" in
    install) cmd_install ;;
    backup) cmd_backup ;;
    upgrade) cmd_upgrade ;;
    instance)
      case "$SUBCOMMAND" in
        add) cmd_instance_add ;;
        list) cmd_instance_list ;;
        remove) cmd_instance_remove ;;
        add-user) cmd_instance_add_user ;;
        remove-user) cmd_instance_remove_user ;;
        list-users) cmd_instance_list_users ;;
        demo-seed) cmd_instance_demo_seed ;;
        *) usage_die "usage: install.sh instance add|list|remove|add-user|remove-user|list-users|demo-seed" ;;
      esac
      ;;
  esac
}

main "$@"
