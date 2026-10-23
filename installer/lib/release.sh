# shellcheck shell=bash
# Release manifest and local image builds. Images are built from this checkout and never pushed.

# Flat string values only, so the manifest can be read without a JSON tool.
json_get() {
  sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
}

valid_digest_ref() {
  matches_whole "$1" '^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$'
}

# Checks the pins shipped with the installer before anything is pulled or written.
pins_validate() {
  local dex
  [ -f "$PINS_FILE" ] || die "release manifest missing: $PINS_FILE"
  [ "$(json_get "$PINS_FILE" schema)" = 1 ] || die "unsupported release manifest schema in $PINS_FILE"
  dex=$(json_get "$PINS_FILE" dex_image)
  valid_digest_ref "$dex" || die "dex_image in $PINS_FILE must be pinned by sha256 digest"
  mail=$(json_get "$PINS_FILE" mail_email_image)
  valid_digest_ref "$mail" || die "mail_email_image in $PINS_FILE must be pinned by sha256 digest"
  valid_digest_ref "$(json_get "$PINS_FILE" caddy_image)" || die "caddy_image in $PINS_FILE must be pinned by sha256 digest"
  node_pins_validate
}

# The Node.js runtime for the sandbox setup is pinned by version and by the published SHA-256 of each tarball.
node_pins_validate() {
  local key
  matches_whole "$(json_get "$PINS_FILE" node_version)" '^22\.[[:digit:]]+\.[[:digit:]]+$' || die "node_version in $PINS_FILE must be a 22.x.y release"
  for key in node_sha256_linux_x64 node_sha256_linux_arm64 node_sha256_darwin_x64 node_sha256_darwin_arm64; do
    matches_whole "$(json_get "$PINS_FILE" "$key")" '^[a-f0-9]{64}$' || die "$key in $PINS_FILE must be a sha256 digest"
  done
}

# Content id of a path in the checkout: tree hash, plus a hash of local changes when dirty, so the
# same source always maps to the same image tag and a rerun builds nothing.
source_id() {
  local path=$1 base spec status dirty
  if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    printf 'nogit\n'
    return 0
  fi
  if [ "$path" = . ]; then
    base=$(git -C "$REPO_ROOT" rev-parse HEAD)
  else
    base=$(git -C "$REPO_ROOT" rev-parse "HEAD:$path")
  fi
  base=$(printf '%s' "$base" | cut -c1-12)
  spec=$path
  status=$(git -C "$REPO_ROOT" status --porcelain -- "$spec")
  if [ -z "$status" ]; then
    printf '%s\n' "$base"
    return 0
  fi
  dirty=$(
    {
      git -C "$REPO_ROOT" diff HEAD -- "$spec"
      printf '%s\n' "$status"
    } | sha256_stdin | cut -c1-8
  )
  printf '%s-d%s\n' "$base" "$dirty"
}

checkout_app_tag() { printf 'aman-app:%s\n' "$(source_id .)"; }

# Resolves tags for the current checkout into REL_* globals (read-only).
release_resolve() {
  pins_validate
  REL_REF=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')
  REL_APP_TAG=$(checkout_app_tag)
  REL_STT_TAG=aman-stt:$(source_id ops/aman-stt)
  REL_CALENDAR_TAG=aman-calendar-caldav:$(source_id ops/calendar-sidecar)
  REL_DEX_IMAGE=$(json_get "$PINS_FILE" dex_image)
  REL_MAIL_EMAIL_IMAGE=$(json_get "$PINS_FILE" mail_email_image)
}

# The resolved manifest recorded under release/; the previous one is kept for rollback.
release_write() {
  local file="$RELEASE_DIR/release.json" tmp
  ensure_private_dir "$RELEASE_DIR"
  tmp=$(umask 077 && mktemp "$RELEASE_DIR/release.XXXXXX")
  {
    printf '{\n'
    printf '  "schema": "1",\n'
    printf '  "source_ref": "%s",\n' "$REL_REF"
    printf '  "app_image": "%s",\n' "$REL_APP_TAG"
    printf '  "stt_image": "%s",\n' "$REL_STT_TAG"
    printf '  "calendar_image": "%s",\n' "$REL_CALENDAR_TAG"
    printf '  "dex_image": "%s",\n' "$REL_DEX_IMAGE"
    printf '  "mail_email_image": "%s"\n' "$REL_MAIL_EMAIL_IMAGE"
    printf '}\n'
  } >"$tmp"
  if [ -f "$file" ] && cmp -s "$tmp" "$file"; then
    rm -f "$tmp"
    return 0
  fi
  if [ -f "$file" ]; then
    cp "$file" "$RELEASE_DIR/previous.release.json"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# Loads the images recorded by an earlier install or upgrade into the CUR_* globals.
release_load() {
  local file=$1
  [ -f "$file" ] || return 1
  CUR_APP_TAG=$(json_get "$file" app_image)
  CUR_STT_TAG=$(json_get "$file" stt_image)
  CUR_CALENDAR_TAG=$(json_get "$file" calendar_image)
  CUR_DEX_IMAGE=$(json_get "$file" dex_image)
  CUR_MAIL_EMAIL_IMAGE=$(json_get "$file" mail_email_image)
  [ -n "$CUR_APP_TAG" ] && [ -n "$CUR_STT_TAG" ] && [ -n "$CUR_DEX_IMAGE" ]
}

build_app_image() {
  [ -f "$REPO_ROOT/Dockerfile.dev" ] || die "The file Dockerfile.dev is missing from $REPO_ROOT. Run the installer from a complete copy of the Aman code."
  local rc=0
  step_begin build-app "Building the Aman app (this might take a while)"
  D build -f "$REPO_ROOT/Dockerfile.dev" --build-arg "BUILD_REF=$REL_REF" -t "$REL_APP_TAG" "$REPO_ROOT" >"$STEP_LOG" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    # The log tells an out-of-memory kill (exit 137) from other failures.
    if [ "$rc" = 137 ] || grep -Eq 'exit code: 137|signal: killed' "$STEP_LOG"; then
      step_fail "Building the Aman app ran out of memory" "Docker needs at least 6 GB of memory. Raise it in Docker Desktop under Settings, Resources, Memory. On Linux, free up memory or add swap. Then run install.sh again. Anything already running was not touched."
    fi
    step_fail "Building the Aman app failed" "Fix what the log says, then run install.sh again. Anything already running was not touched."
  fi
  step_ok "Built the Aman app"
}

build_calendar_image() {
  [ -f "$REPO_ROOT/ops/calendar-sidecar/Dockerfile" ] || die "The file ops/calendar-sidecar/Dockerfile is missing from $REPO_ROOT. Run the installer from a complete copy of the Aman code."
  step_begin build-calendar "Building the calendar connector"
  D build -t "$REL_CALENDAR_TAG" "$REPO_ROOT/ops/calendar-sidecar" >"$STEP_LOG" 2>&1 || step_fail "Building the calendar connector failed" "Fix what the log says, then run install.sh again."
  step_ok "Built the calendar connector"
}

build_stt_image() {
  [ -f "$REPO_ROOT/ops/aman-stt/Dockerfile" ] || die "The file ops/aman-stt/Dockerfile is missing from $REPO_ROOT. Run the installer from a complete copy of the Aman code."
  step_begin build-stt "Building the speech-to-text service"
  D build -t "$REL_STT_TAG" "$REPO_ROOT/ops/aman-stt" >"$STEP_LOG" 2>&1 || step_fail "Building the speech-to-text service failed" "Fix what the log says, then run install.sh again."
  step_ok "Built the speech-to-text service"
}

# Builds whatever is missing. Pulls the login image by digest. Nothing is pushed anywhere.
images_ensure() {
  if docker_image_exists "$REL_APP_TAG"; then
    ui_skip "The Aman app is already built"
  else
    build_app_image
  fi
  if docker_image_exists "$REL_STT_TAG"; then
    ui_skip "The speech-to-text service is already built"
  else
    build_stt_image
  fi
  if docker_image_exists "$REL_CALENDAR_TAG"; then
    ui_skip "The calendar connector is already built"
  else
    build_calendar_image
  fi
  if docker_image_exists "$REL_DEX_IMAGE"; then
    ui_skip "The sign-in service is already downloaded"
  else
    step_begin pull-login "Downloading the sign-in service"
    D pull "$REL_DEX_IMAGE" >"$STEP_LOG" 2>&1 || step_fail "The sign-in service could not be downloaded" "Check that this computer can reach ghcr.io, then run install.sh again."
    step_ok "Downloaded the sign-in service"
  fi
  if docker_image_exists "$REL_MAIL_EMAIL_IMAGE"; then
    ui_skip "The email connector is already downloaded"
  else
    step_begin pull-mail "Downloading the email connector"
    D pull "$REL_MAIL_EMAIL_IMAGE" >"$STEP_LOG" 2>&1 || step_fail "The email connector could not be downloaded" "Check that this computer can reach ghcr.io, then run install.sh again."
    step_ok "Downloaded the email connector"
  fi
  sandbox_images_ensure
}
