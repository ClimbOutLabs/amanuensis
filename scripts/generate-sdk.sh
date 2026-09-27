#!/usr/bin/env bash
# Regenerates OpenAPI (.github/fern + docs/) and packages/trueforge-sdk (same steps as CI).
# Requires Docker (Fern --local) and network access for the Fern CLI/image.
set -euo pipefail

cd "$(dirname "$0")/.."

repo_root="$(pwd -P)"
sdk_relative_dir="packages/trueforge-sdk"
sdk_dir="$repo_root/$sdk_relative_dir"
if [[ ! -d "$sdk_dir" || "$sdk_dir" != "$repo_root/packages/trueforge-sdk" ]]; then
  echo "Refusing SDK generation: unexpected SDK directory '$sdk_dir'" >&2
  exit 1
fi

# Fern replaces the SDK directory and regeneration can also update OpenAPI and
# the workspace lockfile. Keep verified repository-owned snapshots until every
# generation, install, build, and test step succeeds. node_modules is pnpm-owned
# workspace state and is deliberately recreated rather than archiving symlinks.
sdk_backup_root="$(mktemp -d "${TMPDIR:-/tmp}/trueforge-sdk-backup.XXXXXX")"
sdk_backup_dir="$sdk_backup_root/trueforge-sdk"
repository_outputs_archive="$sdk_backup_root/repository-outputs.tar"
mkdir -p -- "$sdk_backup_dir"
if ! (cd "$sdk_dir" && tar --exclude='./node_modules' -cf - .) |
  (cd "$sdk_backup_dir" && tar --warning=no-timestamp -xf -); then
  echo "Refusing SDK generation: backup verification failed at '$sdk_backup_dir'" >&2
  rm -rf -- "$sdk_backup_root"
  exit 1
fi
if [[ ! -f "$sdk_backup_dir/package.json" || ! -f "$sdk_backup_dir/src/index.ts" ]]; then
  echo "Refusing SDK generation: backup is incomplete at '$sdk_backup_dir'" >&2
  rm -rf -- "$sdk_backup_root"
  exit 1
fi
if ! tar -cf "$repository_outputs_archive" pnpm-lock.yaml .github/fern/openapi/openapi.json docs/openapi.json; then
  echo "Refusing SDK generation: repository-output backup failed at '$repository_outputs_archive'" >&2
  rm -rf -- "$sdk_backup_root"
  exit 1
fi

generation_succeeded=0
restore_sdk_on_exit() {
  status=$?
  trap - EXIT INT TERM
  if [[ "$generation_succeeded" -ne 1 ]]; then
    echo "SDK generation failed; restoring verified backup from '$sdk_backup_dir'" >&2
    if [[ "$sdk_dir" != "$repo_root/packages/trueforge-sdk" ]]; then
      echo "Refusing SDK restore: target path changed to '$sdk_dir'" >&2
      exit 70
    fi
    rm -rf -- "$sdk_relative_dir"
    mkdir -p -- "$sdk_relative_dir"
    if ! (cd "$sdk_backup_dir" && tar -cf - .) |
      (cd "$sdk_relative_dir" && tar --warning=no-timestamp -xf -); then
      echo "SDK restore failed; backup remains at '$sdk_backup_dir'" >&2
      exit 70
    fi
    if ! tar --warning=no-timestamp -xf "$repository_outputs_archive"; then
      echo "Repository-output restore failed; backup remains at '$repository_outputs_archive'" >&2
      exit 70
    fi
  fi
  rm -rf -- "$sdk_backup_root"
  exit "$status"
}
trap restore_sdk_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Read with node, not jq: node is already a hard requirement of this repo and
# jq is not installed on every developer machine. A regeneration step that only
# runs where jq happens to exist is one that quietly stops running, which
# matters more than usual here because CI cannot regenerate without the
# Generate SDK App, leaving this script as the fallback.
fern_version="$(node -p "require('./.github/fern/fern.config.json').version")"
fern() {
  # Fern only discovers a directory literally named `fern` under the process cwd
  # (https://buildwithfern.com/learn/docs/getting-started/project-structure).
  (cd .github && pnpm dlx "fern-api@${fern_version}" "$@")
}

# Fern --version stamps package.json and baked-in TS literals (SDK_VERSION,
# User-Agent). Pass the version already in package.json so a regen never stomps
# a version changesets (or a human) already set.
current_version="$(node -p "require('./packages/trueforge-sdk/package.json').version")"

pnpm --filter @truefoundry/trueforge-core build
pnpm openapi:write
fern check
# --force skips the overwrite prompt when packages/trueforge-sdk already exists (needed non-interactively / in CI).
# Remove the old output before invoking Fern. Required-file checks are not proof
# of generation while stale files can satisfy them. The verified backup above is
# restored by the trap if Fern fails, reports success without copying output, or
# emits an incomplete SDK.
rm -rf -- "$sdk_relative_dir"
fern generate --group ts-sdk --version "$current_version" --local --generate-tests --force --log-level debug

# Fern 5.89.6 can report success on Windows even when its Docker output was not
# copied back to the host. Never let that silent success delete a checked-in SDK.
required_generated_files=(
  "packages/trueforge-sdk/src/api/index.ts"
  "packages/trueforge-sdk/src/Client.ts"
  "packages/trueforge-sdk/src/errors/index.ts"
  "packages/trueforge-sdk/src/exports.ts"
  "packages/trueforge-sdk/src/serialization/index.ts"
)
for generated_file in "${required_generated_files[@]}"; do
  if [[ ! -f "$generated_file" ]]; then
    echo "SDK generation produced incomplete output: missing '$generated_file'." >&2
    echo "On Windows, run this script under WSL2 with Docker Desktop integration; Linux CI is the canonical drift check." >&2
    exit 1
  fi
done

# Fern does not generate TrueForge's deterministic event-delta helpers. They
# are a deliberate, repository-owned compatibility surface, so carry only the
# explicitly declared file forward from the verified backup. If a future Fern
# release starts generating the same path with different content, stop instead
# of silently choosing one implementation.
repository_owned_sdk_files=(
  ".fernignore"
  "CHANGELOG.md"
  "src/events.ts"
)
for repository_file in "${repository_owned_sdk_files[@]}"; do
  backup_file="$sdk_backup_dir/$repository_file"
  generated_file="$sdk_dir/$repository_file"
  if [[ ! -f "$backup_file" ]]; then
    echo "SDK generation backup is missing repository-owned file '$repository_file'." >&2
    exit 1
  fi
  if [[ -e "$generated_file" ]]; then
    if ! cmp -s -- "$backup_file" "$generated_file"; then
      echo "SDK generator now owns '$repository_file' with different content; reconcile it explicitly." >&2
      exit 1
    fi
  else
    mkdir -p -- "$(dirname "$generated_file")"
    cp -- "$backup_file" "$generated_file"
  fi
done
node scripts/postprocess-generated-sdk.mjs

# Fern's generated verify.sh runs `pnpm install` from packages/trueforge-sdk, which now
# resolves to this workspace. CI sets frozen-lockfile, so refresh the root
# lockfile first or that install fails when the generator added/removed deps.
pnpm install --no-frozen-lockfile
(cd packages/trueforge-sdk && bash .fern/verify.sh)
# Fern uses these while assembling and verifying a local package, but none is
# canonical repository output. Keeping them would leave every regeneration
# dirty even when the generated contract is byte-for-byte current.
rm -f -- \
  packages/trueforge-sdk/.fern/metadata.json \
  packages/trueforge-sdk/pnpm-lock.yaml \
  packages/trueforge-sdk/pnpm-workspace.yaml
generation_succeeded=1
