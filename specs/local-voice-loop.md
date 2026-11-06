# Spec: Local-First Voice Loop

**Status:** implemented

**Scope note:** Everything in Scope below has shipped: tap to record, hold to talk (the mic or configurable keys), replies read aloud by the local `aman-tts` voice with the browser voice as a fallback, voice mode (a live spoken conversation), paste from the clipboard, and copy on every answer. A voice send marks its turn `spoken_reply`, so the model is told its answer will be read aloud and keeps it short and plain. The audio data flow is documented in `docs/voice-input.mdx` ("Where your voice goes"); the privacy dashboard links it when the dashboard ships.

## Problem

Aman is text-only. A personal AI assistant on the user's own hardware should support voice: push-to-talk for quick queries, a live voice conversation, and local speech synthesis so no audio ever leaves the device.

## Solution

A voice loop with three parts: speech input (push-to-talk and hotkey), local text-to-speech for responses, and an optional live voice mode. Clipboard input/output as a bridge for accessibility.

## Design Decisions

**Local speech processing only.** Both speech-to-text and text-to-speech run on the Spark. No audio is sent to cloud APIs. This is non-negotiable for the privacy positioning.

**Push-to-talk first, hotkey second.** Hold a button (or keyboard shortcut) to talk, release to send. Simpler and more reliable than wake-word detection for v1.

**Voice mode** is opt-in per session and replaces the earlier browser-only hands-free mode. One engine on the server (`packages/trueforge/src/voice`) owns the whole spoken conversation. See "Voice engine" below.

**Clipboard I/O** as an accessibility bridge: copy Aman's response to clipboard with one tap, paste text in as an alternative to typing.

## Scope

- Push-to-talk button in chat UI (mobile and desktop)
- Configurable hotkey for push-to-talk on desktop
- Local TTS for Aman responses (voice selectable)
- Voice mode, a live spoken conversation (opt-in per session)
- Copy response to clipboard
- Paste from clipboard as input
- Visual transcript always visible during voice sessions

## Voice engine

**One owner.** `VoiceSession` takes audio frames in and puts audio frames out through a `VoiceTransport` (input format, output format, `voiceApprovals`, send audio, clear audio, send event, close). The browser WebSocket is the first transport. A phone line (Twilio Media Streams, 8 kHz mu-law) is a second transport with `voiceApprovals: false` and needs no engine change; the engine decodes mu-law input and asks the voice for mu-law output.

**The loop.** Audio, then speech detection, then `/v1/transcribe` on `aman-stt` (contract unchanged), then a normal agent turn exactly as for a typed message (the app's own turn route, with the person's own session, so auth, tenant scoping and approvals are the same), then sentence splitting, then streaming `aman-tts`, then audio out. Turns are saved as normal chat text.

**Speech detection.** Silero VAD v5.1.2 (MIT, 2.3 MB ONNX), run in the server through onnxruntime, which the server already ships. It sits in the server because a window is 32 ms and a separate service would add a network hop to each one. The file is baked into both images at build time (`ADD --checksum`, so the build fails on any other file) and the server loads it only after its size and SHA-256 match the same pin; a test keeps the Dockerfile hashes and the server pin equal. The server never downloads it. Host development fetches it with `pnpm voice:model`.

**Interrupting.** Speech that starts while the voice is talking must be stronger and longer than normal speech start (probability 0.7 for 400 ms) before the voice stops and playback is cleared. An echo guard drops mic sound that matches what was just sent to the speakers (loudness correlation with up to 800 ms delay) or that repeats the spoken words.

**Approvals by voice.** After a turn that waits on one approval card, the engine reads it back and listens for an exact phrase. The read-back covers everything the card does (an email's subject and body, a calendar event's time and description, a schedule's task). The answer uses the chat's own approval input for that tool call, for one time only (`scope: once`); the server's change check refuses it if the held call is no longer what was read, and refusal codes map to plain messages (including `changed`). Only the exact phrases count, and not as a question. Never during speech, nor within 1.5 s after the assistant stops (timed by when the audio arrived). After one reminder, other speech is a new turn. Typed-confirmation cards, shell and spending cards, new or hidden recipients, long bodies, connector arguments, new schedules, calendar guests, personas and multiple cards stay on screen. A transport with `voiceApprovals: false` never asks.

**Connection.** `POST /api/v1/voice/connect` (behind normal auth) checks the chat is the caller's and issues a single-use 30 s ticket (at most 10 asks a minute per person, 5 open tickets per person). The upgrade also needs an allowed Origin, and the server holds at most 20 conversations. The WebSocket at `/api/v1/voice/stream` carries the ticket as a sub-protocol, never in the address. Binary frames are 16 kHz 16-bit samples in and 24 kHz 16-bit samples out; text frames are JSON events (`ready`, `clear`, `state`, `heard`, `turn_saved`, `notice`).

**Time limits.** A conversation ends after 2 minutes with no speech (judged on the server by the speech model) and after 30 minutes in any case, with a plain-words notice. Input that arrives faster than real time (about 2 s of backlog) closes the line.

**Latency target.** Under 2 s from the end of speech to the first sound. `pnpm voice:latency` runs the real speech model and voice with stand-in speech-to-text and model delays; the engine's own share is about 1.05 s (0.6 s to decide speech ended, about 0.45 s to first audio on 4 shared cores). Speech-to-text and the hosted model's first sentence must be measured on the real machine.

## Privacy

- Audio never leaves the device; voice mode keeps no audio and no transcript beyond the saved chat message
- Voice mode adds no network call: the speech-detection model is baked into the image
- No wake-word listening when the feature is off (no always-on microphone)
- Document the audio data flow in the privacy dashboard

## Testing

- Synthetic speech samples, no real user voice stored in tests
- Verify: push-to-talk transcribes correctly in a quiet room
- Verify: TTS output is intelligible
- Verify: voice mode starts and stops cleanly
- Verify: no network calls to speech APIs during a voice session (packet capture)

## Out of Scope

- Wake-word detection ("Hey Aman")
- Voice cloning or custom voice training
- Speaker identification
- Real-time translation
