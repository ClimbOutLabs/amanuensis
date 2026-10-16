# shellcheck shell=bash
# Small helpers with one owner for the installer and the doctor.

SANDBOX_NODE_MAJOR=22
SANDBOX_NODE_MINOR=14

# ASCII only: a Turkish locale would turn I into a dotless i and break comparisons with plain words.
lowercase() { printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]'; }

# True when the Node.js on this computer is new enough to run the sandbox setup.
sandbox_node_ok() {
  local v major minor
  command -v node >/dev/null 2>&1 || return 1
  v=$(node --version 2>/dev/null) || return 1
  v=${v#v}
  major=${v%%.*}
  minor=${v#*.}
  minor=${minor%%.*}
  case "$major$minor" in '' | *[![:digit:]]*) return 1 ;; esac
  [ "$major" -gt "$SANDBOX_NODE_MAJOR" ] || { [ "$major" -eq "$SANDBOX_NODE_MAJOR" ] && [ "$minor" -ge "$SANDBOX_NODE_MINOR" ]; }
}

# ---- the folder the installer runs from -------------------------------------------------------------------------
# aman backup, aman upgrade and the daily job run the installer of the folder Aman was installed from, often with more
# rights than the person has otherwise, so that folder must be changeable by its owner alone.

checkout_has_links() { # dir: a link in the folder's installer could point at a file anyone can change
  [ -L "$1" ] || [ -L "$1/installer" ] || [ -n "$(find "$1/installer" -type l -print -quit 2>/dev/null)" ]
}

checkout_writable_by_others() { # dir
  [ -n "$(find "$1" "$1/installer" -maxdepth 0 \( -perm -g+w -o -perm -o+w \) -print 2>/dev/null)" ] ||
    [ -n "$(find "$1/installer" ! -type l \( -perm -g+w -o -perm -o+w \) -print -quit 2>/dev/null)" ]
}

# Every folder above it decides who can swap it for another, with links resolved; a sticky one (like /tmp) lets only an
# owner do that.
checkout_parent_writable() { # dir
  local dir
  dir=$(cd -P -- "$1" 2>/dev/null && pwd -P) || return 1
  while [ "$dir" != / ]; do
    dir=$(dirname "$dir")
    if [ -n "$(find "$dir" -maxdepth 0 \( -perm -g+w -o -perm -o+w \) ! -perm -1000 -print 2>/dev/null)" ]; then return 0; fi
  done
  return 1
}

checkout_owned_by_other() { # dir
  local me
  me=$(id -u)
  [ -n "$(find "$1" "$1/installer" -maxdepth 0 ! -uid "$me" ! -uid 0 -print 2>/dev/null)" ] ||
    [ -n "$(find "$1/installer" ! -uid "$me" ! -uid 0 -print -quit 2>/dev/null)" ]
}

# What makes the installer in that folder unsafe to run, one word, or nothing (status 1) when it is fine.
checkout_problem() { # dir
  if checkout_has_links "$1"; then
    printf links
  elif checkout_writable_by_others "$1"; then
    printf writable
  elif checkout_parent_writable "$1"; then
    printf parent
  elif checkout_owned_by_other "$1"; then
    printf owner
  else
    return 1
  fi
}

# "sentence|fix" for a problem word of checkout_problem.
checkout_problem_words() {
  case "$1" in
    links) printf 'The installer of the folder Aman was installed from contains links, so Aman will not run it.|Copy the folder to one of yours and run install.sh from there.' ;;
    writable) printf 'The folder Aman was installed from can be changed by other users, so Aman will not run its installer from it.|Run aman doctor checkout --fix' ;;
    parent) printf 'A folder above the folder Aman was installed from can be changed by other users, so Aman will not run its installer from it.|Move the folder to one only you can change, such as one inside your home folder, then run install.sh from there.' ;;
    *) printf 'The folder Aman was installed from belongs to another user, so Aman will not run its installer from it.|Copy it to a folder of yours and run install.sh from there.' ;;
  esac
}

# Takes the right to change the installer from everyone but its owner: the folder and everything in its installer. It
# never changes a folder above it, which is not Aman's to change, and never touches an installer that holds links. Succeeds
# only when something changed.
tighten_checkout() { # dir
  local dir=$1
  if checkout_has_links "$dir" || ! checkout_writable_by_others "$dir"; then return 1; fi
  chmod go-w "$dir" 2>/dev/null || true
  chmod -R go-w "$dir/installer" 2>/dev/null || true
}
