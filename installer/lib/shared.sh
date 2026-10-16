# shellcheck shell=bash
# Small helpers with one owner for the installer and the doctor.

SANDBOX_NODE_MAJOR=22
SANDBOX_NODE_MINOR=14

lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# True when the Node.js on this computer is new enough to run the sandbox setup.
sandbox_node_ok() {
  local v major minor
  command -v node >/dev/null 2>&1 || return 1
  v=$(node --version 2>/dev/null) || return 1
  v=${v#v}
  major=${v%%.*}
  minor=${v#*.}
  minor=${minor%%.*}
  case "$major$minor" in '' | *[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$SANDBOX_NODE_MAJOR" ] || { [ "$major" -eq "$SANDBOX_NODE_MAJOR" ] && [ "$minor" -ge "$SANDBOX_NODE_MINOR" ]; }
}
