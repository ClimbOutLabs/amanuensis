#!/bin/sh
# Backs each sandbox slot's workspace with its own fixed-size ext4 disk file, so a runaway program can fill
# its slot's disk and nothing else. Run as root by `pnpm sandbox:slots --fix` after the user agrees.
#   setup-disks.sh setup  <dir> <size_gb> <count>
#   setup-disks.sh remove <dir> <count>
# Safe to run again: existing disks are kept and only the missing steps are done.
set -eu

# The slot user owns the disks' root directories.
SLOT_OWNER=65532:65532
FSTAB="${AMAN_SLOTS_FSTAB:-/etc/fstab}"

fail() {
  echo "setup-disks: $*" >&2
  exit 1
}

mode="${1:-}"
dir="${2:-}"
case "$mode" in
  setup) size_gb="${3:-}"; count="${4:-}" ;;
  remove) size_gb=""; count="${3:-}" ;;
  *) fail "usage: setup-disks.sh setup <dir> <size_gb> <count> | remove <dir> <count>" ;;
esac

case "$dir" in
  /*) ;;
  *) fail "the directory must be an absolute path" ;;
esac
case "$dir" in
  *..*|*[!A-Za-z0-9._/-]*) fail "the directory may only contain letters, digits and . _ / -" ;;
esac
case "$count" in
  ''|*[!0-9]*) fail "the slot count must be a number" ;;
esac
[ "$count" -ge 1 ] && [ "$count" -le 16 ] || fail "the slot count must be 1 to 16"
if [ "$mode" = setup ]; then
  case "$size_gb" in
    ''|*[!0-9]*) fail "the size must be a whole number of GB" ;;
  esac
  [ "$size_gb" -ge 1 ] && [ "$size_gb" -le 512 ] || fail "the size must be 1 to 512 GB"
fi
[ "$(id -u)" = 0 ] || fail "this must run as root"

if [ "$mode" = remove ]; then
  i=1
  while [ "$i" -le "$count" ]; do
    img="$dir/ws-$i.img"
    mp="$dir/ws-$i"
    if mountpoint -q "$mp" 2>/dev/null; then
      umount "$mp"
    fi
    # Drop the fstab line and the comment above it.
    if [ -f "$FSTAB" ] && grep -qF "$img " "$FSTAB"; then
      tmp="$(mktemp)"
      grep -vF -e "$img " -e "# aman-sandbox-slots: $img" "$FSTAB" > "$tmp" || true
      cat "$tmp" > "$FSTAB"
      rm -f "$tmp"
    fi
    rm -f "$img"
    rmdir "$mp" 2>/dev/null || true
    i=$((i + 1))
  done
  rmdir "$dir" 2>/dev/null || true
  exit 0
fi

command -v mkfs.ext4 >/dev/null 2>&1 || fail "mkfs.ext4 is missing (install e2fsprogs)"
mkdir -p "$dir"
chmod 755 "$dir"
# One slot filling its whole disk must not be able to fill the host: require room for a single disk.
avail_kb="$(df -Pk "$dir" | awk 'NR==2 {print $4}')"
[ "$avail_kb" -ge $((size_gb * 1024 * 1024)) ] || fail "less than $size_gb GB is free under $dir; choose a smaller --disk-gb or free some space"

i=1
while [ "$i" -le "$count" ]; do
  img="$dir/ws-$i.img"
  mp="$dir/ws-$i"
  mkdir -p "$mp"
  if [ ! -f "$img" ]; then
    # Sparse: the file takes real space only as the slot writes, and gives it back through discard when files
    # are deleted. No reserved blocks, since the slot user is not root.
    truncate -s "${size_gb}G" "$img"
    mkfs.ext4 -q -F -m 0 -L "aman-ws-$i" \
      -E "root_owner=$SLOT_OWNER,lazy_itable_init=1,lazy_journal_init=1" "$img" ||
      { rm -f "$img"; fail "mkfs.ext4 failed for $img"; }
  fi
  chmod 600 "$img"
  if ! grep -qF "$img " "$FSTAB" 2>/dev/null; then
    {
      echo "# aman-sandbox-slots: $img"
      echo "$img $mp ext4 loop,discard,nofail,nodev,nosuid,x-systemd.before=docker.service 0 0"
    } >> "$FSTAB"
  fi
  if ! mountpoint -q "$mp"; then
    mount -t ext4 -o loop,discard,nodev,nosuid "$img" "$mp" || fail "mounting $img failed"
  fi
  i=$((i + 1))
done
if command -v systemctl >/dev/null 2>&1 && [ "$FSTAB" = /etc/fstab ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
