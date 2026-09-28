# Spec: Local-First Voice Loop

## Problem

Aman is text-only. A personal AI assistant on the user's own hardware should support voice input: tap a button, speak, and have the words transcribed locally with no audio ever leaving the device.

## Solution

A local speech-to-text pipeline feeding the chat composer. The user records a message by voice, it is transcribed on-device, and the transcript lands in the composer as editable draft text. Later phases add local text-to-speech and an optional hands-free conversation mode.

## Design Decisions

**Local speech processing only.** Speech-to-text runs on the local machine. No audio is sent to cloud APIs. This is non-negotiable for the privacy positioning.

**Tap-to-toggle for v1.** Tap the mic button to start recording, tap again to stop and transcribe. Simpler than push-to-talk for dictation of any length.

**Voice is a composer input modality, not a separate channel.** Transcribed text enters the composer as an editable draft. The user reviews, edits if needed, and sends normally. Transcribed-then-sent messages are indistinguishable from typed messages downstream.

**No resource contention with the embedding model.** The STT model and the retrieval embedding model both run on CPU. They are pinned to disjoint CPU cores so neither can starve the other.

## Scope (v1)

- Mic button in the chat composer bar. Tap to start, tap again to stop.
- Local speech-to-text via a dedicated sidecar service (see Architecture).
- Transcribed text inserted into the composer as editable draft text.
- Inline, dismissible error in the composer on transcription failure. Typed input always works.
- Visual recording indicator while the mic is active.

## Architecture

### Model: Whisper `small`

| Model | Params | Size | CPU real-time factor (int8) |
|-------|--------|------|------------------------------|
| tiny  | 39M    | ~75MB  | ~0.05x (very fast, poor accuracy) |
| base  | 74M    | ~141MB | ~0.1x (fast, decent) |
| **small** | **244M** | **~464MB** | **~0.2x (real-time, good accuracy)** |
| medium | 769M  | ~1.4GB | ~0.6x (slow on CPU) |

**Decision: `small`.** Best accuracy that still transcribes faster than real-time on CPU with int8 quantization. `base` is the documented fallback if CPU contention is observed in practice.

Multilingual (99 languages) out of the box. Language auto-detect per utterance; the caller may pass an explicit `language` hint.

### Runtime: faster-whisper (CTranslate2), int8

**Decision: `faster-whisper` with `int8` compute type.**

- int8 quantization on CPU gives ~4x speedup over fp32 with negligible accuracy loss for the `small` model.
- Python-native, small dependency surface (`faster-whisper`, `fastapi`, `uvicorn`).
- `whisper.cpp` was evaluated and rejected for v1: comparable CPU performance, but adds a C++ build step to the container image and a second model format to cache. Revisit only if faster-whisper proves inadequate.

### Deployment: separate sidecar container

```
aman-stt          # NEW: Whisper small int8, CPU-only, FastAPI
aman-prod-*       # agent backend (unchanged)
```

**Decision: dedicated `aman-stt` container, not bundled into the agent container.**

- Independent lifecycle: STT can restart/reload without touching the agent.
- Hard resource boundaries via Docker CPU controls (see below).
- Keeps the agent image lean; STT model weights (~500MB) live in their own volume.
- No GPU device access granted to the container. The brain model keeps the whole GPU.
- Model loads once at container start and stays warm in RAM. Cold load is ~2-5s; a warmup transcription of 1s of silence runs at startup to heat the kernels.
- Listens on the Docker bridge network only. The browser never talks to it directly (see Integration).

## Resource isolation: STT vs embedding model

This is the hard requirement. Both Whisper-small and the retrieval embedding model run on the local CPU. Both are bursty (STT active only while the user speaks; embedding active at query time), but bursts can overlap and neither may starve the other.

**Decision: disjoint CPU pinning as the primary mechanism, thread caps as the secondary.**

1. **CPU sets (hard boundary).** Pin each workload to disjoint cores via `--cpuset-cpus`:
   - `aman-stt`: `--cpuset-cpus="16-19"` (4 performance cores, starting point)
   - Embedding model process/container: pinned to the remaining cores, excluding 16-19.
   - Rationale: pinning is the only mechanism that guarantees no contention under overlap. Soft limits (`--cpus`) still allow bursts onto shared cores.
2. **Thread caps (defense in depth).** faster-whisper `cpu_threads=4`, matching the pinned set. The embedding runtime gets its own thread cap sized to its pin set. A workload cannot usefully exceed its pinned cores, and uncapped thread pools cause oversubscription latency spikes.
3. **Memory.** Whisper-small int8 resident set is ~1GB. Set a container memory limit (2GB) as a guardrail against pathological inputs.
4. **Priority.** Do not rely on `nice` levels as the primary mechanism; they don't prevent contention, only bias the scheduler. Acceptable as a secondary tweak during tuning.

**Tuning procedure (not v1-blocking):** run a sustained dictation session while firing embedding queries; measure p95 transcription latency and embedding query latency. If either degrades vs. isolated baseline, adjust the core split or drop STT to Whisper `base`.

## API contract

Base URL (container-internal): `http://aman-stt:8001`

### `POST /v1/transcribe`

Transcribe one complete utterance (record-then-send).

**Request:**
- Content-Type: `audio/wav` (16kHz mono 16-bit PCM WAV), **or** `audio/x-raw-pcm` with query params `?sample_rate=16000&channels=1`
- Max body: 30MB (~3 min at 16kHz mono 16-bit; v1 cap, reject larger with 413)
- Optional query params: `language` (ISO code, e.g. `en`, `es`; omit for auto-detect)

**Response (200):**
```json
{
  "text": "remind me to buy milk tomorrow",
  "language": "en",
  "duration_ms": 2340,
  "model": "whisper-small-int8"
}
```

**Errors:**
- `400` malformed audio / unsupported format
- `413` audio exceeds v1 length cap
- `503` model not warm yet (container still loading; client should retry with backoff)

### `GET /healthz`

Returns `{"status": "ok", "model_loaded": true}`. Used by the agent backend at startup and by orchestrators.

### Notes

- No auth on v1: the endpoint is reachable only on the internal Docker network. The browser never calls it directly (see Integration). If the STT port is ever published beyond the bridge network, add a shared-secret header then.
- No streaming endpoint in v1. If streaming is later needed, it is a new endpoint (`/v1/transcribe/stream`, chunked transfer), not a modification of this one.

## Integration point

1. Mic button in the chat composer (next to send). **Tap-to-toggle:** tap to start recording, tap again to stop and transcribe.
2. Browser captures via `getUserMedia`, encodes 16kHz mono WAV client-side.
3. Audio is POSTed to the **agent backend**, not directly to `aman-stt`. The backend forwards to the STT sidecar and returns the transcript. Rationale: single network trust boundary; STT stays on the internal network.
4. Transcript is inserted into the composer text field as **editable draft text**. The user reviews, edits if needed, and sends normally.
5. On STT failure (timeout, 503, 413): show an inline, dismissible error in the composer ("Transcription failed, try again or type instead"). Never block the composer; typed input always works.
6. Transcribed-then-sent messages are indistinguishable from typed messages downstream. No special agent handling, no metadata flag in v1.

**Latency budget:** warm-model p95 for a 10s utterance should be under 3s end-to-end (capture stop to text in composer). Measured during tuning; if missed, first lever is dropping to Whisper `base`.

## Privacy

- Audio path: browser mic -> agent backend -> Docker bridge -> `aman-stt` -> transcript back. Every hop is inside infrastructure the user controls.
- No audio is written to disk by the STT service (in-memory only). No transcripts are logged by the STT service (log durations and error codes only).
- No cloud STT fallback, ever. If local STT is down, the failure mode is "type instead," not "try a cloud API."
- No wake-word listening. The microphone is only active while the user has tapped to record.

## Testing

- Synthetic speech samples, no real user voice stored in tests.
- Verify: tap-to-toggle transcribes correctly in a quiet room.
- Verify: no network calls to speech APIs during a voice session (packet capture).
- Verify: transcription latency stays within budget while embedding queries run concurrently.
- Verify: STT container restart does not affect the agent backend.

## Out of Scope (explicitly not v1)

- Text-to-speech / voice output.
- Hands-free conversation mode.
- Wake-word detection ("Hey Aman").
- Streaming / live-as-you-speak transcription.
- Speaker diarization (who said what in multi-speaker audio).
- Voice cloning or custom voice training.
- Speaker identification.
- Real-time translation.
- Clipboard input/output bridge.
- Cloud fallback of any kind.

## Later phases

- **Local TTS:** speech synthesis for Aman responses, voice selectable, running on-device.
- **Hands-free mode:** opt-in per session; Aman listens for pauses, responds by voice, keeps the conversation going until the user exits. Visual transcript stays on screen.
