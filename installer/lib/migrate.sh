# shellcheck shell=bash
# Move from an old docker compose Aman: its database is copied into a temporary Postgres and its memory and knowledge
# volumes into temporary volumes, the new image exports from those copies as the app user, and every temporary piece
# is removed again. The old stack is only read: its database through pg_dump, its volumes mounted read-only.

OPT_FROM_COMPOSE=
OPT_MIGRATE_USER=
MIGRATE_LABEL=com.amanuensis.scratch=migrate
MIGRATE_NET=aman_migrate_net
MIGRATE_PG=aman-migrate-pg
MIGRATE_VOLUMES="aman_migrate_pg aman_migrate_pg_data aman_migrate_memory aman_migrate_knowledge aman_migrate_out"
# Set once this run may have created temporary pieces, so the exit handler removes them.
MIGRATE_ACTIVE=0
# The half-written archive, removed if the run stops before it is complete.
MIGRATE_PART=
# The app user of the image, which owns the copied files and runs the export.
APP_UID=10001

check_migrate_options() {
  if [ "$COMMAND" != migrate ] && { [ -n "$OPT_FROM_COMPOSE" ] || [ -n "$OPT_MIGRATE_USER" ]; }; then
    usage_die "--from-compose and --user apply to migrate"
  fi
}

migrate_cleanup() {
  local volume
  D rm -f -v "$MIGRATE_PG" >/dev/null 2>&1 || true
  D network rm "$MIGRATE_NET" >/dev/null 2>&1 || true
  for volume in $MIGRATE_VOLUMES; do
    D volume rm -f "$volume" >/dev/null 2>&1 || true
  done
}

migrate_on_exit() {
  if [ -n "$MIGRATE_PART" ]; then rm -f "$MIGRATE_PART"; fi
  [ "$MIGRATE_ACTIVE" = 1 ] || return 0
  MIGRATE_ACTIVE=0
  migrate_cleanup
}

# The containers of the compose projects that run from FOLDER, or of one PROJECT there, running or not.
old_containers() { # folder [project]
  D ps -a -q --filter "label=com.docker.compose.project.working_dir=$1" ${2:+--filter "label=com.docker.compose.project=$2"} 2>/dev/null
}

# Postgres images set PGDATA, whatever the image is called.
is_postgres() { # container
  case "$(D inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null)" in
    PGDATA=* | *$'\n'PGDATA=*) return 0 ;;
  esac
  return 1
}

# What the old app has mounted at a path: a volume name, or a host folder for a bind mount.
old_mount() { # container destination
  D inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}" "$1" 2>/dev/null
}

# migrate_export ARGS...: export-data from the copies, as the app user; the old .env arrives on stdin and is held on a
# private tmpfs, because the app user cannot read the host user's 0600 file.
migrate_export() {
  D run --rm -i --network "$MIGRATE_NET" --user "$APP_UID:$APP_UID" \
    -e STANDALONE=false -e NODE_ENV=production -e HOME=/tmp -e TRUEFORGE_API_KEY=export-only-placeholder \
    -e POSTGRES_HOST="$MIGRATE_PG" -e POSTGRES_PORT=5432 -e POSTGRES_USER=aman -e POSTGRES_PASSWORD=unused -e POSTGRES_DB=aman \
    -e MEMORY_BACKEND=markdown -e MEMORY_MARKDOWN_DIR=/data/memory -e PERSONA_KNOWLEDGE_DIR=/data/persona-knowledge \
    -v aman_migrate_memory:/data/memory -v aman_migrate_knowledge:/data/persona-knowledge -v aman_migrate_out:/out \
    --tmpfs "/migrate:rw,mode=0700,uid=$APP_UID,gid=$APP_UID,size=1m" \
    "$MIGRATE_IMAGE" sh -c 'cat >/migrate/old.env && exec aman export-data "$@"' export-data "$@" <"$MIGRATE_ENV"
}

# user_id<TAB>sessions<TAB>display name, one line per owner, from the one JSON line --list-users prints; fails when
# the line is not such a list.
migrate_owners() {
  case "$1" in *'"users":['*) ;; *) return 1 ;; esac
  { printf '%s' "$1" | grep -o '"user_id":"[^"]*","display_name":"[^"]*","sessions":[0-9]*' || true; } |
    sed 's/^"user_id":"\([^"]*\)","display_name":"\([^"]*\)","sessions":\([0-9]*\)$/\1\t\3\t\2/'
}

# "id (N chats), ..." for a message.
migrate_owner_list() {
  printf '%s\n' "$1" | awk -F '\t' '{printf "%s%s (%s chats)", sep, $1, $2; sep = ", "}'
}

cmd_migrate() {
  local folder=$OPT_FROM_COMPOSE old_pg='' old_app='' project id memory knowledge pg_image listing owners with_chats count
  local user display include=() stamp dest volume tries=0 log
  [ -n "$folder" ] || usage_die "usage: install.sh migrate --from-compose FOLDER"
  [ -d "$folder" ] || die "There is no folder at $folder. Pass --from-compose the folder the old Aman runs from."
  folder=$(cd -- "$folder" && pwd)
  # A checkout keeps its settings in packages/trueforge/.env; a folder with only a compose file keeps them next to it.
  if [ -f "$folder/packages/trueforge/.env" ]; then
    MIGRATE_ENV=$folder/packages/trueforge/.env
  elif [ -f "$folder/.env" ]; then
    MIGRATE_ENV=$folder/.env
  else
    die "The folder $folder has no .env or packages/trueforge/.env. Pass --from-compose the folder the old Aman runs from, the one with its compose.yml or docker-compose.yml."
  fi
  case "$(env_get "$MIGRATE_ENV" MEMORY_BACKEND)" in
    '' | markdown) ;;
    *) die "The old Aman keeps its memory outside its files, which this move cannot read. Follow docs/migrate-from-compose.md to move by hand." ;;
  esac
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  MIGRATE_IMAGE=$REL_APP_TAG

  # The app is the container with the memory folder, and the database is the Postgres of that same project, so a
  # second stack started from the folder (such as the dev database) is never mixed in.
  for id in $(old_containers "$folder"); do
    [ -n "$(old_mount "$id" /data/memory)" ] || continue
    [ -z "$old_app" ] ||
      die "More than one old Aman runs from $folder, so this move cannot tell which one to copy. Follow docs/migrate-from-compose.md to move by hand."
    old_app=$id
  done
  [ -n "$old_app" ] ||
    die "No old Aman was found running from $folder. Start it once with docker compose up -d in that folder, then run this again."
  project=$(D inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$old_app" 2>/dev/null)
  for id in $(old_containers "$folder" "$project"); do
    is_postgres "$id" || continue
    [ -z "$old_pg" ] ||
      die "The old Aman in $folder has more than one database, so this move cannot tell which one to copy. Follow docs/migrate-from-compose.md to move by hand."
    old_pg=$id
  done
  [ -n "$old_pg" ] ||
    die "No database of the old Aman was found in $folder. Start the old Aman once with docker compose up -d in that folder, then run this again."
  [ "$(D inspect --format '{{.State.Running}}' "$old_pg" 2>/dev/null)" = true ] ||
    die "The database of the old Aman is not running. Run docker compose up -d postgres in $folder, then run this again."
  memory=$(old_mount "$old_app" /data/memory)
  knowledge=$(old_mount "$old_app" /data/persona-knowledge)
  [ -n "$memory" ] && [ -n "$knowledge" ] ||
    die "The old Aman has no memory or knowledge folder, so this move cannot find them. Follow docs/migrate-from-compose.md to move by hand."
  pg_image=$(D inspect --format '{{.Config.Image}}' "$old_pg")

  MIGRATE_ACTIVE=1
  migrate_cleanup
  say "Copying the old Aman from $folder. It keeps running and is not changed."
  D network create --internal --label "$MIGRATE_LABEL" "$MIGRATE_NET" >/dev/null ||
    die "Aman could not make a private network for the copy. Run: aman doctor docker"
  for volume in $MIGRATE_VOLUMES; do
    D volume create --label "$MIGRATE_LABEL" "$volume" >/dev/null || die "Aman could not make room for a temporary copy. Run: aman doctor disk"
  done
  # Trust needs no password and is safe here: the network is internal and holds only this copy and the export.
  # The copied database lives in named temporary volumes covering both places Postgres images declare (17 and 18), so
  # no unnamed volume is left holding it.
  D run -d --name "$MIGRATE_PG" --label "$MIGRATE_LABEL" --network "$MIGRATE_NET" \
    -v aman_migrate_pg:/var/lib/postgresql -v aman_migrate_pg_data:/var/lib/postgresql/data -e PGDATA=/var/lib/postgresql/data \
    -e POSTGRES_USER=aman -e POSTGRES_DB=aman -e POSTGRES_HOST_AUTH_METHOD=trust "$pg_image" >/dev/null ||
    die "Aman could not start the temporary database. Run: aman doctor docker"
  until D exec "$MIGRATE_PG" pg_isready -h 127.0.0.1 -U aman -d aman -q >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || die "The temporary database did not start within a minute. Run: aman doctor docker"
    sleep 1
  done
  # shellcheck disable=SC2016 # the old container's own settings name its database
  if ! D exec "$old_pg" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' |
    D exec -i "$MIGRATE_PG" pg_restore -U aman -d aman --no-owner --no-acl >/dev/null; then
    die "The old database could not be copied, and the old Aman was not changed. Check that the old Aman is running, then run this again."
  fi
  D run --rm --network none --user 0:0 -v "$memory:/from/memory:ro" -v "$knowledge:/from/knowledge:ro" \
    -v aman_migrate_memory:/to/memory -v aman_migrate_knowledge:/to/knowledge -v aman_migrate_out:/out "$MIGRATE_IMAGE" \
    sh -c "cp -a /from/memory/. /to/memory/ && cp -a /from/knowledge/. /to/knowledge/ && chown -R $APP_UID:$APP_UID /to /out" ||
    die "The old memory and knowledge folders could not be copied. Run: aman doctor disk"

  log=$(cli_log migrate)
  listing=$(migrate_export --migrate --list-users 2>"$log") ||
    die "Reading the copy of the old database failed: $(cli_reason "$log" "The app stopped without giving a reason. Run this again.")"
  owners=$(migrate_owners "$listing") ||
    die "Aman could not read the list of people from the copy of the old database. Run this again."
  with_chats=$(printf '%s\n' "$owners" | awk -F '\t' '$2 > 0')
  count=$(printf '%s' "$with_chats" | grep -c . || true)
  if [ -n "$OPT_MIGRATE_USER" ]; then
    user=$OPT_MIGRATE_USER
    printf '%s\n' "$with_chats" | awk -F '\t' -v u="$user" '$1 == u {found = 1} END {exit !found}' ||
      die "No chats in the old Aman belong to $user. Run this again with --user and one of: $(migrate_owner_list "$with_chats")."
  elif [ "$count" = 0 ]; then
    die "The old Aman has no chats, so there is nothing to move. Check that --from-compose names the folder your old Aman runs from."
  elif [ "$count" -gt 1 ]; then
    die "The old Aman has chats from more than one person: $(migrate_owner_list "$with_chats"). Run this again with --user and the id of the person to move."
  else
    user=$(printf '%s\n' "$with_chats" | cut -f 1)
  fi
  display=$(printf '%s\n' "$with_chats" | awk -F '\t' -v u="$user" '$1 == u {print $3}')
  # Shared memories and instance settings can hold other people's data, so they come along only when one person used it.
  if [ "$count" = 1 ]; then include=(--include-instance-data); fi

  say "Exporting the chats of $user from the copy"
  migrate_export --migrate --include-uploads ${include[@]+"${include[@]}"} --user "$user" \
    --secrets-env /migrate/old.env --out /out/aman-export.zip >/dev/null 2>"$log" ||
    die "Export failed: $(cli_reason "$log" "The export stopped without giving a reason. Run this again.")"
  # What the export says it left out.
  cat "$log" >&2
  ensure_private_dir "$AMAN_HOME/exports"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dest=$AMAN_HOME/exports/aman-export-$stamp.zip
  MIGRATE_PART=$dest.part
  if ! D run --rm --network none -v aman_migrate_out:/out:ro "$MIGRATE_IMAGE" cat /out/aman-export.zip >"$MIGRATE_PART"; then
    die "The export file could not be saved. Run: aman doctor disk"
  fi
  chmod 600 "$MIGRATE_PART"
  mv "$MIGRATE_PART" "$dest"
  MIGRATE_PART=
  MIGRATE_ACTIVE=0
  migrate_cleanup
  log_event "migrate from compose folder $folder into $dest"
  ui_ok "Exported from the old Aman to $dest. The old Aman was not changed, and the temporary copies are removed."
  # Single quotes keep the old name inert when the line is pasted; display_name_problem refuses a name with a quote.
  if [ -n "$display" ] && [ "$display" != "$user" ] && [ -z "$(display_name_problem "$display")" ]; then
    ui_hint "Next: aman import $dest --display-name '$display'"
  else
    ui_hint "Next: aman import $dest"
  fi
}
