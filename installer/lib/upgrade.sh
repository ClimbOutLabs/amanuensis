# shellcheck shell=bash
# Upgrade: back up, rebuild, restart, check health; on any failure restore the database and the
# previous images. A migration marker is deliberately not consulted.

UPGRADE_STAGE=idle
UPGRADE_BACKUP=

upgrade_rollback() {
  local name failed=0 rc=1
  set +e
  UPGRADE_STAGE=rollback
  warn "The upgrade failed. Putting the previous version back."
  if [ -f "$RELEASE_DIR/previous.release.json" ]; then
    cp "$RELEASE_DIR/previous.release.json" "$RELEASE_DIR/release.json"
  fi
  if ! release_load "$RELEASE_DIR/release.json"; then
    warn "The record of the previous version cannot be read, so it cannot be put back by itself. Your backup is at $UPGRADE_BACKUP."
    lock_release
    exit 2
  fi
  (machine_up "$CUR_STT_TAG") || failed=1
  for name in $(reg_names); do
    # An instance that never became healthy has no data to restore and nothing worth bringing back.
    instance_ever_healthy "$name" || continue
    say "Putting instance $name back"
    dc "$name" down >/dev/null 2>&1
    if [ -n "$UPGRADE_BACKUP" ]; then
      (restore_sqlite "$name" "$UPGRADE_BACKUP" "$CUR_APP_TAG") || failed=1
    fi
    instance_render "$name" "$CUR_APP_TAG" "$CUR_DEX_IMAGE"
    instance_up "$name" || failed=1
  done
  if [ "$failed" = 0 ]; then
    rc=1
    say "The previous version is back, with its data restored from the backup at $UPGRADE_BACKUP."
  else
    rc=2
    warn "The previous version could not be fully put back. Your backup is at ${UPGRADE_BACKUP:-none}. Fix the error above, then run: aman doctor instance --fix"
  fi
  lock_release
  exit "$rc"
}

# Runs from the EXIT trap, so a die, a failed command or a signal all reach the rollback.
upgrade_on_exit() {
  if [ "$UPGRADE_STAGE" = applying ]; then
    upgrade_rollback
  fi
}

# Whether any instance runs in the sandbox, whose image an upgrade rebuilds.
upgrade_any_sandbox() {
  local name
  for name in $(reg_names); do
    if instance_sandbox_wanted "$name"; then return 0; fi
  done
  return 1
}

# Only an instance that was healthy once has anything the upgrade could harm, so only its failure stops the upgrade;
# an instance that never started is what the upgrade is for. --force skips the check.
upgrade_health_gate() {
  local name
  [ -x "$(doctor_shim)" ] && [ "$OPT_FORCE" != 1 ] || return 0
  for name in $(reg_names); do
    instance_ever_healthy "$name" || continue
    run_doctor --json --local --instance "$name" >/dev/null 2>&1 ||
      die "Instance $name worked before but has a problem now, so the upgrade did not start. See it with: aman doctor. Repair it with: aman doctor instance --fix. Or upgrade anyway with: aman upgrade --force"
  done
}

# Backs up every instance that has data, then builds what is missing. Touches nothing that is running, so a failed
# build needs no rollback.
upgrade_prepare() {
  UPGRADE_BACKUP=
  if [ -n "$(reg_names)" ]; then
    BACKUP_ONLY_HEALTHY=1 backup_run "" || die "The backup before the upgrade failed, so nothing was changed."
    UPGRADE_BACKUP=$LAST_BACKUP_DIR
  fi
  images_ensure
}

# Records the new release and restarts everything on it; from here a failure restores the backup and the old images.
upgrade_switch() {
  local name rc
  UPGRADE_STAGE=applying
  release_write
  machine_up "$REL_STT_TAG"
  for name in $(reg_names); do
    if instance_sandbox_wanted "$name"; then sandbox_ensure "$name" refresh; fi
    rc=
    if instance_enforce_single_owner "$name"; then rc=recreate; fi
    instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
    instance_up "$name" ${rc:+"$rc"} || exit 1
  done
  UPGRADE_STAGE=finished
  log_event "upgrade to $REL_APP_TAG"
}

cmd_upgrade() {
  local name
  require_installed
  release_load "$RELEASE_DIR/release.json" || die "The record of the installed version cannot be read. Run install.sh again."
  docker_attach
  release_resolve
  # The aman command and its helper files come from this checkout too, so an upgrade brings them along.
  if [ "$OPT_CHECK" != 1 ] && [ "$DRY_RUN" != 1 ]; then install_doctor_shim; fi
  if [ "$CUR_APP_TAG" = "$REL_APP_TAG" ] && [ "$CUR_STT_TAG" = "$REL_STT_TAG" ] && [ "$CUR_CALENDAR_TAG" = "$REL_CALENDAR_TAG" ] && [ "$CUR_DEX_IMAGE" = "$REL_DEX_IMAGE" ]; then
    if docker_image_exists "$REL_APP_TAG" && docker_image_exists "$REL_STT_TAG" && docker_image_exists "$REL_CALENDAR_TAG" && docker_image_exists "$REL_DEX_IMAGE"; then
      say "Already up to date ($REL_APP_TAG). Nothing to do."
      return 0
    fi
    if [ "$OPT_CHECK" = 1 ] || [ "$DRY_RUN" = 1 ]; then
      say "Aman is up to date, but part of it is missing. An upgrade would build it again."
      return 0
    fi
    lock_acquire
    say "Building the missing parts again"
    images_ensure
    machine_up "$REL_STT_TAG"
    for name in $(reg_names); do
      instance_up "$name" || exit 1
    done
    return 0
  fi
  if [ "$OPT_CHECK" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    say "An upgrade would change:"
  else
    say "Upgrading these parts of the installed version:"
  fi
  [ "$CUR_APP_TAG" = "$REL_APP_TAG" ] || say "  app     $CUR_APP_TAG -> $REL_APP_TAG"
  [ "$CUR_STT_TAG" = "$REL_STT_TAG" ] || say "  speech  $CUR_STT_TAG -> $REL_STT_TAG"
  [ "$CUR_CALENDAR_TAG" = "$REL_CALENDAR_TAG" ] || say "  calendar $CUR_CALENDAR_TAG -> $REL_CALENDAR_TAG"
  [ "$CUR_DEX_IMAGE" = "$REL_DEX_IMAGE" ] || say "  login   $CUR_DEX_IMAGE -> $REL_DEX_IMAGE"
  if upgrade_any_sandbox; then say "  sandbox PDF and image reading (builds the sandbox again)"; fi
  if [ "$OPT_CHECK" = 1 ]; then
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run: nothing was changed."
    return 0
  fi
  lock_acquire
  say "Steps: check each instance, back up every instance, build the new version, restart the instances, check again."
  say "If anything fails, the old version and the backup are put back."
  upgrade_health_gate
  upgrade_prepare
  upgrade_switch
  if [ -n "$UPGRADE_BACKUP" ]; then
    say "Upgraded to $REL_APP_TAG. The backup from before the upgrade is at $UPGRADE_BACKUP."
  else
    say "Upgraded to $REL_APP_TAG. No backup was needed, since no instance had data yet."
  fi
  if [ -x "$(doctor_shim)" ]; then
    DOCTOR_TIMEOUT=180 run_doctor || warn "The checks after the upgrade found a problem, listed above."
  fi
}
