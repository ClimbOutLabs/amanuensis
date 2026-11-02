# Spec: Dependency License Check

**Status:** approved

## Problem

Aman is licensed under MPL-2.0. Nothing checks the licenses of its dependencies, so a package under a strong copyleft license (GPL, AGPL), a source-available or proprietary license, or no license at all can land without anyone noticing. Two such packages are already in the tree, and neither declares a license anywhere:

- `curry`, pulled in by `bash-parser`, which the sandbox uses to decide whether a command is a single simple command. It ships to everyone who installs the published packages.
- `truefoundry-gateway-sdk`, an optional peer of `@truefoundry/assistant-ui-runtime`. Only the TrueFoundry-hosted server option of `@truefoundry/trueforge-ui` uses it. The app already keeps it out of the frontend bundle, but it is still installed and imported.

## Solution

1. **Remove the two unlicensed packages.**
   - Replace `bash-parser` with a small, conservative parser in `trueforge-core` (`parseSimpleShellCommand`). It accepts only a single command made of plain words, quotes, escapes and parameter expansions, and returns null for anything else. A null result only means the host does not vouch for the exit code. It never turns a failure into "ok".
   - Patch `@truefoundry/assistant-ui-runtime` to remove its TrueFoundry server adapter, the only part that imports the gateway SDK, and override the SDK out of the install. Remove the `type: "truefoundry"` server option from `@truefoundry/trueforge-ui`, which cannot work without that SDK, along with its docs and the frontend's build-time stub.
2. **Add a CI check** (`pnpm licenses:check`) that fails unless every dependency has a license on an accepted list. The list holds permissive licenses plus weak copyleft that stays with its own files or library (MPL-2.0, LGPL, EPL-2.0). Everything else fails, including missing and unrecognised licenses. A dual-licensed package passes when one of its choices is accepted.
   - Sources: the pnpm workspace, every tracked `package-lock.json`, every tracked `requirements*.txt` and `requirements*.lock` (license data from PyPI for each pinned version), and every tracked `go.mod`. Dockerfiles must install Python packages from a requirements file.
   - A package whose metadata is missing or unclear can be recorded in a reviewed file with the license read from its own license text. That license still has to be accepted, and a line that no longer matches a dependency fails.
   - CI runs it when dependency manifests, lockfiles, Dockerfiles or the check change.

## Scope

- In: the removals above, the check, its CI job, and the contributor docs.
- Out: OS packages installed with `apt` in container images (listed in `THIRD_PARTY_NOTICES.md`), and model weights.

## Privacy

No user data is involved. The check reads only dependency manifests in the repository and public package metadata from PyPI. The shell parser runs locally on the command text the sandbox already has, and sends nothing anywhere.

## Testing

All tests use synthetic data. Unit tests cover the license policy (accepted, rejected, malformed and dual-licensed expressions) and the shell parser (plain commands, quoting and escapes, and every disqualifying shape). The existing exit-code tests run unchanged against the new parser. CI runs the check against the real dependency tree.
