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

**One owner.** `VoiceSession` takes audio frames in and puts audio frames out through a `VoiceTransport` (input format, output format, `voiceApprovals`, send audio, clear audio, send event, close). The browser WebSocket is the first transport. A phone line (Twilio Media Streams, 8 kHz mu-law) is a second transport with `voiceApprovals: false` (see [Phone Calls](phone-calls.md)); the engine decodes mu-law input and asks the voice for mu-law output. The one engine addition for it is `say`, which speaks a line no turn asked for, such as a call's opening, and can be interrupted like any reply.

**The loop.** Audio, then speech detection, then `/v1/transcribe` on `aman-stt` (contract unchanged), then a normal agent turn exactly as for a typed message (the app's own turn route, with the person's own session, so auth, tenant scoping and approvals are the same), then sentence splitting, then streaming `aman-tts`, then audio out. Turns are saved as normal chat text.

**Speech detection.** Silero VAD v5.1.2 (MIT, 2.3 MB ONNX), run in the server through onnxruntime, which the server already ships. It sits in the server because a window is 32 ms and a separate service would add a network hop to each one. The file is baked into both images at build time (`ADD --checksum`, so the build fails on any other file) and the server loads it only after its size and SHA-256 match the same pin; a test keeps the Dockerfile hashes and the server pin equal. The server never downloads it. Host development fetches it with `pnpm voice:model`.

**Interrupting.** Speech that starts while the voice is talking must be stronger and longer than normal speech start (probability 0.7 for 400 ms) before the voice stops and playback is cleared. An echo guard drops mic sound that matches what was just sent to the speakers (loudness correlation with up to 800 ms delay) or that repeats the spoken words.

**Approvals by voice.** After a turn that waits on one approval card, the engine reads it back and listens for an exact phrase. The read-back covers everything the card does (an email's subject and body, a calendar event's time and description, a schedule's task). The answer uses the chat's own approval input for that tool call, for one time only (`scope: once`); the server's change check refuses it if the held call is no longer what was read, and refusal codes map to plain messages (including `changed`). Only the exact phrases count, and not as a question. Never during speech, nor within 1.5 s after the assistant stops (timed by when the audio arrived). After one reminder, other speech is a new turn. Voice is an allow-list: only a plain email (no hidden copy, no new recipient), a new calendar event with no guests, and deleting a schedule are read, and every field of each of those shapes is listed in the code as read or required empty; a card with none of those shapes (a file write, a plan, a mark-as-read), every field the code has not classified, and a card that holds the answer phrase stay on screen. Whether the voice would say a read-back exactly as written is decided once, by `aman-tts`, in the same call that speaks it: the whole body of the card goes to `POST /v1/speak` as one text with `exact: true`, and the service refuses with `x-aman-reason: would_change_text` before any sound (a number said another way, two numbers written side by side with only a silent or pause-only sign between them or joined by "and" inside one amount, a web-address-like dot, a link, a list mark, a sign, a letter outside plain English) or else speaks that same text and marks the answer `x-aman-exact: checked`. The engine treats an exact answer without that mark, or that is not audio, as unchecked and speaks nothing, so a voice service that does not know `exact` can never make a card wait. The engine never cuts a card's text itself. The line telling how to answer is a separate call, made only after the body was made. When the body is refused or fails, nothing of the card is read and it stays on the screen; a refusal is not reported as a broken voice. The body is written with the server's own counts and words first ("I'll send this email to 2 addresses", "I'll add 1 event", "I'll delete 1 schedule"), then each address, and each person-supplied short field (title, subject, a recipient's name, the sender name, place, schedule name) last on a line of its own after a fixed label ("The subject is: ..."); an address is said before the name next to it ("To eve at evil dot com, named Victor"), so nothing follows a person's text on its line. A person's text is read as written: it can add words but cannot hide or replace a real address or field, and an extra address would not match the count already heard. Event and schedule cards end with a server-made line that says the real time again ("Once more, the event is on ...") after all person text. A short field with a line break keeps the card on the screen; stops and marks inside it are read as written. Numbers written side by side are judged by one rule: two spellings (digits, digits and a scale word such as "5 million", or a run of number words) joined by a silent or pause-only gap (including dashes and ellipses), or by "and", "an", "n" or "&" when the left ends in a scale and the right is smaller (so "1000 and 500" is refused, "Between 100 and 150" and "two hundred and fifty" are read), are refused unless they are a date or time written with a comma after a month or weekday. The answer must be plain words, each with at most one `,` `.` or `!` after it, and closing quotes; a question mark, an ellipsis or a dash is not an answer. Speech that began before the card was read out is never an answer to it: it gets the reminder like any other words. A reply that is cut off, including the part queued behind an "I missed that" line, cannot be answered, and the screen is told when a card was cut off before it could be waited on. When the voice would not say the body exactly, the engine says so in plain words ("I can't read that one out exactly") and shows the same notice; an exact answer from an out-of-date voice service is noted `tts_unchecked` and shown as "The voice service is out of date. Run aman upgrade, then try again.", not as a broken voice. For a reply, the message it answers is shown on the screen, not read. What is read also includes the name a mail is sent as, a name left off an address, a duplicate event, an event that falls on several days, and a schedule that is deleted for good; address dots and hyphens are said, and a time zone written as an offset stays on the screen. The card is waited on only when every part of the read-back made sound, and it stops being waited on when the chat has moved on, for example when it is answered on the screen (the chat's newest turn is no longer the card's turn). A transport with `voiceApprovals: false` never asks.

**Connection.** `POST /api/v1/voice/connect` (behind normal auth) checks the chat is the caller's and issues a single-use 30 s ticket (at most 10 asks a minute per person, 5 open tickets per person; the page must be one of the app's own origins, the Host header is not trusted; a person can hold at most 3 of the 20 places across tenants; audio may run at most 5 s ahead of real time, and at most 2 utterances are turned into words at once). The upgrade also needs an allowed Origin, and the server holds at most 20 conversations. When mutual TLS is on, the upgrade is also refused unless the connection presented a client certificate our authority verified; the server's own calls back into its routes (the chat check and each turn) go through `inProcessFetch`, the one in-process path the certificate check lets through. The WebSocket at `/api/v1/voice/stream` carries the ticket as a sub-protocol, never in the address. Binary frames are 16 kHz 16-bit samples in and 24 kHz 16-bit samples out; text frames are JSON events (`ready`, `clear`, `state`, `heard`, `turn_saved`, `notice`, `tts_failed`), described once in `packages/trueforge-core/src/schemas/voiceLine.ts` for the server and the page. `tts_failed` is sent once per reply that could not be turned into sound; the page tells the person the reply is in the chat, and any other kind of line can use it to notice it went quiet.

**Time limits.** A conversation ends after 2 minutes with no speech (judged on the server by the speech model) and after 30 minutes in any case, with a plain-words notice. Input that arrives more than about 5 s ahead of real time (credit refills with the clock and cannot be saved up) closes the line, and so does more than about 5 s of audio waiting to be listened to. At most 2 utterances are turned into words at once; a third is dropped with an "I missed that" notice that is shown, and spoken too unless something is already being said; talking over the spoken line stops it and leaves a waiting card as it is.

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
