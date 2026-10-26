# shellcheck shell=bash
# Optional calendar connection for one instance. The calendar connector keeps the account in a volume it owns,
# and the installer saves it there through the connector's account agent. The app password lives in that volume
# and nowhere else.

CALENDAR_SIDECAR_URL=http://calendar-caldav:9558/mcp
CALENDAR_SERVICE=calendar-caldav
CALENDAR_AGENT=/app/agent.mjs

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

# Built-in addresses, each from the provider's own help pages. One row per address: the provider key, or
# gmx:DOMAIN for GMX because its address depends on the domain, then the address. A provider with no row, and GMX
# with another domain, has its address typed. iCloud and Zoho have no verified address here, so they go under Other.
# The Settings Calendar card reads the same table from packages/trueforge-core (CALDAV_PROVIDER_PRESETS); a test there
# fails if the two differ.
CALENDAR_PRESETS='fastmail https://caldav.fastmail.com/dav/
yahoo https://caldav.calendar.yahoo.com
gmx:gmx.com https://caldav.gmx.com/
gmx:gmx.net https://caldav.gmx.net/
webde https://caldav.web.de'

calendar_preset_url() { # provider email
  local key=$1
  if [ "$key" = gmx ]; then key=gmx:$(lowercase "${2##*@}"); fi
  printf '%s\n' "$CALENDAR_PRESETS" | awk -v key="$key" '$1 == key { print $2 }'
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
      elif [[ ${host%%:*} != *.* ]]; then
        echo "The calendar address needs a full server name with dots, such as caldav.example.com. Copy the address from your provider's help page."
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

# Only "not empty" is checked here. Which characters a password may hold is decided in one place, the connector's
# account agent, which checks every value again before it saves anything.
calendar_secret_problem() {
  if [ -z "$1" ]; then
    echo "The app password is needed. Create one at your provider, then type it here."
  fi
}

# Checked before any question when --yes is used: nobody can answer, so each missing value is named.
calendar_require_flags() {
  [ -n "$CAL_PROVIDER" ] || usage_die "With --yes the calendar needs --calendar-provider: fastmail, yahoo, gmx, webde or other."
  [ -n "$CAL_EMAIL" ] || usage_die "With --yes the calendar needs --calendar-email ADDRESS, the email address of the calendar account."
}

# The app password is read without echo on a terminal, or taken from its line of the input. It never goes on the
# command line, and it is cleared once it is saved.
calendar_ask_password() {
  local tries=0 problem
  if [ "$OPT_CAL_PASSWORD_STDIN" = 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then return 0; fi
    CAL_PASSWORD=$STDIN_CAL_PASSWORD
    STDIN_CAL_PASSWORD=
    problem=$(calendar_secret_problem "$CAL_PASSWORD")
    [ -z "$problem" ] || usage_die "$problem"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$ASSUME_YES" = 1 ]; then
    usage_die "With --yes the calendar needs its app password. Add --calendar-password-stdin and put the password on its own line of the input, in the order install.sh --help gives."
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
    ui_line "Google Calendar is already connected through the Google connector. A Gmail address does not need this step, so no calendar is set up here."
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

# The plan row for the install. Nothing is shown when the calendar was not asked for or was skipped.
calendar_plan_row() {
  [ -n "$CAL_EMAIL" ] && [ -z "$CAL_SKIP" ] && [ -n "$CAL_TARGET" ] || return 0
  plan_add todo "Connect the calendar of $CAL_EMAIL to instance $CAL_TARGET" \
    "The calendar connector keeps the app password in its own private storage."
}

# Saves the account in the connector, checks the sign-in once, and restarts the app so it learns the calendar is set
# up. The connector starts with the instance, and its tool server starts by itself when the account is saved. A failed
# check is reported and the saved account stays, so the next step is only to fix the password.
calendar_apply() { # name
  local name=$1
  instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  calendar_service_up "$name"
  calendar_agent_write "$name"
  calendar_check "$name"
  CAL_PASSWORD=
  calendar_app_restart "$name"
  ui_ok "Calendar connected to instance $name."
}

# Starts the connector alone, so an instance from before the connector ran without it picks it up.
calendar_service_up() { # name
  local name=$1
  if ! dc "$name" up -d --no-deps "$CALENDAR_SERVICE" >/dev/null 2>&1; then
    die "The calendar connector could not start. Run: install.sh instance calendar $name"
  fi
}

# Saves the account into the connector's volume through its account agent, run as a one-off container on the
# instance's own compose project. The password travels on stdin only, never on a command line or in a host file.
# The agent refuses an address it may not sign in to, and the installer says so in plain words.
calendar_agent_write() { # name
  local name=$1 rc=0
  calendar_env_text | dc "$name" run --rm --no-deps --entrypoint node "$CALENDAR_SERVICE" "$CALENDAR_AGENT" --write-stdin >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) return 0 ;;
    2) die "The calendar connector could not save those details. Check the address, login name, email and app password for odd characters, then run: install.sh instance calendar $name" ;;
    3) die "That calendar address cannot be used here. Use the address your provider gives you, then run: install.sh instance calendar $name" ;;
    *) die "The calendar account could not be saved in the connector. Run: install.sh instance calendar $name" ;;
  esac
}

# Deletes the account in the connector's volume through its account agent. Returns 0 when the compose file has no
# connector service, so an instance from before the connector still removes cleanly.
calendar_agent_remove() { # name
  local name=$1 dir
  dir=$(instance_dir "$name")
  grep -q "^  $CALENDAR_SERVICE:" "$dir/compose.yaml" 2>/dev/null || return 0
  if ! dc "$name" run --rm --no-deps --entrypoint node "$CALENDAR_SERVICE" "$CALENDAR_AGENT" --remove >/dev/null 2>&1; then
    die "The saved app password could not be removed from the connector. Run: install.sh instance calendar $name --remove"
  fi
}

# Restarts only the app, so it registers the Calendar connector from the saved account, or drops it.
calendar_app_restart() { # name
  local name=$1
  if ! dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 240 app >/dev/null 2>&1; then
    ui_warn "The app could not restart to pick up the calendar change." "Run: aman doctor instance --fix"
  fi
}

# The account in the agent's file format. The agent checks every value again before it stores anything.
calendar_env_text() {
  printf '%s\n' \
    "CALDAV_URL=$CAL_URL" \
    "CALDAV_USERNAME=$CAL_USER" \
    "CALDAV_PASSWORD=$CAL_PASSWORD" \
    "CALDAV_USER_EMAIL=$CAL_EMAIL"
}

# Signs in once, from inside the connector, with the saved account. It prints one word: ok, login (the server
# refused the sign-in), server (the server could not be reached or trusted) or blocked.
calendar_check() { # name
  local name=$1 answer
  answer=$(dc "$name" run --rm --no-deps --entrypoint node "$CALENDAR_SERVICE" "$CALENDAR_AGENT" --check 2>/dev/null | tr -d '\r' | tail -n 1 || true)
  case "$answer" in
    ok)
      ui_ok "Signed in to $CAL_URL as $CAL_USER. The calendar connector can read this calendar."
      ;;
    login)
      ui_warn "$CAL_URL did not accept this login and app password." \
        "Check both, make a new app password if needed, then run: install.sh instance calendar $name"
      ;;
    *)
      ui_warn "Could not reach $CAL_URL, or its security certificate was refused." \
        "Check the calendar address and this computer's internet connection, then run: install.sh instance calendar $name"
      ;;
  esac
}

# Drops the connector line an older installer wrote below its block. Returns 0 when a line was there.
calendar_link_remove() { # env file
  local had
  had=$(env_key_values "$1" CALENDAR_CONNECTOR_URL)
  [ -n "$had" ] || return 1
  env_drop_outside_block "$1" CALENDAR_CONNECTOR_URL
  return 0
}

# Moves an account an older installer kept in the instance folder into the connector's own storage, then deletes the
# old file and its settings line. An account already saved in the connector (connected again in Settings) is newer, so
# it is kept and the old file is only deleted. Returns 1 when the account could not be moved, and then keeps the file.
calendar_migrate_old_file() { # name
  local name=$1 dir old answer
  dir=$(instance_dir "$name")
  old=$dir/.env.calendar
  [ -s "$old" ] || return 0
  grep -q "^  $CALENDAR_SERVICE:" "$dir/compose.yaml" 2>/dev/null || return 1
  dc "$name" up -d --no-deps "$CALENDAR_SERVICE" >/dev/null 2>&1 || return 1
  answer=$(dc "$name" run --rm --no-deps --entrypoint node "$CALENDAR_SERVICE" "$CALENDAR_AGENT" --check 2>/dev/null | tr -d '\r' | tail -n 1 || true)
  if [ "$answer" = none ]; then
    dc "$name" run --rm --no-deps --entrypoint node "$CALENDAR_SERVICE" "$CALENDAR_AGENT" --write-stdin <"$old" >/dev/null 2>&1 || return 1
  fi
  rm -f -- "$old"
  calendar_link_remove "$dir/.env" || true
}

cmd_instance_calendar() {
  local name=${OPT_NAME:-} dir
  [ -n "$name" ] || usage_die "usage: install.sh instance calendar <name> [--remove]"
  valid_name "$name" || usage_die "$(name_problem "$name")"
  reg_exists "$name" || die "Instance $name does not exist."
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  warn_if_installed_older
  dir=$(instance_dir "$name")
  # The connector's compose settings need the shared secret, so an instance from before it gets one first.
  calendar_secret_backfill "$name"
  if [ "$OPT_REMOVE" = 1 ]; then
    # The saved password is deleted for good from the connector's volume, through its account agent.
    # The file an older installer kept in the instance folder, and its settings line, go too.
    calendar_agent_remove "$name"
    rm -f -- "$dir/.env.calendar"
    calendar_link_remove "$dir/.env" || true
    calendar_app_restart "$name"
    ui_ok "The Calendar connector is removed. Any saved app password has been deleted from this computer."
    return 0
  fi
  [ -n "$REL_CALENDAR_TAG" ] ||
    die "The installed version of Aman has no calendar connector yet. Run install.sh upgrade first, then run this command again."
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
