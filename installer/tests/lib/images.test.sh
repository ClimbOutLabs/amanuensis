#!/usr/bin/env bash
# Aman's own images: downloaded by pinned digest when a release published them for this source, built otherwise.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

DIGEST=sha256:$(printf 'a%.0s' $(seq 64))

# The id the installer computes for one image of the fixture checkout.
image_id() { # registry name
  bash "$INSTALLER_DIR/image-ids.sh" "$REPO" | awk -v n="$1" '$1 == n {print $2}'
}

# Pins a published copy of each named image under the id given, or under its own id when none is given.
pin_published() { # key:name[:id]...
  local entry key name id
  for entry in "$@"; do
    key=${entry%%:*}
    name=${entry#*:}
    id=${name#*:}
    name=${name%%:*}
    [ "$id" != "$name" ] || id=$(image_id "$name")
    sed -i "s|\"$key\": \"[^\"]*\"|\"$key\": \"ghcr.io/climboutlabs/$name:$id@$DIGEST\"|" "$SB_INSTALLER/release.json"
  done
}

ALL_PUBLISHED=(published_app_image:aman-app published_stt_image:aman-stt published_tts_image:aman-tts
  published_calendar_image:aman-calendar-caldav published_browser_image:aman-browser
  published_browser_gateway_image:aman-browser-gateway)

test_nothing_published_builds_everything() {
  t_begin "with no published images, every Aman image is built here and the plan says so"
  sandbox_new
  run_install --dry-run --yes
  assert_flat_contains "$OUT" "Build the Aman app"
  assert_flat_contains "$OUT" "Everything is built on this computer"
  install_machine
  assert_log_has "docker build -f $REPO/Dockerfile.dev"
  assert_log_lacks "docker pull ghcr.io/climboutlabs/"
  sandbox_drop
}

test_a_published_image_for_this_source_is_downloaded_by_digest() {
  t_begin "an image published for this exact source is pulled by its digest and named like a local build"
  sandbox_new
  pin_published "${ALL_PUBLISHED[@]}"
  run_install --dry-run --yes
  assert_flat_contains "$OUT" "Download the Aman app"
  assert_flat_contains "$OUT" "Download the speech-to-text service"
  assert_flat_contains "$OUT" "Download Aman's browser"
  assert_flat_contains "$OUT" "checked by their pinned digest"
  assert_not_contains "$OUT" "mostly to build the app"
  install_machine
  local app
  app=$(image_id aman-app)
  assert_log_has "docker pull ghcr.io/climboutlabs/aman-app:$app@$DIGEST"
  assert_log_has "docker tag ghcr.io/climboutlabs/aman-app:$app@$DIGEST aman-app:$app"
  assert_log_has "docker pull ghcr.io/climboutlabs/aman-browser-gateway:"
  assert_log_lacks "docker build -f $REPO/Dockerfile.dev"
  assert_log_lacks "docker build -t aman-stt:"
  assert_log_lacks "docker build -t aman-browser:"
  assert_contains "$(cat "$AMAN_HOME/release/release.json")" "\"app_image\": \"aman-app:$app\""
  sandbox_drop
}

test_a_published_image_for_other_source_is_not_used() {
  t_begin "an image published for a different source is ignored and the image is built here"
  sandbox_new
  pin_published published_app_image:aman-app:ffffffffffff published_stt_image:aman-stt
  install_machine
  assert_log_lacks "docker pull ghcr.io/climboutlabs/aman-app"
  assert_log_has "docker build -f $REPO/Dockerfile.dev"
  assert_log_has "docker pull ghcr.io/climboutlabs/aman-stt:"
  sandbox_drop
}

test_build_from_source_ignores_published_images() {
  t_begin "--build-from-source builds every image even when all were published"
  sandbox_new
  pin_published "${ALL_PUBLISHED[@]}"
  INSTALL_EXTRA=(--build-from-source)
  install_machine
  INSTALL_EXTRA=()
  assert_log_lacks "docker pull ghcr.io/climboutlabs/"
  assert_log_has "docker build -f $REPO/Dockerfile.dev"
  assert_log_has "docker build -t aman-browser:"
  sandbox_drop
}

test_a_failed_download_is_built_instead() {
  t_begin "when a published image cannot be downloaded, the installer says so and builds it"
  sandbox_new
  pin_published "${ALL_PUBLISHED[@]}"
  STUB_FAIL_ON=ghcr.io/climboutlabs/aman-app install_machine
  assert_flat_contains "$OUT$ERR" "Could not download the Aman app, so it is built here instead"
  assert_log_has "docker build -f $REPO/Dockerfile.dev"
  assert_log_lacks "docker build -t aman-stt:"
  sandbox_drop
}

test_a_malformed_pin_stops_the_installer() {
  t_begin "a published pin that is not an Aman image pinned by digest stops the run before anything changes"
  sandbox_new
  sed -i 's|"published_app_image": "[^"]*"|"published_app_image": "ghcr.io/someone-else/aman-app:abcdefabcdef"|' "$SB_INSTALLER/release.json"
  run_install --dry-run --yes
  assert_eq "$RC" 1 "the run stops"
  assert_flat_contains "$ERR" "published_app_image in"
  sandbox_drop
}

test_the_app_id_follows_its_build_inputs_only() {
  t_begin "the app's id changes with what Dockerfile.dev copies and not with other files, such as the pins"
  sandbox_new
  local before
  before=$(image_id aman-app)
  printf 'notes\n' >"$REPO/NOTES.md"
  mkdir -p "$REPO/installer" && printf '{}\n' >"$REPO/installer/release.json"
  (cd "$REPO" && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m other)
  assert_eq "$(image_id aman-app)" "$before" "a change outside the build inputs keeps the id"
  printf 'COPY package.json ./\n' >>"$REPO/Dockerfile.dev"
  printf '{}\n' >"$REPO/package.json"
  (cd "$REPO" && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m app)
  local after
  after=$(image_id aman-app)
  if [ "$after" != "$before" ]; then t_pass; else t_fail "a change to Dockerfile.dev changes the id"; fi
  printf '{"a":1}\n' >"$REPO/package.json"
  (cd "$REPO" && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m copied)
  if [ "$(image_id aman-app)" != "$after" ]; then t_pass; else t_fail "a change to a copied path changes the id"; fi
  sandbox_drop
}

test_an_app_build_step_the_id_cannot_follow_builds_the_app() {
  local step
  local -a steps=(
    'COPY ["package.json", "./"]'
    $'COPY package.json \\\n  ./'
    $'COPY <<EOT /notes.txt\nnotes\nEOT'
    'copy package.json ./'
    'ADD package.json ./'
    'RUN --mount=type=bind,source=.,target=/src true'
    'RUN --mount=target=/src true'
  )
  for step in "${steps[@]}"; do
    t_begin "a published app image is not used when Dockerfile.dev has: ${step%%$'\n'*}"
    sandbox_new
    printf '%s\n' "$step" >>"$REPO/Dockerfile.dev"
    (cd "$REPO" && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m step)
    pin_published "${ALL_PUBLISHED[@]}"
    run_install --dry-run --yes
    assert_flat_contains "$OUT" "Build the Aman app"
    assert_flat_contains "$OUT" "Download the speech-to-text service"
    sandbox_drop
  done
}

test_nothing_published_builds_everything
test_a_published_image_for_this_source_is_downloaded_by_digest
test_a_published_image_for_other_source_is_not_used
test_build_from_source_ignores_published_images
test_a_failed_download_is_built_instead
test_a_malformed_pin_stops_the_installer
test_the_app_id_follows_its_build_inputs_only
test_an_app_build_step_the_id_cannot_follow_builds_the_app
tests_finish
