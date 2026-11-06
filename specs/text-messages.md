# Spec: Text Messages

**Status:** implemented

**Scope note:** This spec covers texts as a channel of the delivery feed in [Reaching You](notifications-delivery.md): confirming a person's number, what a text says, the one-way STOP rule, the separate listener Twilio talks to, and the Settings, Reach me flow. When a text is sent is decided by [Noticing](noticing.md). Phone calls are separate work and will use the same listener.

## Problem

A nudge only reached a person through the bell and push notices on devices that opted in. A person away from Aman, or with push off, heard nothing. A text reaches any phone, but it travels through other companies, so it must be opt-in, must prove the number belongs to the person, and must say as little as possible by default.

## Solution

One text provider, Twilio, behind a small interface. The person enters a number, gets a one-time code by text, and types it back. Only then can texts be switched on. A nudge or a reminder then goes out as a text, recorded as a channel attempt on its delivery and in Activity. The default words say only the kind of thing.

## What a text says

- **Private (default):** `<assistant name>: a reminder is due. Open the app to see it.` The words by kind are "a reminder is due", "something needs you", "something is waiting for your ok" and "a note is waiting". No names, amounts, message content or reasons.
- **Full:** `<assistant name>: <the one-sentence message>`, in plain characters (accents dropped, curly quotes and dashes made plain, emoji left out) so the phone company never switches to its costlier long form, and cut at a word so the whole text fits two segments (306 characters), ending with `...`.
- The assistant's name is the one in the person's own Personalization settings, kept to letters, spaces, apostrophes and dashes and at most 20 of them, so a name cannot carry a link, a number to call or a message of its own. When nothing is left, or they have not named it, the text says "Your assistant". No name is written into the code.
- The confirmation code text reads `Your confirmation code is 123456. It works for 10 minutes. If you did not ask for it, ignore this text.` It names no assistant, because it goes to a number nobody has proved yet.
- The server sends the Private words for a reminder with the number's status, so the Settings page shows exactly what a text says.

## Confirming a number

- A number is entered with its country code (`+15550100`). Spaces, dashes and brackets are ignored.
- Nothing but the code is ever sent to a number before it is confirmed. An unconfirmed number receives nothing from the delivery layer, and the attempt is recorded as skipped.
- The code is six digits, kept only as a salted HMAC-SHA256 hash keyed with a server secret that is not in the database (the Twilio auth token), compared in constant time, and valid for 10 minutes. A short id of the key is kept with it, so after the auth token changes an old code reads as no code and uses up no tries.
- At most 5 tries per code. The fifth wrong try voids the code. The right code on the fifth try still works.
- At most 3 codes an hour per person, whatever number they ask for, at most 50 a day for the whole server, and at most 3 an hour and 10 a day to one number, whoever asks, so the page cannot be used to text strangers. The number limits do not hold back the person whose confirmed or opted-out number it already is. A number only waiting for its code does not count as theirs, since anyone can make any number wait. A trunk 0 after the country code is left out of the number a limit counts, so `+44 07700` and `+44 7700` are one number.
- Each send is counted in one database statement before Twilio is called, so requests at the same moment cannot pass a limit together, and a failed send still counts. The counts live in their own table, `text_send_count`, keyed by person, by server and by a keyed hash of the number, so removing a number never resets them. Changing the auth token starts the number counts over.
- A new code voids the one before. A fresh code for the same number leaves it confirmed. A new number for a person with a confirmed number waits beside it: texts keep going to the confirmed number until the new one's code is confirmed, and a failed send or a STOP from the new number drops only the new one. A different number for a person with no confirmed number replaces it.
- Every change after a read is conditional on the code that was read, so a STOP or a newer code in between is never undone.
- Texts cannot be switched on in Reach me settings until the number is confirmed.

## STOP

- Texts are one way. Replies are ignored, and Aman never writes back.
- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT (the words Twilio treats as STOP, in any case) turn texts off for that number, for everyone on the instance who has it, mark it unconfirmed and record "You replied STOP" in Activity. Texts come back only after the person replies START from that phone and confirms the number again.
- When Twilio refuses to send because the number replied STOP (error 21610), the same thing happens. When that happens to a code, the page says the number cannot get texts and to reply START if the person replied STOP, the same words as for a number that cannot take texts, so the page never tells whether a number opted out.
- A STOP from a new number that waits for its code drops only that number, and Activity says so under its own name, `delivery.sms_new_number_stopped`.

## The Twilio listener

- Twilio posts incoming texts to a **separate listener** on its own port, `TWILIO_WEBHOOK_PORT` (default 9201, outside the ranges the installer picks other ports from). It is only started when `REACH_SMS_PROVIDER` is `twilio`, and a port it cannot open stops the server, so texts never go out while a STOP cannot be heard. It serves only Twilio's routes and shares no routes with the main app, so sign-in and the rest of Aman are never reachable through it. Any other address answers 404 with an empty body.
- Every request is checked with Twilio's `X-Twilio-Signature` (HMAC-SHA1 of the public address plus the sorted form fields, signed with the auth token, compared in constant time). An unsigned or badly signed request is refused with 403 before any route runs. The address is built from `TWILIO_WEBHOOK_PUBLIC_URL`, never from a header the caller sent.
- Only form posts up to 64 KB are read. A request from another Twilio account is refused. A message id seen in the last day is answered and not acted on again, so a copied request cannot be replayed soon after. The id is marked before the work starts, so two copies at once are acted on once, and forgotten again if the work fails, so Twilio can send it again. A route that fails answers 500 with empty TwiML, and only the address and the kind of error are logged.
- The route is `POST /twilio/sms`. Routes are listed in one place, so the voice webhook and the media WebSocket of phone calls plug into the same listener, behind the same signature check.
- The person exposes the port in one of two ways, written in plain words in the Text messages page of the docs: Tailscale Funnel on that port only, or their own domain with HTTPS in front of that port. The main app port is never published.
- When the server starts, it points the Twilio number at itself: it looks up `TWILIO_FROM_NUMBER` in the account's numbers through Twilio's API and sets that number's incoming-text address to `TWILIO_WEBHOOK_PUBLIC_URL` plus `/twilio/sms`, method POST, so nothing is set by hand in the Twilio console. Nothing else on the number or the account changes. A number already pointed there is left alone, and a failure is logged by its kind only and does not stop the server.

## Delivery

- Texts are a delivery channel sender (`channel: 'sms'`). It texts a delivery of level nudge when the person has texts on and a confirmed number. A note stays in the app. A new install has no settings, so it texts no one.
- Each text is a channel attempt on its delivery (sent, failed or skipped), with a plain-words detail and a target that names the number only by its last four digits. It is also written to Activity as `delivery.sms`.
- A failure never loses the delivery: it stays in the app.
- A test of one channel asks the delivery service to try only that channel, so a push or in-app test never sends a paid text.
- Every text counts toward at most 30 a day for the person, nudges, reminders and tests alike, counted in `text_send_count` before Twilio is called. Over that, the attempt is recorded as skipped and says when texts start again, and the item stays in the app.
- Try it for texts has its own limit of 3 an hour and answers 429 with the minutes to wait.
- A Full message that names a link or a phone number is sent in Private words, with the same check the noticing layer uses on the model's words, since the message can come from mail someone else wrote.

## Reach me settings

- When the server has no provider, the Texts row stays off and says the one thing to do: follow the Text messages page of the docs.
- With a provider: enter the number, send the code, confirm, choose Private or Full, switch texts on, save, and press Try it. Remove number forgets it and switches texts off. Change number keeps the confirmed number, and its texts, until the new one is confirmed.
- The page says in plain words that texts travel through Twilio and the phone company.

## Design Decisions

- **Texts plug in as a channel, not a patch.** The delivery service tries each sender it was given. The only change to the feed's contract is that a sender names its channel, so a failure is recorded under the right one.
- **The number is not part of Reach me settings.** The settings document is replaced whole by the page, so the number and its code hash live in their own table, `text_contact`, one row per person, and the send counts in `text_send_count`.
- **Secrets are never logged.** The auth token is in the outbound secret guard, the provider returns only a result code, and no log line carries a number or a message.
- **Outbound calls use the public-address guard**, like push.
- **No new dependency.** Twilio's REST API is called with the repo's own fetch, and the signature check uses Node's crypto.
- **The public address is required.** Aman only starts texts when it can verify Twilio's requests, so STOP is always heard.

## Scope

- `text_contact` and `text_send_count` tables on SQLite and Postgres, with a shared store contract suite
- Config in `config.ts`: `REACH_SMS_PROVIDER` (default `none`), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_PORT`, `TWILIO_WEBHOOK_PUBLIC_URL`
- Routes under `/api/v1/user/reach/texts` (get, send code, confirm, choose words, remove) and `text` as a test channel in `/api/v1/user/reach/test`
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
- Code expiry, wrong tries, the limits per person, per number and per server, the owner of a number not locked out, a trunk 0, removing a number and sending at the same moment, and codes kept only as hashes keyed outside the database, with a code from another key reading as no code
- The day's limit on texts, reminders included, and Try it in a loop
- A Full message with a link or a phone number goes out in Private words
- The server points the number's incoming texts at itself, and touches nothing when the number is not found
- A new number waits beside the confirmed one, and a failed send keeps the confirmed one
- A long or unusual assistant name, and Full texts in plain characters within two segments
- A push test with texts on sends no text
- The listener fails the boot when its port is taken, starts only when Twilio is set up, answers a failing route with empty TwiML, and acts on a repeated message id once, also when two copies arrive at once
- STOP and the other opt-out words turn texts off and are recorded in Activity; other replies are ignored
- Unsigned, badly signed and wrong-address requests are refused; the listener serves nothing but its own routes
- Twilio's own worked signature example
- Shared store contract tests on SQLite and Postgres
- Export and import: the number comes in unconfirmed with texts off, and exports from before texts import

## Out of Scope

- Phone calls and the voice webhook
- Replies other than STOP, and any two-way texting
- Providers other than Twilio
- Per-person Twilio numbers: one Twilio number serves the instance
