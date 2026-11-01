#!/bin/sh
# Backs each sandbox slot's workspace with its own fixed-size ext4 disk file, so a runaway program can fill
# its slot's disk and nothing else. Run as root by `pnpm sandbox:slots --fix` after the user agrees.
#   setup-disks.sh setup  <dir> <size_gb> <count>
#   setup-disks.sh remove <dir> <count>
#   setup-disks.sh retire <dir> <keep>    removes the disks of slots past <keep> that an older install made
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
  remove | retire) size_gb=""; count="${3:-}" ;;
  *) fail "usage: setup-disks.sh setup <dir> <size_gb> <count> | remove <dir> <count> | retire <dir> <keep>" ;;
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

# fstab is replaced as a whole, from a temporary file beside it, so a failure never leaves half a file.
write_fstab() {
  tmp="$(mktemp "$(dirname "$FSTAB")/.fstab.XXXXXX")"
  cat > "$tmp"
  if [ -e "$FSTAB" ]; then
    chmod --reference="$FSTAB" "$tmp"
  else
    chmod 644 "$tmp"
  fi
  mv "$tmp" "$FSTAB"
}

has_fstab_line() {
  [ -f "$FSTAB" ] && awk -v img="$1" '$1 == img { found = 1 } END { exit !found }' "$FSTAB"
}

# Unmounts, unlists and deletes the disk of slot $1.
remove_disk() {
  img="$dir/ws-$1.img"
  mp="$dir/ws-$1"
  # Unmount only what this script mounted: the mount's device must be a loop device backed by our image.
  if mountpoint -q "$mp" 2>/dev/null; then
    source_dev="$(findmnt -n -o SOURCE --mountpoint "$mp")"
    if losetup -n -O NAME -j "$img" 2>/dev/null | grep -qx "$source_dev"; then
      umount "$mp"
    else
      echo "setup-disks: $mp is mounted from something else; leaving it alone" >&2
    fi
  fi
  # Drop exactly our fstab line and the comment above it.
  if has_fstab_line "$img"; then
    awk -v img="$img" '$1 != img && $0 != "# aman-sandbox-slots: " img' "$FSTAB" | write_fstab
  fi
  rm -f "$img"
  rmdir "$mp" 2>/dev/null || true
}

if [ "$mode" = remove ]; then
  i=1
  while [ "$i" -le "$count" ]; do
    remove_disk "$i"
    i=$((i + 1))
  done
  rmdir "$dir" 2>/dev/null || true
  exit 0
fi

if [ "$mode" = retire ]; then
  i=$((count + 1))
  while [ "$i" -le 16 ]; do
    remove_disk "$i"
    i=$((i + 1))
  done
  exit 0
fi

command -v mkfs.ext4 >/dev/null 2>&1 || fail "mkfs.ext4 is missing (install e2fsprogs)"
mkdir -p "$dir"
chmod 755 "$dir"

# Every disk may fill completely, so there must be room for all of them to: what each could still grow by.
# This is checked on every run, not only the first, because other things on the machine use the space too.
avail_kb="$(df -Pk "$dir" | awk 'NR==2 {print $4}')"
need_kb=0
i=1
while [ "$i" -le "$count" ]; do
  img="$dir/ws-$i.img"
  if [ -f "$img" ]; then
    apparent_kb=$(($(stat -c %s "$img") / 1024))
    used_kb="$(du -k "$img" | cut -f 1)"
    grow_kb=$((apparent_kb - used_kb))
    [ "$grow_kb" -gt 0 ] || grow_kb=0
    need_kb=$((need_kb + grow_kb))
  else
    need_kb=$((need_kb + size_gb * 1024 * 1024))
  fi
  i=$((i + 1))
done
[ "$avail_kb" -ge "$need_kb" ] ||
  fail "$((need_kb / 1024 / 1024)) GB must be free under $dir so every slot disk can fill, but only $((avail_kb / 1024 / 1024)) GB is; choose a smaller --disk-gb or free some space"

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
  if ! has_fstab_line "$img"; then
    {
      if [ -f "$FSTAB" ]; then cat "$FSTAB"; fi
      echo "# aman-sandbox-slots: $img"
      echo "$img $mp ext4 loop,discard,nofail,nodev,nosuid,x-systemd.before=docker.service 0 0"
    } | write_fstab
  fi
  if ! mountpoint -q "$mp"; then
    mount -t ext4 -o loop,discard,nodev,nosuid "$img" "$mp" || fail "mounting $img failed"
  fi
  i=$((i + 1))
done
if command -v systemctl >/dev/null 2>&1 && [ "$FSTAB" = /etc/fstab ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
