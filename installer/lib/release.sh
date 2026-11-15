# shellcheck shell=bash
# Release manifest and the Aman images. Each image is downloaded when a release published it for this exact source,
# and built from this checkout otherwise. Nothing is ever pushed from here.

# Where release CI publishes the Aman images. A published image is used only when installer/release.json pins it by
# digest, and only under the source id this checkout computes for it.
REL_REGISTRY=ghcr.io/climboutlabs

# The release.json key for the published copy of each Aman image, and its name in the registry.
PUBLISHED_IMAGE_KEYS='published_app_image:aman-app published_stt_image:aman-stt published_tts_image:aman-tts published_calendar_image:aman-calendar-caldav published_browser_image:aman-browser published_browser_gateway_image:aman-browser-gateway'

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
  valid_digest_ref "$(json_get "$PINS_FILE" setup_image)" || die "setup_image in $PINS_FILE must be pinned by sha256 digest"
  valid_digest_ref "$(json_get "$PINS_FILE" caddy_image)" || die "caddy_image in $PINS_FILE must be pinned by sha256 digest"
  published_pins_validate
  node_pins_validate
}

# A published image is either absent (empty) or REL_REGISTRY/<name>:<source id>@sha256:<digest>.
published_pins_validate() {
  local entry key name ref
  for entry in $PUBLISHED_IMAGE_KEYS; do
    key=${entry%%:*}
    name=${entry#*:}
    ref=$(json_get "$PINS_FILE" "$key")
    [ -n "$ref" ] || continue
    matches_whole "$ref" "^${REL_REGISTRY//./\\.}/$name:[a-f0-9]{12}@sha256:[a-f0-9]{64}\$" ||
      die "$key in $PINS_FILE must be $REL_REGISTRY/$name:<source id>@sha256:<digest>, or empty"
  done
}

# The published copy of an image for this checkout: its pinned reference when the pin's source id equals the local
# tag's, otherwise nothing. $1 release.json key, $2 local tag (name:source id).
published_image_for() {
  local ref
  [ "${OPT_BUILD_FROM_SOURCE:-0}" != 1 ] || return 0
  [ "$1" != published_app_image ] || app_build_inputs_followable || return 0
  ref=$(json_get "$PINS_FILE" "$1")
  [ -n "$ref" ] || return 0
  case "$ref" in
    *":${2#*:}@sha256:"*) printf '%s\n' "$ref" ;;
  esac
}

# The Node.js runtime for the sandbox setup is pinned by version and by the published SHA-256 of each tarball.
node_pins_validate() {
  local key
  matches_whole "$(json_get "$PINS_FILE" node_version)" '^22\.[[:digit:]]+\.[[:digit:]]+$' || die "node_version in $PINS_FILE must be a 22.x.y release"
  for key in node_sha256_linux_x64 node_sha256_linux_arm64 node_sha256_darwin_x64 node_sha256_darwin_arm64; do
    matches_whole "$(json_get "$PINS_FILE" "$key")" '^[a-f0-9]{64}$' || die "$key in $PINS_FILE must be a sha256 digest"
  done
}

# Content id of one or more paths in the checkout, plus a hash of local changes when dirty, so the same source always
# maps to the same image tag and a rerun builds nothing. One path is named by its tree hash; several by a hash of
# each path's object id.
source_id() {
  local base status dirty path
  if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    printf 'nogit\n'
    return 0
  fi
  if [ "$#" = 1 ]; then
    base=$(git -C "$REPO_ROOT" rev-parse "HEAD:$1")
  else
    base=$(
      for path in "$@"; do
        printf '%s %s\n' "$path" "$(git -C "$REPO_ROOT" rev-parse --verify --quiet "HEAD:$path" || true)"
      done | sha256_stdin
    )
  fi
  base=$(printf '%s' "$base" | cut -c1-12)
  status=$(git -C "$REPO_ROOT" status --porcelain -- "$@")
  if [ -z "$status" ]; then
    printf '%s\n' "$base"
    return 0
  fi
  dirty=$(
    {
      git -C "$REPO_ROOT" diff HEAD -- "$@"
      printf '%s\n' "$status"
    } | sha256_stdin | cut -c1-8
  )
  printf '%s-d%s\n' "$base" "$dirty"
}

# What the app image is built from: Dockerfile.dev, .dockerignore and every path Dockerfile.dev copies from the
# checkout. Reading the Dockerfile keeps it the one owner of the list, so a change elsewhere (docs, the installer, a
# release pin) leaves the app's id, and a published copy of it, valid.
app_build_inputs() {
  {
    printf '%s\n' Dockerfile.dev .dockerignore
    awk '$1 == "COPY" && $0 !~ /--from=/ {
      n = 0
      for (i = 2; i <= NF; i++) if ($i !~ /^--/) words[++n] = $i
      for (i = 1; i < n; i++) print words[i]
    }' "$REPO_ROOT/Dockerfile.dev"
  } | LC_ALL=C sort -u
}

# True when app_build_inputs can see every file Dockerfile.dev takes from the checkout. A step it cannot read (a
# JSON-form or continued COPY/ADD, a heredoc, a local ADD, a bind mount of the checkout) could change the image without
# changing its id, so a published app image is not used then.
app_build_inputs_followable() {
  awk '
    { op = toupper($1) }
    (op == "COPY" || op == "ADD") && $0 !~ /--from=/ {
      if ($0 ~ /\\[[:space:]]*$/ || $0 ~ /<</) bad = 1
      for (i = 2; i <= NF; i++) if ($i !~ /^--/) break
      if (i <= NF && $i ~ /^\[/) bad = 1
      if (op == "ADD") for (; i < NF; i++) if ($i !~ /^https?:\/\//) bad = 1
    }
    op == "COPY" && $0 !~ /--from=/ && $1 != "COPY" { bad = 1 }
    {
      for (i = 1; i <= NF; i++)
        if ($i ~ /^--mount=/ && $i !~ /from=/ && $i !~ /type=(cache|secret|ssh|tmpfs)/) bad = 1
    }
    END { exit bad }
  ' "$REPO_ROOT/Dockerfile.dev"
}

checkout_app_tag() {
  local inputs
  # Word splitting is the point: each input is one path without spaces.
  inputs=$(app_build_inputs | tr '\n' ' ')
  # shellcheck disable=SC2086
  printf 'aman-app:%s\n' "$(source_id $inputs)"
}

# Resolves tags for the current checkout into REL_* globals (read-only).
release_resolve() {
  pins_validate
  REL_REF=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')
  REL_APP_TAG=$(checkout_app_tag)
  REL_STT_TAG=aman-stt:$(source_id ops/aman-stt)
  REL_TTS_TAG=aman-tts:$(source_id ops/aman-tts)
  REL_CALENDAR_TAG=aman-calendar-caldav:$(source_id ops/calendar-sidecar)
  REL_BROWSER_TAG=aman-browser:$(source_id ops/browser-sidecar)
  REL_BROWSER_GATEWAY_TAG=aman-browser-gateway:$(source_id ops/browser-sidecar)
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
    printf '  "tts_image": "%s",\n' "$REL_TTS_TAG"
    printf '  "calendar_image": "%s",\n' "$REL_CALENDAR_TAG"
    printf '  "browser_image": "%s",\n' "$REL_BROWSER_TAG"
    printf '  "browser_gateway_image": "%s",\n' "$REL_BROWSER_GATEWAY_TAG"
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
  # Empty for a release from before the voice service.
  CUR_TTS_TAG=$(json_get "$file" tts_image)
  CUR_CALENDAR_TAG=$(json_get "$file" calendar_image)
  CUR_BROWSER_TAG=$(json_get "$file" browser_image)
  CUR_BROWSER_GATEWAY_TAG=$(json_get "$file" browser_gateway_image)
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

# Aman's own browser and the gateway that walls it off, built from the same folder.
build_browser_images() {
  [ -f "$REPO_ROOT/ops/browser-sidecar/Dockerfile" ] || die "The file ops/browser-sidecar/Dockerfile is missing from $REPO_ROOT. Run the installer from a complete copy of the Aman code."
  step_begin build-browser "Building Aman's browser (this might take a while)"
  {
    D build -t "$REL_BROWSER_TAG" "$REPO_ROOT/ops/browser-sidecar" &&
      D build -f "$REPO_ROOT/ops/browser-sidecar/Dockerfile.gateway" -t "$REL_BROWSER_GATEWAY_TAG" "$REPO_ROOT/ops/browser-sidecar"
  } >"$STEP_LOG" 2>&1 || step_fail "Building Aman's browser failed" "Fix what the log says, then run install.sh again."
  step_ok "Built Aman's browser"
}

build_stt_image() {
  [ -f "$REPO_ROOT/ops/aman-stt/Dockerfile" ] || die "The file ops/aman-stt/Dockerfile is missing from $REPO_ROOT. Run the installer from a complete copy of the Aman code."
  step_begin build-stt "Building the speech-to-text service"
  D build -t "$REL_STT_TAG" "$REPO_ROOT/ops/aman-stt" >"$STEP_LOG" 2>&1 || step_fail "Building the speech-to-text service failed" "Fix what the log says, then run install.sh again."
  step_ok "Built the speech-to-text service"
}

build_tts_image() {
  [ -f "$REPO_ROOT/ops/aman-tts/Dockerfile" ] || die "The file ops/aman-tts/Dockerfile is missing from $REPO_ROOT. Run the installer from a complete copy of the Aman code."
  step_begin build-tts "Building the voice that reads replies aloud"
  D build -t "$REL_TTS_TAG" "$REPO_ROOT/ops/aman-tts" >"$STEP_LOG" 2>&1 || step_fail "Building the voice that reads replies aloud failed" "Fix what the log says, then run install.sh again."
  step_ok "Built the voice that reads replies aloud"
}

# Downloads the published copies of one step's images and names them with the local tags. Each pair is
# "reference local-tag". Pulling by digest is what proves the download is the published image. Returns 1 when a
# download fails, after saying so, so the caller can build instead.
pull_published() { # step id, what, pairs...
  local id=$1 what=$2 pair
  shift 2
  step_begin "pull-$id" "Downloading $what"
  for pair in "$@"; do
    if ! { D pull "${pair% *}" && D tag "${pair% *}" "${pair#* }"; } >>"$STEP_LOG" 2>&1; then
      ui_step_abort
      ui_warn "Could not download $what, so it is built here instead"
      return 1
    fi
  done
  step_ok "Downloaded $what"
}

# One Aman image: kept when it is here, downloaded when a release published it for this source, built otherwise.
image_ensure() { # local tag, release.json key, step id, what, already-here text, build function
  local tag=$1 key=$2 id=$3 what=$4 have=$5 build=$6 ref
  if docker_image_exists "$tag"; then
    ui_skip "$have"
    return 0
  fi
  ref=$(published_image_for "$key" "$tag")
  if [ -n "$ref" ] && pull_published "$id" "$what" "$ref $tag"; then
    return 0
  fi
  "$build"
}

# Puts every image in place. Pulls the login and email images by digest. Nothing is pushed anywhere.
images_ensure() {
  local browser gateway
  image_ensure "$REL_APP_TAG" published_app_image app "the Aman app" "The Aman app is already on this computer" build_app_image
  image_ensure "$REL_STT_TAG" published_stt_image stt "the speech-to-text service" "The speech-to-text service is already on this computer" build_stt_image
  image_ensure "$REL_TTS_TAG" published_tts_image tts "the voice that reads replies aloud" "The voice that reads replies aloud is already on this computer" build_tts_image
  image_ensure "$REL_CALENDAR_TAG" published_calendar_image calendar "the calendar connector" "The calendar connector is already on this computer" build_calendar_image
  # The browser and its gateway are built by one step, so they are downloaded together or built together.
  if docker_image_exists "$REL_BROWSER_TAG" && docker_image_exists "$REL_BROWSER_GATEWAY_TAG"; then
    ui_skip "Aman's browser is already on this computer"
  else
    browser=$(published_image_for published_browser_image "$REL_BROWSER_TAG")
    gateway=$(published_image_for published_browser_gateway_image "$REL_BROWSER_GATEWAY_TAG")
    if [ -z "$browser" ] || [ -z "$gateway" ] ||
      ! pull_published browser "Aman's browser" "$browser $REL_BROWSER_TAG" "$gateway $REL_BROWSER_GATEWAY_TAG"; then
      build_browser_images
    fi
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
