#!/usr/bin/env bash
# Keeping this computer's key in its security chip: asked for by hand, checked before anything is replaced, undone
# by hand, and never done on a computer that cannot.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

BLOB=etc/aman/master.key.cred
UNIT=etc/systemd/system/aman-key.service

key_volume_device() { sed -n 's/^aman_key //p' "$SB_STATE/volume_devices" 2>/dev/null | tail -n 1; }

test_the_key_moves_into_the_chip() {
  t_begin "key chip seals the key with the chip, opens it in memory, points the volume there and starts the instance again"
  sandbox_new
  fixture_security_chip
  install_machine
  assert_flat_contains "$OUT$ERR" "This computer has a security chip that can hold the key instead."
  assert_flat_contains "$OUT$ERR" "Run: install.sh key chip"
  assert_no_path "$CHIP/$BLOB" "install alone never touches the chip"
  local key
  key=$(cat "$SB_STATE/key")
  : >"$STUB_LOG"
  run_install --yes key chip
  assert_rc 0
  assert_flat_contains "$OUT" "A copied or stolen disk can no longer open Aman's data. Your recovery keys still work."
  assert_file "$CHIP/$BLOB"
  assert_not_contains "$(cat "$CHIP/$BLOB")" "$key" "the file on disk is not the key"
  assert_eq "$(cat "$CHIP/run/aman-key/master.key")" "$key" "the key is open in memory"
  assert_eq "$(key_volume_device)" "$CHIP/run/aman-key" "the volume points at the folder in memory"
  assert_eq "$(cat "$SB_STATE/key")" "$key" "the instance sees the same key"
  assert_contains "$(cat "$CHIP/$UNIT")" "LoadCredentialEncrypted=aman-master-key:$CHIP/$BLOB"
  assert_contains "$(cat "$CHIP/$UNIT")" "Before=docker.service" "the key is open before Docker starts the instances"
  assert_contains "$(cat "$CHIP/etc/tmpfiles.d/aman-key.conf")" "d $CHIP/run/aman-key 0755 root root -"
  assert_log_has "stub-systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs= --name=aman-master-key"
  assert_log_has "stub-systemctl enable aman-key.service"
  assert_eq "$(grep -n 'aman-main.* down\|volume rm aman_key\|aman-main.* up -d' "$STUB_LOG" | sed 's/^[0-9]*://' | awk '/ down/ {print "down"} /volume rm/ {print "rm"} / up -d/ {print "up"}' | tr '\n' ' ')" "down rm up " "stopped, swapped, started"
  assert_not_contains "$(cat "$STUB_LOG")" "$key" "the key was never an argument"
  assert_not_contains "$OUT$ERR" "$key"
  assert_tree_lacks "$AMAN_HOME" "$key"
  run_install --yes key chip
  assert_rc 0
  assert_flat_contains "$OUT" "Aman's key is already kept in this computer's security chip."
  sandbox_drop
}

test_a_later_run_keeps_the_chip() {
  t_begin "an upgrade and a new instance keep using the key from the chip, and a backup still opens"
  sandbox_new
  fixture_security_chip
  install_machine
  run_install --yes key chip
  assert_rc 0
  local key
  key=$(cat "$SB_STATE/key")
  repo_commit_change "app change"
  run_install upgrade
  assert_rc 0
  assert_eq "$(key_volume_device)" "$CHIP/run/aman-key"
  assert_eq "$(cat "$SB_STATE/key")" "$key"
  run_install --yes backup
  assert_rc 0
  sandbox_drop
}

test_a_computer_without_a_chip_is_left_alone() {
  t_begin "key chip changes nothing on a computer without a usable chip and says what to do instead"
  sandbox_new
  install_machine
  run_install --yes key chip
  assert_rc 1
  assert_flat_contains "$ERR" "This computer has no security chip that Aman can use, so the key stays where it is. Turn on disk encryption for this computer instead"
  sandbox_drop
  sandbox_new
  fixture_security_chip
  install_machine
  STUB_CHIP_MISSING=1 run_install --yes key chip
  assert_rc 1
  assert_no_path "$CHIP/$BLOB"
  assert_eq "$(key_volume_device)" "" "the volume is as it was"
  assert_log_lacks "sudo sh"
  sandbox_drop
}

test_a_chip_that_fails_leaves_the_key_as_a_file() {
  t_begin "a chip that refuses the key, gives another back, or a service that does not start leaves the key file in use"
  local fault key
  for fault in STUB_CHIP_REFUSES STUB_CHIP_GARBLES STUB_CHIP_UNIT_FAILS; do
    sandbox_new
    fixture_security_chip
    install_machine
    key=$(cat "$SB_STATE/key")
    export "$fault=1"
    run_install --yes key chip
    unset "$fault"
    assert_rc 1
    assert_flat_contains "$ERR" "so the key was left where it is"
    assert_no_path "$CHIP/$BLOB"
    assert_no_path "$CHIP/$BLOB.new"
    assert_no_path "$CHIP/$UNIT"
    assert_no_path "$CHIP/run/aman-key/master.key"
    assert_eq "$(cat "$SB_STATE/key")" "$key" "$fault: the key file is untouched"
    assert_eq "$(key_volume_device)" "" "$fault: the volume is as it was"
    assert_log_lacks " down"
    sandbox_drop
  done
}

test_a_volume_that_cannot_be_swapped_puts_the_file_back() {
  t_begin "when Docker will not point the volume at memory, the key goes back to a file and the instance starts"
  sandbox_new
  fixture_security_chip
  install_machine
  local key
  key=$(cat "$SB_STATE/key")
  : >"$STUB_LOG"
  STUB_VOLUME_CREATE_FAIL=1 run_install --yes key chip
  assert_rc 1
  assert_flat_contains "$ERR" "so the key was put back as a file"
  assert_eq "$(cat "$SB_STATE/key")" "$key"
  assert_eq "$(key_volume_device)" ""
  assert_no_path "$CHIP/$BLOB"
  assert_no_path "$CHIP/$UNIT"
  assert_log_has "up -d"
  sandbox_drop
}

test_the_key_moves_back_to_a_file() {
  t_begin "key file takes the key out of the chip, keeps the same key and removes the service"
  sandbox_new
  fixture_security_chip
  install_machine
  local key
  key=$(cat "$SB_STATE/key")
  run_install --yes key chip
  assert_rc 0
  # --yes alone never takes the key out of the chip: the question's own answer is no.
  run_install --yes key file
  assert_rc 1
  assert_file "$CHIP/$BLOB"
  run_install_tty "*Move the key back to a file now?=>y" key file
  assert_rc 0
  assert_eq "$(cat "$SB_STATE/key")" "$key"
  assert_eq "$(key_volume_device)" ""
  assert_no_path "$CHIP/$BLOB"
  assert_no_path "$CHIP/$UNIT"
  assert_no_path "$CHIP/run/aman-key"
  assert_flat_contains "$OUT" "Without disk encryption, a lost or stolen computer can be read."
  run_install --yes key file
  assert_rc 0
  assert_flat_contains "$OUT" "Aman's key is already kept as a file on this computer."
  sandbox_drop
}

test_removing_the_last_instance_removes_the_chip_copy() {
  t_begin "purging the last instance removes the chip's copy and its service with the key"
  sandbox_new
  fixture_security_chip
  install_machine
  run_install --yes key chip
  assert_rc 0
  run_install --yes instance remove main --purge-data --confirm-name main
  assert_rc 0
  assert_no_path "$CHIP/$BLOB"
  assert_no_path "$CHIP/$UNIT"
  assert_not_contains "$(cat "$SB_STATE/volumes")" "aman_key"
  sandbox_drop
}

test_the_key_moves_into_the_chip
test_a_later_run_keeps_the_chip
test_a_computer_without_a_chip_is_left_alone
test_a_chip_that_fails_leaves_the_key_as_a_file
test_a_volume_that_cannot_be_swapped_puts_the_file_back
test_the_key_moves_back_to_a_file
test_removing_the_last_instance_removes_the_chip_copy
tests_finish
