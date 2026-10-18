#!/usr/bin/env bash
# Amanuensis installer: plan, local image builds, shared speech-to-text, per-person instances and their sandbox.
# Usage: install.sh [--dry-run] [--yes] [options]
#        install.sh instance add|list|remove <name>
#        install.sh instance demo-seed [--reset]
#        install.sh instance import <name> <file.zip> [--display-name NAME]
#        install.sh migrate --from-compose <folder> [--user ID]
#        install.sh instance refresh <name>
#        install.sh instance password [<name>]
#        install.sh backup [<name>]
#        install.sh backups daily|off
#        install.sh upgrade [--check] [--force]
#        install.sh docker
#        install.sh command
#        install.sh tls
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
# shellcheck source=lib/shared.sh
. "$INSTALLER_DIR/lib/shared.sh"
# shellcheck source=lib/common.sh
. "$INSTALLER_DIR/lib/common.sh"
# shellcheck source=lib/diagnose.sh
. "$INSTALLER_DIR/lib/diagnose.sh"
# shellcheck source=lib/docker.sh
. "$INSTALLER_DIR/lib/docker.sh"
# shellcheck source=lib/network.sh
. "$INSTALLER_DIR/lib/network.sh"
# shellcheck source=lib/shellpath.sh
. "$INSTALLER_DIR/lib/shellpath.sh"
# shellcheck source=lib/tls.sh
. "$INSTALLER_DIR/lib/tls.sh"
# shellcheck source=lib/schedule.sh
. "$INSTALLER_DIR/lib/schedule.sh"
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
# shellcheck source=lib/demo.sh
. "$INSTALLER_DIR/lib/demo.sh"
# shellcheck source=lib/import.sh
. "$INSTALLER_DIR/lib/import.sh"
# shellcheck source=lib/migrate.sh
. "$INSTALLER_DIR/lib/migrate.sh"
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
OPT_LOCAL_ONLY=0
OPT_HOME_NETWORK=0
CLOUD_DEFAULT_LOCAL=0
OPT_ADDRESSES=
OPT_BACKUPS=
OPT_BACKUPS_ARG=
OPT_RESET=0
OPT_NAME=
OPT_INSTANCE=
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
  install.sh instance demo-seed [--reset] [--instance NAME]
  install.sh instance import <name> <file.zip> [--display-name NAME]
                                  back up the instance, then restore a data export into it (stops its app meanwhile)
  install.sh migrate --from-compose <folder> [--user ID]
                                  export your data from an old docker compose Aman in that folder, which is only read
  install.sh instance refresh <name>
  install.sh instance password [<name>]   set a new owner password and sign everyone out (run it on the computer where Aman is installed)
  install.sh backup [<name>]
  install.sh backups daily|off
  install.sh upgrade [--check] [--force]
  install.sh docker               install or start Docker, or update its Compose plugin, asking before sudo
  install.sh command              put the aman command and its files back
  install.sh tls                  renew the https certificates that are due

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
  --email ADDRESS       owner email
  --instance NAME       the instance demo-seed and password apply to (default: the only one)
  --password-stdin      read the owner password (otherwise you are asked) from the first line of stdin, before any prompt
  --token-factory-key-stdin  read the Token Factory key from stdin (the line after the password with --password-stdin); the key is never a command-line value
  --token-factory-model ID   Token Factory model the app uses (default nvidia/nemotron-3-super-120b-a12b)
  --token-factory-daily-cap N  stop answering after N Token Factory tokens per day (default: no cap)
  --demo                mark the instance as a demo (DEMO_MODE=true) and seed its synthetic demo world once it is healthy
  --reset               with instance demo-seed, remove the synthetic demo records instead of seeding
  --local-only          open Aman only at 127.0.0.1 on this computer (by default it answers at every address this computer has on a private network, and at its names)
  --backups daily|off   back up every day (default) or not, without asking
  --address HOST        also answer at this name or private address; repeat for more (for example --address spark.local)
  --public-url URL      https address of Aman behind your own reverse proxy; the ports then stay on 127.0.0.1
  --login-url URL       https address for the sign-in service behind the same proxy
  --home-network        on a cloud server, still answer at its private addresses (they are shared with other customers, so the default there is this computer only)
  --port N              port on this computer for the app
  --login-port N        port on this computer for the sign-in service
  --tls local|off|caddy  https on your network with a certificate from this computer (default), plain http, or
                        --public-url and --login-url over https with Caddy on this computer (Ubuntu package, Let's Encrypt)
  --public-ip ADDRESS   this computer's public IPv4 address for the --tls DNS check (default: ask a lookup service)
  --confirm-name NAME   with --purge-data, the instance name typed in advance
  --display-name NAME   with instance import, your name as imported chats show it (default: asked, or the start of your email)
  --from-compose DIR    with migrate, the folder the old docker compose Aman runs from
  --user ID             with migrate, the old sign-in id to move when more than one person has chats there
  --print-root-steps    print the root steps for installing Docker and stop
  --print-network       print every host the installer may contact and stop
  --print-proxy-requirements  print what a reverse proxy in front of an instance must do and stop
  --help                this text
USAGE
}

set_paths() {
  valid_home_path "$AMAN_HOME" || usage_die "The folder for Aman data must be an absolute path of letters, digits and . _ - + @ : = , or /. Pass --home with such a path."
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
      --local-only) OPT_LOCAL_ONLY=1 ;;
      --home-network) OPT_HOME_NETWORK=1 ;;
      --home | --name | --instance | --email | --public-url | --login-url | --port | --login-port | --confirm-name | --tls | --public-ip | --address | --backups | --token-factory-model | --token-factory-daily-cap | --display-name | --from-compose | --user)
        [ "$#" -ge 2 ] || usage_die "$arg needs a value"
        set_option "$arg" "$2"
        shift
        ;;
      --home=* | --name=* | --instance=* | --email=* | --public-url=* | --login-url=* | --port=* | --login-port=* | --confirm-name=* | --tls=* | --public-ip=* | --address=* | --backups=* | --token-factory-model=* | --token-factory-daily-cap=* | --display-name=* | --from-compose=* | --user=*)
        set_option "${arg%%=*}" "${arg#*=}"
        ;;
      -*) usage_die "unknown option $arg" ;;
      *)
        safe_value "$arg" || usage_die "an argument contains a character that is not allowed"
        positional=$((positional + 1))
        case "$positional:$COMMAND" in
          1:install)
            case "$arg" in
              instance | backup | backups | upgrade | docker | command | tls | migrate) COMMAND=$arg ;;
              *) usage_die "unknown command $arg" ;;
            esac
            ;;
          2:instance) SUBCOMMAND=$arg ;;
          3:instance | 2:backup) OPT_NAME=$arg ;;
          4:instance) OPT_IMPORT_FILE=$arg ;;
          2:backups) OPT_BACKUPS_ARG=$arg ;;
          *) usage_die "unexpected argument $arg" ;;
        esac
        ;;
    esac
    shift
  done
}

set_option() {
  local problem
  case "$1" in
    --home) AMAN_HOME=$2 ;;
    --name) OPT_NAME=$2 ;;
    --instance) OPT_INSTANCE=$2 ;;
    --email) OPT_EMAIL=$2 ;;
    --public-url) OPT_PUBLIC_URL=$2 ;;
    --login-url) OPT_LOGIN_URL=$2 ;;
    --port) OPT_PORT=$2 ;;
    --login-port) OPT_LOGIN_PORT=$2 ;;
    --confirm-name) OPT_CONFIRM_NAME=$2 ;;
    --tls) OPT_TLS=$2 ;;
    --public-ip) OPT_PUBLIC_IP=$2 ;;
    --address)
      problem=$(address_problem "$2")
      [ -z "$problem" ] || usage_die "$problem"
      OPT_ADDRESSES="${OPT_ADDRESSES:+$OPT_ADDRESSES }$2"
      ;;
    --backups)
      case "$2" in daily | off) OPT_BACKUPS=$2 ;; *) usage_die "--backups takes daily or off" ;; esac
      ;;
    --token-factory-model) OPT_TF_MODEL=$2 ;;
    --token-factory-daily-cap) OPT_TF_CAP=$2 ;;
    --display-name) OPT_DISPLAY_NAME=$2 ;;
    --from-compose) OPT_FROM_COMPOSE=$2 ;;
    --user) OPT_MIGRATE_USER=$2 ;;
  esac
  safe_value "$2" || usage_die "$1 contains a character that is not allowed"
}

print_signout_note() {
  if [ "$NEEDS_SIGNOUT" = 1 ]; then
    ui_newline
    ui_warn "Docker access: this run used your new docker group membership without a re-login." "Open a new terminal window once so Docker works in your other terminals."
  fi
}

# --demo belongs to install and instance add; --reset only to instance demo-seed.
check_demo_options() {
  local seeding=0
  if [ "$COMMAND:$SUBCOMMAND" = instance:demo-seed ]; then seeding=1; fi
  if [ "$OPT_DEMO" = 1 ] && { [ "$seeding" = 1 ] || { [ "$COMMAND" != install ] && [ "$SUBCOMMAND" != add ]; }; }; then
    usage_die "--demo applies to install and instance add (instance demo-seed reseeds a demo instance)"
  fi
  if [ "$OPT_RESET" = 1 ] && [ "$seeding" != 1 ]; then
    usage_die "--reset applies to instance demo-seed"
  fi
  if [ "$OPT_LOCAL_ONLY" = 1 ] && [ -n "$OPT_PUBLIC_URL" ]; then
    usage_die "--local-only and --public-url are opposites; pick one."
  fi
  if [ "$OPT_LOCAL_ONLY" = 1 ] && [ "$OPT_HOME_NETWORK" = 1 ]; then
    usage_die "--local-only and --home-network are opposites; pick one."
  fi
}

# On a cloud server a private address is shared with other customers, so an instance whose reach is not recorded yet (a
# new one, or one from before the address list) stays on this computer unless asked. A recorded reach is kept.
cloud_guard() {
  local name undecided=0
  [ "$COMMAND" = install ] || { [ "$COMMAND" = instance ] && [ "$SUBCOMMAND" = add ]; } || return 0
  [ "$OPT_LOCAL_ONLY" != 1 ] && [ "$OPT_HOME_NETWORK" != 1 ] && [ -z "$OPT_PUBLIC_URL" ] && [ -z "$OPT_ADDRESSES" ] || return 0
  network_cloud_vm || return 0
  if need_new_instance; then undecided=1; fi
  if [ "$COMMAND" = install ]; then
    for name in $(reg_names); do reach_recorded "$name" || undecided=1; done
  fi
  [ "$undecided" = 1 ] || return 0
  warn "This looks like a cloud server, where private addresses are shared with other customers, so Aman will open on this computer only. To open it at the private addresses anyway, run this again with --home-network."
  CLOUD_DEFAULT_LOCAL=1
}

on_exit() {
  local rc=$?
  trap - EXIT
  AMAN_PASSWORD=
  AMAN_TF_KEY=
  ui_step_abort
  upgrade_on_exit
  import_on_exit
  migrate_on_exit
  lock_release
  exit "$rc"
}

main() {
  # The installer's own checks run the aman command; they must not start a renewal of their own inside this run.
  export AMAN_NO_TLS_RENEW=1
  parse_args "$@"
  set_paths
  trap on_exit EXIT
  check_demo_options
  check_import_options
  check_migrate_options
  cloud_guard
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
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
    print_proxy_requirements "https://<app-origin>" "<app port>" "https://<login-origin>"
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
    backups) cmd_backups ;;
    docker) docker_fix ;;
    command) cmd_command ;;
    tls) cmd_tls ;;
    upgrade) cmd_upgrade ;;
    migrate) cmd_migrate ;;
    instance)
      case "$SUBCOMMAND" in
        add) cmd_instance_add ;;
        list) cmd_instance_list ;;
        remove) cmd_instance_remove ;;
        demo-seed) cmd_instance_demo_seed ;;
        import) cmd_instance_import ;;
        refresh) cmd_instance_refresh ;;
        password) cmd_instance_password ;;
        *) usage_die "usage: install.sh instance add|list|remove|demo-seed|import|refresh|password" ;;
      esac
      ;;
  esac
}

main "$@"
