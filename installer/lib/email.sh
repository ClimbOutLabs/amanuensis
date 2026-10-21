# shellcheck shell=bash
# The optional email account of an instance. The Email connector reads one account from .env.mail-email in the
# instance folder. The app password stays in shell memory, is written only to that file (0600), and is never printed.

# Provider menu in the order the prompt shows it. The slugs are what --email-provider takes.
EMAIL_PROVIDER_NAMES=(Gmail Yahoo AOL iCloud Fastmail Zoho GMX web.de "Proton Mail Bridge" Other)
EMAIL_PROVIDER_SLUGS=(gmail yahoo aol icloud fastmail zoho gmx webde proton other)

# One preset per line: slug, incoming host, port, mode, outgoing host, port, mode, check the certificate.
# A mode is ssl (encrypted from the start) or starttls (upgraded after connecting). Proton Bridge runs on this computer
# with its own certificate, which is why only its preset turns the certificate check off.
EMAIL_PRESETS='gmail imap.gmail.com 993 ssl smtp.gmail.com 465 ssl true
yahoo imap.mail.yahoo.com 993 ssl smtp.mail.yahoo.com 465 ssl true
aol imap.aol.com 993 ssl smtp.aol.com 465 ssl true
icloud imap.mail.me.com 993 ssl smtp.mail.me.com 587 starttls true
fastmail imap.fastmail.com 993 ssl smtp.fastmail.com 465 ssl true
zoho imap.zoho.com 993 ssl smtp.zoho.com 465 ssl true
gmx imap.gmx.net 993 ssl mail.gmx.net 465 ssl true
webde imap.web.de 993 ssl smtp.web.de 587 starttls true
proton 127.0.0.1 1143 starttls 127.0.0.1 1025 starttls false'

# The one sign-in check after saving. It runs from this computer, so the Email connector does not have to be running.
# Its six input lines (server, port, mode, certificate check, address, password) come on stdin, never on the command line.
# It prints ok, login (the server refused the sign-in) or server (the server could not be reached or trusted).
EMAIL_CHECK_PY=$(
  cat <<'PY'
import imaplib, ssl, sys
host, port, mode, verify, user, password = sys.stdin.read().split("\n")[:6]
ctx = ssl.create_default_context()
if verify != "true":
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
try:
    if mode == "ssl":
        conn = imaplib.IMAP4_SSL(host, int(port), ssl_context=ctx, timeout=20)
    else:
        conn = imaplib.IMAP4(host, int(port), timeout=20)
        conn.starttls(ssl_context=ctx)
except (OSError, ssl.SSLError, imaplib.IMAP4.error, ValueError):
    print("server")
    sys.exit(0)
# Quoted, so a password with spaces or symbols reaches the server as one string.
quoted = '"' + password.replace("\\", "\\\\").replace('"', '\\"') + '"'
try:
    conn.login(user, quoted)
except imaplib.IMAP4.error:
    print("login")
    sys.exit(0)
conn.logout()
print("ok")
PY
)

# True when at least one email option was given on the command line.
email_option_given() {
  [ -n "$OPT_EMAIL_PROVIDER$OPT_EMAIL_ADDRESS$OPT_EMAIL_IMAP_HOST$OPT_EMAIL_IMAP_PORT$OPT_EMAIL_SMTP_HOST$OPT_EMAIL_SMTP_PORT" ] ||
    [ "$OPT_EMAIL_PASSWORD_STDIN" = 1 ]
}

email_env_file() { printf '%s/.env.mail-email' "$(instance_dir "$1")"; }

# Spaces are how providers display an app password; they are not part of it. Only what remains is checked.
email_clean_password() { printf '%s' "${1// /}"; }

email_password_problem() {
  local LC_ALL=C
  if [ -z "$1" ]; then
    echo "The app password is needed. Make one with your provider and type it here."
  elif [[ $1 == *[![:graph:]]* ]] || [[ $1 == *"'"* ]]; then
    echo "The app password has a character this installer cannot use. Copy it again from your provider."
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

email_choice_problem() {
  local count=${#EMAIL_PROVIDER_NAMES[@]}
  if matches_whole "$1" '^[[:digit:]]{1,2}$' && [ "$((10#$1))" -ge 1 ] && [ "$((10#$1))" -le "$count" ]; then
    return 0
  fi
  echo "Type a number from the list, from 1 to $count."
}

email_slug_known() {
  local slug
  for slug in "${EMAIL_PROVIDER_SLUGS[@]}"; do
    [ "$slug" = "$1" ] && return 0
  done
  return 1
}

# Outlook, Hotmail and Live addresses need a Microsoft sign-in, which is not part of this installer yet.
email_is_microsoft() {
  local address
  address=$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  case "$address" in
    *@outlook.* | *@hotmail.* | *@live.*) return 0 ;;
  esac
  return 1
}

email_microsoft_message() {
  echo "Outlook, Hotmail and Live addresses need a Microsoft sign-in, which comes in a later update. Skip email for now."
}

# Sets E_IMAP_* and E_SMTP_* and E_VERIFY from the preset row of a provider slug. Returns 1 for an unknown slug.
email_preset() {
  local row
  row=$(printf '%s\n' "$EMAIL_PRESETS" | sed -n "/^$1 /p")
  [ -n "$row" ] || return 1
  # shellcheck disable=SC2034 # the slug column is only there to find the row
  read -r _slug E_IMAP_HOST E_IMAP_PORT E_IMAP_MODE E_SMTP_HOST E_SMTP_PORT E_SMTP_MODE E_VERIFY <<<"$row"
}

# The encryption of a server the person typed: port 993 and 465 are encrypted from the start, others upgrade.
email_other_modes() {
  E_IMAP_MODE=starttls
  [ "$E_IMAP_PORT" != 993 ] || E_IMAP_MODE=ssl
  E_SMTP_MODE=starttls
  [ "$E_SMTP_PORT" != 465 ] || E_SMTP_MODE=ssl
  E_VERIFY=true
}

email_provider_label() { # slug
  local i
  for i in "${!EMAIL_PROVIDER_SLUGS[@]}"; do
    if [ "${EMAIL_PROVIDER_SLUGS[$i]}" = "$1" ]; then printf '%s' "${EMAIL_PROVIDER_NAMES[$i]}"; fi
  done
}

# The one sentence on how to make an app password for each provider.
email_password_hint() { # slug
  case "$1" in
    gmail) echo "In your Google account, turn on 2-Step Verification, then create an app password under Security." ;;
    yahoo) echo "In your Yahoo account security settings, create an app password for a mail app." ;;
    aol) echo "In your AOL account security settings, create an app password for a mail app." ;;
    icloud) echo "On account.apple.com, under Sign-In and Security, create an app-specific password." ;;
    fastmail) echo "In Fastmail settings, create an app password that allows IMAP and SMTP." ;;
    zoho) echo "In your Zoho account security settings, create an application-specific password, or use your Zoho password if two-step sign-in is off." ;;
    gmx) echo "Turn on IMAP in your GMX settings first, then type your GMX password." ;;
    webde) echo "Turn on POP3 and IMAP access in your web.de mail settings first, then make an app password there if you use two-step sign-in." ;;
    proton) echo "Open Proton Mail Bridge on this computer and copy the Bridge password it shows for your account, not your Proton login password." ;;
    *) echo "Type the password your provider gave you for mail apps." ;;
  esac
}

# Reads one line for --email-password-stdin. It follows the sign-in password and the Token Factory key on the input.
email_read_password_stdin() {
  local line=
  [ "$OPT_EMAIL_PASSWORD_STDIN" = 1 ] && [ "$DRY_RUN" != 1 ] || return 0
  IFS= read -r line || true
  AMAN_EMAIL_PASSWORD=$(email_clean_password "$line")
  [ -n "$AMAN_EMAIL_PASSWORD" ] || usage_die "The input line for --email-password-stdin was empty, so no app password was read."
  local problem
  problem=$(email_password_problem "$AMAN_EMAIL_PASSWORD")
  [ -z "$problem" ] || usage_die "$problem"
}

# Sets the E_* settings from the --email-* options. Used by install, instance add and instance email alike.
email_collect_flags() {
  local slug=$OPT_EMAIL_PROVIDER problem
  [ -n "$slug" ] || usage_die "The email options need --email-provider: gmail, yahoo, aol, icloud, fastmail, zoho, gmx, webde, proton or other."
  email_slug_known "$slug" || usage_die "--email-provider takes gmail, yahoo, aol, icloud, fastmail, zoho, gmx, webde, proton or other."
  [ -n "$OPT_EMAIL_ADDRESS" ] || usage_die "--email-provider needs --email-address, the address to connect."
  problem=$(email_problem "$OPT_EMAIL_ADDRESS")
  [ -z "$problem" ] || usage_die "$problem"
  email_is_microsoft "$OPT_EMAIL_ADDRESS" && usage_die "$(email_microsoft_message)"
  if [ "$slug" = other ]; then
    problem=$(email_host_problem "$OPT_EMAIL_IMAP_HOST")
    [ -z "$problem" ] || usage_die "--email-imap-host: $problem"
    problem=$(email_port_problem "$OPT_EMAIL_IMAP_PORT")
    [ -z "$problem" ] || usage_die "--email-imap-port: $problem"
    problem=$(email_host_problem "$OPT_EMAIL_SMTP_HOST")
    [ -z "$problem" ] || usage_die "--email-smtp-host: $problem"
    problem=$(email_port_problem "$OPT_EMAIL_SMTP_PORT")
    [ -z "$problem" ] || usage_die "--email-smtp-port: $problem"
    E_IMAP_HOST=$OPT_EMAIL_IMAP_HOST E_IMAP_PORT=$OPT_EMAIL_IMAP_PORT
    E_SMTP_HOST=$OPT_EMAIL_SMTP_HOST E_SMTP_PORT=$OPT_EMAIL_SMTP_PORT
    email_other_modes
  else
    [ -z "$OPT_EMAIL_IMAP_HOST$OPT_EMAIL_IMAP_PORT$OPT_EMAIL_SMTP_HOST$OPT_EMAIL_SMTP_PORT" ] ||
      usage_die "The server options are for --email-provider other. $(email_provider_label "$slug") fills in its own servers."
    email_preset "$slug" || usage_die "No preset for $slug."
  fi
  E_PROVIDER=$(email_provider_label "$slug")
  E_ADDRESS=$OPT_EMAIL_ADDRESS
  E_ON=1
  if [ -z "$AMAN_EMAIL_PASSWORD" ] && [ "$DRY_RUN" != 1 ]; then
    [ -t 0 ] || usage_die "--email-provider needs the app password on the input. Add --email-password-stdin, and give it as the line after the other stdin lines."
    email_ask_password "$slug"
  fi
}

# Asks for the password without echo until it passes the check, up to the usual number of tries.
email_ask_password() { # slug
  local problem tries=0
  ui_hint "$(email_password_hint "$1") Spaces in it are removed for you."
  while [ "$tries" -lt "$UI_MAX_TRIES" ]; do
    ui_password AMAN_EMAIL_PASSWORD "App password for $E_ADDRESS" || die "No password was entered, so the email account was not changed."
    AMAN_EMAIL_PASSWORD=$(email_clean_password "$AMAN_EMAIL_PASSWORD")
    problem=$(email_password_problem "$AMAN_EMAIL_PASSWORD")
    [ -z "$problem" ] && return 0
    UI_FD=2 ui_fail "$problem"
    tries=$((tries + 1))
  done
  die "No valid app password after $UI_MAX_TRIES tries, so the email account was not changed. Run the command again."
}

# Asks the provider, address and servers or preset, then the app password. Returns 1 when the step is skipped.
email_ask_account() {
  local i choice slug problem
  ui_hint "Pick your email provider. Outlook, Hotmail and Live addresses cannot be connected yet."
  for i in "${!EMAIL_PROVIDER_NAMES[@]}"; do
    printf '  %s. %s\n' "$((i + 1))" "${EMAIL_PROVIDER_NAMES[$i]}" >&2
  done
  ask_valid choice "Type the number of your provider" "" "" email_choice_problem
  slug=${EMAIL_PROVIDER_SLUGS[$((10#$choice - 1))]}
  E_PROVIDER=$(email_provider_label "$slug")
  ask_valid E_ADDRESS "Email address" "" "Example: you@gmail.com" email_problem
  if email_is_microsoft "$E_ADDRESS"; then
    ui_warn "$(email_microsoft_message)" "Connect it later with: install.sh instance email NAME"
    return 1
  fi
  if [ "$slug" = other ]; then
    ask_valid E_IMAP_HOST "Incoming mail server" "" "Example: imap.example.com" email_host_problem
    ask_valid E_IMAP_PORT "Incoming mail port" "993" "Usually 993" email_port_problem
    ask_valid E_SMTP_HOST "Outgoing mail server" "" "Example: smtp.example.com" email_host_problem
    ask_valid E_SMTP_PORT "Outgoing mail port" "465" "Usually 465" email_port_problem
    email_other_modes
  else
    email_preset "$slug" || die "No preset for $slug."
  fi
  E_ON=1
  email_ask_password "$slug"
}

# install and instance add: the optional question, asked only at a terminal and never with --yes or --dry-run.
email_collect() {
  E_ON=0
  if email_option_given; then
    email_collect_flags
  elif [ "$ASSUME_YES" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    return 0
  else
    ui_confirm "Connect an email account? (optional)" n || return 0
    email_ask_account || E_ON=0
  fi
}

# Writes the account file of an instance, records it, and signs in once to check it. A failed check is reported, and
# the file stays so the next step is only to fix the password.
email_save() { # name
  local name=$1 file
  file=$(email_env_file "$name")
  email_env_text | write_if_changed "$file" 600 || true
  reg_set "$name" mail_provider "$E_PROVIDER"
  reg_set "$name" mail_address "$E_ADDRESS"
  log_event "email account saved for instance $name"
  email_check "$name"
}

email_env_text() {
  local imap_ssl=false imap_start=false smtp_ssl=false smtp_start=false
  if [ "$E_IMAP_MODE" = ssl ]; then imap_ssl=true; else imap_start=true; fi
  if [ "$E_SMTP_MODE" = ssl ]; then smtp_ssl=true; else smtp_start=true; fi
  printf '%s\n' \
    '# Written by the installer for the Email connector. Keep it private: it holds the app password.' \
    "MCP_EMAIL_SERVER_EMAIL_ADDRESS=$E_ADDRESS" \
    "MCP_EMAIL_SERVER_PASSWORD='$AMAN_EMAIL_PASSWORD'" \
    "MCP_EMAIL_SERVER_IMAP_HOST=$E_IMAP_HOST" \
    "MCP_EMAIL_SERVER_IMAP_PORT=$E_IMAP_PORT" \
    "MCP_EMAIL_SERVER_IMAP_SSL=$imap_ssl" \
    "MCP_EMAIL_SERVER_IMAP_START_SSL=$imap_start" \
    "MCP_EMAIL_SERVER_IMAP_VERIFY_SSL=$E_VERIFY" \
    "MCP_EMAIL_SERVER_SMTP_HOST=$E_SMTP_HOST" \
    "MCP_EMAIL_SERVER_SMTP_PORT=$E_SMTP_PORT" \
    "MCP_EMAIL_SERVER_SMTP_SSL=$smtp_ssl" \
    "MCP_EMAIL_SERVER_SMTP_START_SSL=$smtp_start" \
    "MCP_EMAIL_SERVER_SMTP_VERIFY_SSL=$E_VERIFY"
}

# Signs in once. The password reaches python3 on stdin only. Without python3 the check is skipped and says so.
email_check() { # name
  local name=$1 answer
  if ! command -v python3 >/dev/null 2>&1; then
    ui_warn "The email account was saved, but its sign-in was not checked: python3 is not on this computer." \
      "Install python3, then run: install.sh instance email $name"
    return 0
  fi
  answer=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$E_IMAP_HOST" "$E_IMAP_PORT" "$E_IMAP_MODE" "$E_VERIFY" "$E_ADDRESS" "$AMAN_EMAIL_PASSWORD" |
    python3 -c "$EMAIL_CHECK_PY" 2>/dev/null || true)
  case "$answer" in
    ok)
      ui_ok "Signed in to $E_IMAP_HOST as $E_ADDRESS. The email connector can read this account."
      ;;
    login)
      ui_warn "$E_IMAP_HOST did not accept this address and app password." \
        "Check both, make a new app password if needed, then run: install.sh instance email $name"
      ;;
    *)
      ui_warn "Could not reach $E_IMAP_HOST on port $E_IMAP_PORT, or its security certificate was refused." \
        "Check the server name and this computer's internet connection, then run: install.sh instance email $name"
      ;;
  esac
}

# install and instance add for an instance that exists: the email options belong to instance email.
email_refuse_on_existing() {
  email_option_given || return 0
  usage_die "Aman is already set up. To connect an email account to an instance, run: install.sh instance email NAME"
}

check_email_options() {
  if [ "$OPT_EMAIL_REMOVE" = 1 ] && [ "$COMMAND:$SUBCOMMAND" != instance:email ]; then
    usage_die "--remove applies to instance email"
  fi
  if email_option_given && [ "$COMMAND:$SUBCOMMAND" != install: ] && [ "$COMMAND:$SUBCOMMAND" != instance:add ] &&
    [ "$COMMAND:$SUBCOMMAND" != instance:email ]; then
    usage_die "The email options apply to install, instance add and instance email"
  fi
}

# install.sh instance email NAME [--remove]: connect, change or remove the email account of an instance, then restart it.
cmd_instance_email() {
  local name=${OPT_NAME:-}
  [ -n "$name" ] || usage_die "usage: install.sh instance email <name> [--remove]"
  valid_name "$name" || usage_die "$(name_problem "$name")"
  reg_exists "$name" || die "Instance $name does not exist."
  require_installed
  if [ "$OPT_EMAIL_REMOVE" = 1 ]; then
    email_option_given && usage_die "--remove takes no email options."
  else
    email_read_password_stdin
    if email_option_given; then
      email_collect_flags
    elif [ -t 0 ] && [ "$ASSUME_YES" != 1 ]; then
      email_ask_account || return 0
    else
      usage_die "instance email needs --email-provider and the other email options, or a terminal to answer questions."
    fi
  fi
  docker_prepare
  lock_acquire
  load_installed_release
  warn_if_installed_older
  if [ "$OPT_EMAIL_REMOVE" = 1 ]; then
    rm -f "$(email_env_file "$name")"
    reg_unset "$name" mail_provider
    reg_unset "$name" mail_address
    log_event "email account removed from instance $name"
    ui_ok "Email account removed from instance $name."
  else
    email_save "$name"
  fi
  AMAN_EMAIL_PASSWORD=
  instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  instance_up "$name" recreate
}
