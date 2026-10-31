# aman-tts: local text-to-speech sidecar

Dedicated CPU-only container that reads reply text aloud with Kokoro-82M
(82M parameters, int8 ONNX, ~92 MB) through onnxruntime. It takes plain or
Markdown text and returns a WAV file. Nothing is written to disk and no text is
logged (only character counts, durations and error codes).

## API contract

Base URL (container-internal): `http://aman-tts:8002`

### `POST /v1/speak`

- Request: `Content-Type: application/json`, body `{"text": "...", "voice": "af_heart"}`.
  `voice` is optional; the default is `af_heart`.
- Text cap: 5000 characters (`AMAN_TTS_MAX_TEXT_CHARS`); longer text is
  refused with 413. The body is also capped while it streams in.
- 200 response: `audio/wav`, 24 kHz mono 16-bit PCM, with `x-voice` and
  `x-model` headers.
- Errors: `400` bad JSON, empty text, unknown voice, or nothing to read aloud;
  `413` text too long; `503` model not loaded.

One synthesis runs at a time; a single run already uses every configured thread.

### `GET /healthz`

Returns `{"status": "ok", "model_loaded": true, "model_error": null,
"voices": ["af_heart", "af_bella", "am_michael"], "default_voice": "af_heart"}`.
The agent backend probes it, and the Docker health check asserts `model_loaded`.

No auth: like `aman-stt`, the service is reachable only inside the compose
network (`docker-compose.dev.yml` binds `127.0.0.1:8002` for host development).

## How text becomes sound

`phonemes.py` turns text into the phoneme alphabet Kokoro was trained on:

1. Markdown is reduced to sentences: code blocks are skipped, links are read by
   their text, bare web addresses become "a link".
2. Numbers, times (`9:30`), money (`$12.50`), ordinals (`2nd`) and a few
   symbols are spelled out in words.
3. Each word is looked up in misaki's American English word lists (gold, then
   silver). Unknown words are tried without a common ending, short all-capital
   words are spelled letter by letter, and anything left is sounded out with
   simple spelling rules.

This deliberately avoids espeak-ng and phonemizer (both GPL) and num2words
(LGPL), so everything in the image is under a permissive license. The cost is
that rare words and names are sounded out from their spelling.

## Assets and pinning

All pins live in `pins.py`. `build_assets.py` runs in the first build stage:
it downloads each pinned file, refuses any whose size or SHA-256 differs, and
writes the model, the three baked voices and the word lists to
`/opt/aman-tts/assets`. The service verifies the model hash again before
loading it, so a tampered file fails closed and `/healthz` reports why.

| Asset                                       | Source                                 | License    |
| ------------------------------------------- | -------------------------------------- | ---------- |
| Kokoro-82M v1.0 int8 ONNX model             | kokoro-onnx `model-files-v1.0` release | Apache-2.0 |
| Voices `af_heart`, `af_bella`, `am_michael` | same release, `voices-v1.0.bin`        | Apache-2.0 |
| `us_gold.json`, `us_silver.json`            | misaki 0.9.4 wheel (data files only)   | Apache-2.0 |
| `kokoro_vocab.json`                         | Kokoro-82M model config (phoneme ids)  | Apache-2.0 |

To move to new assets: change the URL, size and SHA-256 in `pins.py`, rebuild,
and run the tests.

## Configuration (env)

| Variable                  | Default                | Purpose                                |
| ------------------------- | ---------------------- | -------------------------------------- |
| `AMAN_TTS_CPU_THREADS`    | `4`                    | onnxruntime threads                    |
| `AMAN_TTS_MAX_TEXT_CHARS` | `5000`                 | text cap per request                   |
| `AMAN_TTS_DEFAULT_VOICE`  | `af_heart`             | voice used when the request names none |
| `AMAN_TTS_ASSET_DIR`      | `/opt/aman-tts/assets` | where the baked assets live            |

The full stack pins the service to the same cores as `aman-stt` (`16-19`):
people speak, then listen, so the two rarely run at once.

## Tests

No model needed; a fake synthesizer covers the HTTP contract:

```
pip install -r requirements.txt httpx
python -m unittest discover -s tests
```
