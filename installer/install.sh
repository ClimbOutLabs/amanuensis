#!/usr/bin/env bash
# Amanuensis installer: plan, local image builds, shared speech-to-text, per-person instances and their sandbox.
# Usage: install.sh [--dry-run] [--yes] [options]
#        install.sh instance add|list|remove <name>
#        install.sh instance demo-seed [--reset | --fresh]
#        install.sh instance import <name> <file.zip> [--display-name NAME] [--dry-run]
#        install.sh migrate --from-compose <folder> [--user ID]
#        install.sh instance refresh <name>
#        install.sh instance email <name> [--remove]
#        install.sh instance calendar <name> [--remove]
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
unset AMAN_PASSWORD AMAN_TF_KEY EM_PASSWORD NEBIUS_API_KEY

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
# shellcheck source=lib/email.sh
. "$INSTALLER_DIR/lib/email.sh"
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
# shellcheck source=lib/calendar.sh
. "$INSTALLER_DIR/lib/calendar.sh"

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
OPT_FRESH=0
OPT_NAME=
OPT_INSTANCE=
OPT_EMAIL=
OPT_YOUR_NAME=
OPT_PUBLIC_URL=
OPT_LOGIN_URL=
OPT_PORT=
OPT_LOGIN_PORT=
OPT_TLS=
OPT_PUBLIC_IP=
OPT_TF_MODEL=
OPT_TF_CAP=
OPT_CONFIRM_NAME=
OPT_EMAIL_PROVIDER=
OPT_EMAIL_ADDRESS=
OPT_EMAIL_IMAP_HOST=
OPT_EMAIL_IMAP_PORT=
OPT_EMAIL_SMTP_HOST=
OPT_EMAIL_SMTP_PORT=
OPT_EMAIL_PASSWORD_STDIN=0
OPT_CAL_PROVIDER=
OPT_CAL_EMAIL=
OPT_CAL_URL=
OPT_CAL_USER=
OPT_CAL_PASSWORD_STDIN=0
OPT_REMOVE=0
COMMAND=install
SUBCOMMAND=
LOCK_HELD=0
AMAN_PASSWORD=
AMAN_TF_KEY=
ui_init

usage() {
  cat <<'USAGE'
Amanuensis installer

  install.sh                      set up Aman on this computer: check it, show the plan, build, start a first instance
  install.sh --dry-run            show the plan and change nothing
  install.sh instance add [<name>]
                                  add an instance for another person; asks the name when left out
  install.sh instance list        show every instance
  install.sh instance remove <name> [--purge-data]
                                  remove an instance; --purge-data deletes its data too
  install.sh instance demo-seed [--reset | --fresh] [--instance NAME]
                                  fill a demo instance with example data, clear it with --reset, or start it fresh with --fresh
  install.sh instance import <name> <file.zip> [--display-name NAME] [--dry-run]
                                  put an exported file into an instance (it is backed up first; its app pauses meanwhile)
  install.sh migrate --from-compose <folder> [--user ID]
                                  export your data from an older Aman in that folder; the old Aman is only read
  install.sh instance refresh <name>
                                  start the instance again with its current settings
  install.sh instance email <name> [--remove]
                                  connect, change or remove an email account of an instance, then restart it;
                                  asks for the details unless the --email-* options are given
  install.sh instance calendar <name> [--remove]
                                  connect a calendar to an instance (asks for the details); --remove takes it away
  install.sh instance password [<name>]
                                  set a new owner password and sign everyone out
  install.sh backup [<name>]      make a backup now
  install.sh backups daily|off    turn the daily backup on or off
  install.sh upgrade [--check] [--force]
                                  update Aman to this copy of its code; --check only shows what would change
  install.sh docker               install or start Docker, or update it, asking before anything that needs admin rights
  install.sh command              put the aman command back
  install.sh tls                  renew the https certificates that are due

Options
  --home DIR            keep Aman's data in this folder (default ~/.amanuensis)
  --yes                 accept the plan and the defaults without asking (never installs Docker, changes groups or uses admin rights)
  --install-docker      let the installer install Docker with admin rights (Linux systems that use apt)
  --add-docker-group    let the installer give your user access to Docker (needs admin rights)
  --sandbox-root        let the installer do the sandbox steps that need admin rights without asking
  --tls-root            let the installer do the --tls caddy steps that need admin rights without asking
  --no-sandbox          install without the sandbox (the assistant then cannot run code or read attachments)
  --use-host-node       set up the sandbox with the Node.js on this computer (22.14 or newer) instead of a downloaded copy
  --verbose             show technical details and the full list of downloads
  --dry-run             show the plan and stop; with instance import, check the file and say what it would bring
                        (an instance that has never started is started once first, so the file can be checked)
  --name NAME           name of the first instance (default main)
  --email ADDRESS       the email you sign in with
  --your-name NAME      what Aman should call you (default: asked, or the start of your email)
  --instance NAME       which instance demo-seed and password apply to (default: the only one)
  --password-stdin      read the sign-in password from the input instead of asking for it
  --token-factory-key-stdin  read the Token Factory key from the input; never put the key on the command line
                        Each option that ends in -stdin reads one line of the input. The lines come in this order:
                        sign-in password, Token Factory key, calendar app password, email app password.
                        Leave out the line of an option you do not give.
  --token-factory-model ID   the Token Factory model to use (default nvidia/nemotron-3-super-120b-a12b)
  --token-factory-daily-cap N  stop answering after N Token Factory tokens in a day (default: no limit)
  --demo                make the instance a demo and fill it with example data once it runs
  --reset               with instance demo-seed, remove the example data instead of adding it
  --fresh               with instance demo-seed, remove everything the demo person made (chats, spaces, memory, schedules, personas, files), then add the example data again
  --local-only          open Aman on this computer only (by default it also opens for other devices on your private network)
  --backups daily|off   back up every day (default) or never, without asking
  --address HOST        also open Aman at this name or private address; repeat for more (for example --address host.local)
  --public-url URL      the https address of Aman behind your own reverse proxy; the ports then stay on this computer
  --login-url URL       the https address of the sign-in service behind the same proxy
  --home-network        on a cloud server, still open Aman at its private addresses (other customers share them, so the default there is this computer only)
  --port N              the port for the app on this computer
  --login-port N        the port for the sign-in service on this computer
  --tls local|off|caddy  https on your network with a certificate made on this computer (default), plain http, or
                        https at --public-url and --login-url with Caddy on this computer (the system's Caddy package, Let's Encrypt)
  --public-ip ADDRESS   this computer's public address, for the --tls caddy check (default: ask a lookup service)
  --confirm-name NAME   with --purge-data, the instance name typed in advance
  --display-name NAME   with instance import, your name as imported chats show it (default: the name Aman calls you)
  --from-compose DIR    with migrate, the folder the old Aman runs from
  --user ID             with migrate, which person's chats to move when the old Aman has more than one
  --email-provider NAME  with the email options: gmail, yahoo, aol, icloud, fastmail, zoho, gmx, webde or other
  --email-address ADDRESS  the email address to connect
  --email-password-stdin  read the email app password from the input (see the line order above)
  --email-imap-host HOST, --email-imap-port N, --email-smtp-host HOST, --email-smtp-port N
                        the incoming and outgoing servers, for --email-provider other only
  --calendar-provider NAME  the calendar provider: fastmail, yahoo, gmx, webde or other (with --yes: required)
  --calendar-email ADDRESS  the email address of the calendar account (with --yes: required)
  --calendar-url URL    the https address of the calendar, for the other provider (with --yes: required for other)
  --calendar-user NAME  the calendar login name (default: the email address)
  --calendar-password-stdin  read the calendar app password from the input (see the line order above; with --yes: required)
  --remove              with instance email or instance calendar, remove that connection
  --print-root-steps    show the admin steps that install Docker, and stop
  --print-network       show every site the installer may contact, and stop
  --print-proxy-requirements  show what a reverse proxy in front of Aman must do, and stop
  --help                this text
USAGE
}

set_paths() {
  valid_home_path "$AMAN_HOME" || usage_die "The folder for Aman's data must be a full path made of letters, digits and . _ - + @ : = , or /. Give --home such a path."
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
      --email-password-stdin) OPT_EMAIL_PASSWORD_STDIN=1 ;;
      --calendar-password-stdin) OPT_CAL_PASSWORD_STDIN=1 ;;
      --remove) OPT_REMOVE=1 ;;
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
      --token-factory-key | --token-factory-key=*) usage_die "The Token Factory key is never taken from the command line. Use --token-factory-key-stdin." ;;
      --check) OPT_CHECK=1 ;;
      --force) OPT_FORCE=1 ;;
      --purge-data) OPT_PURGE=1 ;;
      --demo) OPT_DEMO=1 ;;
      --reset) OPT_RESET=1 ;;
      --fresh) OPT_FRESH=1 ;;
      --local-only) OPT_LOCAL_ONLY=1 ;;
      --home-network) OPT_HOME_NETWORK=1 ;;
      --home | --name | --instance | --email | --your-name | --public-url | --login-url | --port | --login-port | --confirm-name | --tls | --public-ip | --address | --backups | --token-factory-model | --token-factory-daily-cap | --display-name | --from-compose | --user | --email-provider | --email-address | --email-imap-host | --email-imap-port | --email-smtp-host | --email-smtp-port | --calendar-provider | --calendar-email | --calendar-url | --calendar-user)
        [ "$#" -ge 2 ] || usage_die "$arg needs a value"
        set_option "$arg" "$2"
        shift
        ;;
      --home=* | --name=* | --instance=* | --email=* | --your-name=* | --public-url=* | --login-url=* | --port=* | --login-port=* | --confirm-name=* | --tls=* | --public-ip=* | --address=* | --backups=* | --token-factory-model=* | --token-factory-daily-cap=* | --display-name=* | --from-compose=* | --user=* | --email-provider=* | --email-address=* | --email-imap-host=* | --email-imap-port=* | --email-smtp-host=* | --email-smtp-port=* | --calendar-provider=* | --calendar-email=* | --calendar-url=* | --calendar-user=*)
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
    --your-name)
      [ -n "$2" ] || usage_die "$(display_name_problem "")"
      OPT_YOUR_NAME=$2
      ;;
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
    --email-provider) OPT_EMAIL_PROVIDER=$2 ;;
    --email-address) OPT_EMAIL_ADDRESS=$2 ;;
    --email-imap-host) OPT_EMAIL_IMAP_HOST=$2 ;;
    --email-imap-port) OPT_EMAIL_IMAP_PORT=$2 ;;
    --email-smtp-host) OPT_EMAIL_SMTP_HOST=$2 ;;
    --email-smtp-port) OPT_EMAIL_SMTP_PORT=$2 ;;
    --calendar-provider) OPT_CAL_PROVIDER=$2 ;;
    --calendar-email) OPT_CAL_EMAIL=$2 ;;
    --calendar-url) OPT_CAL_URL=$2 ;;
    --calendar-user) OPT_CAL_USER=$2 ;;
  esac
  safe_value "$2" || usage_die "$1 contains a character that is not allowed"
}

print_signout_note() {
  if [ "$NEEDS_SIGNOUT" = 1 ]; then
    ui_newline
    ui_warn "This run was given Docker access that your other terminals do not have yet." "Open a new terminal window once. Docker works there from then on."
  fi
}

# --demo belongs to install and instance add; --reset and --fresh only to instance demo-seed.
check_demo_options() {
  local seeding=0
  if [ "$COMMAND:$SUBCOMMAND" = instance:demo-seed ]; then seeding=1; fi
  if [ "$OPT_DEMO" = 1 ] && { [ "$seeding" = 1 ] || { [ "$COMMAND" != install ] && [ "$SUBCOMMAND" != add ]; }; }; then
    usage_die "--demo applies to install and instance add. To fill a demo instance again, use instance demo-seed."
  fi
  if [ "$OPT_RESET" = 1 ] && [ "$seeding" != 1 ]; then
    usage_die "--reset applies to instance demo-seed"
  fi
  if [ "$OPT_FRESH" = 1 ] && [ "$seeding" != 1 ]; then
    usage_die "--fresh applies to instance demo-seed"
  fi
  if [ "$OPT_FRESH" = 1 ] && [ "$OPT_RESET" = 1 ]; then
    usage_die "Use either --fresh or --reset, not both."
  fi
  if [ -n "$OPT_YOUR_NAME" ] && [ "$COMMAND" != install ] && [ "$COMMAND:$SUBCOMMAND" != instance:add ]; then
    usage_die "--your-name applies to install and instance add"
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
  warn "This looks like a cloud server. Its private addresses are shared with other customers, so Aman will open on this computer only. To open it at those addresses anyway, run this again with --home-network."
  CLOUD_DEFAULT_LOCAL=1
}

on_exit() {
  local rc=$?
  trap - EXIT
  AMAN_PASSWORD=
  AMAN_TF_KEY=
  EM_PASSWORD=
  CAL_PASSWORD=
  STDIN_SIGNIN_PASSWORD=
  STDIN_CAL_PASSWORD=
  STDIN_EMAIL_PASSWORD=
  ui_step_abort
  upgrade_on_exit
  import_on_exit
  migrate_on_exit
  if [ "$rc" != 0 ]; then instance_pending_notice; fi
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
  check_email_options
  check_calendar_options
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
      install: | upgrade: | instance:add | instance:import) ;;
      *) usage_die "--dry-run applies to install, upgrade, instance add and instance import" ;;
    esac
  fi
  stdin_answers_read
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
        email) cmd_instance_email ;;
        password) cmd_instance_password ;;
        calendar) cmd_instance_calendar ;;
        *) usage_die "usage: install.sh instance add|list|remove|demo-seed|import|refresh|email|password|calendar" ;;
      esac
      ;;
  esac
}

main "$@"
