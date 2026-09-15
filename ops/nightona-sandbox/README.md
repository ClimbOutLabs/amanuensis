# Nightona PDF/OCR sandbox

Aman's document tools execute inside the configured sandbox. This image preserves the pinned
Nightona runtime contract and adds the local binaries those tools require:

- Poppler (`pdfinfo`, `pdftotext`, and `pdftoppm`) for native PDF text and page rendering.
- Tesseract with configurable language packs for raster-image and scanned-page OCR (English is
  always included).
- FFmpeg for audio/video media processing.

The base image is pinned by digest. Package versions are pinned for the base image's Debian
release. No OCR data leaves the sandbox.

## Build arguments

- `TESSERACT_LANGS` (default `eng hin mar`): space-separated Tesseract language codes to install; the shipped release image is built with the fifteen listed in the `nightona:sandbox:build` script. `eng`
  is always installed regardless. Common codes:
  - `deu` (German) – `tesseract-ocr-deu`
  - `fra` (French) – `tesseract-ocr-fra`
  - `spa` (Spanish) – `tesseract-ocr-spa`
  - `hin` (Hindi) – `tesseract-ocr-hin`
  - `jpn` (Japanese) – `tesseract-ocr-jpn`
  - `chi_sim` (Simplified Chinese) – `tesseract-ocr-chi-sim`

- `TESSERACT_LANG_PACK_VERSION` (default `1:4.1.0-2`): Debian package version for language packs,
  pinned to match the base image's Debian release.

## Configuring OCR language at runtime

Set the host environment variable `DOCUMENT_OCR_LANGUAGES` to a space-separated list of Tesseract
language codes to use during OCR. The OCR command will include `-l <codes joined with +>` when
this is configured; without it, Tesseract defaults to English. The sandbox image must have the
requested language pack installed for OCR to succeed.

## Build and verify on the Nightona host

The Docker host reaches its registry as `REGISTRY_HOST:PORT`; Nightona snapshots reach the same
registry as `REGISTRY_HOST:PORT`.

```bash
pnpm run nightona:sandbox:build
pnpm run nightona:sandbox:verify
pnpm run nightona:sandbox:push
```

The pushed `tf7` manifest has registry digest
`sha256:32cc5eec3637ee3a346e4438bced0d88e0e9caf69010a94aacbc0d80b3d1f72b`. Nightona 0.6.0
currently rewrites digest-form image references into invalid Docker tags, so `sandboxImage.json`
uses the versioned `0.6.0-slim-tf7` release tag and this digest remains the reproducibility check.

New provider configurations use the image pinned in `sandboxImage.json`. Existing providers stay
on their persisted image during ordinary operation. **Settings → Sandbox providers → Upgrade
runtime** is the explicit upgrade action; it registers the current release image and persists the
new snapshot identity. Existing running sandboxes and snapshots are not replaced.

Snapshot build references are deterministic release artifacts and may be shared by multiple Aman
replicas. If local configuration changes after registration but before publication, Aman retains
the registered snapshot and logs the lost publication race; it does not delete an artifact that
another replica may already have adopted. Registry retention remains an operator concern until the
provider offers ownership or lease semantics that can prove an artifact is unreferenced.
