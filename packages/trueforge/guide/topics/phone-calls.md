---
id: phone-calls
title: Phone calls from Aman
covers: route:reach
---

Aman can phone you when something urgent needs you. Calls are off until you turn them on.

## Turn calls on

1. Set up texts first. Calls use the same Twilio account and ring the number you confirmed for texts.
2. Make sure voice mode works. A call uses the same voice and listening parts. It speaks with the default voice, because the voice you pick is kept in your browser.
3. Go to **Settings**, then **Reach me**. Switch **Phone calls** on and tick what may call you. Then save.
4. Press **Try it** next to Phone calls. Your phone rings with a test call.

Each test call costs money. So Try it rings at most once every 2 minutes, and 5 times a day.

## When Aman calls

Aman calls only for the kinds of things you ticked, or for a reminder you marked urgent. It does not call during your quiet hours. It waits at least 6 hours between calls. Otherwise the same thing reaches you as a nudge.

## On the call

The call starts with who is calling and who it is for. It names only the kind of thing, then asks if this is a good time. Nothing private is said until you answer with a short yes, such as "Yes" or "Sure".

Whoever says yes hears the message, because the phone cannot tell if it is you. If a kind of thing is too private for that, untick it under "What may call you".

After your yes, Aman tells you what it is about. You can ask about that one thing. It cannot see your mail, calendar or files on the call, and nothing is approved on a call. To do anything about it, open the app.

A call lasts at most 10 minutes. What was said is written in a chat called "Phone call". The chat keeps the call as a record in quotes, and your assistant never takes it as your own request.

## If you miss the call

If a voicemail picks up, Aman leaves one short message that says only that something needs you. If no one answers, it leaves no message. Either way it then sends one text and one notice to your devices. If you connected a Telegram bot, it sends one Telegram message too. It never calls again about the same thing.

If Aman's voice cannot speak on the call, it hangs up and sends the text and the notice instead.

## If calls do not work

- If Reach me says calls are not available, start the voice parts of Aman, then try again in a minute.
- If Reach me says the voice service is out of date, run `aman upgrade`, then try again.
- If the test call never rings, check that your Twilio account may call your number. A trial account can only call numbers you verified with Twilio.
- If Try it says to wait, you pressed it too often. Wait the time it says, then try again.
