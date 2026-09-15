#!/usr/bin/env bash
# Regenerate checked-in API contracts and fail when the result drifts. This is
# credential-free and blocking; CI never trusts stale generated clients.
set -euo pipefail

cd "$(dirname "$0")/.."

generated_paths=(
  ".github/fern/openapi"
  "docs/openapi.json"
  "packages/trueforge-sdk"
  "pnpm-lock.yaml"
)

pnpm sdk:generate

changes="$(git status --porcelain=v1 -- "${generated_paths[@]}")"
if [[ -z "$changes" ]]; then
  echo "Generated OpenAPI and SDK output is up to date."
  exit 0
fi

echo "Generated contract drift detected. Regenerate and commit the outputs before merging:" >&2
printf '%s\n' "$changes" >&2
echo >&2
echo "Changed tracked files:" >&2
git diff --name-status -- "${generated_paths[@]}" >&2
exit 1
