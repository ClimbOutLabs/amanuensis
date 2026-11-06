#!/usr/bin/env bash
# Smoke check for the setup image: proves the image can run the shell
# installer before anyone publishes or pins it.
#
#   smoke.sh IMAGE
#
# IMAGE is a local tag or a registry reference. Two checks run:
#
#   1. The installer itself, executed the way the Windows installer
#      executes it: the file installer/install.sh as the container's
#      command, from a mounted copy of the installer folder, asking for
#      its help text. That is the run that died with "env: can't
#      execute 'bash'" before this image existed, so it is the run this
#      check exists to prove. --help changes nothing, and the mount is
#      a throwaway copy, so the check writes nowhere.
#
#   2. Every outside tool installer/install.sh and installer/lib/*.sh
#      call, looked up inside the image by name, plus "docker compose
#      version" for the Compose plugin the scripts drive. The list is
#      the traced call set; the Dockerfile names where each entry comes
#      from. A tool that goes missing when the base image changes
#      fails here, at publish time, not on a person's computer.
set -euo pipefail

IMAGE=${1:-}
if [ -z "$IMAGE" ]; then
  echo "Say which image to check, for example: $0 ghcr.io/climboutlabs/aman-setup:latest" >&2
  exit 2
fi

SETUP_IMAGE_DIR=$(cd "$(dirname "$0")" && pwd)
INSTALLER_DIR=$(dirname "$SETUP_IMAGE_DIR")

fail() {
  echo "Setup image check failed: $1" >&2
  echo "Next step: $2" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 ||
  fail "Docker is not on this computer, so the image cannot be checked." \
    "Install Docker, start it, then run this check again."

docker image inspect "$IMAGE" >/dev/null 2>&1 ||
  fail "Docker does not have the image $IMAGE." \
    "Build it first (publish.sh does), or pull it, then run this check again."

# Check 1: the installer runs in the image, through its own first line.
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
cp -a "$INSTALLER_DIR/." "$SCRATCH/"
HELP_OUT=$(docker run --rm -v "$SCRATCH:/src" -w /src "$IMAGE" installer/install.sh --help 2>&1) ||
  fail "installer/install.sh did not run in $IMAGE. Its output was: $HELP_OUT" \
    "Read the output above; the usual cause is a tool the base image does not carry. Add its Alpine package to the Dockerfile, rebuild, and check again."
case "$HELP_OUT" in
  *"Amanuensis installer"*) ;;
  *)
    fail "installer/install.sh ran but did not print its help text. Its output was: $HELP_OUT" \
      "Run the same command by hand in the image and see where it stops."
    ;;
esac
echo "The shell installer runs in $IMAGE and prints its help text."

# Check 2: every outside tool the scripts call is in the image.
TOOLS=(bash python3 curl ip getconf getent docker git tar cat cp mv rm mkdir chmod cmp cut date df dirname basename find grep head tail wc id uname sed awk sort tr od mktemp sleep env wget sha256sum hostname stty timeout touch)
MISSING=$(docker run --rm "$IMAGE" sh -c '
  missing=""
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  printf "%s" "$missing"
' sh "${TOOLS[@]}")
[ -z "$MISSING" ] ||
  fail "These tools are missing from $IMAGE:$MISSING" \
    "Add the Alpine package that provides each one to the Dockerfile (the Dockerfile comments say which package provides what), rebuild, and check again."
echo "Every tool the shell installer calls is in $IMAGE."

docker run --rm "$IMAGE" docker compose version >/dev/null 2>&1 ||
  fail "Docker Compose does not answer in $IMAGE, and the shell installer drives it for every instance." \
    "The Compose plugin comes from the base image; if the base pin changed, pick one that carries it, rebuild, and check again."
echo "Docker Compose answers in $IMAGE."

echo "Setup image check passed for $IMAGE."
