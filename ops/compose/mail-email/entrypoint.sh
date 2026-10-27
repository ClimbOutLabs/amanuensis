#!/bin/sh
# Starts the Email sidecar on the send list the Aman server writes, and restarts it when that list changes.
# The sidecar reads its list when it first uses its settings, so a new list needs a restart. After each start
# this records the hash of the list it started with. The server waits for that hash before it sends.
# A stale hash only makes the server wait or refuse, never let a send through.
# The mail account comes from the account file in this sidecar's own volume. The installer writes it
# through the account agent's command line and the Settings Email card changes it through the account
# agent (started below, on this container's private network port). The sidecar always starts from the
# account file, never from the environment Docker loaded at container start, which can hold an older
# account; when the account file changes, the sidecar restarts on the new account.
set -eu

# The list file is the only source of recipients. An env list would let the sidecar send to addresses the file lacks.
unset MCP_EMAIL_SERVER_ALLOWED_RECIPIENTS

policy=${MCP_EMAIL_SERVER_CONFIG_PATH:?set MCP_EMAIL_SERVER_CONFIG_PATH to the send list file}
status=${AMAN_MAIL_STATUS_FILE:?set AMAN_MAIL_STATUS_FILE to the loaded-list status file}
account=${AMAN_MAIL_ACCOUNT_FILE:?set AMAN_MAIL_ACCOUNT_FILE to the account file}
agent=${AMAN_MAIL_ACCOUNT_AGENT:?set AMAN_MAIL_ACCOUNT_AGENT to the account agent}

# How long a stop is given before the server is forced down. The server holds nothing across a
# restart (mail connections are made per tool call, and sessions are the client's to rebuild), so
# forcing it down after the grace loses nothing. An unbounded wait once left the mail service
# down for good when a graceful shutdown stalled on connections that never closed.
stop_grace=${AMAN_MAIL_STOP_GRACE_SECONDS:-30}
case $stop_grace in
  '' | *[!0-9]*) stop_grace=30 ;;
esac

# An unreadable list hashes to nothing, which never matches a loaded list.
list_hash() {
  sha256sum "$policy" 2>/dev/null | cut -d' ' -f1 || true
}

# An absent account file hashes to nothing; the file lives in the sidecar's volume and is emptied on remove.
account_hash() {
  sha256sum "$account" 2>/dev/null | cut -d' ' -f1 || true
}

child=
agent_pid=
loaded=
loaded_account=

# Puts this shell's mail account variables in the account file's state: its account, or none.
load_account() {
  eval "$(python3 "$agent" --print-child-env)"
}

start_server() {
  loaded=$(list_hash)
  loaded_account=$(account_hash)
  load_account
  mcp-email-server "$@" &
  child=$!
  printf '%s\n' "$loaded" >"$status.tmp"
  mv "$status.tmp" "$status"
  echo "mail server started (send list $loaded, account $loaded_account)"
  # A start that does not hold must be plain in the log, not a silent service: give the server a
  # moment, then say if it already stopped or if the loaded-list record is not what was written.
  # The loop below keeps starting it again either way.
  sleep 1
  if ! kill -0 "$child" 2>/dev/null; then
    echo "the mail server stopped again right after it started; it will be started again"
  elif [ "$(cat "$status" 2>/dev/null || true)" != "$loaded" ]; then
    echo "the mail server started but the loaded send list was not recorded; it will be started again"
  fi
}

stop_server() {
  if [ -n "$child" ]; then
    echo "stopping the mail server"
    kill -TERM "$child" 2>/dev/null || true
    # The graceful stop is given the grace period, no more: a watchdog forces the server down
    # when the grace runs out, so the wait below always ends and the restart this stop makes
    # room for always happens. A server that stops promptly never meets the watchdog.
    (
      sleep "$stop_grace"
      echo "the mail server did not stop within $stop_grace seconds; forcing it down"
      kill -KILL "$child" 2>/dev/null || true
    ) &
    watchdog=$!
    wait "$child" 2>/dev/null || true
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    child=
  fi
}

on_signal() {
  stop_server
  if [ -n "$agent_pid" ]; then
    kill -TERM "$agent_pid" 2>/dev/null || true
  fi
  exit 0
}
trap on_signal TERM INT

python3 "$agent" &
agent_pid=$!

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
    echo "the mail server stopped on its own; starting it again"
    start_server "$@"
  elif [ "$(list_hash)" != "$loaded" ]; then
    echo "the send list changed (was $loaded); restarting the mail server"
    stop_server
    start_server "$@"
  elif [ "$(account_hash)" != "$loaded_account" ]; then
    echo "the mail account changed (was $loaded_account); restarting the mail server"
    stop_server
    start_server "$@"
  fi
done
