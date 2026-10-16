# Spec: Local-First Voice Loop

**Status:** implemented

**Scope note:** v1 ships local speech-to-text input only: a tap-to-record mic button in the chat composer, transcribed by the local `aman-stt` sidecar. Text-to-speech playback, hands-free mode, the push-to-talk hotkey, and the clipboard bridge are future work; the sections below describe the full target.

## Problem

Aman is text-only. A personal AI assistant on the user's own hardware should support voice: push-to-talk for quick queries, hands-free conversation mode, and local speech synthesis so no audio ever leaves the device.

## Solution

A voice loop with three parts: speech input (push-to-talk and hotkey), local text-to-speech for responses, and an optional hands-free conversation mode. Clipboard input/output as a bridge for accessibility.

## Design Decisions

**Local speech processing only.** Both speech-to-text and text-to-speech run on the Spark. No audio is sent to cloud APIs. This is non-negotiable for the privacy positioning.

**Push-to-talk first, hotkey second.** Hold a button (or keyboard shortcut) to talk, release to send. Simpler and more reliable than wake-word detection for v1.

**Hands-free mode** is opt-in per session: Aman listens for pauses, responds by voice, and keeps the conversation going until the user exits. Visual transcript stays on screen.

**Clipboard I/O** as an accessibility bridge: copy Aman's response to clipboard with one tap, paste text in as an alternative to typing.

## Scope

- Push-to-talk button in chat UI (mobile and desktop)
- Configurable hotkey for push-to-talk on desktop
- Local TTS for Aman responses (voice selectable)
- Hands-free conversation mode (opt-in per session)
- Copy response to clipboard
- Paste from clipboard as input
- Visual transcript always visible during voice sessions

## Privacy

- Audio never leaves the device
- No wake-word listening when the feature is off (no always-on microphone)
- Document the audio data flow in the privacy dashboard

## Testing

- Synthetic speech samples, no real user voice stored in tests
- Verify: push-to-talk transcribes correctly in a quiet room
- Verify: TTS output is intelligible
- Verify: hands-free mode starts and stops cleanly
- Verify: no network calls to speech APIs during a voice session (packet capture)

## Out of Scope

- Wake-word detection ("Hey Aman")
- Voice cloning or custom voice training
- Speaker identification
- Real-time translation
