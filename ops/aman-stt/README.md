# aman-stt: local speech-to-text sidecar

Dedicated CPU-only container running Whisper `small` (244M params, ~464 MB)
via faster-whisper with `int8` compute type. It accepts one complete utterance
per request and returns a transcript. No audio is written to disk, no
transcripts are logged (only durations and error codes).

## API contract

Base URL (container-internal): `http://aman-stt:8001`

### `POST /v1/transcribe`

Transcribes one complete utterance (record-then-send).

- Request: `Content-Type: audio/wav` (16 kHz mono 16-bit PCM WAV), or
  `Content-Type: audio/x-raw-pcm` with `?sample_rate=16000&channels=1`.
- Max body: 30 MB (~16 min at 16 kHz mono 16-bit); larger bodies are
  rejected with 413 (checked both on declared `Content-Length` and while
  streaming).
- Optional query param: `language` (ISO code, e.g. `en`, `es`). Omit for
  auto-detect. v1 always omits it; the parameter exists for later use.
- 200 response: `{"text": "...", "language": "en", "duration_ms": 2340,
"model": "whisper-small-int8"}`.
- Errors: `400` malformed audio / unsupported format, `413` body too large,
  `503` model not warm yet (still loading; the caller retries).

Only one transcription runs at a time: the 4 pinned cores are fully used by
a single decode, so requests serialize on a semaphore rather than contend.

### `GET /healthz`

Returns `{"status": "ok", "model_loaded": true}`. The agent backend polls this
at startup (advisory: the backend boots regardless) and every 30 s to
recompute the voice capability flag. Docker also uses it as the container
health check; the check asserts `model_loaded` so orchestrators wait for the
warm model before routing.

No auth on v1: the service is reachable only inside the compose network (the
full stack publishes no host port; `docker-compose.dev.yml` binds
`127.0.0.1:8001` for host development). If the port is ever published beyond
loopback, add a shared-secret header before doing so.

## Lifecycle

1. At container start the model loads once from the persistent
   `stt-model-cache` volume (`/data/stt-cache`), downloading from Hugging
   Face the first time only.
2. A warmup transcription of 1 s of silence runs at startup to heat the
   kernels before the first real request.
3. The model stays warm in RAM for the container's lifetime.

Cold load is ~2-5 s; first-run download adds network time, which is why the
Docker health check allows a 180 s start period.

## Configuration (env)

| Variable                          | Default            | Purpose                                                    |
| --------------------------------- | ------------------ | ---------------------------------------------------------- |
| `AMAN_STT_HOST` / `AMAN_STT_PORT` | `0.0.0.0` / `8001` | listen address                                             |
| `AMAN_STT_MODEL`                  | `small`            | Whisper model size                                         |
| `AMAN_STT_FALLBACK_MODEL`         | `base`             | fallback if `small` fails to load                          |
| `AMAN_STT_CPU_THREADS`            | `4`                | faster-whisper encoder threads; keep equal to pinned cores |
| `AMAN_STT_MODEL_DIR`              | `/data/stt-cache`  | model cache directory (persistent volume)                  |
| `AMAN_STT_MAX_BODY_BYTES`         | `31457280`         | 30 MB body cap                                             |

## Resource isolation and tuning

`aman-stt` and the retrieval embedding model both run bursty CPU work, so
they are pinned to disjoint cores via Docker `cpuset` (deploy-time
parameter), with thread caps as defense in depth:

- `aman-stt`: `cpuset: '16-19'` (4 cores), `cpu_threads=4`, memory limit 2 GB.
- The agent server and its in-process embedding workload are pinned to
  `cpuset: '0-15'` (see the root `docker-compose.yml`).

Pinning is the primary mechanism: soft CPU limits still let bursts land on
shared cores, and `nice` levels only bias the scheduler, neither prevents
contention. Keep `AMAN_STT_CPU_THREADS` equal to the pinned core count so the
encoder pool does not oversubscribe the set.

**Tuning procedure (deriving the pin set for a host):**

1. Count physical/logical cores. Reserve 4 cores for `aman-stt` at the high
   end of the topology (e.g. `16-19` on a 20-core host), keeping it disjoint
   from the embedding workload's set. On smaller hosts pick any valid
   disjoint 4-core set and adjust both compose services together.
2. Baseline: measure p95 transcription latency for a 10 s utterance with the
   warm model in isolation (protocol: 50 sequential utterances, timed from
   capture stop to transcript). Target: under 3 s.
3. Contention test: run a sustained dictation session while firing embedding
   queries; measure p95 transcription latency and p95 embedding query latency.
4. If either degrades vs. its isolated baseline, widen the embedding pin set
   or drop STT to Whisper `base` (set `AMAN_STT_MODEL=base`); `base` is the
   documented fallback when CPU contention is observed in practice.

## Privacy

- Audio is decoded and transcribed in memory only; nothing is written to disk.
- Logs carry audio length, request duration, detected language, and the model
  label. Transcript text and audio bytes never appear in logs (covered by the
  `PrivacyTest` unit test).
- There is no cloud STT fallback. If the sidecar is down, the failure mode is
  "type instead."

## Tests

Pure-stdlib + numpy + FastAPI, no model needed:

```
python -m unittest discover -s tests
```

Tests inject a fake transcriber, so they cover healthz, the WAV and raw-PCM
decode paths, 400/413/503 handling, and the no-transcript-logging guarantee
without downloading the model.
