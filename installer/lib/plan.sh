# shellcheck shell=bash
# The default command: preflight, printed plan, confirmation, then execution.

MIN_FREE_KB=$((10 * 1024 * 1024))
# The frontend and core builds run side by side and peak near 5 GB together.
DOCKER_MEM_BLOCK_BYTES=$((6 * 1024 * 1024 * 1024))
DOCKER_MEM_WARN_BYTES=$((8 * 1024 * 1024 * 1024))

PLAN_LINES=
PLAN_TODO=0
PLAN_ROOT=0
PLAN_BLOCKERS=
DL_TOTAL_MB=0
DL_LINES=
DL_HOSTS=
# 1 when this checkout differs from the recorded release: the run then updates the installed version first.
INSTALL_UPGRADE=0
PLAN_UPGRADE_NOTE=
PLAN_FS=$'\037'
PLAN_RS=$'\036'
INSTALL_T0=0
DOCTOR_PROBLEMS=0
# daily or off: the choice for the automatic backup.
B_MODE=

# Results of the checks on this computer print as they are made; a blocker also stops the run before any question.
check_ok() { ui_ok "$1"; }
check_warn() { ui_warn "$1" "${2:-}" "${3:-}"; }
check_block() { # what is wrong, what to do next, technical details
  PLAN_BLOCKERS="$PLAN_BLOCKERS$1"$'\n'
  ui_fail "$1" "${2:-}" "${3:-}"
}

# First sentence and the rest of a message, for text that says the problem and then the way out.
split_problem() {
  case "$1" in
    *". "*)
      SPLIT_HEAD=${1%%. *}
      SPLIT_NEXT=${1#*. }
      ;;
    *)
      SPLIT_HEAD=${1%.}
      SPLIT_NEXT="Fix this, then run install.sh again."
      ;;
  esac
}

# plan_add STATE TEXT [DETAIL...]: STATE is have, todo, root or blocked. Details print dim under the row; for a
# blocked row the first one is what to do next.
plan_add() {
  local state=$1 text=$2 details='' d
  shift 2
  for d in "$@"; do details="$details$PLAN_RS$d"; done
  case "$state" in
    todo) PLAN_TODO=$((PLAN_TODO + 1)) ;;
    root)
      PLAN_TODO=$((PLAN_TODO + 1))
      PLAN_ROOT=$((PLAN_ROOT + 1))
      ;;
    blocked) PLAN_BLOCKERS="$PLAN_BLOCKERS$text"$'\n' ;;
  esac
  PLAN_LINES="$PLAN_LINES$state$PLAN_FS$text$PLAN_FS$details"$'\n'
}

# Free space of the filesystem holding a path (nearest existing ancestor), in KB.
free_kb() {
  local path=$1
  local kb
  while [ ! -e "$path" ] && [ "$path" != / ]; do
    path=$(dirname "$path")
  done
  # A directory this user cannot enter (Docker's data root) cannot be measured; its parent is on the
  # same disk unless the data root is a mount of its own.
  while :; do
    kb=$(df -Pk "$path" 2>/dev/null | awk 'NR == 2 {print $4}')
    if [ -n "$kb" ] || [ "$path" = / ]; then
      printf '%s' "$kb"
      return 0
    fi
    path=$(dirname "$path")
  done
}

# The disk holding Docker's data is the one the images, builds and volumes fill, and it is often not the
# one holding the install home. Docker Desktop keeps its data in a virtual machine, so it is skipped there.
preflight_docker_space() {
  local root free
  case "$DOCKER_ACCESS" in direct | sg) ;; *) return 0 ;; esac
  root=$(D info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -z "$root" ] || [ ! -d "$root" ]; then
    return 0
  fi
  free=$(free_kb "$root")
  case "${free:-}" in
    '' | *[![:digit:]]*) ;;
    *)
      if [ "$free" -lt "$MIN_FREE_KB" ]; then
        check_block "Less than 10 GB free on the disk holding Docker's data ($root): $((free / 1024 / 1024)) GB free" "Make room on that disk (old Docker files go with: docker system prune), then run install.sh again."
      else
        check_ok "$((free / 1024 / 1024)) GB free for Docker data"
      fi
      ;;
  esac
}

# The app image build is killed without a clear message when Docker has too little memory.
preflight_docker_memory() {
  local bytes gb
  case "$DOCKER_ACCESS" in direct | sg) ;; *) return 0 ;; esac
  bytes=$(D info --format '{{.MemTotal}}' 2>/dev/null || true)
  case "${bytes:-}" in '' | *[![:digit:]]*) return 0 ;; esac
  gb=$(awk -v b="$bytes" 'BEGIN {printf "%.1f", b / 1073741824}')
  if [ "$bytes" -lt "$DOCKER_MEM_BLOCK_BYTES" ]; then
    check_block "Docker has only $gb GB of memory and needs at least 6 GB to build the app" "Raise it in Docker Desktop under Settings, Resources, Memory. On Linux, free up memory or add swap, then run install.sh again."
  elif [ "$bytes" -lt "$DOCKER_MEM_WARN_BYTES" ]; then
    check_warn "Docker has $gb GB of memory. The first build may be slow; 8 GB or more is recommended" "Raise it in Docker Desktop under Settings, Resources, Memory."
  else
    check_ok "Docker has $((bytes / 1073741824)) GB of memory"
  fi
}

preflight_system() {
  local os arch free pretty='' unsupported=0
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) pretty=Linux ;;
    Darwin) pretty=macOS ;;
    *)
      unsupported=1
      check_block "Operating system $os is not supported" "On Windows, run this inside the Linux of WSL2, which Docker Desktop sets up."
      ;;
  esac
  case "$arch" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *)
      unsupported=1
      check_block "This kind of computer ($arch) is not supported" "Use an x86_64 or arm64 computer."
      ;;
  esac
  if [ "$unsupported" = 0 ]; then check_ok "$pretty on $arch"; fi
  if command -v git >/dev/null 2>&1; then
    check_ok "git is installed"
  else
    check_block "git is not installed, and the installer needs it to build the app" "Install git, then run install.sh again."
  fi
  free=$(free_kb "$AMAN_HOME")
  case "${free:-}" in
    '' | *[![:digit:]]*) ;;
    *)
      if [ "$free" -lt "$MIN_FREE_KB" ]; then
        check_block "Less than 10 GB free on the disk holding $(ui_path "$AMAN_HOME") ($((free / 1024 / 1024)) GB free)" "Make room on that disk, then run install.sh again."
      else
        check_ok "$((free / 1024 / 1024)) GB free for the install"
      fi
      ;;
  esac
}

# Adds one download to the plan unless its owner step is already done.
dl_add() {
  local id=$1 mb='' what='' hosts='' found=0 fid fmb fwhat fhosts
  while IFS='|' read -r fid fmb fwhat fhosts; do
    case "$fid" in '' | '#'*) continue ;; esac
    if [ "$fid" = "$id" ]; then
      mb=$fmb
      what=$fwhat
      hosts=$fhosts
      found=1
    fi
  done <"$DOWNLOADS_FILE"
  [ "$found" = 1 ] || return 0
  DL_TOTAL_MB=$((DL_TOTAL_MB + mb))
  DL_LINES="$DL_LINES
  $(printf '%6s MB  %s (%s)' "$mb" "$what" "$hosts")"
  DL_HOSTS="$DL_HOSTS $hosts"
}

print_network_destinations() {
  local line fid hosts all='' skipped iface addr
  while IFS='|' read -r fid _ _ hosts; do
    case "$fid" in '' | '#'*) continue ;; esac
    all="$all $hosts"
  done <"$DOWNLOADS_FILE"
  say "The installer may contact only these sites:"
  for line in $(printf '%s' "$all" | tr ' ' '\n' | sort -u); do
    say "  $line"
  done
  say "Nothing is scanned and nothing is reported to the project."
  skipped=$(network_skipped_addresses)
  if [ -n "$skipped" ]; then
    say ""
    say "Addresses of this computer that Aman skips, because other devices cannot reach them (virtual or VPN networks):"
    while read -r iface addr; do
      say "  $addr ($iface)"
    done <<<"$skipped"
  fi
}

# One plan row per entry: a status word and a sentence, the detail dim underneath.
print_plan_rows() {
  local state text details rest piece
  while IFS=$PLAN_FS read -r state text details; do
    [ -n "$state" ] || continue
    case "$state" in
      have) ui_done "$text" ;;
      todo) ui_todo "$text" ;;
      root) ui_admin "$text" ;;
      blocked) ui_fail "$text" "${details#"$PLAN_RS"}" ;;
    esac
    if [ "$state" != blocked ]; then
      rest=$details
      while [ -n "$rest" ]; do
        rest=${rest#"$PLAN_RS"}
        piece=${rest%%"$PLAN_RS"*}
        ui_detail "$piece"
        case "$rest" in *"$PLAN_RS"*) rest=$PLAN_RS${rest#*"$PLAN_RS"} ;; *) rest= ;; esac
      done
    fi
  done <<<"$PLAN_LINES"
}

print_plan() {
  local total_gb hosts count=0 host
  ui_phase "The plan" 3 6
  if [ "$UI_VERBOSE" = 1 ]; then
    ui_hint "State directory $(ui_path "$AMAN_HOME"); source checkout $(ui_path "$REPO_ROOT") (${REL_REF:-unknown})."
    if [ -n "${DOCKER_ENGINE_VERSION:-}" ]; then
      ui_hint "Docker Engine $DOCKER_ENGINE_VERSION, Compose ${DOCKER_COMPOSE_VERSION:-?} (access: ${DOCKER_ACCESS:-direct})."
    fi
  fi
  if [ -n "$PLAN_UPGRADE_NOTE" ]; then ui_line "$PLAN_UPGRADE_NOTE"; fi
  print_plan_rows
  ui_hint "Everything is built on this computer. Nothing is sent anywhere."
  if [ "$PLAN_ROOT" -gt 0 ]; then
    ui_hint "Steps marked needs admin change this computer and run only after you say yes. --yes alone does not allow them; --install-docker, --add-docker-group, --sandbox-root and --tls-root do."
  fi
  if [ "$EDGE_IN_PLAN" = 1 ]; then
    edge_print_firewall_hint
  fi
  if [ -n "$DL_LINES" ]; then
    total_gb=$(awk -v mb="$DL_TOTAL_MB" 'BEGIN {printf "%.1f", mb / 1024}')
    hosts=$(printf '%s' "$DL_HOSTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
    for host in $hosts; do count=$((count + 1)); done
    ui_hint "Downloads: about $total_gb GB from $count sites. The first run takes several minutes, mostly to build the app."
    if [ "$UI_VERBOSE" = 1 ]; then
      say "  First-run downloads (approximate):$DL_LINES"
      say "    total: about $DL_TOTAL_MB MB ($total_gb GB)"
      say "    sources: $hosts"
    else
      ui_hint "Full list of downloads and sources: --verbose"
    fi
  fi
  if sandbox_needed; then
    ui_hint "Run code (Python, shell, files) runs in a sandbox, and so does reading attachments (PDFs and images)."
  else
    ui_hint "Run code and reading attachments stay off (installed with --no-sandbox). To turn it on later, run aman doctor sandbox --fix."
  fi
}

# Machine checks that need no answers from the user, so a blocker can stop the run before any prompt.
plan_preflight() {
  local ver
  PLAN_LINES=
  PLAN_TODO=0
  PLAN_ROOT=0
  PLAN_BLOCKERS=
  ui_phase "Checking this computer" 1 6
  preflight_system
  docker_plan_access
  case "$DOCKER_ACCESS" in
    direct | sg) ;;
    install)
      plan_add root "Install Docker Engine from Docker's own download site" "The steps: install.sh --print-root-steps"
      ui_skip "Docker is not installed yet; the plan below installs it"
      dl_add docker-engine
      ;;
    add-group)
      plan_add root "Give $(current_user) access to Docker, and use it in this run right away"
      ui_skip "You cannot use Docker yet; the plan below gives you access"
      ;;
    *)
      docker_blocked_parts
      check_block "$DB_HEAD" "$DB_NEXT" "${DOCKER_DETAIL:-}"
      ;;
  esac
  docker_plan_runtime
  if [ -n "$PLAN_BLOCKER" ]; then
    split_problem "$PLAN_BLOCKER"
    check_block "$SPLIT_HEAD" "$SPLIT_NEXT"
  else
    case "$DOCKER_ACCESS" in
      direct)
        ver=${DOCKER_ENGINE_VERSION%.*}
        check_ok "Docker $ver is running and you can use it"
        ;;
      sg)
        ver=${DOCKER_ENGINE_VERSION%.*}
        check_ok "Docker $ver works for this run"
        ;;
    esac
  fi
  case "$DOCKER_ACCESS" in direct | sg) AMAN_DOCKER_MODE=$DOCKER_ACCESS ;; esac
  if [ -z "$PLAN_BLOCKERS" ]; then
    preflight_docker_space
    preflight_docker_memory
  fi
  preflight_sandbox
  if sandbox_needed && [ -z "$PLAN_BLOCKERS" ]; then
    check_ok "This computer can run the sandbox"
  fi
}

# The closing block of a run that cannot start; nothing has been changed.
report_blockers_and_exit() {
  local UI_FD=2
  ui_summary fail "Stopped before changing anything."
  ui_line "Fix the item above, then run install.sh again. It picks up where it left off."
  ui_summary_end
  exit 1
}

# Read-only look at what exists, turned into plan lines and download entries. Runs after plan_preflight.
plan_build() {
  local name extra have_release=0 expected_app expected_stt
  if [ -f "$RELEASE_DIR/release.json" ]; then
    have_release=1
  fi
  if [ -d "$AMAN_HOME" ] && [ -f "$STATE_DIR/installed" ]; then
    plan_add have "The folder $(ui_path "$AMAN_HOME") exists"
  else
    plan_add todo "Create the folder $(ui_path "$AMAN_HOME")"
  fi
  INSTALL_UPGRADE=0
  PLAN_UPGRADE_NOTE=
  if [ "$have_release" = 1 ] && release_load "$RELEASE_DIR/release.json"; then
    if [ "$CUR_APP_TAG" != "$REL_APP_TAG" ] || [ "$CUR_STT_TAG" != "$REL_STT_TAG" ] || [ "$CUR_CALENDAR_TAG" != "$REL_CALENDAR_TAG" ] || [ "$CUR_DEX_IMAGE" != "$REL_DEX_IMAGE" ] || [ "$CUR_MAIL_EMAIL_IMAGE" != "$REL_MAIL_EMAIL_IMAGE" ]; then
      # A re-run never quietly reuses older images: this checkout is what gets installed.
      INSTALL_UPGRADE=1
      PLAN_UPGRADE_NOTE="This copy of Aman is newer than the installed one, so it will be updated."
      plan_add todo "Update Aman to this newer copy" \
        "App version $CUR_APP_TAG to $REL_APP_TAG." \
        "Each instance with data is backed up first. If the update fails, the old version and the backup are put back."
    fi
  fi

  plan_image "$REL_APP_TAG" "The Aman app is built" "Build the Aman app" app-base app-deps dockerfile-frontend
  plan_image "$REL_STT_TAG" "The speech-to-text service is built" "Build the speech-to-text service" stt-base stt-deps
  plan_image "$REL_CALENDAR_TAG" "The calendar connector is built" "Build the calendar connector"
  plan_image "$REL_DEX_IMAGE" "The sign-in service is downloaded" "Download the sign-in service" dex
  plan_image "$REL_MAIL_EMAIL_IMAGE" "The email connector is downloaded" "Download the email connector" mail-email
  plan_tls

  plan_sandbox

  plan_aman_command

  if ! docker_available_for_probes; then
    plan_add todo "Start the speech-to-text service"
  elif machine_running; then
    plan_add have "The speech-to-text service is running"
  else
    plan_add todo "Start the speech-to-text service"
  fi
  if ! docker_available_for_probes || ! docker_volume_exists aman_stt_cache; then
    dl_add stt-weights
  fi

  if [ -n "$(reg_names)" ]; then
    for name in $(reg_names); do
      extra=$(extra_sign_in_users "$(reg_file "$name")" "$(instance_dir "$name")")
      if [ -n "$extra" ]; then plan_add todo "Remove $extra from instance $name"; fi
      if [ "$INSTALL_UPGRADE" = 1 ]; then
        plan_add todo "Restart instance $name on the new version"
      elif [ -n "$(instance_address_change "$name")" ]; then
        plan_existing_addresses "$name"
      elif docker_available_for_probes && [ "$(instance_state "$name")" = running ]; then
        plan_add have "Instance $name is running"
      else
        plan_add todo "Start instance $name"
      fi
    done
  fi
  if need_new_instance; then
    if [ -n "$I_ORIGINS" ]; then
      plan_instance_with_addresses
    else
      plan_add todo "Create instance $I_NAME for $I_EMAIL" "Open it at $I_PUBLIC_URL. Sign-in uses port $I_LOGIN_PORT on this computer."
    fi
    if [ "$I_TF" = 1 ]; then
      plan_add todo "Use Token Factory (model $I_TF_MODEL) as the default model" "$(tf_plan_detail)"
    fi
    dl_add embed
  fi
  if [ "$OPT_DEMO" = 1 ]; then
    name=$(demo_target)
    if need_new_instance; then
      plan_add todo "$(demo_plan_text "$name" "$I_EMAIL")"
    elif demo_env_on "$name"; then
      plan_add have "Demo mode is on for instance $name"
    else
      plan_add todo "$(demo_plan_text "$name" "$(reg_get "$name" owner_email)")"
    fi
  fi
  if ! need_new_instance && [ "$OPT_TF_KEY_STDIN" = 1 ]; then
    plan_add todo "Replace the Token Factory key of instance $(tf_rotation_name) and restart its app" "The key is saved only in the settings file of that instance."
  fi
  calendar_plan_row
  email_plan_row
  plan_backups
  plan_edge
}

# The plan row of the aman command: the command itself and the line that puts it on the path of new terminals.
plan_aman_command() {
  local profiles
  [ -f "$INSTALLER_DIR/doctor/aman" ] || return 0
  if aman_command_current && path_ready; then
    plan_add have "The aman command is installed"
    return 0
  fi
  profiles=$(shell_profiles | while IFS= read -r f; do ui_path "$f"; done | tr '\n' ' ')
  plan_add todo "Install the aman command" "At $(ui_path "$(doctor_shim)"), with a line in ${profiles% } so new terminals find it."
}

# An instance from before addresses were listed is opened on the network like a new one, unless --local-only says not to.
# One already open on the network changes between https and plain http when --tls says so, or moves to https by default.
plan_existing_addresses() { # name
  local name=$1 hosts port
  port=$(reg_get "$name" app_port)
  if [ "$(instance_address_change "$name")" = close ]; then
    plan_add todo "Open instance $name on this computer only" "It stops answering at other addresses."
    return 0
  fi
  # On a Mac Docker opens ports on this computer alone, so nothing is opened to the network.
  if network_publishes_on_loopback_only; then
    plan_add todo "Open instance $name on this computer only" "Docker here opens it on this computer alone, so addresses of your network are not used."
    return 0
  fi
  # shellcheck disable=SC2086 # the extra hosts are checked hosts without spaces
  hosts=$(network_origin_list "$port" '' ${OPT_ADDRESSES:-$(reg_get "$name" extra_hosts)} | sed "s|http://||g; s|:$port||g; s|,|, |g")
  if [ "$(tls_target "$name")" = local ]; then
    plan_add todo "Serve instance $name over https on your network" \
      "It will open at: $hosts, with a certificate Aman makes on this computer. The old plain http address sends devices to https." \
      "Each device trusts that certificate once. Its data and sign-in stay as they are."
    return 0
  fi
  plan_add todo "Open instance $name on your network" \
    "It will open at: $hosts. Sign-in works from each. Only devices on your private network can reach it." \
    "Its data and sign-in stay as they are."
}

# The https front end and the local authority, when an instance is about to be served over https.
plan_tls() {
  local name change need=0
  if need_new_instance && [ -n "${I_TLS_PORT:-}" ]; then need=1; fi
  for name in $(reg_names); do
    change=$(instance_address_change "$name")
    if tls_active "$name" || { [ -n "$change" ] && [ "$change" != close ] && [ "$(tls_target "$name")" = local ]; }; then need=1; fi
  done
  if tls_authority_needs_replacing && [ -n "$(tls_instances)" ]; then
    plan_add todo "Make this computer's root certificate again" \
      "The old one, from an earlier version, is valid for more names than it should be. The new one covers only the names Aman opens at and private addresses. Each device trusts it again."
  fi
  [ "$need" = 1 ] || return 0
  plan_image "$(tls_image)" "The https service is downloaded" "Download the https service" https-front
  if [ -f "$(tls_ca_dir)/root.crt" ]; then
    plan_add have "This computer's root certificate exists"
  else
    plan_add todo "Make this computer's root certificate" "Each device trusts it once, so https works. Its private key never leaves this computer."
  fi
}

# The daily backup: asked once (or given with --backups), default yes.
backups_collect() {
  B_MODE=${OPT_BACKUPS:-$(backups_mode)}
  [ -z "$B_MODE" ] || return 0
  B_MODE=daily
  if [ -z "$(backup_scheduler)" ]; then
    B_MODE=off
    if [ "$DRY_RUN" != 1 ]; then ui_warn "Automatic backups are not possible here" "This computer has no way to run a task every day without admin rights."; fi
    return 0
  fi
  if [ "$DRY_RUN" != 1 ] && ! ui_confirm "Back up automatically every day?" y; then B_MODE=off; fi
}

plan_backups() {
  case "$B_MODE" in
    daily)
      if [ "$(backups_mode)" = daily ] && backup_schedule_present; then
        plan_add have "Daily backups are on"
      else
        plan_add todo "Back up every day, keeping the last $BACKUP_KEEP" "Runs at $(printf '%02d:%02d' "$BACKUP_HOUR" "$BACKUP_MINUTE") with $(backup_scheduler_label)."
      fi
      ;;
    off)
      if backup_schedule_present; then plan_add todo "Turn off the daily backups"; fi
      ;;
  esac
}

docker_available_for_probes() {
  case "$DOCKER_ACCESS" in direct | sg) return 0 ;; *) return 1 ;; esac
}

# plan_image TAG TEXT download-ids...
plan_image() { # tag, have text, todo text, download ids...
  local tag=$1 have=$2 text=$3 dl
  shift 3
  if docker_available_for_probes && docker_image_exists "$tag"; then
    plan_add have "$have"
  else
    plan_add todo "$text"
    for dl in "$@"; do dl_add "$dl"; done
  fi
}

need_new_instance() {
  [ -z "$(reg_names)" ] || { [ -n "$OPT_NAME" ] && ! reg_exists "$OPT_NAME"; }
}

cmd_install() {
  local name
  INSTALL_T0=$SECONDS
  DL_TOTAL_MB=0
  DL_LINES=
  DL_HOSTS=
  release_resolve
  AMAN_PASSWORD=
  ui_title "Setting up a private assistant on this computer"
  plan_preflight
  if [ "$DRY_RUN" != 1 ] && [ -n "$PLAN_BLOCKERS" ]; then
    report_blockers_and_exit
  fi
  if need_new_instance; then
    ui_phase "Your first instance" 2 6
    read_password_first
    instance_collect main
    instance_derive
  else
    ui_phase "Your instance" 2 6
    ui_skip "Instance $(reg_names | tr '\n' ' ')is already set up; nothing to ask"
    tf_rotation_collect
  fi
  calendar_collect install
  email_collect install
  backups_collect
  plan_build
  print_plan
  if [ -n "$PLAN_BLOCKERS" ]; then
    report_blockers_and_exit
  fi
  if [ "$DRY_RUN" = 1 ]; then
    ui_summary ok "Dry run: nothing was changed."
    ui_summary_end
    exit 0
  fi
  if [ "$PLAN_TODO" = 0 ]; then
    # Nothing is claimed that was not looked at: the checks run again before the table says what is on.
    docker_attach
    ui_phase "Checking the result" 6 6
    check_result
    if [ "$DOCTOR_PROBLEMS" = 1 ] || [ "$SANDBOX_VERIFY_FAILED" = 1 ]; then
      ui_summary warn "Nothing to change, but the checks found a problem (listed above)."
    else
      ui_summary ok "Nothing to do."
    fi
    print_signout_note
    for name in $(reg_names); do
      print_instance_summary "$name"
    done
    print_closing_lines
    ui_summary_end
    sandbox_finish
    exit 0
  fi
  if ! ui_confirm "Go ahead?" y; then
    say "Nothing was changed."
    exit 0
  fi
  install_execute
}

install_execute() {
  local name demo_name='' change recreate enabled='' ADDRESS_CHANGED=''
  ensure_private_dir "$AMAN_HOME"
  lock_acquire
  ensure_private_dir "$STATE_DIR/logs"
  docker_prepare
  ensure_private_dir "$RELEASE_DIR"
  ensure_private_dir "$MACHINE_DIR"
  ensure_private_dir "$INSTANCES_DIR"
  install_doctor_shim
  if need_new_instance && [ -z "$AMAN_PASSWORD" ]; then
    ui_hint "Asked now so the rest of the setup runs on its own."
    ask_password AMAN_PASSWORD
  fi
  ui_phase "Building the app" 4 6
  if [ "$INSTALL_UPGRADE" = 1 ]; then
    upgrade_prepare
  else
    images_ensure
    release_write
  fi
  ui_phase "Starting services" 5 6
  if sandbox_enable_wanted; then
    enabled=$OPT_NAME
    sandbox_enable "$enabled"
  fi
  for name in $(reg_names); do
    change=$(instance_address_change "$name")
    if [ -n "$change" ]; then
      instance_apply_addresses "$name" "$change"
      ADDRESS_CHANGED="$ADDRESS_CHANGED $name "
    fi
  done
  if [ "$INSTALL_UPGRADE" = 1 ]; then
    upgrade_switch
  else
    machine_up "$REL_STT_TAG"
    for name in $(reg_names); do
      recreate=
      case "$ADDRESS_CHANGED" in *" $name "*) recreate=recreate ;; esac
      if instance_enforce_single_owner "$name"; then recreate=recreate; fi
      if [ "$(instance_state "$name")" != running ] || [ -n "$recreate" ] || { instance_sandbox_wanted "$name" && ! instance_sandbox_wired "$name"; } ||
        { instance_sandbox_wanted "$name" && ! sandbox_slots_use_current_image "$name"; }; then
        if [ "$name" = "$enabled" ]; then recreate=recreate; fi
        if instance_sandbox_wanted "$name" && [ "$name" != "$enabled" ]; then sandbox_ensure "$name"; fi
        instance_render "$name" "$REL_APP_TAG" "$REL_DEX_IMAGE"
        instance_up "$name" ${recreate:+"$recreate"} || exit 1
      fi
    done
  fi
  if [ "$OPT_DEMO" = 1 ]; then demo_name=$(demo_target); fi
  if need_new_instance; then
    instance_create
    AMAN_PASSWORD=
  fi
  if [ -n "$CAL_TARGET" ] && [ -n "$CAL_EMAIL" ] && [ -z "$CAL_SKIP" ]; then calendar_apply "$CAL_TARGET"; fi
  if [ -n "$EM_TARGET" ] && [ -n "$EM_ADDRESS" ] && [ -z "$EM_SKIP" ]; then email_apply "$EM_TARGET"; fi
  tf_rotation_apply
  if tls_authority_needs_replacing && [ -n "$(tls_instances)" ]; then
    tls_renew_all "$REL_APP_TAG" || warn "A certificate could not be renewed. Run: aman doctor tls --fix"
  fi
  for name in $(reg_names); do
    edge_ensure "$name"
  done
  if [ "$OPT_DEMO" = 1 ]; then demo_install_apply "$demo_name"; fi
  if [ -n "$B_MODE" ]; then
    backups_apply "$B_MODE" || warn "The daily backup could not be set up. Run: aman doctor backup --fix"
  fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REL_APP_TAG" >"$STATE_DIR/installed"
  log_event "install complete $REL_APP_TAG"
  ui_phase "Checking the result" 6 6
  check_result
  print_install_summary
  sandbox_finish
  edge_finish
  [ "$DEMO_FAILED" = 0 ] || exit 1
}

# The doctor's one line (or only its problems), and a quiet look at the sandbox of each instance that has one.
check_result() {
  local name
  [ -x "$(doctor_shim)" ] || return 0
  # Includes the model and the public https checks, which wait on the network.
  AMAN_REPORT_COMMAND=install DOCTOR_TIMEOUT=180 run_doctor --summary || DOCTOR_PROBLEMS=1
  for name in $(reg_names); do
    if instance_sandbox_wanted "$name"; then sandbox_verify "$name"; fi
  done
}

# The plan row of an instance that answers at every address of this computer.
plan_instance_with_addresses() {
  local hosts
  hosts=$(printf '%s' "$I_ORIGINS" | sed "s|https\{0,1\}://||g; s|:[[:digit:]]*||g; s|,|, |g")
  if [ -n "$I_TLS_PORT" ]; then
    plan_add todo "Create instance $I_NAME for $I_EMAIL" \
      "It opens over https on port $I_TLS_PORT at: $hosts, with a certificate Aman makes on this computer. Sign-in uses port $I_LOGIN_PORT on this computer." \
      "Port $I_PORT only sends devices to https. $(plan_public_address_note)"
    return 0
  fi
  if [ -n "${I_PUBLIC_ADDRESSES// /}" ]; then
    plan_add todo "Create instance $I_NAME for $I_EMAIL" \
      "It opens on port $I_PORT at: $hosts. Sign-in works from each, and the port is open to your network. Sign-in uses port $I_LOGIN_PORT on this computer." \
      "This computer's public address (${I_PUBLIC_ADDRESSES% }) is not used, because signing in over plain http from the internet is not safe. For the internet use --tls caddy."
  else
    plan_add todo "Create instance $I_NAME for $I_EMAIL" \
      "It opens on port $I_PORT at: $hosts. Sign-in works from each, and the port is open to your network. Sign-in uses port $I_LOGIN_PORT on this computer."
  fi
}

# The line about this computer's public address, when it has one; nothing otherwise.
plan_public_address_note() {
  if [ -n "${I_PUBLIC_ADDRESSES// /}" ]; then
    printf "This computer's public address (%s) is not used. For the internet use --tls caddy." "${I_PUBLIC_ADDRESSES% }"
  fi
}

# The closing block of a finished install: one verdict, then each instance and what to do next.
print_install_summary() {
  local names count
  names=$(reg_names)
  count=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
  if [ "$DOCTOR_PROBLEMS" = 1 ] || [ "$SANDBOX_VERIFY_FAILED" = 1 ]; then
    ui_summary warn "Running, but the checks found a problem (listed above)."
  elif [ "$count" = 1 ]; then
    ui_summary ok "Ready. Instance $names is running."
  else
    ui_summary ok "Ready. Your instances are running."
  fi
  print_signout_note
  for name in $names; do
    print_instance_summary "$name"
  done
  print_closing_lines
  ui_summary_end "$(_ui_elapsed_since "$INSTALL_T0")"
}
