# shellcheck shell=bash
# Sign-in users besides the owner. The registry holds each one's name, email and role; the password hash lives only in
# the instance dex.env. Dex users and the app's allowed emails are derived from those two on every render, so a re-render,
# an upgrade or a re-run never loses a user.

# The only role a added user can have. The app grants admin to the one email in OIDC_ADMIN_ROLE_VALUE (the owner), so
# every other signed-in user is a member: chat and history of their own, no server settings.
USER_ROLE_MEMBER=member
# These two lines are also in templates/instance/dex.env.tpl; a dex.env from before users existed gets them appended.
DEX_ENV_USERS_BEGIN='# >>> sign-in users added with install.sh instance add-user: one password hash each, kept by the installer'
DEX_ENV_USERS_END='# <<< end of user hashes'

valid_user_name() {
  [ "$1" != owner ] && matches_whole "$1" '^[a-z]([a-z0-9-]{0,22}[a-z0-9])?$'
}

# Upper-case form of a user name that is legal in an environment variable name (hyphens cannot be, and names hold no
# underscores, so two names never share a key).
user_key() { printf '%s' "$1" | tr 'a-z-' 'A-Z_'; }

# Environment variable that carries one user's hash into Dex.
user_hash_var() { printf 'DEX_USER_PASSWORD_HASH_%s' "$(user_key "$1")"; }

# Registry names of an instance's added users, one per line.
user_names() {
  sed -n 's/^user_\([a-z0-9-]*\)=.*/\1/p' "$(reg_file "$1")" | sort
}

user_record() { reg_get "$1" "user_$2"; }
user_role() { local r; r=$(user_record "$1" "$2"); printf '%s' "${r%%:*}"; }
user_email() { local r; r=$(user_record "$1" "$2"); printf '%s' "${r#*:}"; }

lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# The name of the user (owner included) who already signs in with this email, if any.
user_with_email() {
  local name=$1 email other wanted
  wanted=$(lowercase "$2")
  if [ "$wanted" = "$(lowercase "$(reg_get "$name" owner_email)")" ]; then
    printf 'owner'
    return 0
  fi
  for other in $(user_names "$name"); do
    if [ "$wanted" = "$(lowercase "$(user_email "$name" "$other")")" ]; then
      printf '%s' "$other"
      return 0
    fi
  done
  return 1
}

# Owner first, then members; comma separated, as OIDC_ALLOWED_EMAILS wants it.
users_allowed_emails() {
  local name=$1 list user
  list=$(reg_get "$name" owner_email)
  for user in $(user_names "$name"); do
    list="$list,$(user_email "$name" "$user")"
  done
  printf '%s' "$list"
}

dex_env_file() { printf '%s/dex.env' "$(instance_dir "$1")"; }

dex_env_has_hash() {
  grep -q "^$(user_hash_var "$2")=" "$(dex_env_file "$1")" 2>/dev/null
}

# dex_env_put NAME USER HASH: one line per user, replaced when present. A dex.env from before users existed has no
# end marker, so the block is added at its end.
dex_env_put() {
  local file line var rendered written=0
  file=$(dex_env_file "$1")
  [ -f "$file" ] || die "instance $1 has no dex.env"
  var=$(user_hash_var "$2")
  rendered=$(render_template "$TEMPLATES_DIR/instance/dex.user.env.tpl" "USER_KEY=$(user_key "$2")" "PASSWORD_HASH=$3")
  {
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$var="*)
          printf '%s\n' "$rendered"
          written=1
          continue
          ;;
        "$DEX_ENV_USERS_END"*)
          if [ "$written" = 0 ]; then
            printf '%s\n' "$rendered"
            written=1
          fi
          ;;
      esac
      printf '%s\n' "$line"
    done <"$file"
    if [ "$written" = 0 ]; then
      printf '%s\n%s\n%s\n' "$DEX_ENV_USERS_BEGIN" "$rendered" "$DEX_ENV_USERS_END"
    fi
  } | write_if_changed "$file" 600 || true
}

dex_env_drop() {
  local file line var
  file=$(dex_env_file "$1")
  [ -f "$file" ] || return 0
  var=$(user_hash_var "$2")
  {
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$var="*) ;;
        *) printf '%s\n' "$line" ;;
      esac
    done <"$file"
  } | write_if_changed "$file" 600 || true
}

# The Dex staticPasswords entries of the added users. A user without a hash is left out with a warning rather than
# written as an entry Dex cannot start with: one broken account must not take the login down for everyone.
dex_members_yaml() {
  local name=$1 user out='' entry
  for user in $(user_names "$name"); do
    if ! dex_env_has_hash "$name" "$user"; then
      warn "user $user of instance $name has no password hash in dex.env, so it cannot sign in; remove it and add it again"
      continue
    fi
    entry=$(render_template "$TEMPLATES_DIR/instance/dex.user.yaml.tpl" \
      "USER=$user" "EMAIL=$(user_email "$name" "$user")" "USER_KEY=$(user_key "$user")")
    out="${out:+$out$'\n'}$entry"
  done
  printf '%s' "$out"
}

# Re-derives everything that depends on the user set: the allowed emails in .env and dex.yaml. Returns 0 when a file
# changed, 1 when nothing did.
users_sync() {
  local name=$1 dir before after
  dir=$(instance_dir "$name")
  before=$(cat "$dir/.env" "$dir/dex.env" "$dir/dex.yaml" 2>/dev/null | sha256_stdin)
  env_managed_set "$dir/.env" OIDC_ALLOWED_EMAILS "$(users_allowed_emails "$name")"
  instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  after=$(cat "$dir/.env" "$dir/dex.env" "$dir/dex.yaml" | sha256_stdin)
  [ "$before" != "$after" ]
}

# The app reads its allowed emails at start and Dex its users, so both restart; a stopped instance picks the change up
# when it starts.
users_apply() {
  local name=$1
  if [ "$(instance_state "$name")" = stopped ]; then
    say "Instance $name is stopped; the change applies when it starts."
    return 0
  fi
  say "Restarting the sign-in service and the app of instance $name"
  dc "$name" up -d --force-recreate --no-deps --wait --wait-timeout 240 dex app ||
    die "instance $name did not restart healthy. Look at: docker compose -p aman-$name logs --tail 50"
}

# A readable one-time password: 96 random bits, grouped for typing.
generate_password() {
  local hex
  hex=$(rand_hex 12)
  printf '%s-%s-%s-%s' "${hex:0:6}" "${hex:6:6}" "${hex:12:6}" "${hex:18:6}"
}

# The one instance a user command targets: --instance, else the only one.
users_target_instance() {
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

cmd_instance_add_user() {
  local user=${OPT_NAME:-} email=${OPT_EMAIL:-} name role=${OPT_ROLE:-$USER_ROLE_MEMBER} owner_of existing generated=0 hash
  [ -n "$user" ] && [ -n "$email" ] || usage_die "usage: install.sh instance add-user <name> --email ADDRESS [--role member] [--instance NAME] [--password-stdin]"
  valid_user_name "$user" || usage_die "a user name is 1-24 lowercase letters, digits or hyphens, starts with a letter, and is not 'owner'"
  valid_email "$email" || usage_die "a valid email address is required"
  case "$role" in
    "$USER_ROLE_MEMBER") ;;
    admin) usage_die "the owner is the only admin; added users are members (they chat, but cannot change server settings)" ;;
    *) usage_die "--role takes member" ;;
  esac
  require_installed
  name=$(users_target_instance)
  existing=$(user_record "$name" "$user")
  if [ -n "$existing" ]; then
    [ "$(lowercase "$(user_email "$name" "$user")")" = "$(lowercase "$email")" ] ||
      die "user $user already exists with a different email; run remove-user first to replace it"
  else
    if owner_of=$(user_with_email "$name" "$email"); then
      die "the email $email already signs in as $owner_of"
    fi
  fi
  docker_prepare
  lock_acquire
  load_installed_release
  if [ -n "$existing" ]; then
    # Same user again: keep the password, but finish a change an interrupted run left half applied.
    if users_sync "$name"; then users_apply "$name"; fi
    say "User $user ($email) already exists on instance $name; the password is unchanged."
    return 0
  fi
  AMAN_PASSWORD=
  if [ "$PASSWORD_FROM_STDIN" = 1 ]; then
    ask_password AMAN_PASSWORD
  else
    AMAN_PASSWORD=$(generate_password)
    generated=1
  fi
  hash=$(hash_password "$REL_APP_TAG")
  dex_env_put "$name" "$user" "$hash"
  reg_set "$name" "user_$user" "$role:$email"
  users_sync "$name" || true
  users_apply "$name"
  log_event "user $user added to instance $name as $role"
  say ""
  say "Added $role $user to instance $name."
  say "  Open:      $(reg_get "$name" public_url)"
  say "  Email:     $email"
  if [ "$generated" = 1 ]; then
    say "  Password:  $AMAN_PASSWORD"
    say "  This password is shown once and stored nowhere readable. Hand it over on a private channel."
  else
    say "  Password:  the one read from stdin"
  fi
  AMAN_PASSWORD=
}

cmd_instance_remove_user() {
  local user=${OPT_NAME:-} name
  [ -n "$user" ] || usage_die "usage: install.sh instance remove-user <name> [--instance NAME]"
  valid_user_name "$user" || usage_die "invalid user name (the owner cannot be removed)"
  require_installed
  name=$(users_target_instance)
  if [ -z "$(user_record "$name" "$user")" ] && ! dex_env_has_hash "$name" "$user"; then
    say "User $user does not exist on instance $name; nothing to do."
    return 0
  fi
  docker_prepare
  lock_acquire
  load_installed_release
  reg_unset "$name" "user_$user"
  dex_env_drop "$name" "$user"
  users_sync "$name" || true
  users_apply "$name"
  log_event "user $user removed from instance $name"
  say "Removed user $user from instance $name. Their chats stay in the instance data."
}

# Names, emails and roles only; no hash is ever read into the output.
cmd_instance_list_users() {
  local name user
  [ -z "${OPT_NAME:-}" ] || usage_die "usage: install.sh instance list-users [--instance NAME]"
  name=$(users_target_instance)
  {
    printf '%s\t%s\t%s\n' NAME EMAIL ROLE
    printf '%s\t%s\t%s\n' owner "$(reg_get "$name" owner_email)" admin
    for user in $(user_names "$name"); do
      printf '%s\t%s\t%s\n' "$user" "$(user_email "$name" "$user")" "$(user_role "$name" "$user")"
    done
  } | align_columns
}
