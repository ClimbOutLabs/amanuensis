#!/usr/bin/env bash
# Random secrets and password hashing.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

in_lib() {
  PATH=$SB_BIN "$SB_BIN/bash" -c ". '$INSTALLER_DIR/lib/common.sh'; . '$INSTALLER_DIR/lib/secrets.sh'; $1"
}

test_random_secrets() {
  t_begin "random secrets are hex of the requested size and differ per call"
  sandbox_new
  local a b
  a=$(in_lib 'rand_hex 32')
  b=$(in_lib 'rand_hex 32')
  assert_eq "${#a}" 64 "length"
  if printf '%s' "$a" | grep -Eq '^[0-9a-f]{64}$'; then t_pass; else t_fail "not hex: $a"; fi
  if [ "$a" != "$b" ]; then t_pass; else t_fail "two secrets identical"; fi
  sandbox_drop
}

test_hash_parsing() {
  t_begin "the hash is read from JSON or plain output and validated as bcrypt"
  sandbox_new
  local good="\$2a\$10\$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXY01"
  local out
  out=$(in_lib "D() { cat >/dev/null; echo '{\"hash\":\"$good\"}'; }; AMAN_PASSWORD=x; hash_password img")
  assert_eq "$out" "$good" "json"
  out=$(in_lib "D() { cat >/dev/null; echo '$good'; }; AMAN_PASSWORD=x; hash_password img")
  assert_eq "$out" "$good" "plain"
  if in_lib "D() { cat >/dev/null; echo 'not-a-hash'; }; AMAN_PASSWORD=x; hash_password img" >/dev/null 2>&1; then
    t_fail "garbage accepted"
  else
    t_pass
  fi
  if in_lib "D() { cat >/dev/null; return 1; }; AMAN_PASSWORD=x; hash_password img" >/dev/null 2>&1; then
    t_fail "failed hashing accepted"
  else
    t_pass
  fi
  sandbox_drop
}

test_random_secrets
test_hash_parsing
tests_finish
