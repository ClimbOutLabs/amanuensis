#!/bin/sh
# Starts the Email sidecar on the send list the Aman server writes, and restarts it when that list changes.
# The sidecar reads its list when it first uses its settings, so a new list needs a restart. After each start
# this records the hash of the list it started with, once the started server answers on its port. The server
# waits for that hash before it sends, so the record must not appear while the server is still starting.
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
# down for good when a graceful shutdown stalled on connections that never closed. The grace is
# short because the app keeps a stream open that never closes on its own, and a send waits on the
# restart: the whole restart must fit inside the app's wait for the new list.
stop_grace=${AMAN_MAIL_STOP_GRACE_SECONDS:-5}
case $stop_grace in
  '' | *[!0-9]*) stop_grace=5 ;;
esac

# An unreadable list hashes to nothing, which never matches a loaded list.
list_hash() {
  sha256sum "$policy" 2>/dev/null | cut -d' ' -f1 || true
}

# An absent account file hashes to nothing; the file lives in the sidecar's volume and is emptied on remove.
account_hash() {
  sha256sum "$account" 2>/dev/null | cut -d' ' -f1 || true
}

# Where the started server listens, read from the --host and --port it is started with. A server
# listening on every address is probed on this container's own loopback address.
probe_host=127.0.0.1
probe_port=9557
read_listen_address() {
  while [ "$#" -gt 0 ]; do
    case $1 in
      --host)
        if [ "$#" -gt 1 ]; then
          probe_host=$2
          shift
        fi
        ;;
      --host=*) probe_host=${1#--host=} ;;
      --port)
        if [ "$#" -gt 1 ]; then
          probe_port=$2
          shift
        fi
        ;;
      --port=*) probe_port=${1#--port=} ;;
    esac
    shift
  done
  case $probe_host in
    '' | 0.0.0.0) probe_host=127.0.0.1 ;;
    '::' | '[::]') probe_host=::1 ;;
  esac
}

# How long a start waits for the server to answer before it stops waiting, in seconds, counted
# from the start and including each probe's own connect time. It stays well inside the app's
# 45 second wait for the record. A server that answers later is recorded by the watch loop below.
answer_wait=${AMAN_MAIL_ANSWER_WAIT_SECONDS:-20}
case $answer_wait in
  '' | *[!0-9]*) answer_wait=20 ;;
esac

# True once the started server answers on its port within the given seconds. False as soon as
# the server exits. A started process is not an answering server: it can still be loading its account
# and index, and a connection in that window is refused.
server_answers() { # seconds
  python3 - "$child" "$probe_host" "$probe_port" "$1" <<'PY'
import os
import socket
import sys
import time

pid, host, port, limit = int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
deadline = time.monotonic() + limit
while True:
    left = deadline - time.monotonic()
    if left <= 0:
        sys.exit(1)
    try:
        os.kill(pid, 0)
    except OSError:
        sys.exit(1)
    try:
        socket.create_connection((host, port), timeout=min(1.0, left)).close()
        sys.exit(0)
    except OSError:
        pass
    time.sleep(min(0.2, max(0.0, deadline - time.monotonic())))
PY
}

child=
agent_pid=
loaded=
loaded_account=
recorded=

# Records this start's send list as loaded. Only called once the started server answers.
record_loaded() {
  printf '%s\n' "$loaded" >"$status.tmp"
  mv "$status.tmp" "$status"
  recorded=yes
}

# Puts this shell's mail account variables in the account file's state: its account, or none.
load_account() {
  eval "$(python3 "$agent" --print-child-env)"
}

start_server() {
  loaded=$(list_hash)
  loaded_account=$(account_hash)
  load_account
  # A start begins here, so the loaded record goes first: while this server is still coming up,
  # nothing may read the previous start's record as this start's list. On an account change the
  # list hash is the same, so a leftover record would otherwise pass for the new server's own.
  rm -f "$status"
  recorded=
  # Its own process group, so a stop reaches a launcher's workers too: forcing down only the first
  # process would leave a worker holding the port, and the restarted server could not bind it.
  if command -v setsid >/dev/null 2>&1; then
    setsid mcp-email-server "$@" &
  else
    mcp-email-server "$@" &
  fi
  child=$!
  # The list is recorded as loaded only once the server answers on its port. The wait is bounded
  # well inside the server's own wait for the record; a server still starting after it is
  # recorded by the loop below as soon as it answers.
  if server_answers "$answer_wait"; then
    record_loaded
  fi
  echo "mail server started (send list $loaded, account $loaded_account)"
  # A start that does not hold must be plain in the log, not a silent service: give the server a
  # moment, then say if it already stopped or if the loaded-list record is not what was written.
  # The loop below keeps starting it again either way.
  sleep 1
  if ! kill -0 "$child" 2>/dev/null; then
    echo "the mail server stopped again right after it started; it will be started again"
  elif [ "$(cat "$status" 2>/dev/null || true)" != "$loaded" ]; then
    echo "the mail server started but does not answer yet; the send list is recorded once it does"
  fi
}

# Signals the server's whole process group when it has one, else only the server.
signal_server() {
  kill "-$1" "-$child" 2>/dev/null || kill "-$1" "$child" 2>/dev/null || true
}

stop_server() {
  if [ -n "$child" ]; then
    echo "stopping the mail server"
    signal_server TERM
    # The graceful stop is given the grace period, no more: a watchdog forces the server down
    # when the grace runs out, so the wait below always ends and the restart this stop makes
    # room for always happens. A server that stops promptly never meets the watchdog.
    (
      sleep "$stop_grace" >/dev/null 2>&1
      echo "the mail server did not stop within $stop_grace seconds; forcing it down"
      signal_server KILL
    ) &
    watchdog=$!
    wait "$child" 2>/dev/null || true
    # The leader can exit on TERM while a worker in its group ignores it and keeps the port. Wait for
    # the whole group to go, and force it down when the grace runs out, before the watchdog is ended.
    waited=0
    while kill -0 "-$child" 2>/dev/null; do
      if [ "$waited" -ge $((stop_grace * 5)) ]; then
        echo "the mail server did not stop within $stop_grace seconds; forcing it down"
        signal_server KILL
        break
      fi
      sleep 0.2
      waited=$((waited + 1))
    done
    # KILL, not TERM, so the watchdog ends at once; its own sleep is detached from our output.
    kill -KILL "$watchdog" 2>/dev/null || true
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

read_listen_address "$@"

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
  elif [ -z "$recorded" ] && server_answers 1; then
    echo "the mail server answers now; recording the send list $loaded"
    record_loaded
  fi
done
