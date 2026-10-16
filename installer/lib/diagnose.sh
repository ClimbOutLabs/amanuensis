# shellcheck shell=bash
# What a failed container log says, in one plain sentence, so a person is never sent to read container logs.
# A log it does not recognise prints nothing and the caller calls it a bug.

# A permission error while the app starts is never something the person can fix on their computer: the image
# decides where the app may write.
PERMISSION_ERROR_PATTERN='EACCES|EPERM|permission denied|read-only file system|EROFS'

# Reads log text on stdin.
container_failure_cause_stdin() {
  local text path
  text=$(cat)
  path=$(printf '%s\n' "$text" | sed -n "s/.*E\\(ACCES\\|PERM\\): permission denied, mkdir '\\([^']*\\)'.*/\\2/p" | head -n 1)
  if [ -n "$path" ]; then
    echo "The app could not start: it was not allowed to create a folder ($path). This is a bug in Aman, not a problem on your computer."
  elif printf '%s\n' "$text" | grep -Eqi "$PERMISSION_ERROR_PATTERN"; then
    echo "The app could not start: a permission error stopped it. This is a bug in Aman, not a problem on your computer."
  elif printf '%s\n' "$text" | grep -Eqi 'port is already allocated|address already in use|EADDRINUSE'; then
    echo "A port the app needs is already in use on this computer."
  elif printf '%s\n' "$text" | grep -Eqi 'no space left on device|ENOSPC'; then
    echo "This computer ran out of disk space."
  elif printf '%s\n' "$text" | grep -Eqi 'oom true|OOMKilled|exit code: 137'; then
    echo "The app was stopped because Docker ran out of memory."
  fi
}

container_failure_cause() { container_failure_cause_stdin <"$1"; }

# bug when the log shows a failure only an update of Aman can fix, fixable when the person can act on it.
container_failure_kind() {
  if grep -Eqi "$PERMISSION_ERROR_PATTERN" "$1"; then echo bug; else echo fixable; fi
}
