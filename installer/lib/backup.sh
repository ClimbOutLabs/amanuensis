# shellcheck shell=bash
# Backups: the CLI writes into a scratch volume and every archive is streamed over stdout, so no host bind mounts are involved.

BACKUP_KEEP=5
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

# backup_data NAME DESTDIR IMAGE: runs `aman backup --target` into a scratch volume mounted at
# /backup, then streams that volume into DESTDIR as tar. The scratch volume is always removed again.
# The CLI opens the live database through SQLite's online backup API, safe beside the running app.
backup_data() {
  local name=$1 dest=$2 image=$3 scratch env_file rc=0
  scratch="aman_${name}_backup_scratch"
  env_file="$(instance_dir "$name")/.env"
  D volume create --label "$BACKUP_SCRATCH_LABEL" "$scratch" >/dev/null || return 1
  D run --rm --network none -v "aman_${name}_data:/data" -v "$scratch:/backup" "$image" aman backup \
    --target /backup \
    --sqlite "$(env_get "$env_file" SQLITE_PATH)" \
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

# backup_run [NAME]: one timestamped directory; removed again if any part fails.
backup_run() {
  local only=${1:-} stamp dir name image n=0
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
  for name in $(reg_names); do
    if [ -n "$only" ] && [ "$only" != "$name" ]; then continue; fi
    say "Backing up instance $name"
    if ! backup_instance "$name" "$dir" "$image"; then
      rm -rf "$dir"
      warn "the backup of $name failed; the partial backup was removed"
      return 1
    fi
    n=$((n + 1))
  done
  cp "$RELEASE_DIR/release.json" "$dir/release.json"
  chmod 600 "$dir/release.json"
  write_checksums "$dir"
  LAST_BACKUP_DIR=$dir
  backup_prune
  log_event "backup $dir"
  say "Backup written to $dir (unencrypted; it holds secrets, keep it on this machine)"
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
