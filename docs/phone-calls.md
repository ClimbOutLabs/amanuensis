---
title: 'Phone calls'
description: 'Let your assistant call you, in its own voice, when something urgent needs you.'
---

Your assistant can phone you when something urgent needs you. You can talk it through on the call. Calls are off until you turn them on, and a new install calls no one.

Calls go through Twilio, the same service as [Text messages](/text-messages). You pay Twilio for each call.

## When it calls

A call only happens when all of these are true:

- you switched calls on in Settings, Reach me, and your number is confirmed;
- you ticked that kind of event under "What may call you", or ticked "Call me for reminders I mark urgent" and marked the reminder urgent;
- it is not during your quiet hours (21:00 to 08:00 unless you change them);
- there was no other call in the last 6 hours (you can change the gap).

Otherwise the same thing reaches you as a nudge, and the bell says why.

## What the call sounds like

- The call uses your assistant's own voice, made on your computer. Its name is the one you chose in Personalization.
- It starts with only the kind of thing: "Hi, it's Mannie. Something needs you. Is this a good time?" It says more only after you answer yes. Say no and it says goodbye. The phone cannot tell who picked up, so nothing private is said first.
- After your yes it tells you what it is about and asks "Want me to do something about it?". From then on it is a normal voice conversation with the same assistant, tools and rules as in the app. You can ask questions and interrupt it.
- **Nothing is approved on a call.** Anything that would send, save or change something is left waiting in Aman for you to approve. The assistant says so. Looking things up and answering questions are fine.
- A call lasts at most 10 minutes.

## If you do not answer

If no one answers, or a voicemail picks up, the assistant leaves one short voicemail that says only "Mannie here, something needs you, please open Aman." Then it sends one text (if texts are on) and one notice to your devices. It never calls again about the same thing.

## What you see afterwards

Each call is recorded in Activity: when it was, how it ended, and anything left waiting for your ok. What was said on the call is written in a chat called "Phone call", starting from the moment you said yes.

## Set it up

1. Set up [Text messages](/text-messages) first. Calls use the same Twilio account, number and settings, and they ring the number you confirmed there. Your Twilio number must be able to make voice calls.
2. Make sure the voice and speech parts of Aman are running. Calls use the same voice and speech-to-text as voice mode. See [Voice input](/voice-input).
3. In Settings, Reach me, switch Phone calls on, tick what may call you, save, and press Try it next to Phone calls. Your phone rings with a test call. A test call never sends a text.

There is nothing to set in the Twilio console for calls. Aman tells Twilio where to reach it each time it calls. Calls to your Twilio number are not answered by Aman.

## Let Twilio reach Aman

Calls use the same separate Twilio door as texts, on the same port (8793 unless you changed it). Twilio reaches it at three addresses under your `TWILIO_WEBHOOK_PUBLIC_URL`:

- `/twilio/voice`, when you pick up;
- `/twilio/call-status`, when the call ends;
- `/twilio/media`, a WebSocket that carries the sound of the call, as `wss://` at the same address.

Every request must carry Twilio's signature. The sound connection must also carry a one-time key that Aman gave Twilio for that same call, and it works only once, within 30 seconds. Aman refuses anything else. The door never shows the Aman app or the sign-in page. Never publish the main Aman port.

- **Tailscale Funnel, on that port only.** `tailscale funnel 8793` carries the WebSocket too. Nothing else is needed.
- **Your own domain with https.** Your web server must pass WebSockets on. Caddy does this on its own. With nginx, add the `Upgrade` and `Connection` headers for the `/twilio/` path.

## Privacy

Calls and texts travel through Twilio and the phone company. They hear the call and see your number. The assistant's voice and the transcript are made on your computer. No speech service on the internet is used. Aman does not record the sound of the call, and it never writes your number or what was said to its logs.

See [Privacy](/privacy).
