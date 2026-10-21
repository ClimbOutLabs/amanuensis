# Releasing Amanuensis

This repo follows a simple rule: **users install from release tags, never from `main`.** The `main` branch is active development and may be unstable. Every release must be buildable.

## When to cut a release

Cut a new release when:

1. The PRs targeted for the release are merged to `main`.
2. `main` HEAD is verified buildable on the exact head:
   - `pnpm install --frozen-lockfile` succeeds from a fresh checkout
   - `pnpm typecheck` passes
   - `pnpm guide:build` runs as part of `pnpm build`, so each release ships a fresh Aman guide; commit the regenerated `knowledgePack.generated.ts` if it changed
   - `pnpm test` passes (or the focused suites covering the merged changes)

Do not cut a release on an unverified head. If verification fails, fix `main` first.

## How to cut a release

Releases are created with the GitHub Releases API (no git protocol needed):

```
POST /repos/ClimbOutLabs/amanuensis/releases
{
  "tag_name": "v0.2.0",
  "target_commitish": "main",
  "name": "v0.2.0",
  "body": "Short summary of what is new in this release."
}
```

This creates the `v0.2.0` tag on the current `main` HEAD and publishes the release page.

## After cutting a release

1. Update `README.md`: change the `--branch` pin in both install commands (Quick start and Docker Compose) to the new tag.
2. Open a PR with the README change (follow `.github/pull_request_template.md`). The README pin keeps users on the latest stable release.

## Versioning

Tags use `vMAJOR.MINOR.PATCH`:

- `MAJOR` for breaking changes (config format, API, deployment topology).
- `MINOR` for new features.
- `PATCH` for bug fixes.

## Checklist for the release PR

- [ ] New tag exists at https://github.com/ClimbOutLabs/amanuensis/releases
- [ ] Tag points at a verified `main` HEAD
- [ ] README install commands pin the new tag
- [ ] Private data scan passes on changed files
