# shellcheck shell=bash
# Upgrade: back up, rebuild, restart, check health; on any failure restore the database and the
# previous images. A migration marker is deliberately not consulted.

UPGRADE_STAGE=idle
UPGRADE_BACKUP=
# What upgrade_checkout_behind adds to the pull command it advises when the checkout's branch
# does not track its source, so the command names the source and branch a plain pull would need.
UPGRADE_PULL_ARGS=

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

# Runs the doctor so the app's saved report is current when an upgrade finds nothing to change; its own result is not used.
upgrade_report() {
  [ "$OPT_CHECK" != 1 ] && [ "$DRY_RUN" != 1 ] || return 0
  [ -x "$(doctor_shim)" ] || return 0
  AMAN_REPORT_COMMAND=upgrade DOCTOR_TIMEOUT=180 run_doctor --json >/dev/null 2>&1 || true
}

# Before the Email connector kept its account in its own volume, the installer kept the account
# in a file in the instance folder, and nothing reads that file now. An instance that still has
# the file has an account the upgrade did not carry over, so the output says how to connect it
# again. Said once, however many instances have the file.
upgrade_old_email_notice() {
  local name dir
  for name in $(reg_names); do
    dir=$(instance_dir "$name")
    if [ -s "$dir/.env.mail-email" ]; then
      say "Email was set up the old way. Connect it again in Settings, then Connectors, then Email."
      return 0
    fi
  done
}

# The source a branch that tracks nothing would be pulled from: the checkout's only remote, when
# it has exactly one. With no remote, or several to choose from, there is no safe guess.
upgrade_fallback_remote() {
  local remotes
  remotes=$(git -C "$REPO_ROOT" remote 2>/dev/null) || remotes=
  if [ "$(printf '%s\n' "$remotes" | grep -c . || true)" = 1 ]; then
    printf '%s' "$remotes"
  fi
}

# The checkout path wrapped in double quotes, with the few characters that stay special inside
# double quotes escaped, so a printed command still runs when the path has spaces or the like.
upgrade_quoted_path() {
  local path=$1
  path=${path//\\/\\\\}
  path=${path//\"/\\\"}
  path=${path//\$/\\$}
  path=${path//\`/\\\`}
  printf '"%s"' "$path"
}

# Whether the checkout is missing commits that its source has. The tags an upgrade compares come
# from this checkout alone, so a checkout that fell behind its source looks current until the
# source is asked. Fetching just the branch the checkout is on is enough to tell; nothing is
# ever pulled. A checkout that cannot be compared (no git, no source) is not behind. A
# comparison that fails warns with the reason it found and counts as not behind, so an offline
# computer still upgrades with the code it has.
upgrade_checkout_behind() {
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 1
  local branch remote tracked source_ref
  branch=$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null) || branch=
  tracked=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null) || tracked=
  if [ -n "$tracked" ]; then
    remote=${tracked%%/*}
    source_ref=${tracked#*/}
    UPGRADE_PULL_ARGS=
  elif [ -n "$branch" ]; then
    remote=$(upgrade_fallback_remote)
    [ -n "$remote" ] || return 1
    source_ref=$branch
    UPGRADE_PULL_ARGS=" $remote $source_ref"
  else
    return 1
  fi
  git -C "$REPO_ROOT" remote get-url "$remote" >/dev/null 2>&1 || return 1
  if ! GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" fetch --quiet "$remote" "+refs/heads/$source_ref:refs/remotes/$remote/$source_ref" 2>/dev/null; then
    # The fetch failed. Asking the source to list the branch tells a branch it does not have
    # apart from a source that cannot be reached, so the warning names the real reason.
    local listing_rc=0
    GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" ls-remote --exit-code --heads "$remote" "refs/heads/$source_ref" >/dev/null 2>&1 || listing_rc=$?
    if [ "$listing_rc" = 2 ]; then
      warn "Aman could not check for a newer version, because this copy is on the branch $source_ref, which is not on $remote. The upgrade carries on with the code already on this computer. To check for a newer version, switch this copy to a branch that is on $remote, then run: aman upgrade --check"
    else
      warn "Aman could not check for a newer version, because $remote could not be reached. The upgrade carries on with the code already on this computer. To check again, fix the connection and run: aman upgrade --check"
    fi
    return 1
  fi
  [ -n "$(git -C "$REPO_ROOT" rev-list "HEAD..refs/remotes/$remote/$source_ref" 2>/dev/null)" ]
}

cmd_upgrade() {
  local name
  require_installed
  release_load "$RELEASE_DIR/release.json" || die "The record of the installed version cannot be read. Run install.sh again."
  docker_attach
  release_resolve
  if upgrade_checkout_behind; then
    say "A newer version of Aman is available."
    say "This copy of the code is behind the copy on GitHub, so upgrading now would only rebuild the older code."
    say "To get the newer version, run: git -C $(upgrade_quoted_path "$REPO_ROOT") pull$UPGRADE_PULL_ARGS && aman upgrade"
    return 0
  fi
  # The aman command and its helper files come from this checkout too, so an upgrade brings them along.
  if [ "$OPT_CHECK" != 1 ] && [ "$DRY_RUN" != 1 ]; then install_doctor_shim; fi
  if [ "$CUR_APP_TAG" = "$REL_APP_TAG" ] && [ "$CUR_STT_TAG" = "$REL_STT_TAG" ] && [ "$CUR_CALENDAR_TAG" = "$REL_CALENDAR_TAG" ] && [ "$CUR_DEX_IMAGE" = "$REL_DEX_IMAGE" ]; then
    if docker_image_exists "$REL_APP_TAG" && docker_image_exists "$REL_STT_TAG" && docker_image_exists "$REL_CALENDAR_TAG" && docker_image_exists "$REL_DEX_IMAGE"; then
      say "Already up to date ($REL_APP_TAG). Nothing to do."
      upgrade_old_email_notice
      upgrade_report
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
    upgrade_old_email_notice
    upgrade_report
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
  upgrade_old_email_notice
  if [ -x "$(doctor_shim)" ]; then
    AMAN_REPORT_COMMAND=upgrade DOCTOR_TIMEOUT=180 run_doctor || warn "The checks after the upgrade found a problem, listed above."
  fi
}
