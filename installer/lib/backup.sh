# shellcheck shell=bash
# Backups: the CLI writes into a scratch volume and each instance leaves it as one sealed file streamed over stdout, so
# no host bind mounts are involved and nothing readable reaches the backup folder.

BACKUP_KEEP=7
# The newest manifest.json version of the backup CLI that restore understands.
BACKUP_MANIFEST_VERSION=1
LAST_BACKUP_DIR=

write_checksums() {
  local dir=$1 f sums
  sums=$(
    cd "$dir" || exit 1
    find . -type f | sort | while IFS= read -r f; do
      printf '%s  %s\n' "$(sha256_stdin <"$f")" "${f#./}"
    done
  )
  printf '%s\n' "$sums" >"$dir/SHA256SUMS"
  chmod 600 "$dir/SHA256SUMS"
}

# Streams a volume's files as a tar archive, read-only, with no network.
volume_tar() {
  local volume=$1 image=$2
  D run --rm --network none -v "$volume:/data:ro" "$image" tar -C /data -cf - .
}

BACKUP_SCRATCH_LABEL=com.amanuensis.scratch=backup

# Removes scratch volumes a killed run left behind; only volumes carrying the scratch label are touched.
backup_scratch_prune() {
  local volume
  for volume in $(D volume ls -q --filter "label=$BACKUP_SCRATCH_LABEL" 2>/dev/null || true); do
    D volume rm -f "$volume" >/dev/null 2>&1 || true
  done
}

# Whether the database file is there: 0 yes, 1 no (the folder is missing or readable and holds none), 2 or more when
# it cannot be told (the folder is not readable, or the check itself failed), which is an error and never "no data".
database_probe() { # name image path
  local name=$1 image=$2 path=$3 dir rc=0
  dir=$(dirname "$path")
  D run --rm --network none -v "aman_${name}_data:/data:ro" "$image" test -f "$path" >/dev/null 2>&1 || rc=$?
  [ "$rc" = 0 ] && return 0
  [ "$rc" = 1 ] || return 2
  D run --rm --network none -v "aman_${name}_data:/data:ro" "$image" test ! -e "$dir" -o -x "$dir" >/dev/null 2>&1 || return 2
  return 1
}

# Puts one more file into the scratch volume, from stdin, so it is sealed with the rest.
backup_scratch_add() { # scratch image file
  D run --rm -i --network none -v "$1:/backup" "$2" sh -c 'cat >"/backup/$1"' sh "$3"
}

# backup_instance NAME DESTDIR IMAGE: one sealed file, DESTDIR/NAME.sealed, holding the database, the memory and
# persona files, the sign-in service's data and both settings files. Everything is gathered in a scratch volume
# and sealed there with this computer's key, so nothing readable is ever written to the backup folder. The
# instance's recovery key opens the file on another computer. The scratch volume is always removed again.
# The CLI opens the live database through SQLite's online backup API, safe beside the running app.
backup_instance() {
  local name=$1 dest=$2 image=$3 scratch env_file sqlite file how rc=0
  scratch="aman_${name}_backup_scratch"
  env_file="$(instance_dir "$name")/.env"
  sqlite=$(env_get "$env_file" SQLITE_PATH)
  docker_volume_exists "aman_${name}_data" || {
    say "Instance $name has no data yet, so there is nothing to back up for it."
    return 0
  }
  # An instance that never got as far as creating its database has no data yet; that is not a failed backup.
  database_probe "$name" "$image" "$sqlite" || {
    case $? in
      1)
        say "Instance $name has no data yet, so there is nothing to back up for it."
        return 0
        ;;
      *)
        warn "Instance $name has data Aman cannot read. This is a bug in Aman, not a problem on your computer."
        return 1
        ;;
    esac
  }
  D volume create --label "$BACKUP_SCRATCH_LABEL" "$scratch" >/dev/null || return 1
  D run --rm --network none -v "aman_${name}_data:/data" -v "$scratch:/backup" "$image" aman backup \
    --target /backup \
    --sqlite "$sqlite" \
    --memory-dir "$(env_get "$env_file" MEMORY_MARKDOWN_DIR)" \
    --persona-dir "$(env_get "$env_file" PERSONA_KNOWLEDGE_DIR)" >/dev/null || rc=1
  if [ "$rc" = 0 ] && docker_volume_exists "aman_${name}_dex"; then
    volume_tar "aman_${name}_dex" "$image" | backup_scratch_add "$scratch" "$image" dex.tar || rc=1
  fi
  # A settings file that is already lost cannot be saved; that is told, not a reason to lose the rest.
  for file in env:.env dex.env:dex.env; do
    [ "$rc" = 0 ] || break
    if [ -f "$(instance_dir "$name")/${file#*:}" ]; then
      backup_scratch_add "$scratch" "$image" "${file%%:*}" <"$(instance_dir "$name")/${file#*:}" || rc=1
    else
      warn "The settings file ${file#*:} of $name is missing, so this backup does not include it."
    fi
  done
  # An instance not yet tied to this computer's key has no recovery key, so its backup opens only on this computer.
  if [ "$(reg_get "$name" secrets)" = 1 ]; then
    how='--sqlite /backup/db.sqlite'
  else
    how='--this-computer-only'
    [ "$rc" != 0 ] || machine_key_ensure "$image" || rc=1
  fi
  if [ "$rc" = 0 ]; then
    D run --rm --network none -v "$scratch:/backup" -v "$MACHINE_KEY_VOLUME:/run/aman-key:ro" "$image" sh -c \
      "tar -C /backup -cf - . | aman seal --in - --out - $how --key-file \"\$1\"" sh "$MACHINE_KEY_FILE" \
      >"$dest/$name.sealed.part" || rc=1
  fi
  D volume rm -f "$scratch" >/dev/null 2>&1 || true
  if [ "$rc" != 0 ] || [ ! -s "$dest/$name.sealed.part" ]; then
    rm -f "$dest/$name.sealed.part"
    return 1
  fi
  chmod 600 "$dest/$name.sealed.part"
  mv "$dest/$name.sealed.part" "$dest/$name.sealed"
}

# Only plain timestamped backups count and are pruned; a kept one (named after its stamp) stays until removed by hand.
plain_backups() {
  [ -d "$BACKUPS_DIR" ] || return 0
  find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d | grep -E '/[[:digit:]]{8}T[[:digit:]]{6}Z(-[[:digit:]]+)?$' | sort || true
}

backup_prune() {
  local total drop dir
  total=$(plain_backups | grep -c . || true)
  drop=$((total - BACKUP_KEEP))
  [ "$drop" -gt 0 ] || return 0
  plain_backups | head -n "$drop" | while IFS= read -r dir; do
    rm -rf "$dir"
  done
}

# The instances a backup covers: the one named, or all; with BACKUP_ONLY_HEALTHY=1 not those that never became healthy.
backup_targets() {
  local only=$1 name
  for name in $(reg_names); do
    if [ -n "$only" ] && [ "$only" != "$name" ]; then continue; fi
    if [ "${BACKUP_ONLY_HEALTHY:-0}" = 1 ] && ! instance_ever_healthy "$name"; then continue; fi
    printf '%s\n' "$name"
  done
}

# backup_run [NAME [LABEL]]: one timestamped directory, kept for good when it carries a label; removed again if any
# part fails. Nothing to cover means no backup.
backup_run() {
  local only=${1:-} label=${2:-} stamp dir name image n=0
  LAST_BACKUP_DIR=
  [ -n "$(backup_targets "$only")" ] || return 0
  release_load "$RELEASE_DIR/release.json" || die "The record of the installed version cannot be read. Run install.sh again."
  # An upgrade backs up with the version it is about to start, which can seal a backup even when the old one cannot.
  image=${BACKUP_IMAGE:-$CUR_APP_TAG}
  docker_image_exists "$image" || die "Part of Aman ($image) is missing. Run install.sh to build it again."
  image_has_key_support "$image" || die "This version of Aman cannot make an encrypted backup yet. Run: aman upgrade"
  ensure_private_dir "$BACKUPS_DIR"
  backup_scratch_prune
  backup_stage_prune
  stamp=$(date -u +%Y%m%dT%H%M%SZ)${label:+-$label}
  dir=$BACKUPS_DIR/$stamp
  while [ -e "$dir" ]; do
    n=$((n + 1))
    dir=$BACKUPS_DIR/$stamp-$n
  done
  ensure_private_dir "$dir"
  for name in $(backup_targets "$only"); do
    if ! backup_instance "$name" "$dir" "$image"; then
      rm -rf "$dir"
      warn "The backup of $name failed, so the unfinished backup was removed."
      return 1
    fi
    ui_ok "Backed up instance $name"
    n=$((n + 1))
  done
  # Only the authority's certificate goes into a backup, never its private key: whoever holds that key can vouch
  # for any name this computer is opened at. A restore makes a new key.
  if [ -f "$(tls_ca_dir)/root.crt" ]; then
    ensure_private_dir "$dir/tls"
    cp "$(tls_ca_dir)/root.crt" "$dir/tls/"
  fi
  cp "$RELEASE_DIR/release.json" "$dir/release.json"
  chmod 600 "$dir/release.json"
  write_checksums "$dir"
  LAST_BACKUP_DIR=$dir
  backup_prune
  log_event "backup $dir"
  if [ -n "$label" ]; then
    ui_ok "Saved a backup to $(ui_path "$dir"), kept until you remove it."
  else
    ui_ok "Saved a backup to $(ui_path "$dir")."
  fi
  ui_hint "It is encrypted. Only this computer, or the recovery key of each instance, can open it."
  if [ -f "$dir/tls/root.crt" ]; then
    ui_hint "After a restore, each device needs to trust this computer again."
  fi
}

cmd_backup() {
  if [ -n "${OPT_NAME:-}" ]; then
    reg_exists "$OPT_NAME" || die "There is no instance named $OPT_NAME."
  fi
  if [ -z "$(reg_names)" ]; then
    say "No instances yet; nothing to back up."
    return 0
  fi
  require_installed
  docker_attach
  lock_acquire
  backup_run "${OPT_NAME:-}" || exit 1
  # The daily job is also what keeps certificates from running out.
  load_installed_release
  tls_renew_all "$REL_APP_TAG" || warn "A certificate could not be renewed. Run: aman doctor tls --fix"
}

# ---- opening a backup ---------------------------------------------------------------------------

# A sealed backup is opened into a private folder under the state folder, in the layout a backup had before sealing:
# one folder per instance. It is removed again as soon as the restore ends, and by the next backup or restore if a
# run was killed. A backup from before sealing is read where it is.
backup_stage_dir() { printf '%s/stage' "$STATE_DIR"; }

backup_stage_prune() {
  local stage
  stage=$(backup_stage_dir)
  [ ! -d "$stage" ] || rm -rf "$stage"
}

# The file or folder of an instance in a backup, for its size.
backup_part() { # name dir
  if [ -f "$2/$1.sealed" ]; then printf '%s/%s.sealed' "$2" "$1"; else printf '%s/%s' "$2" "$1"; fi
}

# Whether a backup folder holds the instance, sealed or not.
backup_has() { # name dir
  [ -f "$2/$1.sealed" ] || [ -d "$2/$1" ]
}

# The folder that holds NAME/ for a backup: the backup itself, or where its sealed file was opened.
backup_view() { # name dir
  if [ -f "$2/$1.sealed" ]; then
    printf '%s/%s' "$(backup_stage_dir)" "$(basename "$2")"
  else
    printf '%s' "$2"
  fi
}

# Whether a sealed file can be opened with a recovery key. One made for data that had no recovery key yet cannot.
backup_takes_recovery_key() { # sealed file
  ! head -c 4096 "$1" | LC_ALL=C grep -aq '"recovery_copy":null'
}

# The sealed file on stdout, opened with the recovery key in BACKUP_RECOVERY_KEY. The key goes in on the same
# input as the file and is held in memory inside the container, so it is never in a command line or on a disk.
backup_unseal_with_recovery_key() { # sealed file, image
  {
    printf '%s\n' "$BACKUP_RECOVERY_KEY"
    cat "$1"
  } | D run --rm -i --network none --tmpfs /tmp "$2" sh -c \
    'umask 077; IFS= read -r key && printf %s "$key" >/tmp/recovery-key && exec aman unseal --in - --out - --recovery-key-file /tmp/recovery-key' 2>/dev/null
}

# Opens a sealed backup of one instance with this computer's key, or, for a backup another computer made, with the
# recovery key in BACKUP_RECOVERY_KEY when one was typed. Does nothing for a backup from before sealing, or one
# already opened in this run. Fails when neither opens it. BACKUP_OPENED_BY then says which one did.
BACKUP_RECOVERY_KEY=
backup_open() { # name dir image
  local name=$1 dir=$2 image=$3 view
  [ -f "$dir/$name.sealed" ] || return 0
  view=$(backup_view "$name" "$dir")
  [ ! -f "$view/.opened-$name" ] || return 0
  ensure_private_dir "$(backup_stage_dir)"
  ensure_private_dir "$view"
  rm -rf "${view:?}/$name"
  ensure_private_dir "$view/$name"
  if ! D run --rm -i --network none -v "$MACHINE_KEY_VOLUME:/run/aman-key:ro" "$image" \
    aman unseal --in - --out - --key-file "$MACHINE_KEY_FILE" <"$dir/$name.sealed" 2>/dev/null |
    tar -x --no-same-owner -C "$view/$name" -f - 2>/dev/null; then
    rm -rf "${view:?}/$name"
    [ -n "$BACKUP_RECOVERY_KEY" ] || return 1
    ensure_private_dir "$view/$name"
    if ! backup_unseal_with_recovery_key "$dir/$name.sealed" "$image" | tar -x --no-same-owner -C "$view/$name" -f - 2>/dev/null; then
      rm -rf "${view:?}/$name"
      return 1
    fi
    echo recovery >"$view/.opened-$name"
    return 0
  fi
  echo computer >"$view/.opened-$name"
}

# restore_sqlite NAME BACKUPDIR IMAGE: puts the backed-up database back and drops stale WAL files. BACKUPDIR is the
# folder that holds NAME/, so an opened one for a sealed backup.
restore_sqlite() {
  local name=$1 dir=$2 image=$3
  if [ ! -f "$dir/$name/db.sqlite" ]; then
    warn "The backup in $dir has no data for instance $name, so nothing was put back for it."
    return 0
  fi
  D run --rm -i --network none -v "aman_${name}_data:/data" "$image" sh -c \
    'mkdir -p /data/db && cat > /data/db/db.sqlite.restore && rm -f /data/db/db.sqlite-wal /data/db/db.sqlite-shm && mv /data/db/db.sqlite.restore /data/db/db.sqlite' \
    <"$dir/$name/db.sqlite"
}

# install.sh backups daily|off: turns the automatic daily backup on or off.
cmd_backups() {
  case "$OPT_BACKUPS_ARG" in
    daily | off) ;;
    *) usage_die "usage: install.sh backups daily|off" ;;
  esac
  if ! backups_apply "$OPT_BACKUPS_ARG"; then
    die "This computer has no way to run a backup every day without admin rights."
  fi
  if [ "$OPT_BACKUPS_ARG" = daily ]; then
    ui_ok "A backup is made every day, keeping the last $BACKUP_KEEP"
  else
    ui_ok "Automatic backups are off"
  fi
}
