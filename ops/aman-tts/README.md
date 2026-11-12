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
- Errors: `400` bad JSON, empty text, unknown voice or format, `stream` without a streamable format, `exact` that is not true or false, nothing to read aloud, or (with `exact`) text the voice would not say as written;
  `413` text too long; `429` busy (with `Retry-After`); `503` model not loaded.

One synthesis runs at a time, a stream included; a single run already uses every configured thread.
At most two more requests wait (`AMAN_TTS_MAX_WAITING`); more get 429. A request
whose caller hangs up stops between pieces of text and is never finished. A
request whose caller hangs up while it waits leaves the line at once, so it
does not count toward the two.

#### `exact`

Send `"exact": true` with `/v1/speak` when a text must be heard exactly as written, as a card read
back before a yes. The whole text is checked first, with the same code that then speaks it, so the
text that was checked is the text that is heard. The check needs no model.

- 400 with header `x-aman-reason: would_change_text`, before any sound: the voice would say something
  other than what is written. That covers numbers it would read another way (`1,5`, `10.0.0.1`,
  `11.06.2026`, `007`, `5 000`, `3th`, more than two cents), times that are not real (`9:60`), digits
  written as superscripts or other forms, links, code, list marks, a minus sign or range, line breaks
  other than a plain one, letters outside plain English, and web-address-like text (`my.bank.com`,
  `t.co`, `163.com`; a single letter after a dot, as in `e.g.`, `p.m.` and `Ph.D.`, is allowed).
  Numbers written side by side are judged by one rule. A _spelling_ is digits (`1,000`, `2:30`), digits and
  a scale word (`5 million`, `2 dozen`), or a run of number words (`twenty-five`). Two spellings joined by a
  gap of only blanks, silent signs, dashes and pause marks (`1000 (500)`, `1000; 500`, `1000...500`,
  `1000 — 500`, `twenty (5)`, `one, two`), or by `and` (also `an`, `n`, `&`, with signs around it) when
  the left ends in a scale and the right is smaller (`1000 and $500`, `1000 & 500`, `1000 and—500`,
  `1,000,000 and 500,000`), are refused. Two number words joined by a plain "and" are one amount in
  words and are read (`two hundred and fifty`). A month or weekday excuses a comma only with a capital
  letter. A text the check cannot judge is refused, never an error. Not refused: one sentence stop and a space
  (`Use 5. 3 more follow.`), ranges (`Between 100 and 150`, `Rooms 101 and 102`), and a date or time
  written with a comma after a month or weekday (`Fri Nov 6, 2:30`, `March 5, 2026`,
  `Nov 6, 2026, 2:30 pm`). `Pay 19, 99 dollars` and `Send 12, 2000 dollars` are refused. Plain
  forms are kept: digits with no leading zero, groups of three with commas, up to two cents after a dollar
  sign, a decimal, a time like `9:30` and an ordinal with its right ending (`14th`).
- A `200` for an exact speak carries `x-aman-exact: checked`. A caller that asked for `exact` must treat
  an answer without it as unchecked: an older service ignores `exact` and speaks anything.
- Cents are said with their unit: `$1,000.10` is "one thousand dollars and ten cents".
- Send the whole text in one request. A piece cut from a longer text can start with a list mark or a
  number-and-bracket that the voice drops from the start of a text, so it is judged on its own.

### `GET /healthz`

Returns `{"status": "ok", "model_loaded": true, "model_error": null,
"voices": ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_alloy", "af_aoede", "af_kore", "af_nova", "af_sky", "am_michael", "am_fenrir", "am_puck"], "default_voice": "af_heart",
"exact": true}`.
The agent backend probes it, and the Docker health check asserts `model_loaded`. `exact` says this service
checks `exact` speech; an older one leaves it out, so phone calls are not offered with it.

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
writes the model, the twelve baked voices and the word lists to
`/opt/aman-tts/assets`. The service verifies the model hash again before
loading it, so a tampered file fails closed and `/healthz` reports why.

| Asset                                                                                                                                                | Source                                 | License    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------- |
| Kokoro-82M v1.0 int8 ONNX model                                                                                                                      | kokoro-onnx `model-files-v1.0` release | Apache-2.0 |
| Voices `af_heart`, `af_bella`, `af_nicole`, `af_sarah`, `af_alloy`, `af_aoede`, `af_kore`, `af_nova`, `af_sky`, `am_michael`, `am_fenrir`, `am_puck` | same release, `voices-v1.0.bin`        | Apache-2.0 |
| `us_gold.json`, `us_silver.json`                                                                                                                     | misaki 0.9.4 wheel (data files only)   | Apache-2.0 |
| `kokoro_vocab.json`                                                                                                                                  | Kokoro-82M model config (phoneme ids)  | Apache-2.0 |

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

When you pin `aman-stt` to its own cores, pin this service to the same ones:
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
