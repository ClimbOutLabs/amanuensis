# shellcheck shell=bash
# Upgrade: back up, rebuild, restart, check health; on any failure restore the database and the
# previous images. A migration marker is deliberately not consulted.

UPGRADE_STAGE=idle
UPGRADE_BACKUP=

upgrade_rollback() {
  local name failed=0 rc=1
  set +e
  UPGRADE_STAGE=rollback
  warn "the upgrade failed; restoring the previous version"
  if [ -f "$RELEASE_DIR/previous.release.json" ]; then
    cp "$RELEASE_DIR/previous.release.json" "$RELEASE_DIR/release.json"
  fi
  if ! release_load "$RELEASE_DIR/release.json"; then
    warn "the previous release record is unreadable; restore by hand from $UPGRADE_BACKUP"
    exit 2
  fi
  (machine_up "$CUR_STT_TAG") || failed=1
  for name in $(reg_names); do
    say "Restoring instance $name"
    dc "$name" down >/dev/null 2>&1
    if [ -n "$UPGRADE_BACKUP" ]; then
      (restore_sqlite "$name" "$UPGRADE_BACKUP" "$CUR_APP_TAG") || failed=1
    fi
    instance_render "$name" "$CUR_APP_TAG" "$CUR_DEX_IMAGE"
    instance_up "$name" || failed=1
  done
  if [ "$failed" = 0 ]; then
    rc=1
    say "Rolled back to the previous version. The database is restored from $UPGRADE_BACKUP."
  else
    rc=2
    warn "the rollback did not fully complete. Your backup is at ${UPGRADE_BACKUP:-none}; run install.sh again after fixing the error above."
  fi
  exit "$rc"
}

# Runs from the EXIT trap, so a die, a failed command or a signal all reach the rollback.
upgrade_on_exit() {
  if [ "$UPGRADE_STAGE" = applying ]; then
    upgrade_rollback
  fi
}

cmd_upgrade() {
  local name
  require_installed
  release_load "$RELEASE_DIR/release.json" || die "the recorded release is unreadable; run install.sh again"
  docker_attach
  release_resolve
  if [ "$CUR_APP_TAG" = "$REL_APP_TAG" ] && [ "$CUR_STT_TAG" = "$REL_STT_TAG" ] && [ "$CUR_DEX_IMAGE" = "$REL_DEX_IMAGE" ]; then
    if docker_image_exists "$REL_APP_TAG" && docker_image_exists "$REL_STT_TAG" && docker_image_exists "$REL_DEX_IMAGE"; then
      say "Already up to date ($REL_APP_TAG). Nothing to do."
      return 0
    fi
    if [ "$OPT_CHECK" = 1 ] || [ "$DRY_RUN" = 1 ]; then
      say "The recorded version is current but some of its images are missing; upgrade would rebuild them."
      return 0
    fi
    lock_acquire
    say "Rebuilding missing images of the recorded version"
    images_ensure
    machine_up "$REL_STT_TAG"
    for name in $(reg_names); do
      instance_up "$name" || exit 1
    done
    return 0
  fi
  say "An upgrade would change:"
  [ "$CUR_APP_TAG" = "$REL_APP_TAG" ] || say "  app     $CUR_APP_TAG -> $REL_APP_TAG"
  [ "$CUR_STT_TAG" = "$REL_STT_TAG" ] || say "  speech  $CUR_STT_TAG -> $REL_STT_TAG"
  [ "$CUR_DEX_IMAGE" = "$REL_DEX_IMAGE" ] || say "  login   $CUR_DEX_IMAGE -> $REL_DEX_IMAGE"
  if [ "$OPT_CHECK" = 1 ]; then
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run: nothing was changed."
    return 0
  fi
  lock_acquire
  if [ -x "$(doctor_shim)" ] && [ "$OPT_FORCE" != 1 ]; then
    run_doctor --json >/dev/null 2>&1 || die "doctor reports a failure; fix it first or run upgrade --force"
  fi
  # The backup comes first so every later step has something to return to.
  UPGRADE_BACKUP=
  if [ -n "$(reg_names)" ]; then
    backup_run "" || die "the pre-upgrade backup failed; nothing was changed"
    UPGRADE_BACKUP=$LAST_BACKUP_DIR
  fi
  # Building touches nothing that is running, so a failed build needs no rollback.
  images_ensure
  UPGRADE_STAGE=applying
  release_write
  machine_up "$REL_STT_TAG"
  for name in $(reg_names); do
    instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
    instance_up "$name" || exit 1
  done
  UPGRADE_STAGE=finished
  log_event "upgrade to $REL_APP_TAG"
  say "Upgraded to $REL_APP_TAG. The pre-upgrade backup is ${UPGRADE_BACKUP:-not needed (no instances)}."
  if [ -x "$(doctor_shim)" ]; then
    run_doctor || warn "doctor reported problems after the upgrade; see its output above"
  fi
}
