#!/usr/bin/env bash
# Prints "registry-name source-id" for each Aman image this checkout builds, the same ids the installer looks for.
# Release CI tags the images it publishes with these ids, so the installer can tell a published image matches.
set -euo pipefail

INSTALLER_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=${1:-$(cd -P -- "$INSTALLER_DIR/.." && pwd)}
export REPO_ROOT
# shellcheck source=lib/common.sh
. "$INSTALLER_DIR/lib/common.sh"
# shellcheck source=lib/release.sh
. "$INSTALLER_DIR/lib/release.sh"

app=$(checkout_app_tag)
printf 'aman-app %s\n' "${app#aman-app:}"
printf 'aman-stt %s\n' "$(source_id ops/aman-stt)"
printf 'aman-tts %s\n' "$(source_id ops/aman-tts)"
printf 'aman-calendar-caldav %s\n' "$(source_id ops/calendar-sidecar)"
printf 'aman-browser %s\n' "$(source_id ops/browser-sidecar)"
printf 'aman-browser-gateway %s\n' "$(source_id ops/browser-sidecar)"
