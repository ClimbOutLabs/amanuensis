# shellcheck shell=bash
# Data import: restores a data export into a fresh instance. A kept backup is taken first, the import waits for the
# search model, then the app is stopped while the CLI runs in a one-off container that has the instance's data volume
# and no network, and started again whatever the outcome.

OPT_IMPORT_FILE=
OPT_DISPLAY_NAME=
# The instance whose app this run stopped and has not started again yet.
IMPORT_STOPPED_APP=
# Seconds between two looks at the search model; tests set it to 0.
IMPORT_POLL_SECONDS=${AMAN_IMPORT_POLL_SECONDS:-5}
IMPORT_MODEL_WAIT_SECONDS=1200

# The export file is the fourth word of `instance import NAME FILE` and of no other command.
check_import_options() {
  if [ -n "$OPT_IMPORT_FILE" ] && [ "$COMMAND:$SUBCOMMAND" != instance:import ]; then
    usage_die "unexpected argument $OPT_IMPORT_FILE"
  fi
  if [ -n "$OPT_DISPLAY_NAME" ] && [ "$COMMAND:$SUBCOMMAND" != instance:import ]; then
    usage_die "--display-name applies to instance import"
  fi
}

display_name_problem() {
  if [ -z "$1" ]; then
    echo "The name is empty. Type the name Aman should call you."
  elif [ "${#1}" -gt 80 ]; then
    echo "The name is longer than 80 characters. Type a shorter one."
  elif ! safe_value "$1"; then
    echo "The name contains a character that is not allowed. Leave out quotes and & ; | \\ \`."
  fi
}

# Starts the app this run stopped. The exit handler calls it as well, so an interrupt or hangup never leaves it stopped.
# A successful import restarts it quietly (IMPORT_QUIET_RESTART=1): the stop and start lines are only shown when
# something failed, or when the start itself does not come up properly.
import_on_exit() {
  local name=$IMPORT_STOPPED_APP
  [ -n "$name" ] || return 0
  IMPORT_STOPPED_APP=
  if [ "${IMPORT_QUIET_RESTART:-0}" != 1 ]; then
    say "Starting the app of instance $name again"
  fi
  dc "$name" up -d --wait --wait-timeout 240 >/dev/null ||
    warn "The app of instance $name did not start properly. Run: aman doctor instance --fix"
}

# An instance that never started has no database to back up and no search model yet, so it is started once.
import_start_once() {
  local name=$1 image=$2 rc=0
  if docker_volume_exists "aman_${name}_data"; then
    database_probe "$name" "$image" "$(env_get "$(instance_dir "$name")/.env" SQLITE_PATH)" || rc=$?
  else
    rc=1
  fi
  case "$rc" in
    0) return 0 ;;
    1) ;;
    *) die "Instance $name has data Aman cannot read, so nothing was imported. Run: aman doctor instance --fix" ;;
  esac
  say "Instance $name has never started, so it starts once now and can be backed up before the import."
  instance_up "$name" || exit 1
}

# ready or downloading, from the CLI's look at the data volume; empty when it could not be asked.
search_model_state() {
  local name=$1 image=$2
  D run --rm --network none --env-file "$(instance_dir "$name")/.env" -e NODE_ENV=production \
    -v "aman_${name}_data:/data" "$image" aman import-data --check-ready 2>/dev/null |
    LC_ALL=C sed -n 's/.*"search_model"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1
}

# The import indexes persona knowledge with the search model, which the app downloads once when it starts.
import_wait_for_search_model() {
  local name=$1 image=$2 looks=0 shown=0 most=3
  if [ "$IMPORT_POLL_SECONDS" -gt 0 ]; then most=$((IMPORT_MODEL_WAIT_SECONDS / IMPORT_POLL_SECONDS)); fi
  while :; do
    case "$(search_model_state "$name" "$image")" in
      ready) return 0 ;;
      downloading) ;;
      *) die "Aman could not tell whether instance $name has its search model yet, so nothing was imported. Run: aman doctor instance --fix" ;;
    esac
    if [ "$shown" = 0 ]; then
      if [ "$(instance_state "$name")" = stopped ]; then
        instance_up "$name" || exit 1
      fi
      say "Waiting for instance $name to finish downloading its search model (about 120 MB, once)."
      shown=1
    fi
    looks=$((looks + 1))
    if [ "$looks" -gt "$most" ]; then
      die "Instance $name did not finish downloading its search model in 20 minutes, so nothing was imported. Check this computer's internet connection, then run the import again."
    fi
    sleep "$IMPORT_POLL_SECONDS"
  done
}

# import_run NAME FILE OWNER DISPLAY IMAGE: the file is streamed in and held on a private tmpfs, because the app user
# inside the image cannot read a 0600 file of the host user; the instance's own settings reach the CLI through its .env,
# so it reads the same database and memory paths the app does.
import_run() {
  local name=$1 file=$2 owner=$3 display=$4 image=$5 base was_running=0 rc=0 log layout check=()
  base=$(basename -- "$file")
  if [ "$DRY_RUN" = 1 ]; then check=(--dry-run); fi
  log=$(cli_log import)
  # The CLI prints its summary on stdout and its log lines and JSON result on stderr: the summary is captured here
  # so it can be shown as printed and kept in the log, and the JSON never reaches the screen.
  layout=$log.layout
  : >"$layout"
  if [ "$(instance_state "$name")" != stopped ]; then was_running=1; fi
  if [ "$was_running" = 1 ]; then
    IMPORT_STOPPED_APP=$name
    dc "$name" stop app >/dev/null || die "The app of instance $name did not stop, so nothing was imported."
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "Checking $base for $name. Nothing will be changed."
  else
    say "Importing $base into $name."
  fi
  # The capture sits on a subshell, not on the run itself: a stop signal landing during the run fires the exit
  # path while the run's own redirects are still in place, which would send the restart line into the capture
  # file instead of onto the screen.
  (D run --rm -i --network none \
    --env-file "$(instance_dir "$name")/.env" -e NODE_ENV=production \
    -v "aman_${name}_data:/data" \
    --tmpfs /import:rw,mode=0700,uid=10001,gid=10001,size=1200m \
    "$image" sh -c "cat >/import/export.zip && exec aman import-data --in /import/export.zip --user \"\$1\" --display-name \"\$2\" \${3:+\"\$3\"}" \
    import "$owner" "$display" ${check[@]+"${check[@]}"} <"$file") >"$layout" 2>"$log" || rc=$?
  if [ "$was_running" = 1 ]; then
    if [ "$rc" = 0 ]; then IMPORT_QUIET_RESTART=1; fi
    import_on_exit
    IMPORT_QUIET_RESTART=0
  else
    say "Instance $name was not running, so it was left stopped."
  fi
  if [ "$rc" != 0 ]; then
    rm -f "$layout"
    warn "Import failed: $(cli_reason "$log" "The import stopped without giving a reason. Run: aman doctor instance --fix")"
    UI_FD=2 ui_hint "Full log: $(ui_path "$log")"
    return 1
  fi
  # The CLI's summary of what it imported, or would import, including anything from an older version it left out.
  cat "$layout"
  cat "$layout" >>"$log"
  rm -f "$layout"
  if [ "$DRY_RUN" = 1 ]; then
    ui_ok "Checked. Nothing was imported."
    UI_FD=2 ui_hint "To import, run the same command without --dry-run."
    UI_FD=2 ui_hint "Full log: $(ui_path "$log")"
    return 0
  fi
  log_event "data import into instance $name from $base"
  ui_ok "Imported into instance $name."
  UI_FD=2 ui_hint "Full log: $(ui_path "$log")"
}

cmd_instance_import() {
  local name=${OPT_NAME:-} file=${OPT_IMPORT_FILE:-} owner
  if [ -z "$name" ] || [ -z "$file" ]; then
    usage_die "usage: install.sh instance import NAME FILE"
  fi
  valid_name "$name" || usage_die "invalid instance name"
  [ -f "$file" ] || die "There is no file at $file."
  require_installed
  reg_exists "$name" || die "instance $name does not exist"
  owner=$(reg_get "$name" owner_email)
  [ -n "$owner" ] || die "Instance $name has no recorded owner, so nothing was imported."
  # The name recorded at install is already the person's choice, so it is not asked again.
  if [ -z "$OPT_DISPLAY_NAME" ]; then OPT_DISPLAY_NAME=$(reg_get "$name" owner_name); fi
  ask_valid OPT_DISPLAY_NAME "Your name, as imported chats show it" "$(owner_name_default "$owner")" "" display_name_problem
  docker_prepare
  lock_acquire
  load_installed_release
  import_start_once "$name" "$REL_APP_TAG"
  import_wait_for_search_model "$name" "$REL_APP_TAG"
  # A kept backup is never pruned, so the instance as it was before the import can always be put back. A dry run writes
  # nothing, so it needs none.
  if [ "$DRY_RUN" != 1 ]; then
    backup_run "$name" before-import || die "The backup before the import failed, so nothing was imported. Run: aman doctor backup"
  fi
  import_run "$name" "$file" "$owner" "$OPT_DISPLAY_NAME" "$REL_APP_TAG" || exit 1
}
