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

A release is made in three steps: a tag, a signature, and a publish. Only the signature happens on your own machine, because the release key never goes to GitHub.

### 1. Push a version tag on `main`

Tag the verified `main` HEAD and push the tag:

```
git tag v0.2.0 origin/main
git push origin v0.2.0
```

The **Release** workflow (`.github/workflows/release.yml`) starts on the tag. It refuses a tag that is not on `main` or that already has a published release. It builds:

- `Aman-Setup.exe`, the download for Windows. The name never changes between releases.
- `aman-windows-x64.exe`, the same program under the name the update looks for.
- `aman-darwin-arm64` and `aman-linux-x64`, the programs for Mac and Linux.
- `amanuensis-v0.2.0.tar.gz`, the source archive that installs and updates unpack.
- `manifest.json`, the release record: the SHA-256 of every file above and the image names for this source.
- `SHA256SUMS`, the same hashes in the form `sha256sum --check` reads.

The Windows build runs in the `release` environment, so it waits for your approval. The workflow ends with a **draft** release that carries all of these files.

### 2. Sign the release record

Download `manifest.json` from the draft release and sign it with the release key. Either of these makes `manifest.json.minisig`:

```
minisign -S -m manifest.json
```

or, with the key as a PKCS#8 Ed25519 file and its 16-character key number:

```
pnpm release:aman-installer sign --manifest manifest.json --key <your key file> --key-num <key number> --out manifest.json.minisig
```

Add `manifest.json.minisig` to the draft release, on the release page or with `gh release upload v0.2.0 manifest.json.minisig`.

### 3. Run the Publish release workflow

Run **Publish release** (`.github/workflows/release-publish.yml`) from the Actions tab with the tag. It also runs in the `release` environment. It checks every file in the record with `aman verify`, using the release key built into Aman, writes `SHA256SUMS` again with the signature in it, and makes the release public and the latest. A file that does not match stops it, and the release stays a draft.

### Signing `Aman-Setup.exe`

The Windows build signs the program with Azure Artifact Signing when the `release` environment has these six variables (IDs, not secrets): `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE`. Sign-in to Azure uses GitHub's OIDC token, so no password is stored. Without the variables, signing is skipped and the run says so. Once signing is set up, set `REQUIRE_WINDOWS_SIGNING` to `'true'` in `release.yml`, so a release tag can no longer build an unsigned program.

### The `release` environment

Create it once in the repository settings, under Environments: add the owner as a required reviewer, and allow only `v*` tags to deploy to it. The signing variables go there too.

### Dry runs

A pull request that changes the release steps runs the Release workflow as a dry run. It builds every file, signs the record with a key made for that run and thrown away, checks every file against it, and checks `SHA256SUMS`. It publishes nothing; the files are kept on the run for two weeks.

## After cutting a release

1. Update `README.md`: the "Install on your own computer" section names the newest release tag and says whether it includes the installer. Change it to the new tag, and make the `git checkout <tag>` step the default once the release includes `installer/install.sh`.
2. Open a PR with the README change (follow `.github/pull_request_template.md`). The named tag keeps users on the latest stable release.

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
