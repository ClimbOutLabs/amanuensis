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
POLICY_VOLUME=$NAME-mail-policy
MIRROR_VOLUME=$NAME-mirror
SLOT_IMAGE_NAME=$NAME-slot

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker volume rm "$POLICY_VOLUME" >/dev/null 2>&1 || true
  docker volume rm "$MIRROR_VOLUME" >/dev/null 2>&1 || true
  docker image rm "$SLOT_IMAGE_NAME" >/dev/null 2>&1 || true
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
docker volume create "$POLICY_VOLUME" >/dev/null
# The login service is not part of this check: the app boots with an issuer it cannot reach and retries.
# The send list volume mounts the way the instance compose file mounts it for an instance with email.
docker run -d --name "$NAME" --read-only --tmpfs /tmp -v "$VOLUME:/data" -v "$POLICY_VOLUME:/data/mail-policy" \
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

# A fresh send list volume takes the ownership of the image dir it mounts over. The app is the only
# writer of the list, so the dir must belong to the app user and the first write must succeed.
policy_uid=$(docker exec "$NAME" stat -c %u /data/mail-policy) || fail "the send list dir is missing"
[ "$policy_uid" = 10001 ] || fail "the send list dir is owned by uid $policy_uid, expected 10001"
docker exec "$NAME" node -e "require('node:fs').writeFileSync('/data/mail-policy/allowed_recipients.toml', 'allowed_recipients = []\n')" \
  || fail "the app could not write the send list into a fresh volume"

printf 'ok: %s runs as uid 10001 with only /data and /tmp writable and became healthy\n' "$IMAGE"
printf 'ok: a fresh send list volume is owned by uid 10001 and the app writes its send list into it\n'

# The account agent runs as the sidecar's user with no capabilities, against the account file in the
# sidecar's own volume: read, save and remove must all work there, while a file owned by another
# user stays unreadable. Needs root (only root can make a file owned by another user), setpriv and
# python3; skipped otherwise. No Docker is needed for this part.
agent_fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}
if [ "$(id -u)" = 0 ] && command -v setpriv >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  agent_tmp=$(mktemp -d)
  trap 'if [ -n "${agent_tmp:-}" ]; then rm -rf "$agent_tmp"; fi; cleanup' EXIT
  agent="$REPO/ops/compose/mail-email/account_agent.py"
  agent_env() {
    setpriv --bounding-set=-all --inh-caps=-all -- env AMAN_MAIL_ACCOUNT_FILE="$1" python3 "$agent" --print-child-env
  }
  agent_write() {
    printf '%s\n' "$2" | setpriv --bounding-set=-all --inh-caps=-all -- env AMAN_MAIL_ACCOUNT_FILE="$1" python3 "$agent" --write-stdin
  }
  agent_remove() {
    setpriv --bounding-set=-all --inh-caps=-all -- env AMAN_MAIL_ACCOUNT_FILE="$1" python3 "$agent" --remove
  }
  account_text=$(printf '%s\n' \
    '# Written by the installer for the Email connector. Keep it private: it holds the app password.' \
    'MCP_EMAIL_SERVER_EMAIL_ADDRESS=a@example.invalid' \
    "MCP_EMAIL_SERVER_PASSWORD='image-runtime-pw'" \
    'MCP_EMAIL_SERVER_IMAP_HOST=imap.example.invalid' \
    'MCP_EMAIL_SERVER_IMAP_PORT=993' \
    'MCP_EMAIL_SERVER_IMAP_SSL=true' \
    'MCP_EMAIL_SERVER_IMAP_START_SSL=false' \
    'MCP_EMAIL_SERVER_IMAP_VERIFY_SSL=true' \
    'MCP_EMAIL_SERVER_SMTP_HOST=smtp.example.invalid' \
    'MCP_EMAIL_SERVER_SMTP_PORT=465' \
    'MCP_EMAIL_SERVER_SMTP_SSL=true' \
    'MCP_EMAIL_SERVER_SMTP_START_SSL=false' \
    'MCP_EMAIL_SERVER_SMTP_VERIFY_SSL=true')
  changed_text=$(printf '%s' "$account_text" | sed 's/a@example.invalid/b@example.invalid/')
  # The sidecar's own file: owned by the sidecar's user, readable only by that user.
  owned="$agent_tmp/owned.env"
  printf '%s\n' "$account_text" >"$owned"
  chmod 600 "$owned"
  agent_env "$owned" | grep -q 'MCP_EMAIL_SERVER_EMAIL_ADDRESS=a@example.invalid' ||
    agent_fail "the capability-free agent could not read the sidecar's own account file"
  agent_write "$owned" "$changed_text" | grep -qx 'saved' ||
    agent_fail "the capability-free agent could not save the sidecar's own account file"
  grep -q 'MCP_EMAIL_SERVER_EMAIL_ADDRESS=b@example.invalid' "$owned" ||
    agent_fail "the saved account did not land in the sidecar's own account file"
  [ "$(stat -c %a "$owned")" = 600 ] ||
    agent_fail "the saved account file has mode $(stat -c %a "$owned"), expected 600"
  agent_remove "$owned" | grep -qx 'removed' ||
    agent_fail "the capability-free agent could not remove the sidecar's own account file"
  [ ! -s "$owned" ] || agent_fail "the account file is not empty after remove"
  agent_env "$owned" | grep -q 'unset MCP_EMAIL_SERVER_EMAIL_ADDRESS' ||
    agent_fail "a removed account still reads as connected"
  # Another user's file: the old bind-mounted layout, which the volume replaces.
  foreign="$agent_tmp/foreign.env"
  printf '%s\n' "$account_text" >"$foreign"
  chmod 600 "$foreign"
  chown 1000 "$foreign"
  agent_env "$foreign" | grep -q 'unset MCP_EMAIL_SERVER_EMAIL_ADDRESS' ||
    agent_fail "the capability-free agent read another user's account file"
  if agent_write "$foreign" "$changed_text" >/dev/null 2>&1; then
    agent_fail "the capability-free agent wrote another user's account file"
  fi
  grep -q 'MCP_EMAIL_SERVER_EMAIL_ADDRESS=a@example.invalid' "$foreign" ||
    agent_fail "the failed save changed another user's account file"
  printf 'ok: the capability-free account agent reads, saves and removes the sidecar-owned account file, and not another user'"'"'s file\n'
else
  printf 'skip: the account agent permission case needs root, setpriv and python3\n'
fi

# A fresh package mirror volume takes the ownership of the slot image dir it mounts over. The slot
# image carries that dir owned by the app user (10001), so the app can bind its mirror socket in a
# fresh volume; the slot user (65532) only connects through the socket, so it needs to pass through
# the dir, not write in it.
docker build -f "$REPO/ops/sandbox-slot/Dockerfile" -t "$SLOT_IMAGE_NAME" "$REPO/ops/sandbox-slot" >/dev/null
docker volume create "$MIRROR_VOLUME" >/dev/null
mirror_uid=$(docker run --rm -v "$MIRROR_VOLUME:/run/aman/mirror" --entrypoint stat "$SLOT_IMAGE_NAME" -c %u /run/aman/mirror) ||
  fail "the mirror dir is missing from the slot image"
[ "$mirror_uid" = 10001 ] || fail "a fresh mirror volume is owned by uid $mirror_uid, expected 10001"
docker run --rm --user 65532:65532 -v "$MIRROR_VOLUME:/run/aman/mirror" --entrypoint sh "$SLOT_IMAGE_NAME" -c 'test -x /run/aman/mirror' ||
  fail "the slot user cannot pass through a fresh mirror volume"
printf 'ok: a fresh mirror volume is owned by uid 10001 and the slot user can pass through it\n'
