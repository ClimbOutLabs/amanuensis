# shellcheck shell=bash
# Optional calendar connection for one instance. The calendar service reads its own file of settings, and the
# instance only learns where that service is. The app password lives in that file and nowhere else.

CALENDAR_SIDECAR_URL=http://calendar-caldav:9558/mcp
CALENDAR_SERVICE=calendar-caldav

# The answers of this run. Nothing is written until calendar_apply or calendar_remove.
CAL_PROVIDER=
CAL_EMAIL=
CAL_URL=
CAL_USER=
CAL_PASSWORD=
CAL_TARGET=
CAL_SKIP=

# True when any calendar flag was given on the command line.
calendar_flags_given() {
  [ -n "$OPT_CAL_PROVIDER$OPT_CAL_EMAIL$OPT_CAL_URL$OPT_CAL_USER" ] || [ "$OPT_CAL_PASSWORD_STDIN" = 1 ]
}

calendar_provider_key() { # number or name -> key, nothing when unknown
  case "$1" in
    1 | fastmail) echo fastmail ;;
    2 | yahoo) echo yahoo ;;
    3 | gmx) echo gmx ;;
    4 | webde) echo webde ;;
    5 | other) echo other ;;
  esac
}

calendar_provider_name() { # key -> the name a person sees
  case "$1" in
    fastmail) echo Fastmail ;;
    yahoo) echo Yahoo ;;
    gmx) echo GMX ;;
    webde) echo web.de ;;
    *) echo "Other provider" ;;
  esac
}

# Built-in addresses, each from the provider's own help pages. Empty when there is none, and then the address is typed.
# iCloud and Zoho have no verified address here, so they go under Other.
calendar_preset_url() { # provider email
  local domain=${2##*@}
  case "$1" in
    fastmail) echo 'https://caldav.fastmail.com/dav/' ;;
    yahoo) echo 'https://caldav.calendar.yahoo.com' ;;
    gmx)
      case "$(lowercase "$domain")" in
        gmx.com) echo 'https://caldav.gmx.com/' ;;
        gmx.net) echo 'https://caldav.gmx.net/' ;;
      esac
      ;;
    webde) echo 'https://caldav.web.de' ;;
  esac
}

calendar_is_gmail() { # email
  case "$(lowercase "${1##*@}")" in
    gmail.com | googlemail.com) return 0 ;;
  esac
  return 1
}

calendar_provider_problem() {
  if [ -z "$(calendar_provider_key "$1")" ]; then
    echo "Type a number from 1 to 5, or one of fastmail, yahoo, gmx, webde, other."
  fi
}

# The address must be https, carry no name or password, and hold only the characters a URL needs.
calendar_url_problem() {
  local rest host
  case "$1" in
    '') echo "A calendar address is needed. Type the full address, for example https://caldav.fastmail.com/dav/." ;;
    https://*)
      rest=${1#https://}
      host=${rest%%/*}
      if [[ $host == *@* ]]; then
        echo "The calendar address must not hold a name or password. Remove the part before the @, then type it again."
      elif ! matches_whole "$1" '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/@%+=,:-]*)?$'; then
        echo "The calendar address has a character that is not allowed. Copy the address from your provider's help page."
      fi
      ;;
    *) echo "The calendar address must start with https://. Type the full address, for example https://caldav.fastmail.com/dav/." ;;
  esac
}

calendar_user_problem() {
  if [ -z "$1" ]; then
    echo "A login name is needed. Type the email address you sign in to the calendar with."
  elif ! matches_whole "$1" '^[A-Za-z0-9._+@=-]+$'; then
    echo "The login name has a character that cannot be saved. Use only letters, numbers and . _ + @ = -."
  fi
}

calendar_secret_problem() {
  if [ -z "$1" ]; then
    echo "The app password is needed. Create one at your provider, then type it here."
  elif ! matches_whole "$1" '^[A-Za-z0-9._+@=!%~,:/-]+$'; then
    echo "The app password has a character that cannot be saved. Create a new app password with letters and numbers, then try again."
  fi
}

# Checked before any question when --yes is used: nobody can answer, so each missing value is named.
calendar_require_flags() {
  [ -n "$CAL_PROVIDER" ] || usage_die "With --yes the calendar needs --calendar-provider: fastmail, yahoo, gmx, webde or other."
  [ -n "$CAL_EMAIL" ] || usage_die "With --yes the calendar needs --calendar-email ADDRESS, the email address of the calendar account."
}

# The app password is read without echo on a terminal and from the next input line otherwise. It never goes on the
# command line, and it is cleared once the file is written.
calendar_ask_password() {
  local tries=0 problem
  if [ "$OPT_CAL_PASSWORD_STDIN" = 1 ]; then
    IFS= read -r CAL_PASSWORD || CAL_PASSWORD=
    problem=$(calendar_secret_problem "$CAL_PASSWORD")
    [ -z "$problem" ] || usage_die "$problem"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$ASSUME_YES" = 1 ]; then
    usage_die "With --yes the calendar needs its app password. Add --calendar-password-stdin and put the password on the next line of the input."
  fi
  ui_line "Create an app password at your provider and use it here. Your normal password does not work."
  while [ "$tries" -lt "$UI_MAX_TRIES" ]; do
    ui_password CAL_PASSWORD "App password for the calendar" || die "No app password was entered, so the calendar was not set up."
    problem=$(calendar_secret_problem "$CAL_PASSWORD")
    if [ -z "$problem" ]; then return 0; fi
    UI_FD=2 ui_fail "$problem"
    CAL_PASSWORD=
    tries=$((tries + 1))
  done
  die "No valid app password after $UI_MAX_TRIES tries, so nothing was changed. Run the command again."
}

# Asks the calendar questions. In the install it asks "Connect a calendar?" first, with No as the default. The instance
# command passes CAL_EXPLICIT=1 and always asks the rest. Flags answer any question they cover.
calendar_collect() { # install|instance
  local names count preset
  CAL_PROVIDER=$OPT_CAL_PROVIDER
  CAL_EMAIL=$OPT_CAL_EMAIL
  CAL_URL=$OPT_CAL_URL
  CAL_USER=$OPT_CAL_USER
  CAL_PASSWORD=
  CAL_SKIP=
  CAL_TARGET=
  if [ "$1" = install ]; then
    # Only the instance this run creates, or the only one there is, can take a calendar in the install.
    if need_new_instance; then
      CAL_TARGET=$I_NAME
    else
      names=$(reg_names)
      count=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
      if [ "$count" = 1 ]; then CAL_TARGET=$names; fi
    fi
    if [ -z "$CAL_TARGET" ]; then
      if calendar_flags_given; then
        usage_die "The calendar is set up for one instance at a time. Use install.sh instance calendar NAME."
      fi
      ui_skip "A calendar is set up one instance at a time. Use: install.sh instance calendar NAME"
      return 0
    fi
    if ! calendar_flags_given; then
      [ "$DRY_RUN" = 1 ] && return 0
      ui_confirm "Connect a calendar?" n || return 0
    fi
  else
    CAL_TARGET=$OPT_NAME
  fi
  if [ "$ASSUME_YES" = 1 ]; then calendar_require_flags; fi
  if [ -z "$CAL_PROVIDER" ] && [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ]; then
    ui_line "Which calendar provider is yours?"
    ui_line "  1 Fastmail"
    ui_line "  2 Yahoo"
    ui_line "  3 GMX (gmx.com or gmx.net)"
    ui_line "  4 web.de"
    ui_line "  5 Other provider, such as iCloud or Zoho: you type its address"
  fi
  ask_valid CAL_PROVIDER "Your provider (type a number)" "" "" calendar_provider_problem
  CAL_PROVIDER=$(calendar_provider_key "$CAL_PROVIDER")
  ask_valid CAL_EMAIL "Email address of the calendar account" "" "The address you sign in to the calendar with." email_problem
  if calendar_is_gmail "$CAL_EMAIL"; then
    ui_line "Google Calendar is already connected through the Google connector. CalDAV is not used for Gmail addresses, so no calendar is set up here."
    CAL_SKIP=gmail
    return 0
  fi
  preset=$(calendar_preset_url "$CAL_PROVIDER" "$CAL_EMAIL")
  if [ -n "$preset" ]; then
    if [ -n "$CAL_URL" ] && [ "$CAL_URL" != "$preset" ]; then
      usage_die "--calendar-url is only for the Other provider. $(calendar_provider_name "$CAL_PROVIDER") uses its own address."
    fi
    CAL_URL=$preset
  else
    if [ "$CAL_PROVIDER" = gmx ]; then
      ui_line "GMX has no built-in address for ${CAL_EMAIL##*@}. Type the address from GMX's help page."
    fi
    # Also checks an address given by flag.
    ask_valid CAL_URL "Calendar address (starts with https://)" "" "The full address from your provider's help page." calendar_url_problem
  fi
  ask_valid CAL_USER "Login name" "$CAL_EMAIL" "Usually the same as the email address." calendar_user_problem
  calendar_ask_password
  ui_line "Calendar: $(calendar_provider_name "$CAL_PROVIDER") at $CAL_URL, signed in as $CAL_USER."
}

calendar_start_command() { # name
  local dir
  dir=$(instance_dir "$1")
  printf 'docker compose --project-name aman-%s --project-directory %s -f %s/compose.yaml up -d %s' \
    "$1" "$dir" "$dir" "$CALENDAR_SERVICE"
}

# The plan row for the install. Nothing is shown when the calendar was not asked for or was skipped.
calendar_plan_row() {
  [ -n "$CAL_EMAIL" ] && [ -z "$CAL_SKIP" ] && [ -n "$CAL_TARGET" ] || return 0
  plan_add todo "Connect the calendar of $CAL_EMAIL to instance $CAL_TARGET" \
    "The calendar service keeps the app password in a file only you can read." \
    "Then start the calendar service: $(calendar_start_command "$CAL_TARGET")"
}

# Writes the calendar file of the instance, adds the connector line to its settings, and restarts only that instance
# when the line was new. The calendar service itself is started by the person, with the printed command.
calendar_apply() { # name
  local name=$1 dir changed=0
  dir=$(instance_dir "$name")
  calendar_write_file "$dir"
  if calendar_link_add "$dir/.env"; then changed=1; fi
  CAL_PASSWORD=
  if [ "$changed" = 1 ]; then
    instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
    instance_up "$name" recreate
  fi
  ui_ok "Calendar connected to instance $name. Start the calendar service with:"
  ui_line "$(calendar_start_command "$name")"
}

calendar_write_file() { # instance folder
  local dir=$1
  ensure_private_dir "$dir"
  {
    printf 'CALDAV_URL=%s\n' "$CAL_URL"
    printf 'CALDAV_USERNAME=%s\n' "$CAL_USER"
    printf 'CALDAV_PASSWORD=%s\n' "$CAL_PASSWORD"
    printf 'CALDAV_USER_EMAIL=%s\n' "$CAL_EMAIL"
  } | write_if_changed "$dir/.env.calendar" 600 || true
}

# Adds the connector line below the installer's block, where the owner's own settings go. Returns 0 when it changed.
calendar_link_add() { # env file
  local env=$1
  if [ "$(env_key_values "$env" CALENDAR_CONNECTOR_URL)" = "$CALENDAR_SIDECAR_URL" ]; then return 1; fi
  env_drop_outside_block "$env" CALENDAR_CONNECTOR_URL
  {
    cat "$env"
    [ -z "$(tail -c1 "$env")" ] || printf '\n'
    printf 'CALENDAR_CONNECTOR_URL=%s\n' "$CALENDAR_SIDECAR_URL"
  } | write_if_changed "$env" 600 || true
  return 0
}

# Returns 0 when a connector line was there and is now removed.
calendar_link_remove() { # env file
  local had
  had=$(env_key_values "$1" CALENDAR_CONNECTOR_URL)
  [ -n "$had" ] || return 1
  env_drop_outside_block "$1" CALENDAR_CONNECTOR_URL
  return 0
}

cmd_instance_calendar() {
  local name=${OPT_NAME:-} dir changed=0
  [ -n "$name" ] || usage_die "usage: install.sh instance calendar <name> [--remove]"
  valid_name "$name" || usage_die "$(name_problem "$name")"
  reg_exists "$name" || die "Instance $name does not exist."
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  warn_if_installed_older
  dir=$(instance_dir "$name")
  if [ "$OPT_REMOVE" = 1 ]; then
    if [ -f "$dir/.env.calendar" ]; then rm -f -- "$dir/.env.calendar"; fi
    if calendar_link_remove "$dir/.env"; then changed=1; fi
    if [ "$changed" = 1 ]; then
      instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
      instance_up "$name" recreate
    fi
    ui_ok "The Calendar connector is removed. Any saved app password has been deleted from this computer."
    return 0
  fi
  calendar_collect instance
  if [ -n "$CAL_SKIP" ]; then return 0; fi
  calendar_apply "$name"
}

# --remove and the calendar flags belong to instance calendar only.
check_calendar_options() {
  if [ "$COMMAND:$SUBCOMMAND" = instance:calendar ]; then
    if [ "$OPT_REMOVE" = 1 ] && calendar_flags_given; then usage_die "--remove cannot be used with the calendar options; use one or the other"; fi
  else
    if [ "$OPT_REMOVE" = 1 ] && [ "$COMMAND:$SUBCOMMAND" != instance:email ]; then usage_die "--remove applies to instance calendar or instance email"; fi
    if calendar_flags_given && [ "$COMMAND" != install ]; then usage_die "The --calendar-* options apply to install and instance calendar"; fi
  fi
}
