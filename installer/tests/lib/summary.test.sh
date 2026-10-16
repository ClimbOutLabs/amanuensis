#!/usr/bin/env bash
# The ending of an install: one compact table per instance, the doctor's one line or only its problems, and the
# command to upgrade later. Each case is compared with the exact text a person sees.
set -euo pipefail
# shellcheck source=../helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../helpers.sh"

# From the doctor's phase on, with this run's paths replaced and the elapsed time (which varies) dropped.
ending() {
  printf '%s\n' "$OUT" | sed -n '/^Checking the result/,$p' |
    sed "s|$SB_INSTALLER|<checkout>/installer|g; s|$AMAN_HOME|<home>|g" |
    sed -E 's/([0-9A-F]{2}:){31}[0-9A-F]{2}/<fingerprint>/g' |
    awk '/^$/ { held = 1; next } /^Done in / { held = 0; next } { if (held) print ""; held = 0; print }'
}

TF_KEY=tf-key-0123456789abcdef

test_fresh_install_without_a_model() {
  t_begin "the ending of a fresh install with no model: the table with the nearest addresses first, the model as a next step, the daily backup and the update line"
  sandbox_new
  fixture_network 192.168.1.20
  fixture_hostname spark
  install_machine
  assert_eq "$(ending)" "$(cat <<'SNAP'
Checking the result (6 of 6)
  + All 16 checks passed

------------------------------------------------------------------------
Ready. Instance main is running.

  + Open      https://192.168.1.20:8443
              https://spark.local:8443
              https://spark:8443
              http://127.0.0.1:8791
              http://localhost:8791
  + Sign in   owner@example.invalid
  > Model     not set: add one in Settings > Models
  + Run code  on, in a sandbox
  + Data      saved in Docker
  + Backups   daily, keeps the last 7
  Trust this computer on each device: http://192.168.1.20:8791/trust
  On an iPhone, open it in Safari, install the profile, then turn it on
  in Settings, General, About, Certificate Trust Settings.
  Before you trust it, check that the fingerprint your device shows is
  <fingerprint>.
  If it differs, stop.
  Bookmark spark.local: it keeps working when this computer's address
  changes.
  Open a new terminal window to use the aman command.
  Update later: aman upgrade
------------------------------------------------------------------------
SNAP
)"
  sandbox_drop
}

test_fresh_install_without_a_model_over_plain_http() {
  t_begin "the ending with --tls off, over plain http: the table with the nearest addresses first, the model as a next step, the daily backup and the update line"
  sandbox_new
  fixture_network 192.168.1.20
  fixture_hostname spark
  INSTALL_EXTRA=(--tls off)
  install_machine
  assert_eq "$(ending)" "$(cat <<'SNAP'
Checking the result (6 of 6)
  + All 16 checks passed

------------------------------------------------------------------------
Ready. Instance main is running.

  + Open      http://192.168.1.20:8791
              http://spark.local:8791
              http://spark:8791
              http://127.0.0.1:8791
              http://localhost:8791
  + Sign in   owner@example.invalid
  > Model     not set: add one in Settings > Models
  + Run code  on, in a sandbox
  + Data      saved in Docker
  + Backups   daily, keeps the last 7
  Sign-in on your home network is not encrypted. Leave out --tls off to
  use https.
  Bookmark spark.local: it keeps working when this computer's address
  changes.
  Open a new terminal window to use the aman command.
  Update later: aman upgrade
------------------------------------------------------------------------
SNAP
)"
  sandbox_drop
}

test_install_with_token_factory() {
  t_begin "the ending with Token Factory: the model row is done, with the daily limit"
  sandbox_new
  fixture_network 192.168.1.20
  with_input "$SENTINEL_PASSWORD
$TF_KEY
"
  run_install --yes --password-stdin --token-factory-key-stdin --token-factory-daily-cap 500000 --email owner@example.invalid --local-only
  clear_input
  assert_rc 0
  assert_eq "$(ending)" "$(cat <<'SNAP'
Checking the result (6 of 6)
  + All 16 checks passed

------------------------------------------------------------------------
Ready. Instance main is running.

  + Open      http://127.0.0.1:8791
  + Sign in   owner@example.invalid
  + Model     Token Factory, nvidia/nemotron-3-super-120b-a12b, limit
              500000 tokens a day
  + Run code  on, in a sandbox
  + Data      saved in Docker
  + Backups   daily, keeps the last 7
  Open a new terminal window to use the aman command.
  Update later: aman upgrade
------------------------------------------------------------------------
SNAP
)"
  sandbox_drop
}

test_install_with_a_problem() {
  t_begin "the ending with a doctor problem and a sandbox that is not ready: only the problems, once each"
  sandbox_new
  STUB_DOCTOR_EXIT=1
  STUB_SANDBOX_DOCTOR_EXIT=1
  with_input "$SENTINEL_PASSWORD
"
  run_install --yes --password-stdin --email owner@example.invalid --local-only
  clear_input
  assert_eq "$(ending)" "$(cat <<'SNAP'
Checking the result (6 of 6)
  Instance main
  x Port 5556 is already in use by another program.
    Next: Run aman doctor instance --fix
  15 other checks passed. Full report: aman doctor

------------------------------------------------------------------------
Running, but the checks found a problem (listed above).

  + Open      http://127.0.0.1:8791
  + Sign in   owner@example.invalid
  > Model     not set: add one in Settings > Models
  ! Run code  not ready: aman doctor sandbox --fix
  + Data      saved in Docker
  + Backups   daily, keeps the last 7
  Open a new terminal window to use the aman command.
  Update later: aman upgrade
------------------------------------------------------------------------
SNAP
)"
  sandbox_drop
}

test_fresh_install_without_a_model
test_fresh_install_without_a_model_over_plain_http
test_install_with_token_factory
test_install_with_a_problem
tests_finish
