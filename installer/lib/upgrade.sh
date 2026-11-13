# shellcheck shell=bash
# Upgrade: back up, rebuild, restart, check health; on any failure restore the database and the
# previous images. A migration marker is deliberately not consulted.

UPGRADE_STAGE=idle
UPGRADE_BACKUP=
# The instances this upgrade moved to https, so the restart that follows recreates them.
UPGRADE_MOVED=
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
  # The instances are drawn again with the connectors of the version put back, not the failed one.
  REL_CALENDAR_TAG=$CUR_CALENDAR_TAG
  REL_BROWSER_TAG=$CUR_BROWSER_TAG
  REL_BROWSER_GATEWAY_TAG=$CUR_BROWSER_GATEWAY_TAG
  (machine_up "$CUR_STT_TAG" "$CUR_TTS_TAG") || failed=1
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
# an instance that never started is what the upgrade is for. --force skips the check. Healthy means the doctor's
# report for the instance holds no fail record: warnings pass, and the message names the failing parts and the fix of
# the first one from the report itself, so it points at the repair that check needs (a sandbox or Docker problem is
# not repaired by restarting the instance). A doctor run that produces no report is a check that could not run, not a
# healthy instance, so it stops the upgrade too, with its own message.
upgrade_health_gate() {
  local name out rc fails flat fix
  [ -x "$(doctor_shim)" ] && [ "$OPT_FORCE" != 1 ] || return 0
  for name in $(reg_names); do
    instance_ever_healthy "$name" || continue
    rc=0
    out=$(DOCTOR_TIMEOUT=180 run_doctor --json --local --instance "$name" 2>/dev/null) || rc=$?
    fails=$(doctor_fail_details "$out")
    if [ -n "$fails" ]; then
      # Each detail ends as a sentence, so two of them never run together.
      flat=$(printf '%s\n' "$fails" | sed -e '/[.!?]$/!s/$/./' | tr '\n' ' ')
      flat=${flat% }
      fix=$(doctor_first_fail_fix "$out")
      die "Instance $name worked before but has a problem now, so the upgrade did not start: $flat ${fix:-Run aman doctor to see it}, then run the upgrade again."
    fi
    if [ "$rc" != 0 ] || [ -z "$out" ]; then
      die "Instance $name could not be checked, so the upgrade did not start. Run the check itself to see why: aman doctor. Or upgrade anyway with: aman upgrade --force"
    fi
  done
}

# Tailscale serve keeps trying for each port it is set up for, so it takes a port of an instance the moment the upgrade
# stops the instance, and the new version and the rollback would both fail to start. The app port is never moved by
# itself, so one Tailscale wants stops the upgrade before anything changes. An https port is moved when the instance is
# drawn again, after the backup and the build.
upgrade_ports_ready() {
  local name
  for name in $(reg_names); do instance_tailscale_port_check "$name"; done
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
  machine_up "$REL_STT_TAG" "$REL_TTS_TAG"
  for name in $(reg_names); do
    if instance_sandbox_wanted "$name"; then sandbox_ensure "$name" refresh; fi
    rc=
    if instance_enforce_single_owner "$name" || upgrade_moved "$name"; then rc=recreate; fi
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

# Before the Email and Calendar connectors kept their account in their own volume, the installer kept the account
# in a file in the instance folder, and nothing reads that file now. An instance that still has the file has an
# account the upgrade did not carry over, so the output says how to connect it again. Said once per connector,
# however many instances have the file.
upgrade_old_connector_notice() { # file, connector name
  local file=$1 connector=$2 name
  for name in $(reg_names); do
    if [ -s "$(instance_dir "$name")/$file" ]; then
      say "$connector was set up the old way. Connect it again in Settings, then Connectors, then $connector."
      return 0
    fi
  done
}

# A calendar account the older installer kept in the instance folder is moved into the connector's own storage. Only
# one that could not be moved is reported, so the notice stops once the account is moved.
upgrade_old_account_notices() {
  local name
  for name in $(reg_names); do
    calendar_migrate_old_file "$name" || true
  done
  upgrade_old_connector_notice .env.mail-email Email
  upgrade_old_connector_notice .env.calendar Calendar
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

# The instances an upgrade should move to https: ones an older installer opened on the network over
# plain http. Their recorded addresses say the move is owed, and no other part of an upgrade looks
# at the addresses, so without this an instance keeps sending its password over plain http.
upgrade_http_instances() {
  local name
  for name in $(reg_names); do
    if [ "$(instance_address_change "$name")" = refresh ]; then printf '%s\n' "$name"; fi
  done
}

# Moves one instance to https. The addresses are settled first, which makes the certificate before
# the record says https and puts the record back if the certificate cannot be made. The instance is
# drawn again so it is served the new way; the caller restarts it.
upgrade_move_to_https() { # name
  say "Moving instance $1 to https, so sign-in on your network is encrypted."
  instance_apply_addresses "$1" refresh "$REL_APP_TAG"
  instance_render "$1" "$REL_APP_TAG" "$REL_DEX_IMAGE"
  UPGRADE_MOVED="$UPGRADE_MOVED $1"
}

# Whether this upgrade moved the instance to https.
upgrade_moved() { # name
  case " $UPGRADE_MOVED " in *" $1 "*) return 0 ;; esac
  return 1
}

cmd_upgrade() {
  local name rc movers
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
  if [ "$CUR_APP_TAG" = "$REL_APP_TAG" ] && [ "$CUR_STT_TAG" = "$REL_STT_TAG" ] && [ "$CUR_TTS_TAG" = "$REL_TTS_TAG" ] && [ "$CUR_CALENDAR_TAG" = "$REL_CALENDAR_TAG" ] && [ "$CUR_BROWSER_TAG" = "$REL_BROWSER_TAG" ] && [ "$CUR_BROWSER_GATEWAY_TAG" = "$REL_BROWSER_GATEWAY_TAG" ] && [ "$CUR_DEX_IMAGE" = "$REL_DEX_IMAGE" ]; then
    if docker_image_exists "$REL_APP_TAG" && docker_image_exists "$REL_STT_TAG" && docker_image_exists "$REL_TTS_TAG" && docker_image_exists "$REL_CALENDAR_TAG" && docker_image_exists "$REL_BROWSER_TAG" && docker_image_exists "$REL_BROWSER_GATEWAY_TAG" && docker_image_exists "$REL_DEX_IMAGE"; then
      movers=$(upgrade_http_instances)
      if [ -z "$movers" ]; then
        say "Already up to date ($REL_APP_TAG). Nothing to do."
        upgrade_old_account_notices
        upgrade_report
        return 0
      fi
      if [ "$OPT_CHECK" = 1 ] || [ "$DRY_RUN" = 1 ]; then
        say "Aman is up to date ($REL_APP_TAG)."
        for name in $movers; do
          say "  Instance $name would move to https (it is open on your network over plain http)."
        done
        return 0
      fi
      lock_acquire
      say "Aman is up to date ($REL_APP_TAG). One change is still needed:"
      for name in $movers; do
        upgrade_move_to_https "$name"
        instance_up "$name" recreate || exit 1
      done
      upgrade_old_account_notices
      upgrade_report
      return 0
    fi
    if [ "$OPT_CHECK" = 1 ] || [ "$DRY_RUN" = 1 ]; then
      say "Aman is up to date, but part of it is missing. An upgrade would build it again."
      return 0
    fi
    lock_acquire
    upgrade_ports_ready
    say "Building the missing parts again"
    images_ensure
    machine_up "$REL_STT_TAG" "$REL_TTS_TAG"
    for name in $(upgrade_http_instances); do
      upgrade_move_to_https "$name"
    done
    for name in $(reg_names); do
      rc=
      if upgrade_moved "$name"; then rc=recreate; fi
      # Containers rebuilt here restart, so an https port Tailscale serve took is moved first.
      if tls_port_taken_by_tailscale "$name"; then instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"; fi
      instance_up "$name" ${rc:+"$rc"} || exit 1
    done
    upgrade_old_account_notices
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
  [ "$CUR_TTS_TAG" = "$REL_TTS_TAG" ] || say "  voice   ${CUR_TTS_TAG:-(not installed)} -> $REL_TTS_TAG"
  [ "$CUR_CALENDAR_TAG" = "$REL_CALENDAR_TAG" ] || say "  calendar $CUR_CALENDAR_TAG -> $REL_CALENDAR_TAG"
  [ "$CUR_BROWSER_TAG" = "$REL_BROWSER_TAG" ] || say "  browser ${CUR_BROWSER_TAG:-(new)} -> $REL_BROWSER_TAG"
  [ "$CUR_DEX_IMAGE" = "$REL_DEX_IMAGE" ] || say "  login   $CUR_DEX_IMAGE -> $REL_DEX_IMAGE"
  if upgrade_any_sandbox; then say "  sandbox PDF and image reading (builds the sandbox again)"; fi
  for name in $(upgrade_http_instances); do
    say "  Instance $name moves to https (it is open on your network over plain http)."
  done
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
  upgrade_ports_ready
  upgrade_prepare
  for name in $(upgrade_http_instances); do
    upgrade_move_to_https "$name"
  done
  upgrade_switch
  if [ -n "$UPGRADE_BACKUP" ]; then
    say "Upgraded to $REL_APP_TAG. The backup from before the upgrade is at $UPGRADE_BACKUP."
  else
    say "Upgraded to $REL_APP_TAG. No backup was needed, since no instance had data yet."
  fi
  upgrade_old_account_notices
  if [ -x "$(doctor_shim)" ]; then
    AMAN_REPORT_COMMAND=upgrade DOCTOR_TIMEOUT=180 run_doctor || warn "The checks after the upgrade found a problem, listed above."
  fi
}
