#!/usr/bin/env bash
# Starts the app image the way the instance compose file does, as the image's own user with only the
# /data volume and a tmpfs /tmp writable, and waits for it to become healthy. Needs a running Docker;
# AMAN_TEST_IMAGE names an already built image and skips the build.
set -euo pipefail

REPO=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE=${AMAN_TEST_IMAGE:-}
WAIT_SECONDS=${AMAN_TEST_WAIT_SECONDS:-90}
NAME=aman-image-runtime-$$
VOLUME=$NAME-data

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  docker logs "$NAME" 2>&1 | tail -n 30 >&2 || true
  exit 1
}

if [ -z "$IMAGE" ]; then
  IMAGE=aman-image-runtime:local
  docker build -f "$REPO/Dockerfile.dev" -t "$IMAGE" "$REPO"
fi

docker volume create "$VOLUME" >/dev/null
# The login service is not part of this check: the app boots with an issuer it cannot reach and retries.
docker run -d --name "$NAME" --read-only --tmpfs /tmp -v "$VOLUME:/data" \
  -e NODE_ENV=production -e STANDALONE=true -e PORT=8790 \
  -e SQLITE_PATH=/data/db/db.sqlite -e MEMORY_MARKDOWN_DIR=/data/memory -e PERSONA_KNOWLEDGE_DIR=/data/persona-knowledge \
  -e OIDC_ISSUER_URL=http://127.0.0.1:9/dex -e OIDC_CLIENT_ID=image-runtime -e OIDC_CLIENT_SECRET=image-runtime \
  -e OIDC_ALLOWED_EMAILS=owner@image-runtime.invalid \
  "$IMAGE" >/dev/null

uid=$(docker exec "$NAME" id -u) || fail "the app container is not running"
[ "$uid" = 10001 ] || fail "the app runs as uid $uid, expected 10001"

health='fetch("http://127.0.0.1:8790/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
deadline=$((SECONDS + WAIT_SECONDS))
until docker exec "$NAME" node -e "$health" >/dev/null 2>&1; do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "the app container stopped"
  [ "$SECONDS" -lt "$deadline" ] || fail "the app was not healthy after ${WAIT_SECONDS}s"
  sleep 1
done

[ "$(docker inspect -f '{{.RestartCount}}' "$NAME")" = 0 ] || fail "the app container restarted"
printf 'ok: %s runs as uid 10001 with only /data and /tmp writable and became healthy\n' "$IMAGE"
