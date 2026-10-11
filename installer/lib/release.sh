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

# Resolves tags for the current checkout into REL_* globals (read-only).
release_resolve() {
  pins_validate
  REL_REF=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')
  REL_APP_TAG=aman-app:$(source_id .)
  REL_STT_TAG=aman-stt:$(source_id ops/aman-stt)
  REL_DEX_IMAGE=$(json_get "$PINS_FILE" dex_image)
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
    printf '  "dex_image": "%s"\n' "$REL_DEX_IMAGE"
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
  CUR_DEX_IMAGE=$(json_get "$file" dex_image)
  [ -n "$CUR_APP_TAG" ] && [ -n "$CUR_STT_TAG" ] && [ -n "$CUR_DEX_IMAGE" ]
}

build_app_image() {
  [ -f "$REPO_ROOT/Dockerfile.dev" ] || die "Dockerfile.dev not found in $REPO_ROOT; run the installer from a checkout of the repository"
  say "Building the app image $REL_APP_TAG (this is the long step)"
  D build -f "$REPO_ROOT/Dockerfile.dev" --build-arg "BUILD_REF=$REL_REF" -t "$REL_APP_TAG" "$REPO_ROOT" ||
    die "the app image build failed; nothing was changed on the running stack"
}

build_stt_image() {
  [ -f "$REPO_ROOT/ops/aman-stt/Dockerfile" ] || die "ops/aman-stt/Dockerfile not found in $REPO_ROOT"
  say "Building the speech-to-text image $REL_STT_TAG"
  D build -t "$REL_STT_TAG" "$REPO_ROOT/ops/aman-stt" || die "the speech-to-text image build failed"
}

# Builds whatever is missing. Pulls the login image by digest. Nothing is pushed anywhere.
images_ensure() {
  if docker_image_exists "$REL_APP_TAG"; then
    say "App image $REL_APP_TAG already built"
  else
    build_app_image
  fi
  if docker_image_exists "$REL_STT_TAG"; then
    say "Speech-to-text image $REL_STT_TAG already built"
  else
    build_stt_image
  fi
  if docker_image_exists "$REL_DEX_IMAGE"; then
    say "Login image already present"
  else
    say "Pulling the login image by digest"
    D pull "$REL_DEX_IMAGE" || die "could not pull $REL_DEX_IMAGE"
  fi
}
