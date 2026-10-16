# shellcheck shell=bash
# Data import: restores a data export into a fresh instance. The app is stopped while the CLI runs in a one-off
# container that has the instance's data volume and no network, then started again whatever the outcome.

OPT_IMPORT_FILE=

# The export file is the fourth word of `instance import NAME FILE` and of no other command.
check_import_options() {
  if [ -n "$OPT_IMPORT_FILE" ] && [ "$COMMAND:$SUBCOMMAND" != instance:import ]; then
    usage_die "unexpected argument $OPT_IMPORT_FILE"
  fi
}

# import_run NAME FILE OWNER IMAGE: the file is streamed in and held on a private tmpfs, because the app user inside the
# image cannot read a 0600 file of the host user; the instance's own settings reach the CLI through its .env, so it
# reads the same database and memory paths the app does.
import_run() {
  local name=$1 file=$2 owner=$3 image=$4 base was_running=0 rc=0
  base=$(basename -- "$file")
  if [ "$(instance_state "$name")" != stopped ]; then was_running=1; fi
  if [ "$was_running" = 1 ]; then
    say "Stopping the app of instance $name for the import"
    dc "$name" stop app >/dev/null || die "could not stop the app of instance $name; nothing was imported"
  fi
  say "Importing $base into instance $name for $owner"
  D run --rm -i --network none \
    --env-file "$(instance_dir "$name")/.env" -e NODE_ENV=production \
    -v "aman_${name}_data:/data" \
    --tmpfs /import:rw,mode=0700,uid=10001,gid=10001,size=1200m \
    "$image" sh -c "cat >/import/export.zip && exec aman import-data --in /import/export.zip --user \"\$1\"" import "$owner" \
    <"$file" || rc=$?
  if [ "$was_running" = 1 ]; then
    say "Starting the app of instance $name again"
    dc "$name" up -d --wait --wait-timeout 240 >/dev/null ||
      warn "The app of instance $name did not start healthy. Run: aman doctor instance --fix"
  else
    say "Instance $name was not running, so it was left stopped."
  fi
  if [ "$rc" != 0 ]; then
    warn "The import failed (see above). Nothing was kept; a failed import leaves the instance as it was."
    return 1
  fi
  log_event "data import into instance $name from $base"
  ui_ok "Imported into instance $name. Model keys and connector sign-ins are not part of an export; set them up in Settings."
}

cmd_instance_import() {
  local name=${OPT_NAME:-} file=${OPT_IMPORT_FILE:-} owner
  [ -n "$name" ] && [ -n "$file" ] || usage_die "usage: install.sh instance import NAME FILE"
  valid_name "$name" || usage_die "invalid instance name"
  [ -f "$file" ] || die "there is no file at $file"
  require_installed
  reg_exists "$name" || die "instance $name does not exist"
  owner=$(reg_get "$name" owner_email)
  [ -n "$owner" ] || die "instance $name has no recorded owner"
  docker_prepare
  lock_acquire
  load_installed_release
  docker_volume_exists "aman_${name}_data" ||
    die "instance $name has no data yet; start it once with install.sh, then import"
  import_run "$name" "$file" "$owner" "$REL_APP_TAG" || exit 1
}
