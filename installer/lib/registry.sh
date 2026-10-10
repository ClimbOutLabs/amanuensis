# shellcheck shell=bash
# Instance registry: one key=value file per instance under state/instances. Holds no secrets.

reg_file() { printf '%s/%s.conf' "$REG_DIR" "$1"; }
reg_exists() { [ -f "$(reg_file "$1")" ]; }

reg_names() {
  local f
  [ -d "$REG_DIR" ] || return 0
  for f in "$REG_DIR"/*.conf; do
    [ -e "$f" ] || continue
    basename "$f" .conf
  done | sort
}

reg_get() {
  sed -n "s/^$2=//p" "$(reg_file "$1")" | head -n 1
}

# reg_write NAME key=value...
reg_write() {
  local name=$1 pair
  shift
  ensure_private_dir "$REG_DIR"
  {
    for pair in "$@"; do
      printf '%s\n' "$pair"
    done
  } | write_if_changed "$(reg_file "$name")" 600 || true
}

reg_remove() { rm -f "$(reg_file "$1")"; }

# Space-separated values of one key across all instances, optionally skipping one instance.
reg_all() {
  local key=$1 skip=${2:-} name out=
  for name in $(reg_names); do
    [ "$name" = "$skip" ] && continue
    out="$out $(reg_get "$name" "$key")"
  done
  printf '%s' "$out"
}
