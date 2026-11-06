# Spec: Phone Calls

**Status:** implemented

**Scope note:** This spec covers phone calls as a channel of the delivery feed in [Reaching You](notifications-delivery.md): placing a call, what the assistant says, the conversation on the call, a missed call, and the call routes on the Twilio listener from [Text Messages](text-messages.md). When a call is placed is decided by [Noticing](noticing.md). The voice itself is the voice loop from [Local Voice Loop](local-voice-loop.md), with the phone as one more way in.

## Problem

A `call` decision had nowhere to go: it was delivered as a nudge. Something truly urgent, like a clash an hour away, could wait in the bell until the person next opened Aman. A phone call reaches a person who is away from every screen. But anyone near the phone can pick up, the call travels through other companies, and a voice "yes" is easy to fake or mishear, so a call must say little until the person agrees and must never approve anything.

## Solution

When the rules allow a call, Aman asks Twilio to ring the person's confirmed number. When someone picks up, Twilio opens a media stream back to Aman, and the call becomes a voice session of the voice loop: the same speech detection, speech-to-text, text-to-speech and assistant, with the phone line as its transport. The phone line carries 8 kHz mu-law both ways and says that it takes no approvals.

## The call

- **Opening:** `Hi, it's <assistant name>. <Kind>. Is this a good time?` The kind uses the same words as a private text ("Something needs you", "A reminder is due"). Nothing else is said, and nothing the person says goes to the model, until they say yes.
- **Yes:** the assistant says the one-sentence message and asks "Want me to do something about it?". From then on each thing the person says is a turn in a new chat called "Phone call", with the same assistant, tools and rules as in the app. The chat starts with the line the assistant said on the phone. It uses the assistant of the person's chat the delivery points to, or else of their latest chat, or else the one a new chat in the app starts on (the default model, with the sandbox as the server has it), so a person who has never chatted still gets the conversation. Only a server with no model at all says it is in the app and hangs up.
- **No:** the assistant says goodbye and hangs up. **Unclear twice:** it says it will leave it in the app and hangs up.
- **No approvals.** A card a turn asks for is left waiting in the app, and the assistant says so once. A spoken "yes, send it" is sent to the chat as an ordinary message, never as an answer to a card.
- A call lasts at most 10 minutes. The person can interrupt the assistant at any time.
- The assistant's name comes from the person's own Personalization settings. No name is written into the code.

## A missed call

- Twilio's answering machine detection tells a person from a machine. A machine gets one short voicemail: `<assistant name> here, something needs you, please open the app.` A fax, busy line, no answer, or failed call gets no voicemail.
- Then, once only, the delivery is tried as a text (when texts are on) and as a push notice. A call is never placed again for the same delivery.
- When the call cannot be placed at all, the text and push are tried at once.

## When it calls

The rules are Noticing's, unchanged: the kind is ticked for calls (or the reminder is urgent and "Call me for reminders I mark urgent" is ticked), calls are switched on, it is not during quiet hours, and the time between calls has passed. The call sender also needs Twilio set up, calls switched on and a confirmed number. Otherwise nothing rings and the delivery stays a nudge. A new install has calls off and rings no one.

## The call routes

- Calls use the separate Twilio listener of texts, on the same port. Twilio is told the addresses each time Aman places a call, so there is nothing to set in the Twilio console.
- `POST /twilio/voice` answers the pick-up, `POST /twilio/call-status` hears how the call ended, and `/twilio/media` is the media WebSocket (`wss://`). All three are behind the same signature check as `/twilio/sms`. A WebSocket upgrade is checked over its public address before the socket opens.
- The media stream is accepted only for a call Aman placed. When the call is picked up, Aman makes a one-time key, keeps only its SHA-256 hash, and hands the key to Twilio in the stream's parameters. The stream must present that key with the same call SID within 30 seconds, and the key works once. A call record expires 5 minutes after it is placed. Anything else is closed before a sound is played.
- Calls to the Twilio number are not answered.

## Delivery

- Calls are a delivery channel sender (`channel: 'call'`). It acts only on level call. Push notices skip level call, so a call and a push are never sent together.
- Each call is a channel attempt on its delivery, written to Activity as `delivery.call`: ringing, then how it ended (talked, not now, voicemail, no answer, failed), with the chat when there was one. The target names the number only by its last four digits.
- The delivery service gains two calls: record a later attempt on a delivery, and fall back to other channels once.

## Reach me settings

- With Twilio set up, the Calls row is available and shows the privacy note: "Calls and texts travel through Twilio and the phone company. The assistant's voice and the transcript are made on your computer."
- Calls can be switched on only once the number under Texts is confirmed.
- Try it rings the person's phone with a test call. A test call never sends a text or a push.

## Design Decisions

- **The conversation is the voice loop, not Twilio's speech.** Twilio carries the sound only. Speech-to-text, text-to-speech and the assistant run on the person's computer, as in voice mode.
- **The call talks in its own chat as the person.** A call has no browser and no sign-in. Turns go through the app's own turn routes, called as a function inside the server process, so the same permissions and approval rules apply. Who the request is for travels as an in-memory object handed to the app's handler, never as a header, cookie or anything else a request can carry, so no request from the network can claim it. The grant covers only that call's chat and ends when the call ends.
- **Approvals are off by transport.** The phone line reports `voiceApprovals: false`, so the voice loop never reads a card back as something to confirm, and the call's turn runner refuses any answer to a card.
- **Private first.** The phone cannot tell who picked up, so the opening says only the kind of thing.
- **One fallback, never a retry.** A call record can claim its fallback once.
- **No new dependency.** Twilio's REST API is called with the repo's own fetch through the public-address guard, and the WebSocket server is the one the voice loop already uses.

## Scope

- `phone_call` table on SQLite and Postgres, with a shared store contract suite. It is runtime state and is not exported.
- The phone line transport, the call's turn runner, the call service, and the call routes on the listener
- The `call` delivery channel and the Reach me calls row
- Data export and import: calls come in switched off, as before

## Privacy

- Twilio and the phone company carry the call and see the number. They hear what is said.
- The assistant's voice and the transcript are made on the person's computer. No speech service on the internet is used.
- Aman does not record the sound of a call. The transcript is the "Phone call" chat, from the moment the person said yes.
- Spoken lines say "the app", never the product name, like texts.
- Aman never logs the number, what was said, the one-time key or the auth token.

## Testing

All tests use synthetic data, never a person's real data.

- An unsigned webhook or WebSocket upgrade is refused; the listener serves nothing but its own routes
- A request from the network gets no identity on the app or the Twilio listener, whatever headers it carries; the in-process grant covers one chat and ends with the call
- A person who has never chatted still gets the conversation, on the assistant a new chat starts on
- An unknown call, a wrong or reused key, and an expired key or call cannot open a media stream
- No answer leaves one voicemail, one text and one push, and no retry
- An approval asked for on a call is left waiting, even when the person says the exact words
- Private opening says only the kind until "yes"; "no" hangs up without opening a chat
- Mu-law round trip and resampling to 16 kHz
- A new install calls no one; quiet hours and the time between calls hold calls back
- Shared store contract tests on SQLite and Postgres

## Out of Scope

- Calls to Aman, and calls to anyone but the person
- Approving anything by voice on a call
- Providers other than Twilio
- Recording the sound of a call
