# shellcheck shell=bash
# This computer's key for saved logins, and tying each instance's data to it.
#
# The key is made once per computer and lives in one Docker volume, outside every instance's data and outside
# every backup. Each instance mounts it read-only. The app never makes a key itself: it waits, locked, until the
# key is there and matches its data. Each instance gets its own recovery key, shown once.

MACHINE_KEY_VOLUME=aman_key
MACHINE_KEY_FILE=/run/aman-key/master.key

machine_key_volume_ensure() {
  docker_volume_exists "$MACHINE_KEY_VOLUME" && return 0
  D volume create "$MACHINE_KEY_VOLUME" >/dev/null ||
    die "The place for this computer's key could not be made. Check that Docker is running, then run the installer again."
  MACHINE_KEY_NEW=1
}
MACHINE_KEY_NEW=0

# Whether an app image can seal backups and set up the key. An image from before this could not, and the version
# an upgrade puts back when it fails may be one of those.
image_has_key_support() { # image
  D run --rm --network none "$1" aman help 2>&1 | grep -q 'unseal'
}

# Makes this computer's key when there is none yet, without touching any instance's data. Used for a backup of an
# instance that has not been tied to the key yet.
machine_key_ensure() { # image
  local out
  machine_key_volume_ensure
  out=$(D run --rm --network none -v "$MACHINE_KEY_VOLUME:/run/aman-key" "$1" aman secrets key --key-file "$MACHINE_KEY_FILE" 2>/dev/null) || return 1
  case "$out" in
    *'"created":true'*) MACHINE_KEY_NEW=1 ;;
    *'"created":false'*) ;;
    *) return 1 ;;
  esac
}

# Runs the setup command in the instance's own one-off container, which is the only one that may write the key.
# Prints the command's answer; what it says on the way goes to the step log, which never sees the answer.
secrets_setup_run() { # name args...
  local name=$1
  shift
  dc "$name" --profile setup run --rm -T secrets-setup "$@" 2>>"${STEP_LOG:-/dev/null}"
}

# Asks the person to type the key back, and checks it by opening the instance's data with it alone. Only at a
# terminal: a scripted run cannot type. Giving up keeps the key, which already works.
recovery_key_confirm() { # name key
  local name=$1 key=$2 typed tries=0
  if [ ! -t 0 ] || [ "$ASSUME_YES" = 1 ]; then
    return 0
  fi
  say "Type the recovery key back now, so you know your copy is right."
  while [ "$tries" -lt "$UI_MAX_TRIES" ]; do
    ui_prompt typed "Recovery key" || break
    if [ "$(printf '%s' "$typed" | tr -cd '0-9')" = "$(printf '%s' "$key" | tr -cd '0-9')" ] &&
      printf '%s' "$typed" | secrets_setup_run "$name" check-recovery --sqlite /data/db/db.sqlite >/dev/null; then
      say "That matches. Keep it somewhere safe."
      return 0
    fi
    UI_IN_PROMPT=1 UI_FD=2 ui_fail "That does not match. Check each group of six digits and type it again."
    tries=$((tries + 1))
  done
  warn "The recovery key was not typed back. It still works: keep the copy shown above somewhere safe."
}

recovery_key_show() { # name key
  ui_newline
  ui_heading "Recovery key for $1"
  ui_line "Aman keeps your saved logins encrypted with a key held on this computer."
  ui_line "If this computer or its key is ever lost, this recovery key is the only way to open your data again."
  ui_newline
  ui_command "$2"
  ui_newline
  ui_line "Write it down now and keep it somewhere safe. It is shown only this once."
  if [ "$MACHINE_KEY_NEW" = 1 ]; then
    if ! disk_encryption_on; then
      warn "This computer's key is kept in a file on this disk. Without disk encryption, a lost or stolen computer can be read." "Turn on disk encryption for this computer: FileVault on a Mac, BitLocker on Windows, LUKS on Linux."
    fi
    MACHINE_KEY_NEW=0
  fi
}

# True only when the disk under Docker's data is known to be encrypted. Not knowing counts as not encrypted, so
# the warning errs toward being shown.
disk_encryption_on() {
  local source
  case "$(uname -s)" in
    Darwin) fdesetup isactive >/dev/null 2>&1 ;;
    Linux)
      command -v findmnt >/dev/null 2>&1 && command -v lsblk >/dev/null 2>&1 || return 1
      source=$(findmnt -no SOURCE -T /var/lib/docker 2>/dev/null) || return 1
      [ -n "$source" ] || return 1
      lsblk -sno TYPE "$source" 2>/dev/null | grep -qx crypt
      ;;
    *) return 1 ;;
  esac
}

# Makes sure the instance's data is tied to this computer's key before the app starts. Does nothing once done.
# The app is stopped first, because setup brings the data up to date for the app that is about to start.
instance_secrets_ensure() { # name
  local name=$1 out key
  [ "$(reg_get "$name" secrets)" != 1 ] || return 0
  # A version from before the key, put back after a failed upgrade, has no setup to run.
  image_has_key_support "$(awk '/^  app:/ { app = 1 } app && /^    image: / { print $2; exit }' "$(instance_dir "$name")/compose.yaml")" || return 0
  machine_key_volume_ensure
  step_begin "secrets-$name" "Setting up the key that protects saved logins for $name"
  if [ "$(instance_state "$name")" != stopped ]; then
    dc "$name" stop app >>"$STEP_LOG" 2>&1 || true
  fi
  # No input: the run's own input may hold answers meant for later questions.
  if ! out=$(secrets_setup_run "$name" init --if-needed --sqlite /data/db/db.sqlite --key-file "$MACHINE_KEY_FILE" </dev/null); then
    if grep -q 'different key' "$STEP_LOG" 2>/dev/null; then
      UI_FD=2 ui_step_end fail "The data of $name was protected with a key from another computer, so it cannot be opened here yet." "Restore it from its backup with: install.sh restore. It asks for the recovery key."
    else
      step_fail "The key that protects saved logins could not be set up for $name." "Run the installer again. If it fails again, run: aman doctor"
    fi
    return 1
  fi
  key=$(printf '%s' "$out" | sed -n 's/.*"recovery_key"[[:space:]]*:[[:space:]]*"\([0-9-]*\)".*/\1/p' | head -n 1)
  if [ -z "$key" ] && ! printf '%s' "$out" | grep -q '"already_set_up"[[:space:]]*:[[:space:]]*true'; then
    step_fail "The key that protects saved logins could not be set up for $name." "Run the installer again. If it fails again, run: aman doctor"
  fi
  step_ok "Saved logins for $name are protected by this computer's key"
  if [ -n "$key" ]; then
    matches_whole "$key" '^[0-9]{6}(-[0-9]{6}){7}$' || die "The app returned something that is not a recovery key. This looks like a bug in Aman."
    recovery_key_show "$name" "$key"
    recovery_key_confirm "$name" "$key"
  fi
  reg_set "$name" secrets 1
  log_event "instance $name secrets set up"
}
