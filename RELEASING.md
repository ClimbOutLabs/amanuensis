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

1. Make sure the three Aman packages on ghcr.io (`aman-app`, `aman-stt`, `aman-calendar-caldav`) are public. Then check that a pull works while logged out, for example with `docker logout ghcr.io` followed by `docker pull ghcr.io/climboutlabs/aman-app:<12-character id>`. A private package makes every installer fall back to a long build.
2. Wait for the `Images` workflow to finish green on the new tag. It publishes the three Aman images that the installer downloads. The README must not point at a tag whose images are missing, or installs fall back to building on every computer.
3. Update `README.md`: the "Install on your own computer" section names the newest release tag and says whether it includes the installer. Change it to the new tag, and make the `git checkout <tag>` step the default once the release includes `installer/install.sh`.
4. Open a PR with the README change (follow `.github/pull_request_template.md`). The named tag keeps users on the latest stable release.

## Versioning

Tags use `vMAJOR.MINOR.PATCH`:

- `MAJOR` for breaking changes (config format, API, deployment topology).
- `MINOR` for new features.
- `PATCH` for bug fixes.

## Checklist for the release PR

- [ ] New tag exists at https://github.com/ClimbOutLabs/amanuensis/releases
- [ ] Tag points at a verified `main` HEAD
- [ ] README install section names the new tag
- [ ] Private data scan passes on changed files
