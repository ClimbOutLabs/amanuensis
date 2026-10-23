# shellcheck shell=bash
# Optional email account for one instance. The Email connector reads its account from a file in the instance folder,
# and the instance only learns where that connector is. The app password lives in that file and nowhere else.

EMAIL_SIDECAR_URL=http://mail-email:9557/mcp
EMAIL_SERVICE=mail-email

# The answers of this run. Nothing is written until email_apply or email_remove.
EM_PROVIDER=
EM_ADDRESS=
EM_IMAP_HOST=
EM_IMAP_PORT=
EM_IMAP_MODE=
EM_SMTP_HOST=
EM_SMTP_PORT=
EM_SMTP_MODE=
EM_PASSWORD=
EM_TARGET=
EM_SKIP=

# One preset per line: key, incoming host, port, mode, outgoing host, port, mode.
# A mode is ssl (encrypted from the start) or starttls (upgraded after connecting). The certificate is always checked.
EMAIL_PRESETS='gmail imap.gmail.com 993 ssl smtp.gmail.com 465 ssl
yahoo imap.mail.yahoo.com 993 ssl smtp.mail.yahoo.com 465 ssl
aol imap.aol.com 993 ssl smtp.aol.com 465 ssl
icloud imap.mail.me.com 993 ssl smtp.mail.me.com 587 starttls
fastmail imap.fastmail.com 993 ssl smtp.fastmail.com 465 ssl
zoho imap.zoho.com 993 ssl smtp.zoho.com 465 ssl
gmx imap.gmx.net 993 ssl mail.gmx.net 465 ssl
webde imap.web.de 993 ssl smtp.web.de 587 starttls'

# The one sign-in check after saving. It runs from this computer, so the Email connector does not have to be running.
# Its five input lines (server, port, mode, address, password) come on stdin, never on the command line.
# It prints ok, login (the server refused the sign-in) or server (the server could not be reached or trusted).
EMAIL_CHECK_PY=$(
  cat <<'PY'
import imaplib, ssl, sys
host, port, mode, user, password = sys.stdin.read().split("\n")[:5]
ctx = ssl.create_default_context()
try:
    if mode == "ssl":
        conn = imaplib.IMAP4_SSL(host, int(port), ssl_context=ctx, timeout=20)
    else:
        conn = imaplib.IMAP4(host, int(port), timeout=20)
        conn.starttls(ssl_context=ctx)
except (OSError, ssl.SSLError, imaplib.IMAP4.error, ValueError):
    print("server")
    sys.exit(0)
# imaplib quotes the password itself, so it is passed as it is.
try:
    conn.login(user, password)
except imaplib.IMAP4.error:
    print("login")
    sys.exit(0)
conn.logout()
print("ok")
PY
)

# True when any email account option was given on the command line.
email_flags_given() {
  [ -n "$OPT_EMAIL_PROVIDER$OPT_EMAIL_ADDRESS$OPT_EMAIL_IMAP_HOST$OPT_EMAIL_IMAP_PORT$OPT_EMAIL_SMTP_HOST$OPT_EMAIL_SMTP_PORT" ] ||
    [ "$OPT_EMAIL_PASSWORD_STDIN" = 1 ]
}

email_provider_key() { # number or name -> key, nothing when unknown
  case "$1" in
    1 | gmail) echo gmail ;;
    2 | yahoo) echo yahoo ;;
    3 | aol) echo aol ;;
    4 | icloud) echo icloud ;;
    5 | fastmail) echo fastmail ;;
    6 | zoho) echo zoho ;;
    7 | gmx) echo gmx ;;
    8 | webde) echo webde ;;
    9 | other) echo other ;;
  esac
}

email_provider_name() { # key -> the name a person sees
  case "$1" in
    gmail) echo Gmail ;;
    yahoo) echo Yahoo ;;
    aol) echo AOL ;;
    icloud) echo iCloud ;;
    fastmail) echo Fastmail ;;
    zoho) echo Zoho ;;
    gmx) echo GMX ;;
    webde) echo web.de ;;
    *) echo "Other provider" ;;
  esac
}

email_provider_problem() {
  if [ -z "$(email_provider_key "$1")" ]; then
    echo "Type a number from 1 to 9, or one of gmail, yahoo, aol, icloud, fastmail, zoho, gmx, webde, other."
  fi
}

email_host_problem() {
  if [ -z "$1" ] || [ "${#1}" -gt 253 ]; then
    echo "A server name is needed, for example imap.example.com."
  elif [ -n "$(printf '%s' "$1" | LC_ALL=C tr -d '[:alnum:].-')" ]; then
    echo "A server name has only letters, digits, dots and dashes, for example imap.example.com."
  fi
}

email_port_problem() {
  if matches_whole "$1" '^[[:digit:]]{1,5}$' && [ "$((10#$1))" -ge 1 ] && [ "$((10#$1))" -le 65535 ]; then
    return 0
  fi
  echo "A port is a number from 1 to 65535, for example 993."
}

# Some providers show an app password in groups split by spaces; the spaces are not part of it. Other passwords are
# kept as typed.
email_clean_password() { # key password
  case "$1" in
    gmail | icloud | yahoo | aol | fastmail) printf '%s' "${2// /}" ;;
    *) printf '%s' "$2" ;;
  esac
}

email_secret_problem() {
  local LC_ALL=C
  if [ -z "$1" ]; then
    echo "The app password is needed. Make one with your provider and type it here."
  elif [[ $1 == *[![:graph:]]* ]] || [[ $1 == *"'"* ]]; then
    echo "The app password has a character this installer cannot use. Copy it again from your provider."
  fi
}

# Sets EM_* from the preset row of a provider key. Returns 1 for an unknown key.
email_preset() {
  local row
  row=$(printf '%s\n' "$EMAIL_PRESETS" | sed -n "/^$1 /p")
  [ -n "$row" ] || return 1
  # shellcheck disable=SC2034 # the key column is only there to find the row
  read -r _key EM_IMAP_HOST EM_IMAP_PORT EM_IMAP_MODE EM_SMTP_HOST EM_SMTP_PORT EM_SMTP_MODE <<<"$row"
}

# The encryption of a server the person typed: port 993 and 465 are encrypted from the start, others upgrade.
email_other_modes() {
  EM_IMAP_MODE=starttls
  [ "$EM_IMAP_PORT" != 993 ] || EM_IMAP_MODE=ssl
  EM_SMTP_MODE=starttls
  [ "$EM_SMTP_PORT" != 465 ] || EM_SMTP_MODE=ssl
}

# Microsoft addresses need a Microsoft sign-in, which is not part of this installer yet.
email_is_microsoft() {
  local address
  address=$(lowercase "$1")
  case "$address" in
    *@outlook.* | *@hotmail.* | *@live.* | *@msn.com | *@passport.com | *@windowslive.com | *@*.onmicrosoft.com) return 0 ;;
  esac
  return 1
}

email_microsoft_message() {
  echo "Microsoft addresses, such as Outlook, Hotmail, Live and MSN, need a Microsoft sign-in. That comes in a later update, so skip email for now."
}

# The one sentence on how to make an app password for each provider.
email_password_hint() { # key
  case "$1" in
    gmail) echo "In your Google account, turn on 2-Step Verification, then create an app password under Security." ;;
    yahoo) echo "In your Yahoo account security settings, create an app password for a mail app." ;;
    aol) echo "In your AOL account security settings, create an app password for a mail app." ;;
    icloud) echo "On account.apple.com, under Sign-In and Security, create an app-specific password." ;;
    fastmail) echo "In Fastmail settings, create an app password that allows IMAP and SMTP." ;;
    zoho) echo "In your Zoho account security settings, create an application-specific password." ;;
    gmx) echo "Turn on IMAP in your GMX settings first, then type your GMX password." ;;
    webde) echo "Turn on POP3 and IMAP access in your web.de mail settings first, then make an app password if you use two-step sign-in." ;;
    *) echo "Type the password your provider gave you for mail apps." ;;
  esac
}

# With --yes nobody can answer, so the provider, the address and, for Other, the servers must come from flags.
email_require_flags() {
  [ -n "$OPT_EMAIL_PROVIDER" ] || usage_die "With --yes the email account needs --email-provider: gmail, yahoo, aol, icloud, fastmail, zoho, gmx, webde or other."
  [ -n "$OPT_EMAIL_ADDRESS" ] || usage_die "With --yes the email account needs --email-address ADDRESS, the address to connect."
  if [ "$(email_provider_key "$OPT_EMAIL_PROVIDER")" = other ]; then
    [ -n "$OPT_EMAIL_IMAP_HOST" ] || usage_die "With --yes, --email-provider other needs --email-imap-host, the incoming mail server."
    [ -n "$OPT_EMAIL_SMTP_HOST" ] || usage_die "With --yes, --email-provider other needs --email-smtp-host, the outgoing mail server."
  fi
}

# The app password is read without echo on a terminal, or taken from its line of the input. It never goes on the
# command line, and it is cleared once the file is written.
email_ask_password() { # key
  local tries=0 problem
  if [ "$OPT_EMAIL_PASSWORD_STDIN" = 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then return 0; fi
    EM_PASSWORD=$(email_clean_password "$1" "$STDIN_EMAIL_PASSWORD")
    STDIN_EMAIL_PASSWORD=
    problem=$(email_secret_problem "$EM_PASSWORD")
    [ -z "$problem" ] || usage_die "$problem"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if [ "$ASSUME_YES" = 1 ]; then
    usage_die "With --yes the email account needs its app password. Add --email-password-stdin and put the password on its own line of the input, in the order install.sh --help gives."
  fi
  ui_line "An app password is a separate password for mail apps. Your normal password often does not work with it."
  ui_line "$(email_password_hint "$1")"
  while [ "$tries" -lt "$UI_MAX_TRIES" ]; do
    ui_password EM_PASSWORD "App password for the email account" || die "No app password was entered, so the email account was not set up."
    EM_PASSWORD=$(email_clean_password "$1" "$EM_PASSWORD")
    problem=$(email_secret_problem "$EM_PASSWORD")
    if [ -z "$problem" ]; then return 0; fi
    UI_FD=2 ui_fail "$problem"
    EM_PASSWORD=
    tries=$((tries + 1))
  done
  die "No valid app password after $UI_MAX_TRIES tries, so nothing was changed. Run the command again."
}

# Asks the email questions. In the install it asks "Connect an email account?" first, with No as the default. The instance
# command passes instance and always asks the rest. Flags answer any question they cover.
email_collect() { # install|instance
  local names count
  EM_PROVIDER=$OPT_EMAIL_PROVIDER
  EM_ADDRESS=$OPT_EMAIL_ADDRESS
  EM_IMAP_HOST=$OPT_EMAIL_IMAP_HOST
  EM_IMAP_PORT=$OPT_EMAIL_IMAP_PORT
  EM_SMTP_HOST=$OPT_EMAIL_SMTP_HOST
  EM_SMTP_PORT=$OPT_EMAIL_SMTP_PORT
  EM_PASSWORD=
  EM_SKIP=
  EM_TARGET=
  if [ "$1" = install ]; then
    # Only the instance this run creates, or the only one there is, can take an email account in the install.
    if need_new_instance; then
      EM_TARGET=$I_NAME
    else
      names=$(reg_names)
      count=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
      if [ "$count" = 1 ]; then EM_TARGET=$names; fi
    fi
    if [ -z "$EM_TARGET" ]; then
      if email_flags_given; then
        usage_die "The email account is set up for one instance at a time. Use install.sh instance email NAME."
      fi
      ui_skip "An email account is set up one instance at a time. Use: install.sh instance email NAME"
      return 0
    fi
    if ! email_flags_given; then
      [ "$DRY_RUN" = 1 ] && return 0
      ui_confirm "Connect an email account? (optional)" n || return 0
    fi
  else
    EM_TARGET=$OPT_NAME
  fi
  if [ "$ASSUME_YES" = 1 ]; then email_require_flags; fi
  if [ -z "$EM_PROVIDER" ] && [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ]; then
    ui_line "Which email provider is yours?"
    ui_line "  1 Gmail"
    ui_line "  2 Yahoo"
    ui_line "  3 AOL"
    ui_line "  4 iCloud"
    ui_line "  5 Fastmail"
    ui_line "  6 Zoho"
    ui_line "  7 GMX"
    ui_line "  8 web.de"
    ui_line "  9 Other provider: you type its servers"
  fi
  ask_valid EM_PROVIDER "Your provider (type a number)" "" "" email_provider_problem
  EM_PROVIDER=$(email_provider_key "$EM_PROVIDER")
  ask_valid EM_ADDRESS "Email address to connect" "" "Example: you@gmail.com" email_problem
  if email_is_microsoft "$EM_ADDRESS"; then
    ui_line "$(email_microsoft_message)"
    EM_SKIP=microsoft
    return 0
  fi
  if [ "$EM_PROVIDER" = other ]; then
    ask_valid EM_IMAP_HOST "Incoming mail server" "" "Example: imap.example.com" email_host_problem
    ask_valid EM_IMAP_PORT "Incoming mail port" "993" "Usually 993" email_port_problem
    ask_valid EM_SMTP_HOST "Outgoing mail server" "" "Example: smtp.example.com" email_host_problem
    ask_valid EM_SMTP_PORT "Outgoing mail port" "465" "Usually 465" email_port_problem
    email_other_modes
  else
    if [ -n "$OPT_EMAIL_IMAP_HOST$OPT_EMAIL_IMAP_PORT$OPT_EMAIL_SMTP_HOST$OPT_EMAIL_SMTP_PORT" ]; then
      usage_die "The server options are for --email-provider other. $(email_provider_name "$EM_PROVIDER") fills in its own servers."
    fi
    email_preset "$EM_PROVIDER" || usage_die "This installer has no servers saved for $EM_PROVIDER. Use --email-provider other and give its servers."
  fi
  email_ask_password "$EM_PROVIDER"
  ui_line "Email: $(email_provider_name "$EM_PROVIDER") at $EM_IMAP_HOST, signed in as $EM_ADDRESS."
}

email_start_command() { # name
  local dir
  dir=$(instance_dir "$1")
  printf 'docker compose --project-name aman-%s --project-directory %s -f %s/compose.yaml up -d --force-recreate %s' \
    "$1" "$dir" "$dir" "$EMAIL_SERVICE"
}

# The plan row for the install. Nothing is shown when the email account was not asked for or was skipped.
email_plan_row() {
  [ -n "$EM_ADDRESS" ] && [ -z "$EM_SKIP" ] && [ -n "$EM_TARGET" ] || return 0
  plan_add todo "Connect the email account $EM_ADDRESS to instance $EM_TARGET" \
    "The email connector keeps the app password in a file only you can read."
}

# Writes the account file of the instance, records the connector line, and checks the sign-in once. The connector is
# restarted alone, or with the instance when its settings line was new. A failed check is reported and the file stays,
# so the next step is only to fix the password.
email_apply() { # name
  local name=$1 dir changed=0
  dir=$(instance_dir "$name")
  email_write_file "$dir"
  if email_link_add "$dir/.env"; then changed=1; fi
  email_check "$name"
  EM_PASSWORD=
  if [ "$changed" = 1 ]; then
    instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
    instance_up "$name" recreate
  else
    email_restart "$name"
  fi
  ui_ok "Email account connected to instance $name."
}

email_write_file() { # instance folder
  local dir=$1
  ensure_private_dir "$dir"
  email_env_text | write_if_changed "$dir/.env.mail-email" 600 || true
}

email_env_text() {
  local imap_ssl=false imap_start=false smtp_ssl=false smtp_start=false
  if [ "$EM_IMAP_MODE" = ssl ]; then imap_ssl=true; else imap_start=true; fi
  if [ "$EM_SMTP_MODE" = ssl ]; then smtp_ssl=true; else smtp_start=true; fi
  printf '%s\n' \
    '# Written by the installer for the Email connector. Keep it private: it holds the app password.' \
    "MCP_EMAIL_SERVER_EMAIL_ADDRESS=$EM_ADDRESS" \
    "MCP_EMAIL_SERVER_PASSWORD='$EM_PASSWORD'" \
    "MCP_EMAIL_SERVER_IMAP_HOST=$EM_IMAP_HOST" \
    "MCP_EMAIL_SERVER_IMAP_PORT=$EM_IMAP_PORT" \
    "MCP_EMAIL_SERVER_IMAP_SSL=$imap_ssl" \
    "MCP_EMAIL_SERVER_IMAP_START_SSL=$imap_start" \
    "MCP_EMAIL_SERVER_IMAP_VERIFY_SSL=true" \
    "MCP_EMAIL_SERVER_SMTP_HOST=$EM_SMTP_HOST" \
    "MCP_EMAIL_SERVER_SMTP_PORT=$EM_SMTP_PORT" \
    "MCP_EMAIL_SERVER_SMTP_SSL=$smtp_ssl" \
    "MCP_EMAIL_SERVER_SMTP_START_SSL=$smtp_start" \
    "MCP_EMAIL_SERVER_SMTP_VERIFY_SSL=true"
}

# Signs in once. The password reaches python3 on stdin only. Without python3 the check is skipped and says so.
email_check() { # name
  local name=$1 answer
  if ! command -v python3 >/dev/null 2>&1; then
    ui_warn "The email account was saved, but its sign-in was not checked: python3 is not on this computer." \
      "Install python3, then run: install.sh instance email $name"
    return 0
  fi
  answer=$(printf '%s\n%s\n%s\n%s\n%s\n' "$EM_IMAP_HOST" "$EM_IMAP_PORT" "$EM_IMAP_MODE" "$EM_ADDRESS" "$EM_PASSWORD" |
    (cd / && python3 -I -c "$EMAIL_CHECK_PY") 2>/dev/null || true)
  case "$answer" in
    ok)
      ui_ok "Signed in to $EM_IMAP_HOST as $EM_ADDRESS. The email connector can read this account."
      ;;
    login)
      ui_warn "$EM_IMAP_HOST did not accept this address and app password." \
        "Check both, make a new app password if needed, then run: install.sh instance email $name"
      ;;
    *)
      ui_warn "Could not reach $EM_IMAP_HOST on port $EM_IMAP_PORT, or its security certificate was refused." \
        "Check the server name and this computer's internet connection, then run: install.sh instance email $name"
      ;;
  esac
}

# Adds the connector line below the installer's block, where the owner's own settings go. Returns 0 when it changed.
email_link_add() { # env file
  local env=$1
  if [ "$(env_key_values "$env" MAIL_EMAIL_MCP_URL)" = "$EMAIL_SIDECAR_URL" ]; then return 1; fi
  env_drop_outside_block "$env" MAIL_EMAIL_MCP_URL
  {
    cat "$env"
    [ -z "$(tail -c1 "$env")" ] || printf '\n'
    printf 'MAIL_EMAIL_MCP_URL=%s\n' "$EMAIL_SIDECAR_URL"
  } | write_if_changed "$env" 600 || true
  return 0
}

# Returns 0 when a connector line was there and is now removed.
email_link_remove() { # env file
  local had
  had=$(env_key_values "$1" MAIL_EMAIL_MCP_URL)
  [ -n "$had" ] || return 1
  env_drop_outside_block "$1" MAIL_EMAIL_MCP_URL
  return 0
}

# Restarts only the email connector, so it picks up the new account file or drops the old one.
email_restart() { # name
  local name=$1
  if ! dc "$name" up -d --force-recreate "$EMAIL_SERVICE" >/dev/null 2>&1; then
    ui_warn "The email connector could not restart." "Run: $(email_start_command "$name")"
  fi
}

cmd_instance_email() {
  local name=${OPT_NAME:-} dir changed=0
  [ -n "$name" ] || usage_die "usage: install.sh instance email <name> [--remove]"
  valid_name "$name" || usage_die "$(name_problem "$name")"
  reg_exists "$name" || die "Instance $name does not exist."
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  warn_if_installed_older
  dir=$(instance_dir "$name")
  if [ "$OPT_REMOVE" = 1 ]; then
    # The saved password is deleted for good. The file itself is then recreated empty, because the
    # sidecar mounts it and a missing file would be created as a folder on the next start, which
    # would break the account file; empty means no account is connected.
    if [ -f "$dir/.env.mail-email" ]; then rm -f -- "$dir/.env.mail-email"; fi
    : >"$dir/.env.mail-email"
    chmod 600 "$dir/.env.mail-email"
    if email_link_remove "$dir/.env"; then changed=1; fi
    if [ "$changed" = 1 ]; then
      instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
      instance_up "$name" recreate
    else
      email_restart "$name"
    fi
    ui_ok "The Email connector is removed. Any saved app password has been deleted from this computer."
    return 0
  fi
  [ -n "$REL_MAIL_EMAIL_IMAGE" ] ||
    die "The installed version of Aman has no email connector yet. Run install.sh upgrade first, then run this command again."
  email_collect instance
  if [ -n "$EM_SKIP" ]; then return 0; fi
  email_apply "$name"
}

# --remove and the email options belong to instance email, and the options to install as well.
check_email_options() {
  if [ "$COMMAND:$SUBCOMMAND" = instance:email ]; then
    if [ "$OPT_REMOVE" = 1 ] && email_flags_given; then usage_die "--remove cannot be used with the email options; use one or the other"; fi
  else
    if email_flags_given && [ "$COMMAND" != install ]; then usage_die "The --email-* options apply to install and instance email"; fi
  fi
}
