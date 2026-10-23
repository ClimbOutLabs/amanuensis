#!/bin/sh
# Starts the Email sidecar on the send list the Aman server writes, and restarts it when that list changes.
# The sidecar reads its list when it first uses its settings, so a new list needs a restart. After each start
# this records the hash of the list it started with. The server waits for that hash before it sends.
# A stale hash only makes the server wait or refuse, never let a send through.
set -eu

# The list file is the only source of recipients. An env list would let the sidecar send to addresses the file lacks.
unset MCP_EMAIL_SERVER_ALLOWED_RECIPIENTS

policy=${MCP_EMAIL_SERVER_CONFIG_PATH:?set MCP_EMAIL_SERVER_CONFIG_PATH to the send list file}
status=${AMAN_MAIL_STATUS_FILE:?set AMAN_MAIL_STATUS_FILE to the loaded-list status file}

# An unreadable list hashes to nothing, which never matches a loaded list.
list_hash() {
  sha256sum "$policy" 2>/dev/null | cut -d' ' -f1 || true
}

child=
loaded=

start_server() {
  loaded=$(list_hash)
  mcp-email-server "$@" &
  child=$!
  printf '%s\n' "$loaded" >"$status.tmp"
  mv "$status.tmp" "$status"
}

stop_server() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    child=
  fi
}

on_signal() {
  stop_server
  exit 0
}
trap on_signal TERM INT

# The server creates the list before it starts this sidecar. Until then there is nothing to load.
# Say so once when the wait begins, so a missing list is plain in the log instead of a silent wait.
if [ ! -f "$policy" ]; then
  echo "waiting for the send list"
  while [ ! -f "$policy" ]; do
    sleep 2
  done
fi

start_server "$@"
while :; do
  sleep 2
  if ! kill -0 "$child" 2>/dev/null; then
    wait "$child" 2>/dev/null || true
    start_server "$@"
  elif [ "$(list_hash)" != "$loaded" ]; then
    stop_server
    start_server "$@"
  fi
done
