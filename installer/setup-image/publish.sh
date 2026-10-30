#!/usr/bin/env bash
# Build the setup image, check it, and (only with --publish) push it.
#
#   publish.sh            build and smoke check only; pushes nothing
#   publish.sh --publish  build, check, push, then check the pushed image
#
# Pushing needs a Docker sign-in to ghcr.io with write access to the
# ClimbOutLabs packages. Without it the push fails and this script says
# so in plain words and stops; nothing is half published, because the
# pin in installer/release.json only changes when a person pastes the
# line this script prints at the end.
#
# After a publish, two files take the printed pin line:
#   installer/release.json (the setup_image line), and
#   packages/aman-installer/tests/golden/install-commands.txt
#     (the same reference, three lines).
# Until both carry the real digest, release.json holds a placeholder of
# zeros and an installer built from it cannot pull the setup image.
set -euo pipefail

IMAGE_NAME=ghcr.io/climboutlabs/aman-setup
SETUP_IMAGE_DIR=$(cd "$(dirname "$0")" && pwd)
DOCKERFILE="$SETUP_IMAGE_DIR/Dockerfile"

PUBLISH=0
case "${1:-}" in
  "") ;;
  --publish) PUBLISH=1 ;;
  *)
    echo "Say $0 on its own to build and check, or $0 --publish to build, check and push." >&2
    exit 2
    ;;
esac

fail() {
  echo "Setup image publish stopped: $1" >&2
  echo "Next step: $2" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 ||
  fail "Docker is not on this computer, so the image cannot be built." \
    "Install Docker, start it, then run this again."

# The base stays a digest pin, like every other image this project
# ships: a tag here would let the base change under a rebuild.
BASE_LINE=$(grep -E '^FROM ' "$DOCKERFILE") ||
  fail "The Dockerfile has no FROM line." "Restore the FROM line in $DOCKERFILE."
if ! printf '%s' "$BASE_LINE" | grep -Eq '@sha256:[a-f0-9]{64}$'; then
  fail "The Dockerfile's base image is not pinned by digest: $BASE_LINE" \
    "Pin the base as name@sha256:<digest> in $DOCKERFILE, then run this again."
fi

echo "Building $IMAGE_NAME:latest from $DOCKERFILE"
docker build -t "$IMAGE_NAME:latest" "$SETUP_IMAGE_DIR"

"$SETUP_IMAGE_DIR/smoke.sh" "$IMAGE_NAME:latest"

if [ "$PUBLISH" -ne 1 ]; then
  echo "Built and checked only; nothing was pushed."
  echo "To publish, run: $0 --publish"
  exit 0
fi

echo "Pushing $IMAGE_NAME:latest"
PUSH_OUT=$(docker push "$IMAGE_NAME:latest" 2>&1) && PUSH_RC=0 || PUSH_RC=$?
printf '%s\n' "$PUSH_OUT"
if [ "$PUSH_RC" -ne 0 ]; then
  case "$PUSH_OUT" in
    *denied* | *unauthorized* | *"authentication required"* | *"no basic auth"*)
      fail "GitHub's registry refused the push. This computer is not signed in to ghcr.io, or the sign-in cannot write to the ClimbOutLabs packages." \
        "Run: docker login ghcr.io, signing in as a GitHub user whose token has the write:packages scope for ClimbOutLabs, then run $0 --publish again."
      ;;
    *)
      fail "The push failed; its output is above." \
        "Fix what the output names, then run $0 --publish again."
      ;;
  esac
fi

DIGEST=$(printf '%s\n' "$PUSH_OUT" | sed -n 's/.*digest: \(sha256:[a-f0-9]\{64\}\).*/\1/p' | tail -n 1)
[ -n "$DIGEST" ] ||
  fail "The push finished but its output named no digest, so there is no pin to print." \
    "Push again by hand with: docker push $IMAGE_NAME:latest, and take the digest from its output."

# Prove the published artifact itself, not just the local build.
docker pull "$IMAGE_NAME@$DIGEST" >/dev/null
"$SETUP_IMAGE_DIR/smoke.sh" "$IMAGE_NAME@$DIGEST"

echo
echo "Published $IMAGE_NAME@$DIGEST"
echo "Put this line in installer/release.json in place of the setup_image line,"
echo "and the same reference in place of the old one in"
echo "packages/aman-installer/tests/golden/install-commands.txt (three lines):"
echo
echo "  \"setup_image\": \"$IMAGE_NAME@$DIGEST\","
