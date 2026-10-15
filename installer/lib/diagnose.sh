# shellcheck shell=bash
# What a failed container log says, in one plain sentence. The installer and the doctor both use it, so a person is
# never sent to read container logs; a log it does not recognise prints nothing and the caller calls it a bug.

# Reads log text on stdin.
container_failure_cause_stdin() {
  local text path
  text=$(cat)
  path=$(printf '%s\n' "$text" | sed -n "s/.*EACCES: permission denied, mkdir '\\([^']*\\)'.*/\\1/p" | head -n 1)
  if [ -n "$path" ]; then
    echo "The app could not start: it was not allowed to create a folder ($path)."
  elif printf '%s\n' "$text" | grep -Eqi 'port is already allocated|address already in use|EADDRINUSE'; then
    echo "A port the app needs is already in use on this computer."
  elif printf '%s\n' "$text" | grep -Eqi 'no space left on device|ENOSPC'; then
    echo "This computer ran out of disk space."
  elif printf '%s\n' "$text" | grep -Eqi 'oom true|OOMKilled|exit code: 137'; then
    echo "The app was stopped because Docker ran out of memory."
  fi
}

container_failure_cause() { container_failure_cause_stdin <"$1"; }
