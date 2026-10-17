# shellcheck shell=bash
# Restore: puts one instance back from a backup. A copy of what it replaces is saved first and put back if anything fails.

RESTORE_STAGE=idle
RESTORE_NAME=
RESTORE_UNDO=
RESTORE_IMAGE=
RESTORE_DEX_IMAGE=
OPT_LATEST=0
OPT_RESTORE_STAMP=

restore_stamp_valid() {
  matches_whole "$1" '^[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$'
}

# 20261017T031500Z -> 2026-10-17 03:15 UTC
restore_label() {
  local s=${1%%-*}
  printf '%s-%s-%s %s:%s UTC' "${s:0:4}" "${s:4:2}" "${s:6:2}" "${s:9:2}" "${s:11:2}"
}

restore_size_label() { # dir
  local kb
  kb=$(du -sk "$1" 2>/dev/null | cut -f1)
  case "$kb" in '' | *[!0-9]*) kb=0 ;; esac
  awk -v kb="$kb" 'BEGIN {
    if (kb < 1024) printf "%d KB", kb
    else if (kb < 1048576) printf "%.1f MB", kb / 1024
    else printf "%.1f GB", kb / 1048576
  }'
}

# Backups that hold the instance, newest first.
restore_stamps() { # name
  local dir stamp
  [ -d "$BACKUPS_DIR" ] || return 0
  for dir in $(find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort -r); do
    stamp=$(basename "$dir")
    restore_stamp_valid "$stamp" || continue
    [ -d "$dir/$1" ] || continue
    printf '%s\n' "$stamp"
  done
}

restore_checksums_ok() { # dir
  local dir=$1 line sum file
  [ -s "$dir/SHA256SUMS" ] || return 1
  while IFS= read -r line; do
    sum=${line%%  *}
    file=${line#*  }
    [ -f "$dir/$file" ] || return 1
    [ "$(sha256_stdin <"$dir/$file")" = "$sum" ] || return 1
  done <"$dir/SHA256SUMS"
}

# Prints "incomplete|why" or "newer|why" when the backup must not be used, and nothing when it can be.
restore_problem() { # name dir
  local name=$1 dir=$2 file schema_backup schema_now version
  for file in "$name/db.sqlite" "$name/manifest.json" "$name/dex.tar" "$name/env" "$name/dex.env" release.json; do
    [ -f "$dir/$file" ] || {
      echo "incomplete|part of it is missing"
      return 0
    }
    [ "$file" = release.json ] || grep -q "^[0-9a-f]\{64\}  $file\$" "$dir/SHA256SUMS" 2>/dev/null || {
      echo "incomplete|its list of checks is missing or damaged"
      return 0
    }
  done
  for file in "$name/memory" "$name/persona-knowledge"; do
    [ -d "$dir/$file" ] || {
      echo "incomplete|part of it is missing"
      return 0
    }
  done
  restore_checksums_ok "$dir" || {
    echo "incomplete|it was copied only in part or has been changed"
    return 0
  }
  schema_backup=$(json_get "$dir/release.json" schema)
  schema_now=$(json_get "$RELEASE_DIR/release.json" schema)
  version=$(sed -n 's/.*"version": *\([0-9][0-9]*\).*/\1/p' "$dir/$name/manifest.json" | head -n 1)
  case "$schema_backup$schema_now$version" in
    '' | *[!0-9]*)
      echo "incomplete|its version record cannot be read"
      return 0
      ;;
  esac
  if [ "$schema_backup" -gt "$schema_now" ] || [ "$version" -gt "$BACKUP_MANIFEST_VERSION" ]; then
    echo "newer|it was made by a newer version of Aman than this one"
  fi
}

restore_refuse() { # what happened, what to do
  UI_FD=2 ui_fail "$1" "$2"
  exit 1
}

# Stream a tar from stdin into PATH of the data volume, replacing what is there. KEEP_OWNER=1 restores as the backup
# recorded it (the login volume belongs to another program's user); otherwise files belong to the app's user.
restore_tar() { # volume path image keep_owner
  local volume=$1 path=$2 image=$3 keep=$4 user=() owner=--no-same-owner script
  if [ "$keep" = 1 ]; then
    user=(--user 0:0)
    owner=--same-owner
  fi
  script="mkdir -p \"\$1\" && find \"\$1\" -mindepth 1 -delete && tar -x \"\$2\" -p -f - -C \"\$1\""
  D run --rm -i --network none ${user[@]+"${user[@]}"} -v "$volume:/data" "$image" sh -c "$script" sh "$path" "$owner"
}

restore_tree() { # name backup_subdir container_path image
  tar -C "$2" -cf - . | restore_tar "aman_${1}_data" "$3" "$4" 0
}

restore_stop() { # name
  stt_detach "$1"
  dc "$1" down >/dev/null 2>&1
}

# An instance whose settings file or stack file is gone cannot be stopped or backed up by name, so those two are put back
# first: the settings from the backup, the stack file from the record.
restore_prepare() { # name backupdir
  local name=$1 idir
  idir=$(instance_dir "$name")
  [ -f "$idir/.env" ] && [ -f "$idir/compose.yaml" ] && return 0
  say "Some of the files $name needs to start are missing, so they are put back from the backup first."
  ensure_private_dir "$idir"
  [ -f "$idir/.env" ] || write_if_changed "$idir/.env" 600 <"$2/$name/env" || true
  instance_render "$name" "$RESTORE_IMAGE" "$RESTORE_DEX_IMAGE"
}

# restore_apply NAME BACKUPDIR: stops the instance, puts back its settings and data as the backup stores them, starts it.
# A part the backup does not hold is left as it is. Used for the restore itself and for undoing it.
restore_apply() {
  local name=$1 dir=$2 src=$2/$1 idir env path
  idir=$(instance_dir "$name")
  restore_stop "$name" || return 1
  ensure_private_dir "$idir"
  [ ! -f "$src/env" ] || write_if_changed "$idir/.env" 600 <"$src/env" || true
  [ ! -f "$src/dex.env" ] || write_if_changed "$idir/dex.env" 600 <"$src/dex.env" || true
  env="$idir/.env"
  if [ -f "$src/db.sqlite" ]; then
    restore_sqlite "$name" "$dir" "$RESTORE_IMAGE" || return 1
    for path in "MEMORY_MARKDOWN_DIR:memory" "PERSONA_KNOWLEDGE_DIR:persona-knowledge"; do
      restore_tree "$name" "$src/${path#*:}" "$(env_get "$env" "${path%%:*}")" "$RESTORE_IMAGE" || return 1
    done
  fi
  if [ -f "$src/dex.tar" ]; then
    restore_tar "aman_${name}_dex" /data "$RESTORE_IMAGE" 1 <"$src/dex.tar" || return 1
  fi
  instance_render "$name" "$RESTORE_IMAGE" "$RESTORE_DEX_IMAGE"
  instance_up "$name"
}

# Runs from a failed restore and from the EXIT trap, so a failed command, a die or a signal all end with the instance put back.
restore_rollback() {
  set +e
  RESTORE_STAGE=rollback
  if [ -n "$RESTORE_UNDO" ] && restore_apply "$RESTORE_NAME" "$RESTORE_UNDO"; then
    say "The restore did not work, so $RESTORE_NAME was put back the way it was. The copy of it is at $RESTORE_UNDO."
    return 0
  fi
  UI_FD=2 ui_fail "The restore did not work and $RESTORE_NAME could not be put back by itself. A copy of it from before is at ${RESTORE_UNDO:-none}." \
    "Run: aman restore $RESTORE_NAME ${RESTORE_UNDO##*/}"
  return 1
}

restore_on_exit() {
  if [ "$RESTORE_STAGE" = applying ]; then
    restore_rollback || true
  fi
}

# A backup time (as the list shows in the folder name) or an instance name, in either order.
restore_take_arg() {
  if restore_stamp_valid "$1"; then
    [ -z "$OPT_RESTORE_STAMP" ] || usage_die "Give one backup time only."
    OPT_RESTORE_STAMP=$1
  else
    [ -z "${OPT_NAME:-}" ] || usage_die "Give one instance name only."
    OPT_NAME=$1
  fi
}

# The instance the person means: the one named, or the only one.
restore_pick_name() {
  local names count
  names=$(reg_names)
  count=$(printf '%s\n' "$names" | grep -c . || true)
  if [ -n "${OPT_NAME:-}" ]; then
    reg_exists "$OPT_NAME" || restore_refuse "There is no instance named $OPT_NAME." "See your instances with: install.sh instance list"
    RESTORE_NAME=$OPT_NAME
  elif [ "$count" = 1 ]; then
    RESTORE_NAME=$names
  elif [ "$count" = 0 ]; then
    restore_refuse "There is nothing to restore yet." "Set Aman up first with: install.sh"
  else
    restore_refuse "There is more than one instance here ($(printf '%s' "$names" | tr '\n' ' ' | sed 's/ $//; s/ /, /g'))." "Say which one: aman restore <name>"
  fi
}

# Shows the backups of an instance, newest first, and asks for a number. Prints the chosen time stamp.
restore_choose() { # name
  local name=$1 stamps=() stamp n=0 answer=''
  while IFS= read -r stamp; do
    [ -z "$stamp" ] || stamps+=("$stamp")
  done < <(restore_stamps "$name")
  [ "${#stamps[@]}" -gt 0 ] || restore_refuse "There is no backup of $name yet." "Make one with: aman backup $name"
  say "Backups of $name, newest first:" >&2
  for stamp in "${stamps[@]}"; do
    n=$((n + 1))
    printf '  %s. %s  %s\n' "$n" "$(restore_label "$stamp")" "$(restore_size_label "$BACKUPS_DIR/$stamp/$name")" >&2
  done
  ui_prompt answer "Restore which backup (number):" "" || true
  case "$answer" in '' | *[!0-9]*) restore_refuse "That is not a number from the list. Nothing was changed." "Run aman restore again and type one of the numbers." ;; esac
  { [ "$answer" -ge 1 ] && [ "$answer" -le "${#stamps[@]}" ]; } ||
    restore_refuse "There is no backup number $answer. Nothing was changed." "Run aman restore again and type one of the numbers."
  printf '%s\n' "${stamps[$((answer - 1))]}"
}

cmd_restore() {
  local name stamp dir label problem undo answer=''
  if [ "$OPT_LATEST" = 1 ] && [ -n "$OPT_RESTORE_STAMP" ]; then
    usage_die "Use either --latest or a backup time, not both."
  fi
  restore_pick_name
  name=$RESTORE_NAME
  require_installed
  docker_attach
  lock_acquire
  load_installed_release
  RESTORE_IMAGE=$REL_APP_TAG
  RESTORE_DEX_IMAGE=$REL_DEX_IMAGE
  if [ "$OPT_LATEST" = 1 ]; then
    stamp=$(restore_stamps "$name" | head -n 1)
    [ -n "$stamp" ] || restore_refuse "There is no backup of $name yet." "Make one with: aman backup $name"
  elif [ -n "$OPT_RESTORE_STAMP" ]; then
    stamp=$OPT_RESTORE_STAMP
    [ -d "$BACKUPS_DIR/$stamp/$name" ] || restore_refuse "There is no backup of $name from $stamp." "See the list with: aman restore $name"
  else
    stamp=$(restore_choose "$name")
  fi
  dir=$BACKUPS_DIR/$stamp
  label=$(restore_label "$stamp")
  problem=$(restore_problem "$name" "$dir")
  case "$problem" in
    incomplete\|*) restore_refuse "The backup from $label cannot be used because ${problem#*|}. Nothing was changed." "Pick another one with: aman restore $name" ;;
    newer\|*) restore_refuse "The backup from $label cannot be used because ${problem#*|}. Nothing was changed." "Update Aman with aman upgrade, or pick an older backup with: aman restore $name" ;;
  esac
  say "This replaces the current chats and settings of $name with the backup from $label. A copy of the current state is saved first."
  ui_prompt answer "Type yes to continue:" "" || true
  [ "$(lowercase "$answer")" = yes ] || {
    say "Nothing was changed."
    return 0
  }
  restore_prepare "$name" "$dir"
  BACKUP_NO_PRUNE=1 backup_run "$name" || restore_refuse "A copy of the current state could not be saved, so nothing was changed." "Free some disk space, then run aman restore $name again."
  undo=$LAST_BACKUP_DIR
  [ -n "$undo" ] || restore_refuse "A copy of the current state could not be saved, so nothing was changed." "Run aman restore $name again."
  say "The current state of $name is saved at $undo"
  RESTORE_UNDO=$undo
  RESTORE_STAGE=applying
  if ! restore_apply "$name" "$dir"; then
    restore_rollback || exit 1
    exit 1
  fi
  RESTORE_STAGE=idle
  backup_prune
  log_event "restore $name from $dir"
  say "Done. $name is back to how it was on $label, and it is running."
  say "If that is not what you wanted, go back with: aman restore $name ${undo##*/}"
}
