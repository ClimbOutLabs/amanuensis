# shellcheck shell=bash
# Backups: the CLI writes into a scratch volume and every archive is streamed over stdout, so no host bind mounts are involved.

BACKUP_KEEP=7
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

# Value of KEY in an instance .env, so the CLI is pointed at the paths the app itself uses.
env_get() {
  sed -n "s/^$2=//p" "$1" | head -n 1
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

# backup_data NAME DESTDIR IMAGE: runs `aman backup --target` into a scratch volume mounted at
# /backup, then streams that volume into DESTDIR as tar. The scratch volume is always removed again.
# The CLI opens the live database through SQLite's online backup API, safe beside the running app.
backup_data() {
  local name=$1 dest=$2 image=$3 scratch env_file sqlite rc=0
  scratch="aman_${name}_backup_scratch"
  env_file="$(instance_dir "$name")/.env"
  sqlite=$(env_get "$env_file" SQLITE_PATH)
  # An instance that never got as far as creating its database has no data yet; that is not a failed backup.
  database_probe "$name" "$image" "$sqlite" || {
    case $? in
      1)
        say "Instance $name has no database yet, so there is nothing to back up for it; its settings are saved."
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
  if [ "$rc" = 0 ]; then
    volume_tar "$scratch" "$image" | tar -x --no-same-owner -C "$dest" -f - || rc=1
  fi
  D volume rm -f "$scratch" >/dev/null 2>&1 || true
  return "$rc"
}

# backup_instance NAME DESTDIR IMAGE
backup_instance() {
  local name=$1 dest=$2/$1 image=$3
  ensure_private_dir "$dest"
  if docker_volume_exists "aman_${name}_data"; then
    backup_data "$name" "$dest" "$image" || return 1
  fi
  if docker_volume_exists "aman_${name}_dex"; then
    volume_tar "aman_${name}_dex" "$image" >"$dest/dex.tar.part" || return 1
    mv "$dest/dex.tar.part" "$dest/dex.tar"
  fi
  cp "$(instance_dir "$name")/.env" "$dest/env"
  cp "$(instance_dir "$name")/dex.env" "$dest/dex.env"
  chmod 600 "$dest/env" "$dest/dex.env"
}

backup_prune() {
  local total drop dir
  [ -d "$BACKUPS_DIR" ] || return 0
  total=$(find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  drop=$((total - BACKUP_KEEP))
  [ "$drop" -gt 0 ] || return 0
  find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d | sort | head -n "$drop" | while IFS= read -r dir; do
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

# backup_run [NAME]: one timestamped directory; removed again if any part fails. Nothing to cover means no backup.
backup_run() {
  local only=${1:-} stamp dir name image n=0
  LAST_BACKUP_DIR=
  [ -n "$(backup_targets "$only")" ] || return 0
  release_load "$RELEASE_DIR/release.json" || die "the recorded release is unreadable; run install.sh again"
  image=$CUR_APP_TAG
  docker_image_exists "$image" || die "image $image is missing; run install.sh to rebuild it"
  ensure_private_dir "$BACKUPS_DIR"
  backup_scratch_prune
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dir=$BACKUPS_DIR/$stamp
  while [ -e "$dir" ]; do
    n=$((n + 1))
    dir=$BACKUPS_DIR/$stamp-$n
  done
  ensure_private_dir "$dir"
  for name in $(backup_targets "$only"); do
    say "Backing up instance $name"
    if ! backup_instance "$name" "$dir" "$image"; then
      rm -rf "$dir"
      warn "the backup of $name failed; the partial backup was removed"
      return 1
    fi
    n=$((n + 1))
  done
  # Only the authority's certificate goes into a backup, never its private key: a backup is not encrypted, and whoever
  # holds that key can vouch for any name this computer is opened at. A restore makes a new key.
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
  say "Backup written to $dir (unencrypted; it holds secrets, keep it on this machine)"
  if [ -f "$dir/tls/root.crt" ]; then
    say "It does not hold the private key of this computer's certificate authority. After a restore, Aman makes a new one and each device trusts it again."
  fi
}

cmd_backup() {
  if [ -n "${OPT_NAME:-}" ]; then
    reg_exists "$OPT_NAME" || die "no instance named $OPT_NAME"
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

# restore_sqlite NAME BACKUPDIR IMAGE: puts the backed-up database back and drops stale WAL files.
restore_sqlite() {
  local name=$1 dir=$2 image=$3
  if [ ! -f "$dir/$name/db.sqlite" ]; then
    warn "no database copy of $name in $dir; skipping its restore"
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
    die "This computer has no way to schedule a backup without admin rights (no user timer, launchd or crontab)."
  fi
  if [ "$OPT_BACKUPS_ARG" = daily ]; then
    ui_ok "A backup is made every day, keeping the last $BACKUP_KEEP"
  else
    ui_ok "Automatic backups are off"
  fi
}
