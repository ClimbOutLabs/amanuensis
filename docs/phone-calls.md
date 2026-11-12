---
title: 'Phone calls'
description: 'Let your assistant call you, in the voice of your computer, when something urgent needs you.'
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

- The call uses the default voice of your computer, not the voice you picked for voice mode, because that choice is kept in your browser. The voice is made on your computer. The assistant's name is the one you chose in Personalization.
- It starts by saying who is calling, who the call is for, and only the kind of thing: "Hi, this is Mannie, calling for Dana. Something needs you. Is this a good time?" The name it calls you by is the one you gave in Personalization. It plays this to the end, and anything said over it does not count as an answer.
- It says more only after a short, plain yes, such as "Yes", "Yeah", "Sure" or "Okay". A longer reply, a question or someone saying "hold on" is not a yes, and neither is a yes that sounds like a question, such as "Yeah?". Then it asks once more. Say no and it says goodbye. If no one answers the question, it asks once more, then says goodbye. If no one said anything at all, it may have been a voicemail, so the call counts as missed and the text and the notice are sent. The phone cannot tell who picked up, so nothing private is said first.
- **Whoever says yes hears the message.** The phone cannot tell if it is you. If someone else answers and says yes, they hear what the call is about and can ask about it. If a kind of thing is too private for that, untick it under "What may call you".
- After your yes it tells you what it is about. A call never reads out a phone number, a link or an address, whatever it is about, because whoever answers hears it. If the words hold one, are very long, or sound like a greeting or a goodbye, the assistant says it does not read them out on the phone and that they are in the app. A text uses the same check, with the same words: the words you added under "Words Aman may text" and your assistant's name are read out, and a word Aman does not know is not. You can then ask about that one thing, and you can interrupt it. On the call it knows only that one thing. It cannot see your mail, calendar, memories or files, and it cannot do or change anything. For anything else, it asks you to open the app.
- **Nothing is approved on a call.** To act on what it called about, open the app.
- A call lasts at most 10 minutes. After that the assistant says goodbye and the line is closed, even if it was in the middle of something.

## If you do not answer

If a voicemail picks up, the assistant leaves one short voicemail that says only "This is Mannie. Something needs you. Please open the app." If no one answers, or the line is busy, no voicemail is left. Either way it then sends one text (if texts are on) and one notice to your devices. It never calls again about the same thing.

If the call cannot be made at all, for example because the voice parts of Aman are not running, the text and the notice are sent at once.

The assistant says the opening and the voicemail only exactly as written. If its voice would say a word differently, for example a name, it says none of that part. Then it hangs up, and the text and the notice are sent instead. The voicemail is simply not left.

After your yes, the message is read out the way your assistant reads any reply, so a time like "2:30 p.m." is said as a time. If the voice cannot speak at all, the assistant hangs up, and the text and the notice are sent instead.

## What you see afterwards

Each call is recorded in Activity: when it was and how it ended. What was said on the call is written in a chat called "Phone call", starting once you heard the message. You can carry on in that chat in the app.

The chat keeps the call as a record, with what was said on both sides in quotes. Each part is labelled: "You, or whoever answered" for the person on the phone, and "The phone helper" for the assistant on the call. Your assistant never takes those words as your own request, or as its own promise, because it cannot know who was on the phone. If you have no chat in the app yet, the call still talks with you, but nothing is written to a chat.

## Set it up

1. Set up [Text messages](/text-messages) first. Calls use the same Twilio account, number and settings, and they ring the number you confirmed there. Your Twilio number must be able to make voice calls.
2. Make sure the voice and speech parts of Aman are running. Calls use the same voice service and speech-to-text as voice mode. A call speaks with the default voice, because the voice you pick is kept in your browser. See [Voice input](/voice-input). While they are not running, Reach me shows calls as not available, and nothing rings. If Reach me says the voice service is out of date, run `aman upgrade`, then try again.
3. In Settings, Reach me, switch Phone calls on, tick what may call you, save, and press Try it next to Phone calls. Your phone rings with a test call. A test call never sends a text, and it does not count toward the time between calls. Each test call costs money, so Try it rings at most once every 2 minutes and 5 times a day.

Aman tells Twilio where to reach it each time it calls, so there is no address to set in the Twilio console. Check two things there:

- A trial Twilio account can only call numbers you verified with Twilio. Verify your number, or upgrade the account.
- Twilio's Voice Geographic Permissions must allow calls to your country. You find them under Voice, Settings. To keep costs low, leave premium and high-cost destinations switched off.

Calls to your Twilio number are not answered by Aman.

## Let Twilio reach Aman

Calls use the same separate Twilio door as texts, on the same port (9201 unless you changed it). Twilio reaches it at three addresses under your `TWILIO_WEBHOOK_PUBLIC_URL`:

- `/twilio/voice`, when you pick up;
- `/twilio/call-status`, when the call ends;
- `/twilio/media/` followed by the call's id, a WebSocket that carries the sound of the call, as `wss://` at the same address. Each call has its own address.

Every request must carry Twilio's signature. The signature on the sound connection covers that call's own address, so it opens no other call, and an address for a call Aman does not know or that already ended is refused before the connection opens. What opens the line is a one-time key that Aman gave Twilio for that same call. The key works only once, within 30 seconds. Aman refuses anything else. The door never shows the Aman app or the sign-in page. Never publish the main Aman port.

- **Tailscale Funnel, on that port only.** `tailscale funnel 9201` carries the WebSocket too. Nothing else is needed.
- **Your own domain with https.** Your web server must pass WebSockets on. Caddy does this on its own. With nginx, add the `Upgrade` and `Connection` headers for the `/twilio/` path.

## Privacy

Calls and texts travel through Twilio and the phone company. They hear the call and see your number. The assistant's voice and the transcript are made on your computer. No speech service on the internet is used. Aman does not record the sound of the call, and it never writes your number or what was said to its logs.

See [Privacy](/privacy).
