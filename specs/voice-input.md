# Spec: Local-First Voice Loop (v2)

## Problem

Aman is text-only. A personal AI assistant on the user's own hardware should support voice input: tap a button, speak, and have the words transcribed locally with no audio ever going to a third-party transcription or AI service.

## Solution

A local speech-to-text pipeline feeding the chat composer. The user records a message by voice, it is transcribed on the user's own hardware, and the transcript lands in the composer as editable draft text. Later phases add local text-to-speech and an optional hands-free conversation mode.

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
- Fail-closed microphone lifecycle: stream tracks are stopped (not muted) on session end, error, timeout, or backgrounding.
- Microphone permission request, denial, and revocation handling.

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
- Listens on a shared user-defined Docker bridge network that both `aman-stt` and the agent backend join (container-name DNS does not resolve on Docker's default `bridge` network, so the default bridge is ruled out). The browser never talks to it directly (see Integration).
- The backend reads the sidecar address from `STT_BASE_URL` (default `http://aman-stt:8001`) and checks `/healthz` at startup via the `warmEmbeddingsAtBoot`-style hook in `main.ts`.

## Resource isolation: STT vs embedding model

This is the hard requirement. Both Whisper-small and the retrieval embedding model run on the local CPU. Both are bursty (STT active only while the user speaks; embedding active at query time), but bursts can overlap and neither may starve the other.

**Decision: disjoint CPU pinning as the primary mechanism, thread caps as the secondary.**

1. **CPU sets (hard boundary).** Pin each workload to disjoint cores via `--cpuset-cpus`, set as a deploy-time parameter with a derivation rule (4 performance cores for STT, disjoint from the embedding set). Reference default on a 20+ core host: `aman-stt` gets `"16-19"`; the embedding model process/container is pinned to the remaining cores, excluding the STT set. On smaller hosts the deployer sets a valid disjoint set.
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
- Max body: 30MB (~16 min at 16kHz mono 16-bit; v1 cap, reject larger with 413)
- Optional query params: `language` (ISO code, e.g. `en`, `es`; omit for auto-detect). v1 passes no language hint (auto-detect); the parameter exists for later use.

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
- `503` model not warm yet (container still loading; the backend retries with bounded backoff per the Backend endpoint contract)

### `GET /healthz`

Returns `{"status": "ok", "model_loaded": true}`. Used by the agent backend at startup and by orchestrators.

### Notes

- No auth on v1: the endpoint is reachable only on the internal Docker network. The browser never calls it directly (see Integration). If the STT port is ever published beyond the bridge network, add a shared-secret header then.
- No streaming endpoint in v1. If streaming is later needed, it is a new endpoint (`/v1/transcribe/stream`, chunked transfer), not a modification of this one.

## Integration point

1. Mic button in the chat composer (next to send). **Tap-to-toggle:** tap to start recording, tap again to stop and transcribe.
2. Browser captures via `getUserMedia`, encodes 16kHz mono WAV client-side.
3. Audio is POSTed to the **agent backend** at `POST /api/v1/voice/transcribe` (new `createVoiceRouter`, mounted unconditionally via `app.route()` alongside the existing API routers; gated internally by the `voice` capability flag), not directly to `aman-stt`. The endpoint requires the same authenticated session as the chat API. The backend forwards to the STT sidecar and returns the transcript. Rationale: single network trust boundary; STT stays on the internal network. The backend never writes audio to disk: it enforces a streaming byte cap that aborts with 413 while reading, holds the body in memory only, logs no audio or transcripts, and releases the buffer after forwarding.
4. Transcript is inserted into the composer text field as **editable draft text**. If the composer already has typed text, the transcript is appended with a separating space, never replacing existing content. The user reviews, edits if needed, and sends normally. This is also how 3-minute-cap "record another segment" composes with prior text.
5. After tap-to-stop the composer shows a transcribing state ("Transcribing…") with a cancel button, covering stop → text-or-error. Cancel releases the mic and discards the in-flight request. While transcribing, the mic control is unavailable (cancel is the only action); if the recording UI unmounts or the route changes mid-transcription, the in-flight request is aborted and the late result is discarded.
6. On STT failure (timeout, 503, 413): show an inline, dismissible error in the composer ("Transcription failed, try again or type instead"). Never block the composer; typed input always works.
7. Transcribed-then-sent messages are indistinguishable from typed messages downstream: they enter normal chat history and the memory pipeline exactly as if typed. No special agent handling, no metadata flag in v1.

### Backend endpoint contract

`POST /api/v1/voice/transcribe` (browser ↔ backend seam).

**Request:** `Content-Type: audio/wav` (16kHz mono 16-bit PCM WAV, client-encoded). No query params in v1 (`language` is not accepted or forwarded; auto-detect only). The endpoint authenticates the session before reading the request body; unauthenticated requests are rejected with 401 before any audio bytes are buffered.

**Forwarding:** the backend POSTs the body as-is to `{STT_BASE_URL}/v1/transcribe` with a 60s forward timeout, holding it in memory only (streaming byte cap aborts with 413 while reading; the 3-minute recording cap is client-side-only, the server enforces the 30MB byte cap). Retries apply to immediate 503 responses only (model not warm), not to forward timeouts: 3 attempts, 2s apart, for a total retry budget under 10s, well inside the 65s client timeout. A forward timeout is returned to the browser as a failure immediately with no retry. Browser-side cancel aborts only the browser's request; it does not propagate to the backend or sidecar (the in-flight forward runs to completion or timeout and its result is discarded).

**Response (200):** the sidecar's JSON (`text`, `language`, `duration_ms`, `model`) returned to the browser unchanged. The composer inserts `text` as the editable draft.

**Errors (browser-visible):**
- `401` unauthenticated (before any body bytes are read)
- `413` body exceeded the 30MB cap while streaming
- `400` sidecar rejected the audio (forwarded)
- `503` sidecar unavailable or still not warm after retries; body `{"error": "voice input unavailable"}`. The composer shows the standard inline transcription-failure error. No client-side retry.

### Voice capability flag

The `voice` capability flag (`capabilities.voice` in `/api/v1/capabilities`) is computed at backend startup from a non-blocking `/healthz` check against `aman-stt`: `true` iff the sidecar responds ok. The check is advisory only; the backend boots regardless of STT state. While the check has not yet resolved, the flag reads `false` (mic hidden until the check completes). The backend re-checks `/healthz` on a background interval (every 30s, non-blocking) and the cached flag reflects the latest result, so a recovered sidecar flips the flag without a backend restart. The frontend re-fetches `/api/v1/capabilities` (every 5s for up to ~1 minute, then on focus/route change only) until the voice flag reads true, so the mic appears once the check resolves or the sidecar recovers. The mic affordance latches: once the frontend has observed the flag true, later refetches never hide the mic within the session. Mid-session STT loss surfaces as the inline transcription error, not a disappearing button; the "flag off hides the mic" rule applies only before the first true is observed.

- Flag on: mic button renders in the composer; the route transcribes normally.
- Flag off: the route stays mounted but returns 503 `{"error": "voice input unavailable"}`; the frontend hides the mic button (both ends key off the same `/api/v1/capabilities` response).
- Mid-session STT loss: the button stays visible for the session; failures surface as the inline transcription error.

### Microphone lifecycle (fail-closed)

- Recording start acquires the mic via `getUserMedia`. The recording indicator reflects the actual stream state: shown only while live tracks exist, cleared only after they are stopped.
- On tap-to-stop, session end, any error, or timeout, the client calls `track.stop()` on every `MediaStreamTrack`. Muting is not sufficient.
- If the tab is backgrounded (`visibilitychange` to hidden) or the page unloads while recording, the client releases the mic immediately. In-app route changes also end the session: tracks are released on recording-UI teardown (component unmount) and on route transitions, since `visibilitychange`/unload do not fire for SPA navigation.
- Maximum recording duration is 3 minutes (~5.8MB at 16kHz mono 16-bit, well under the 30MB body cap). The client stops recording automatically 5 seconds before the cap, transcribes what was captured, and shows in the composer: "Recording stopped at the 3-minute limit. Tap the mic to record another segment."

### Microphone permission

- First tap triggers the browser permission prompt. The mic button's label and tooltip ("Record voice message") state the purpose before the prompt appears.
- Denial: the button stays visible in a tappable "denied" visual state (not `disabled`, which cannot receive taps). Browsers do not re-show a permission prompt after a hard deny, so tapping the denied-state button opens a popover (or inline panel) explaining how to re-enable mic access in browser site settings ("Microphone access denied. Enable it in your browser settings to use voice input, or type instead.") with a "Try again" action; a desktop tooltip is an enhancement on top, not the only path. "Try again" calls getUserMedia: it succeeds silently if the user already re-enabled access in site settings, re-shows the browser prompt only when the browser allows one (soft deny), and otherwise the popover remains. On a successful acquisition the button returns to its normal recording state. Typed input always works. The app never calls getUserMedia without the explicit "Try again" tap.
- Revocation: the user revokes via browser site settings at any time. The next recording attempt behaves like a fresh denial: tracks released, button transitions to the tappable denied visual state, and tapping it opens the same explanatory popover with "Try again".

**Latency budget:** warm-model p95 for a 10s utterance is under 3s end-to-end (capture stop to text in composer). Measurement protocol: 50 sequential 10s utterances, warm model, timed from capture stop to text rendered in the composer. The tuning test measures the same span. If missed, first lever is dropping to Whisper `base`.

**Timeouts:** client-side transcription timeout 65s; backend-to-sidecar forward timeout 60s. The client timeout slightly exceeds the backend's so the backend's response reliably lands before the client's abort. A 3-minute recording transcribes in ~36s at 0.2x real-time factor, so 60s covers the worst case with margin. On timeout the composer shows the standard transcription-failure error.

## Privacy

- Audio path: browser mic -> the user's own agent backend over the same authenticated connection as chat -> Docker bridge -> `aman-stt` -> transcript back. Audio never goes to a third-party transcription or AI service and no cloud STT fallback exists. (When the browser reaches the backend remotely, audio transits the user's own remote-access path the same way chat text does; it is never sent to anyone else for processing.)
- No audio is written to disk by the STT service (in-memory only). No transcripts are logged by the STT service (log durations and error codes only).
- No cloud STT fallback, ever. If local STT is down, the failure mode is "type instead," not "try a cloud API."
- No wake-word listening. The microphone is only active while the user has tapped to record.
- Offline mode: the STT pipeline is fully local (browser mic to agent backend to Docker bridge) and keeps working when offline mode is on. No part of the voice path needs the internet. (Assumes model weights are already cached in the sidecar volume; the first-run download needs internet once.)

## Testing

- Synthetic speech samples, no real user voice stored in tests.
- Verify (journey): `voiceComposer.browser.test.ts` alongside the composer browser tests: render the composer, tap the mic, feed synthetic speech, and assert editable draft text lands in the composer input and is sendable.
- Verify: tap-to-toggle on a synthetic speech sample produces the expected transcript (word error rate under 10%).
- Verify: packet capture during a voice session shows zero egress to non-local addresses.
- Verify: p95 transcription latency stays under 3s (same measurement protocol as the latency budget) while embedding queries run concurrently.
- Verify: restarting `aman-stt` mid-session returns 503 then recovers; the agent backend serves chat throughout with no errors.
- Verify: after stop, error mid-recording, tab backgrounding, and SPA route transition mid-recording, every mic track reports `readyState === 'ended'` and the recording indicator is cleared.
- Verify: at the 3-minute cap the client stops automatically, transcribes, and the composer shows the limit message.

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

- **Local TTS:** speech synthesis for Aman responses, voice selectable, running on-device. Its spec must define: when Aman speaks vs stays silent, per-message vs global controls, how playback stops mid-response, where voice selection lives in the UI, and the engine/runtime contract.
- **Hands-free mode:** opt-in per session; Aman listens for pauses, responds by voice, keeps the conversation going until the user exits. Visual transcript stays on screen. Its spec must define: entry and exit mechanism, pause detection behavior, barge-in during Aman speech, idle timeout, and fail-closed mic release on error or backgrounding.
