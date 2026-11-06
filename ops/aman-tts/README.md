# aman-tts: local text-to-speech sidecar

Dedicated CPU-only container that reads reply text aloud with Kokoro-82M
(82M parameters, int8 ONNX, ~92 MB) through onnxruntime. It takes plain or
Markdown text and returns audio: a WAV file, raw samples, or telephone audio, all
or one sentence at a time. Nothing is written to disk and no text is
logged (only character counts, durations and error codes).

## API contract

Base URL (container-internal): `http://aman-tts:8002`

### `POST /v1/speak`

- Request: `Content-Type: application/json`, body
  `{"text": "...", "voice": "af_heart", "format": "wav", "stream": false}`.
  `voice`, `format` and `stream` are optional; the default voice is `af_heart`.
- `format`: `wav` (default), `pcm16` (24 kHz mono 16-bit little-endian samples, no
  header, `audio/L16`) or `mulaw8k` (8 kHz G.711 mu-law for phone lines, `audio/basic`).
  The `x-sample-rate` header says which rate the bytes are at. The mu-law path
  filters to the phone band, then drops to 8 kHz; only numpy does this.
- `stream`: `true` (with `pcm16` or `mulaw8k`) sends the audio one sentence at a
  time over a chunked response, so the first bytes arrive after the first sentence
  is made, not the whole reply. Sentences are separated by a short pause. A text
  that is too long or has nothing to read still gets its error status before any
  audio. A caller that hangs up stops the work. `wav` cannot stream, because its
  header holds the length.
- Text cap: 5000 characters (`AMAN_TTS_MAX_TEXT_CHARS`); longer text is
  refused with 413. The body is also capped while it streams in.
- Sound cap: 3000 sounds after numbers and symbols are spelled out
  (`AMAN_TTS_MAX_PHONEMES`, about two minutes of speech); more is refused with 413.
  This is the cap that keeps memory in bounds: measured at the cap, a run peaks near
  500 MB, under the 1 GB the container gets.
- 200 response: `audio/wav` by default (24 kHz mono 16-bit PCM), with `x-voice`,
  `x-model` and `x-sample-rate` headers.
- Errors: `400` bad JSON, empty text, unknown voice or format, `stream` without a streamable format, or nothing to read aloud;
  `413` text too long; `429` busy (with `Retry-After`); `503` model not loaded.

One synthesis runs at a time, a stream included; a single run already uses every configured thread.
At most two more requests wait (`AMAN_TTS_MAX_WAITING`); more get 429. A request
whose caller hangs up stops between pieces of text and is never finished. A
request whose caller hangs up while it waits leaves the line at once, so it
does not count toward the two.

### `POST /v1/normalize`

Says what `/v1/speak` would say for a text, without making any audio, and needs no model.
It is how a caller that must read text back exactly finds out whether it can.

- Request: `{"text": "..."}`, with the same size limits as `/v1/speak`.
- 200: `{"spoken": "..."}`, the words as they would be spoken, with numbers spelled out.
- 400 with header `x-aman-reason: would_change_text`: the voice would say something other than
  what is written. That covers numbers it would read another way (`1,5`, `10.0.0.1`, `11.06.2026`,
  more than two cents), links, code, list marks, a minus sign or range, line breaks other than a
  plain one, and letters outside plain English. Only the common forms are kept: plain digits, groups
  of three with commas, up to two cents after a dollar sign, a decimal, and a time like `9:30`.

### `GET /healthz`

Returns `{"status": "ok", "model_loaded": true, "model_error": null,
"voices": ["af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael", "am_fenrir"], "default_voice": "af_heart"}`.
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
writes the model, the six baked voices and the word lists to
`/opt/aman-tts/assets`. The service verifies the model hash again before
loading it, so a tampered file fails closed and `/healthz` reports why.

| Asset                                                                             | Source                                 | License    |
| --------------------------------------------------------------------------------- | -------------------------------------- | ---------- |
| Kokoro-82M v1.0 int8 ONNX model                                                   | kokoro-onnx `model-files-v1.0` release | Apache-2.0 |
| Voices `af_heart`, `af_bella`, `af_nicole`, `af_sarah`, `am_michael`, `am_fenrir` | same release, `voices-v1.0.bin`        | Apache-2.0 |
| `us_gold.json`, `us_silver.json`                                                  | misaki 0.9.4 wheel (data files only)   | Apache-2.0 |
| `kokoro_vocab.json`                                                               | Kokoro-82M model config (phoneme ids)  | Apache-2.0 |

To move to new assets: change the URL, size and SHA-256 in `pins.py`, rebuild,
and run the tests.

## Configuration (env)

| Variable                  | Default                | Purpose                                |
| ------------------------- | ---------------------- | -------------------------------------- |
| `AMAN_TTS_CPU_THREADS`    | `4`                    | onnxruntime threads                    |
| `AMAN_TTS_MAX_TEXT_CHARS` | `5000`                 | text cap per request                   |
| `AMAN_TTS_MAX_PHONEMES`   | `3000`                 | sound cap per request                  |
| `AMAN_TTS_MAX_WAITING`    | `2`                    | requests that may wait their turn      |
| `AMAN_TTS_DEFAULT_VOICE`  | `af_heart`             | voice used when the request names none |
| `AMAN_TTS_ASSET_DIR`      | `/opt/aman-tts/assets` | where the baked assets live            |

The full stack pins the service to the same cores as `aman-stt` (`16-19`):
people speak, then listen, so the two rarely run at once.

## Tests

No model needed; a fake synthesizer covers the HTTP contract. CI runs these
whenever this folder changes:

```
pip install --require-hashes -r requirements.txt && pip install httpx==0.28.1
pnpm test:aman-tts
```

To change a Python package, edit `requirements.in`, then run `pnpm lock:aman-tts`
(needs `pip-tools`) to rewrite the hashed `requirements.txt`.
