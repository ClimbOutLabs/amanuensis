# Spec: Text Messages

**Status:** implemented

**Scope note:** This spec covers texts as a channel of the delivery feed in [Reaching You](notifications-delivery.md): confirming a person's number, what a text says, the one-way STOP rule, the separate listener Twilio talks to, and the Settings, Reach me flow. When a text is sent is decided by [Noticing](noticing.md). Phone calls use the same listener (see [Phone Calls](phone-calls.md)).

## Problem

A nudge only reached a person through the bell and push notices on devices that opted in. A person away from Aman, or with push off, heard nothing. A text reaches any phone, but it travels through other companies, so it must be opt-in, must prove the number belongs to the person, and must say as little as possible by default.

## Solution

One text provider, Twilio, behind a small interface. The person enters a number, gets a one-time code by text, and types it back. Only then can texts be switched on. A nudge or a reminder then goes out as a text, recorded as a channel attempt on its delivery and in Activity. The default words say only the kind of thing.

## What a text says

- **Private (default):** `<assistant name>: a reminder is due. Open Aman to see it.` The words by kind are "a reminder is due", "something needs you", "something is waiting for your ok" and "a note is waiting". No names, amounts, message content or reasons.
- **Full:** `<assistant name>: <the one-sentence message>`, cut at a word near 300 characters.
- The assistant's name is the one in the person's own Personalization settings. When they have not named it, the text says "Your assistant". No name is written into the code.
- The confirmation code text reads `<assistant name>: your confirmation code is 123456. It works for 10 minutes. If you did not ask for it, ignore this text.`

## Confirming a number

- A number is entered with its country code (`+15550100`). Spaces, dashes and brackets are ignored.
- Nothing but the code is ever sent to a number before it is confirmed. An unconfirmed number receives nothing from the delivery layer, and the attempt is recorded as skipped.
- The code is six digits, kept only as a salted HMAC-SHA256 hash, compared in constant time, and valid for 10 minutes.
- At most 5 tries per code. The fifth wrong try voids the code. The right code on the fifth try still works.
- At most 3 codes an hour per person, whatever number they ask for, so the page cannot be used to text strangers. The count is kept when a send fails.
- A new code voids the one before. A different number starts unconfirmed and switches texts off. A fresh code for the same number leaves it confirmed.
- Texts cannot be switched on in Reach me settings until the number is confirmed.

## STOP

- Texts are one way. Replies are ignored, and Aman never writes back.
- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT (the words Twilio treats as STOP, in any case) turn texts off for that number, for everyone on the instance who has it, mark it unconfirmed and record "You replied STOP" in Activity. Texts come back only after the person replies START from that phone and confirms the number again.
- When Twilio refuses to send because the number replied STOP (error 21610), the same thing happens.

## The Twilio listener

- Twilio posts incoming texts to a **separate listener** on its own port, `TWILIO_WEBHOOK_PORT` (default 8793). It is only started when `REACH_SMS_PROVIDER` is `twilio`. It serves only Twilio's routes and shares no routes with the main app, so sign-in and the rest of Aman are never reachable through it. Any other address answers 404 with an empty body.
- Every request is checked with Twilio's `X-Twilio-Signature` (HMAC-SHA1 of the public address plus the sorted form fields, signed with the auth token, compared in constant time). An unsigned or badly signed request is refused with 403 before any route runs. The address is built from `TWILIO_WEBHOOK_PUBLIC_URL`, never from a header the caller sent.
- Only form posts up to 64 KB are read. A request from another Twilio account is refused.
- The route is `POST /twilio/sms`. Routes are listed in one place. The voice webhook, the call status route and the media WebSocket of [phone calls](phone-calls.md) plug into the same listener, behind the same signature check.
- The person exposes the port in one of two ways, written in plain words in the Text messages page of the docs: Tailscale Funnel on that port only, or their own domain with HTTPS in front of that port. The main app port is never published.

## Delivery

- Texts are a delivery channel sender (`channel: 'sms'`). It texts a delivery of level nudge when the person has texts on and a confirmed number. A note stays in the app. A new install has no settings, so it texts no one.
- Each text is a channel attempt on its delivery (sent, failed or skipped), with a plain-words detail and a target that names the number only by its last four digits. It is also written to Activity as `delivery.sms`.
- A failure never loses the delivery: it stays in the app.
- A test of one channel can ask the delivery service to try only that channel.

## Reach me settings

- When the server has no provider, the Texts row stays off and says the one thing to do: add the Twilio details to the settings file and restart Aman.
- With a provider: enter the number, send the code, confirm, choose Private or Full, switch texts on, save, and press Try it. Remove number forgets it and switches texts off.
- The page says in plain words that texts travel through Twilio and the phone company.

## Design Decisions

- **Texts plug in as a channel, not a patch.** The delivery service tries each sender it was given. The only change to the feed's contract is that a sender names its channel, so a failure is recorded under the right one.
- **The number is not part of Reach me settings.** The settings document is replaced whole by the page, so a code hash and its counters live in their own table, `text_contact`, one row per person.
- **Secrets are never logged.** The auth token is in the outbound secret guard, the provider returns only a result code, and no log line carries a number or a message.
- **Outbound calls use the public-address guard**, like push.
- **No new dependency.** Twilio's REST API is called with the repo's own fetch, and the signature check uses Node's crypto.
- **The public address is required.** Aman only starts texts when it can verify Twilio's requests, so STOP is always heard.

## Scope

- `text_contact` table on SQLite and Postgres, with a shared store contract suite
- Config in `config.ts`: `REACH_SMS_PROVIDER` (default `none`), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_PORT`, `TWILIO_WEBHOOK_PUBLIC_URL`
- Routes under `/api/v1/user/reach/texts` (get, send code, confirm, choose words, remove) and `sms` as a test channel in `/api/v1/user/reach/test`
- The listener, the signature check and the inbound text route
- Settings, Reach me: the texts flow
- Data export and import: the number and the choice of words are exported as `texts.json`; an import brings the number in unconfirmed and texts off

## Privacy

- Twilio and the phone company see the number and the text. In Private mode the text holds only the kind of thing and the assistant's name.
- The number is kept in the person's own database and is in their data export. The code is kept only as a hash and is not exported.
- Aman never logs the number, the text, the code or the auth token.

## Testing

All tests use synthetic data, never a person's real data.

- An unconfirmed number receives nothing, and a new install sends no texts
- Private texts contain no names, amounts or mail text, and Full texts carry the message
- The assistant's name comes from the person's settings
- Code expiry, wrong tries, the hourly limit, and codes kept only as hashes
- STOP and the other opt-out words turn texts off and are recorded in Activity; other replies are ignored
- Unsigned, badly signed and wrong-address requests are refused; the listener serves nothing but its own routes
- Twilio's own worked signature example
- Shared store contract tests on SQLite and Postgres
- Export and import: the number comes in unconfirmed with texts off, and exports from before texts import

## Out of Scope

- Phone calls, covered in [Phone Calls](phone-calls.md)
- Replies other than STOP, and any two-way texting
- Providers other than Twilio
- Per-person Twilio numbers: one Twilio number serves the instance
