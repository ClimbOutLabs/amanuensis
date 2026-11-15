# shellcheck shell=bash
# Keeping this computer's key in its security chip (TPM 2.0), on Linux with systemd.
#
# Without this, the key is a file in a Docker volume on the same disk as the data it protects. With it, the disk
# holds only a copy of the key that the chip of this one computer can open. When the computer starts, a small
# systemd service opens that copy into memory (/run, never the disk), and the Docker volume the instances mount
# points there. A disk that is copied or taken out of the computer then opens nothing.
#
# Nothing here runs on its own: a person asks for it with "install.sh key chip" and can undo it with
# "install.sh key file". Each instance's recovery key keeps working either way.

# AMAN_CHIP_ROOT moves every host path under a folder, for tests.
CHIP_ROOT=${AMAN_CHIP_ROOT:-}
CHIP_KEY_BLOB=$CHIP_ROOT/etc/aman/master.key.cred
CHIP_KEY_UNIT=aman-key.service
CHIP_KEY_UNIT_FILE=$CHIP_ROOT/etc/systemd/system/$CHIP_KEY_UNIT
CHIP_KEY_TMPFILES=$CHIP_ROOT/etc/tmpfiles.d/aman-key.conf
CHIP_KEY_RUN_DIR=$CHIP_ROOT/run/aman-key
# The name the chip ties the copy to; a copy renamed or moved to another purpose does not open.
CHIP_KEY_NAME=aman-master-key
# The user the app runs as in its container, which is the only one that may read the key.
CHIP_KEY_OWNER=10001

# True when this computer can keep a key in its chip: Linux started by systemd, with a chip systemd can use.
chip_key_possible() {
  [ "$(uname -s)" = Linux ] || return 1
  command -v systemd-creds >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 || return 1
  [ -d "$CHIP_ROOT/run/systemd/system" ] || return 1
  # Docker Desktop keeps its volumes inside its own small computer, which cannot see this one's memory folder.
  case "$(D info --format '{{.OperatingSystem}}' 2>/dev/null)" in *"Docker Desktop"*) return 1 ;; esac
  systemd-creds has-tpm2 >/dev/null 2>&1
}

# True when the key volume already points at the copy opened in memory.
chip_key_active() {
  [ -f "$CHIP_KEY_BLOB" ] || return 1
  [ "$(D volume inspect --format '{{ index .Options "device" }}' "$MACHINE_KEY_VOLUME" 2>/dev/null)" = "$CHIP_KEY_RUN_DIR" ]
}

# The key volume as a window onto the folder in memory, instead of a place on the disk.
chip_key_volume_create() {
  D volume create --driver local --opt type=none --opt o=bind --opt "device=$CHIP_KEY_RUN_DIR" "$MACHINE_KEY_VOLUME" >/dev/null
}

chip_key_unit_text() {
  printf '%s\n' \
    '[Unit]' \
    "Description=Opens Aman's key from this computer's security chip into memory" \
    'Before=docker.service' \
    '' \
    '[Service]' \
    'Type=oneshot' \
    'RemainAfterExit=yes' \
    "LoadCredentialEncrypted=$CHIP_KEY_NAME:$CHIP_KEY_BLOB" \
    "ExecStart=/usr/bin/install -m 0400 -o $CHIP_KEY_OWNER -g $CHIP_KEY_OWNER \${CREDENTIALS_DIRECTORY}/$CHIP_KEY_NAME $CHIP_KEY_RUN_DIR/master.key" \
    "ExecStop=/bin/rm -f $CHIP_KEY_RUN_DIR/master.key" \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target'
}

# Stops every instance and removes its containers, so nothing holds the key volume. Data volumes are kept.
chip_key_instances_down() {
  local name
  for name in $(reg_names); do
    [ -f "$(instance_dir "$name")/compose.yaml" ] || continue
    dc "$name" down >/dev/null 2>&1 || return 1
  done
}

chip_key_instances_up() {
  local name failed=0
  for name in $(reg_names); do
    [ -f "$(instance_dir "$name")/compose.yaml" ] || continue
    instance_up "$name" || failed=1
  done
  return "$failed"
}

# Takes the chip's copy, the service and the folder in memory away again. Used to undo, and after a move that
# stopped half way.
chip_key_host_remove() {
  run_root sh -c "
systemctl disable --now $CHIP_KEY_UNIT >/dev/null 2>&1 || true
rm -f '$CHIP_KEY_UNIT_FILE' '$CHIP_KEY_TMPFILES' '$CHIP_KEY_BLOB' '$CHIP_KEY_BLOB.new' '$CHIP_KEY_RUN_DIR/master.key'
rmdir '$CHIP_KEY_RUN_DIR' 2>/dev/null || true
systemctl daemon-reload >/dev/null 2>&1 || true
"
}

# After the last instance and the key volume are gone, the chip's copy and its service go too. Without administrator
# rights at hand they stay, and the person is told the one command that removes them.
chip_key_forget() {
  [ -f "$CHIP_KEY_BLOB" ] || return 0
  if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then
    chip_key_host_remove && return 0
  fi
  warn "The copy of Aman's key in this computer's security chip was not removed, because that needs administrator rights." "Run: sudo sh -c 'systemctl disable --now $CHIP_KEY_UNIT; rm -f $CHIP_KEY_UNIT_FILE $CHIP_KEY_TMPFILES $CHIP_KEY_BLOB'"
}

# install.sh key chip
chip_key_move() {
  local image=$REL_APP_TAG before after
  if chip_key_active; then
    ui_ok "Aman's key is already kept in this computer's security chip."
    return 0
  fi
  chip_key_possible ||
    die "This computer has no security chip that Aman can use, so the key stays where it is. Turn on disk encryption for this computer instead: LUKS on Linux, FileVault on a Mac, BitLocker on Windows."
  docker_volume_exists "$MACHINE_KEY_VOLUME" ||
    die "This computer has no key for Aman yet, so there is nothing to move. Run install.sh first."
  before=$(D run --rm --network none -v "$MACHINE_KEY_VOLUME:/run/aman-key:ro" "$image" cat "$MACHINE_KEY_FILE" 2>/dev/null | sha256sum | cut -c1-64)
  [ "$before" != "$(printf '' | sha256sum | cut -c1-64)" ] ||
    die "This computer's key could not be read, so it was left where it is. Run: aman doctor"
  ui_line "This moves Aman's key into this computer's security chip. It needs administrator rights (sudo)."
  ui_line "It adds one small service that opens the key when the computer starts. Every instance stops for a moment."
  ui_confirm "Move the key now?" y || die "The key was left where it is. Nothing was changed."
  root_ready "the key was left where it is"

  step_begin chip-key "Moving this computer's key into its security chip"
  # The key goes from the volume straight into the chip's tool. It is never an argument and never a file on the host.
  # No start-up measurements are tied in, so a system update does not lock the key away; the chip itself still must
  # be this computer's.
  if ! D run --rm --network none -v "$MACHINE_KEY_VOLUME:/run/aman-key:ro" "$image" cat "$MACHINE_KEY_FILE" 2>/dev/null |
    run_root sh -c "
set -e
umask 077
install -d -m 0755 '$(dirname "$CHIP_KEY_BLOB")'
systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs= --name=$CHIP_KEY_NAME - '$CHIP_KEY_BLOB.new'
" >>"$STEP_LOG" 2>&1; then
    chip_key_host_remove
    step_fail "The security chip did not take the key, so the key was left where it is." "Run: aman doctor"
  fi
  # Only a copy the chip opens back to the same key replaces anything.
  after=$(run_root sh -c "systemd-creds decrypt --name=$CHIP_KEY_NAME '$CHIP_KEY_BLOB.new' -" 2>>"$STEP_LOG" | sha256sum | cut -c1-64)
  if [ "$after" != "$before" ]; then
    chip_key_host_remove
    step_fail "The security chip did not give the same key back, so the key was left where it is." "Run: aman doctor"
  fi
  if ! {
    chip_key_unit_text
  } | run_root sh -c "
set -e
mv '$CHIP_KEY_BLOB.new' '$CHIP_KEY_BLOB'
install -d -m 0755 '$(dirname "$CHIP_KEY_UNIT_FILE")' '$(dirname "$CHIP_KEY_TMPFILES")'
cat >'$CHIP_KEY_UNIT_FILE'
chmod 0644 '$CHIP_KEY_UNIT_FILE'
printf 'd %s 0755 root root -\n' '$CHIP_KEY_RUN_DIR' >'$CHIP_KEY_TMPFILES'
install -d -m 0755 '$CHIP_KEY_RUN_DIR'
systemctl daemon-reload
systemctl enable $CHIP_KEY_UNIT
systemctl restart $CHIP_KEY_UNIT
test -s '$CHIP_KEY_RUN_DIR/master.key'
" >>"$STEP_LOG" 2>&1; then
    chip_key_host_remove
    step_fail "The service that opens the key did not start, so the key was left where it is." "Run: aman doctor"
  fi
  # From here the instances are down until the volume is swapped. A failure puts the old volume's key back in use
  # simply by not removing it.
  if ! chip_key_instances_down; then
    chip_key_host_remove
    chip_key_instances_up || true
    step_fail "An instance did not stop, so the key was left where it is." "Run: aman doctor"
  fi
  if ! D run --rm --network none -v "$MACHINE_KEY_VOLUME:/run/aman-key" "$image" rm -f "$MACHINE_KEY_FILE" >>"$STEP_LOG" 2>&1 ||
    ! D volume rm "$MACHINE_KEY_VOLUME" >>"$STEP_LOG" 2>&1 || ! chip_key_volume_create >>"$STEP_LOG" 2>&1; then
    # The key is open in memory and the chip has its copy, so the old way is put back from there.
    chip_key_restore_file "$image" || true
    chip_key_instances_up || true
    step_fail "The key's place in Docker could not be changed, so the key was put back as a file." "Run: aman doctor"
  fi
  step_ok "This computer's key is kept in its security chip"
  log_event "machine key moved to the security chip"
  chip_key_instances_up || die "An instance did not start again. Run: aman doctor"
  ui_ok "Done. A copied or stolen disk can no longer open Aman's data. Your recovery keys still work."
}

# Puts the key back as a file in an ordinary Docker volume, from the copy open in memory, then removes the chip's
# copy and the service. Returns 1 when the key could not be written.
chip_key_restore_file() { # image
  local image=$1 want got
  [ -s "$CHIP_KEY_RUN_DIR/master.key" ] || run_root sh -c "systemctl restart $CHIP_KEY_UNIT" >/dev/null 2>&1 || true
  want=$(run_root sh -c "cat '$CHIP_KEY_RUN_DIR/master.key'" 2>/dev/null | sha256sum | cut -c1-64)
  [ "$want" != "$(printf '' | sha256sum | cut -c1-64)" ] || return 1
  D volume rm "$MACHINE_KEY_VOLUME" >/dev/null 2>&1 || true
  D volume create "$MACHINE_KEY_VOLUME" >/dev/null || return 1
  run_root sh -c "cat '$CHIP_KEY_RUN_DIR/master.key'" 2>/dev/null |
    D run --rm -i --network none -v "$MACHINE_KEY_VOLUME:/run/aman-key" "$image" sh -c "umask 077 && cat >$MACHINE_KEY_FILE" || return 1
  got=$(D run --rm --network none -v "$MACHINE_KEY_VOLUME:/run/aman-key:ro" "$image" cat "$MACHINE_KEY_FILE" 2>/dev/null | sha256sum | cut -c1-64)
  [ "$got" = "$want" ] || return 1
  chip_key_host_remove
}

# install.sh key file
chip_key_undo() {
  local image=$REL_APP_TAG
  if ! chip_key_active; then
    ui_ok "Aman's key is already kept as a file on this computer."
    return 0
  fi
  ui_line "This takes Aman's key out of this computer's security chip and keeps it as a file on the disk again."
  ui_line "It needs administrator rights (sudo). Every instance stops for a moment."
  ui_confirm "Move the key back to a file now?" n || die "The key was left in the security chip. Nothing was changed."
  root_ready "the key was left in the security chip"
  step_begin chip-key "Moving this computer's key back to a file"
  chip_key_instances_down || {
    chip_key_instances_up || true
    step_fail "An instance did not stop, so the key was left in the security chip." "Run: aman doctor"
  }
  if ! chip_key_restore_file "$image" >>"$STEP_LOG" 2>&1; then
    # Nothing of the chip's was removed, so its volume is put back and the instances start as before.
    D volume rm "$MACHINE_KEY_VOLUME" >/dev/null 2>&1 || true
    chip_key_volume_create >>"$STEP_LOG" 2>&1 || true
    chip_key_instances_up || true
    step_fail "The key could not be written as a file, so it was left in the security chip." "Run: aman doctor"
  fi
  step_ok "This computer's key is kept as a file again"
  log_event "machine key moved back to a file"
  chip_key_instances_up || die "An instance did not start again. Run: aman doctor"
  if ! disk_encryption_on; then
    warn "This computer's key is kept in a file on this disk. Without disk encryption, a lost or stolen computer can be read." "Turn on disk encryption for this computer: FileVault on a Mac, BitLocker on Windows, LUKS on Linux."
  fi
}

cmd_key() {
  case "$SUBCOMMAND" in
    chip | file) ;;
    *) usage_die "usage: install.sh key chip|file" ;;
  esac
  require_installed
  docker_prepare
  lock_acquire
  load_installed_release
  if [ "$SUBCOMMAND" = chip ]; then chip_key_move; else chip_key_undo; fi
}
