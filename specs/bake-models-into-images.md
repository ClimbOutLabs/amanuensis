# Spec: Bake the Speech and Memory Search Models into the Images

**Status:** approved

## Problem

Two model files are downloaded from Hugging Face while Aman runs: the speech-to-text model (about 464 MB) when the speech service first starts, and the memory search model (about 120 MB) on the first memory turn. Both happen by default, outside the person's control, and the speech download can take a long time on a slow connection.

## Change

Fetch both models when the images are built, not when Aman runs.

- The speech image fetches the four files of the pinned Whisper small revision. The build checks each file against its SHA-256 and fails on any mismatch. The service loads the files from a read-only folder in the image and runs with the Hugging Face offline and telemetry flags set.
- The app image fetches the five files of the pinned memory search revision, with the same SHA-256 checks. The server loads them from a folder in the image. Both app Dockerfiles do this: `Dockerfile.dev`, which the installer, compose and the published images build, and `Dockerfile`, the image built from the npm package. In `Dockerfile.dev` the files are fetched in a build stage of their own, so Docker's layer cache keeps them across code changes and fetches them again only when a pin changes.
- The install-time downloads for these two models are removed from the installer's plan and from its download list. Their Docker volumes (`stt-cache`, `stt-model-cache`) are no longer mounted. An existing `aman_stt_cache` volume is still removed by uninstall, so nothing is left behind.
- Aman never downloads a model while it runs. The memory search service and the speech service lose their download code. A missing or changed file leaves memory search on keywords, or stops the speech model from loading, and the error names the folder to fix.
- Installs without Docker (`npx` or running from source) have no built-in memory model. Memory search uses keywords until the files are added by hand. The memory guide gives the commands.
- The installer's data import no longer waits for a model download. It checks once that the model is in the image, and stops before changing anything if it is not.

## Licences

Both models are MIT. Their notices are in `THIRD_PARTY_NOTICES.md`, section 13.

## Scope

- Not changed: the pinned revisions, the hashes, the server's verification of the model files, and the speech service's fallback model (`base`). The fallback is not in the image, so if `small` fails to load, `base` cannot load either. That is the same result as having no network.
- Not changed: the voice activity model and the text-to-speech model, which are already built into the images.

## Privacy

Nothing about the person is sent during the build or during a run. Image builds contact Hugging Face only for the pinned files. At run time the model files stay on the person's computer.

## Testing

- Build tests check that each pinned file's SHA-256 appears in the Dockerfile next to its pinned URL, for both images.
- The installer and compose changes are checked by the existing installer tests and by the external-hosts and private-data checks.
- The tests use no personal data.
