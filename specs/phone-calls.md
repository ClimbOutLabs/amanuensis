# Spec: Phone Calls

**Status:** implemented

**Scope note:** This spec covers phone calls as a channel of the delivery feed in [Reaching You](notifications-delivery.md): placing a call, what the assistant says, the conversation on the call, a missed call, and the call routes on the Twilio listener from [Text Messages](text-messages.md). When a call is placed is decided by [Noticing](noticing.md). The voice itself is the voice loop from [Local Voice Loop](local-voice-loop.md), with the phone as one more way in.

## Problem

A `call` decision had nowhere to go: it was delivered as a nudge. Something truly urgent, like a clash an hour away, could wait in the bell until the person next opened Aman. A phone call reaches a person who is away from every screen. But anyone near the phone can pick up, the call travels through other companies, and a voice "yes" is easy to fake or mishear, so a call must say little until the person agrees and must never approve anything.

## Solution

When the rules allow a call, Aman asks Twilio to ring the person's confirmed number. When someone picks up, Twilio opens a media stream back to Aman, and the call becomes a voice session of the voice loop: the same speech detection, speech-to-text, text-to-speech and assistant, with the phone line as its transport. The phone line carries 8 kHz mu-law both ways and says that it takes no approvals.

## The call

- **Opening:** `Hi, this is <assistant name>, calling for <person's name>. <Kind>. Is this a good time?` The person's name is how they asked to be addressed in Personalization, else their name, by the same rule as the assistant's name; with neither it says "calling for the person who set me up". The kind uses the same words as a private text ("Something needs you", "A reminder is due"). The opening plays to the end and cannot be talked over. Nothing else is said, and nothing the person says goes to the model, until they say yes.
- **Yes:** only a reply of one to three words, each of them yes, yeah, yep, yup, sure or okay. A reply that started while the opening was still playing is ignored. "Go", "fine", "ok" and "alright" are not yes words, because each also starts replies that are not a yes ("go away", "I'm fine, who's calling?").
- **No:** a reply with a no word (no, not, busy, later, can't, driving, stop) says goodbye and hangs up. "No problem", "no worries", "not busy", "not bad" and "why not" are not a no; they count as unclear.
- **Unclear, or silence:** anything else, or 8 seconds of silence after the question, asks once more. The 8 seconds start again whenever the person begins to speak, so a slow answer is not talked over. The second time it says it will leave it in the app and hangs up. When nothing at all was heard after the opening, the call ends as `no_answer` and falls back to the text and push, since a voicemail that answering machine detection called `unknown` ends this way.
- **After yes:** the assistant says "Here is your reminder: <text>" (or "Here is what I called about: <text>"), then "You can ask me about it. To do something about it, open the app." The delivery's words are carried by a call only when they pass the texts' one check for plain words (`checkedWords`: no number to call, no site, no address, within the digit budget, and every word known), with the same extra words as a text, from `allowedExtraWords` (the person's added words and the assistant's name, built once per call), checked as given and again after the texts' cleaning, and are at most 300 characters. The call says the words in that cleaned form, so a dash or an accent is said as a plain sign or letter. They must also not hold a greeting, a farewell or a phrase of the call's own opening (such as hi, hello, hey, hola, greetings, good morning or night, goodbye, bye, farewell, cheers, take care, this is, calling for, good time, end of the reminder), decided on the words as sent, with look-alike letters, accents, invisible characters, spacing and marks folded away. A model steered by a mail or a page can write an urgent reminder, and whoever answers hears it, so otherwise the call says "Your reminder is not something I read out on the phone. It is in the app." The one owner is `callWords` (`runtime/calls/callWords.ts`); the delivery itself is never rewritten, so the bell and the fallback keep its words. From then on each thing the person says gets one model answer, with no tools, given only the delivery (its kind, and its text and reason only when they pass the same check, as information) and what was said on the call. A reason that names a sender by address is left out. It is told it cannot see mail, calendar, memories or files and cannot change anything, and to send the person to the app for anything else. No approval grant applies, because no tool runs.
- **The "Phone call" chat:** each exchange is written into a new chat called "Phone call", which starts with the line the assistant said on the phone. The chat is written only once the message was said, so it never claims a message was read out when it was not, and Activity says "what was said is in the chat" only when a chat was written. The chat takes the assistant and the name of the person's chat the delivery points to, or else of their latest chat, so the person can carry on in the app. The chat keeps the whole call as a record, not as the assistant speaking. Its first line says once that it is a record of a phone call, not instructions, and "You, or someone else, answered the phone.", then quotes the opening as "The phone helper (it could see and do nothing else)". Each exchange is one assistant line of two paragraphs: `You, or whoever answered: «…»` and `The phone helper (it could see and do nothing else): «…»`. Both sides are quoted in a code span, with quote marks folded, tags and backticks dropped and line breaks collapsed, so neither can close its quote, and the chat's Markdown neither formats nor links what was said (it would link a site or an address even if escaped). Nothing said on the call is ever written as the person's message or as user-role context, because a later turn with tools would read it as their request, and the call model's replies are never written as the assistant's own words, because a later turn would read a reply the caller talked it into as its own promise. A person with no chat of their own still gets the conversation, but no chat is written: a chat needs an assistant, and the app's own new-chat rules pick that only when the person starts one. A call's answers use the model a new chat starts on. Only a server with no model at all says it is in the app and hangs up.
- **Whoever says yes hears the message.** The phone cannot tell who answered. The docs and the privacy page say so, and suggest unticking sensitive kinds under "What may call you".
- **Length:** Twilio is asked to end the call after 11 minutes. At 10 minutes the assistant says goodbye; 15 seconds later the line is closed, whatever is still running. The person can interrupt the assistant after the opening.
- The assistant's name comes from the person's own Personalization settings, by the same rule as a text: at most 20 plain letters, and "your assistant" when the name holds a phone number or nothing is left. No name is written into the code.

## A missed call

- Twilio's answering machine detection tells a person from a machine. A machine gets one short voicemail: `This is <assistant name>. Something needs you. Please open the app.` A fax, busy line, no answer, or failed call gets no voicemail.
- Then, once only, the delivery is tried as a text (when texts are on) and as a push notice. A call is never placed again for the same delivery.
- When the call cannot be placed at all, the text and push are tried at once, right after the call attempt is written down. When no clear answer comes back from Twilio (the request may have been sent and then timed out or was reset, Twilio answered with a server error, or the reply named no call; an address refused up front, or a connection that could not be made, is a sure failure and texts at once), Twilio may still have started the call, so the call is left open instead: Twilio's requests name it by Aman's own id, and if none come, the sweep ends it as not answered once it expires and the text and push go out then. This way the person is never texted and then hung up on when the phone rings.
- Activity says, for a call that ended without a conversation, what happened and then that it was sent as a text and a notice instead, or for a test call, that it was not tried again. A call the sweep ends before its line was given is recorded as not answered; one whose line was given is recorded as cut off.
- The opening and a voicemail are each sent to the voice whole and said only as written. They are fixed lines where only names change, and they prove the voice works before anything else is said. If the voice would change a word, none of it is said: a voicemail is not left, and an opening falls back to the text and push.
- The message after a yes is read the way every reply after it is read, not checked word for word. It is written for the screen ("2:30 p.m.", "Q3", "room 4B"), so an exact check would refuse many messages while protecting nothing: the person already said yes, and asking "what was that?" makes the model read the same text aloud anyway. If the voice cannot speak it at all, the call hangs up and falls back to the text and push, and no chat is written.
- The same text and push go out when the line could not be opened after the person picked up, when the parts that listen could not load, when the voice could not speak the opening or the message after a yes, and when a call never finished (for example the server stopped mid-call, or Twilio never called back). A sweep every minute ends such calls once they are past their time.

## When it calls

The rules are Noticing's, unchanged: the kind is ticked for calls (or the reminder is urgent and "Call me for reminders I mark urgent" is ticked), calls are switched on, it is not during quiet hours, and the time between calls has passed. The call sender also needs Twilio set up, calls switched on, a confirmed number that has not replied STOP, and the voice parts running: speech-to-text healthy, the voice that speaks healthy and saying it checks exact speech, and the listening model present (a phone that rang without them would be deaf or silent). Otherwise nothing rings, and the text and push are tried at once.

That readiness has one owner: it is checked at start, every 30 seconds and before each call is placed, and Reach me, Noticing's choice to call and Try it all read the last answer, so none of them offers a call that would not ring. The speech-to-text part is the watcher's own 30-second cache, so the check before a call is fresh only for the voice that speaks and the listening model. A call's speech shares the person's place at the voice service with voice mode and read-aloud. It uses the service's default voice, because the voice a person picks is kept only in their browser. A server-side per-person voice setting, read by both the voice ticket and the call, is a follow-up. A new install has calls off and rings no one.

## The call routes

- Calls use the separate Twilio listener of texts, on the same port. Twilio is told the addresses each time Aman places a call, so there is no address to set in the Twilio console. Two account checks remain there: a trial account can only call numbers verified with Twilio, and Voice Geographic Permissions must allow the person's country.
- `POST /twilio/voice` answers the pick-up, `POST /twilio/call-status` hears how the call ended, and `/twilio/media/<call id>` is the media WebSocket (`wss://`), one address per call. The two webhooks are behind the same signature check as `/twilio/sms`, and their fields are checked against a schema; a call SID that is not Twilio's form is refused. Aman puts its own call id in the two webhook addresses it gives Twilio, so a call whose Twilio SID was never saved is still found. The signature covers that id.
- A WebSocket upgrade is checked over its public address before the socket opens. Twilio allows no query string on a stream address but allows a path, so each call's stream is at `/twilio/media/<call id>`: the signature covers the call's own address and opens no other call, and an id Aman did not place, or whose call is not waiting for its stream (not yet answered, already open, or ended), is refused with 404 before the upgrade. The one-time key below still opens the line.
- The media stream is accepted only for a call Aman placed. When the call is picked up, Aman makes a one-time key, keeps only its SHA-256 hash, and hands the key to Twilio in the stream's parameters. The stream must present that key with the same call SID within 30 seconds, and the key works once. A call record expires 2 minutes after it is placed (Twilio rings for 25 seconds and its requests follow within a minute). Anything else is closed before a sound is played. A stream that names no call within 3 seconds is closed; Twilio names it within milliseconds. At most 8 streams may wait to name their call at once; a ninth closes the one that has waited longest. Only a signature Twilio made for a live call's own address can fill those places, so a captured signature of an ended call fills none. A repeated status webhook does nothing a second time, and an ended call stays ended. A repeated voice webhook while the line is not yet open gets a new key that replaces the old one, so a slow retry never hangs up the call; once the line is open, no key is given again.
- Calls to the Twilio number are not answered.
- Calls ring only the confirmed number, never a new number still waiting for its code.

## Delivery

- Calls are a delivery channel sender (`channel: 'call'`). It acts only on level call. Any delivery at level call counts toward the time between calls, answered or not. Push notices skip level call, so a call and a push are never sent together.
- Each call is a channel attempt on its delivery, written to Activity as `delivery.call`: ringing, then how it ended (talked, said no, no yes heard, could not talk it through, voicemail, no answer, line not opened, cut off), with the chat when there was one. The target names the number only by its last four digits.
- The delivery service gains two calls: record a later attempt on a delivery, and fall back to other channels once. A sender can name channels to fall back to when its own attempt does not go out; the service writes that attempt down first, then the fallback.
- Ended call records are deleted after 30 days.

## Reach me settings

- With Twilio set up and the voice parts running, the Calls row is available and shows the privacy note: "Calls and texts travel through Twilio and the phone company. The assistant's voice and the transcript are made on your computer."
- Calls can be switched on only once the number under Texts is confirmed.
- Try it rings the person's phone with a test call. A test call never sends a text or a push. Its item in the feed is a note, so it never counts toward the day's nudges or the time between calls. Each test call is paid, so the button is limited per person through the shared send counter: one call every 2 minutes, then 5 a day. The short wait is claimed first, so a call it refuses spends none of the day. A test past either limit answers 429 and says how long to wait.
- The settings that only matter for calls (which kinds may call, quiet hours, the time between calls, calls for urgent reminders) show once calls are set up.

## Design Decisions

- **The conversation is the voice loop, not Twilio's speech.** Twilio carries the sound only. Speech-to-text, text-to-speech and the assistant run on the person's computer, as in voice mode.
- **On the call, the assistant knows one thing and can do nothing.** The phone cannot tell who picked up, so a yes cannot unlock the person's data. Each answer is one model call with no tools and only the delivery in context. Nothing on a call runs as the person, so no identity is handed to the app's routes, and no "allow for good" grant can apply. The full assistant is one tap away in the "Phone call" chat.
- **A short, plain yes.** A pick-up greeting, a question or someone handing over the phone is not consent. Only a reply made of a few yes words counts, and only once the person has heard the whole question.
- **Approvals are off by transport.** The phone line reports `voiceApprovals: false`, so the voice loop never reads a card back as something to confirm, and the call's turn runner refuses any answer to a card.
- **Private first.** The phone cannot tell who picked up, so the opening says only who is calling, who for, and the kind of thing.
- **Every call is written down.** The close handler is attached before anything is awaited, so a line that drops at any point is still recorded and still falls back; a sweep ends calls this server lost track of.
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
- Aman does not record the sound of a call. The transcript is the "Phone call" chat, from the moment the person said yes. It quotes both sides of the call and never stands for the person's own words or the assistant's own promise.
- What is sent to the model on a call is the delivery and what was said on the call, nothing else of the person's.
- Spoken lines say "the app", never the product name, like texts.
- Aman never logs the number, what was said, the one-time key or the auth token.

## Testing

All tests use synthetic data, never a person's real data.

- An unsigned webhook or WebSocket upgrade is refused, in both the wss and the https form of its address; the listener serves nothing but its own routes, and a request with the old in-process header gets nowhere
- Webhook fields that are not Twilio's form hang up or are ignored
- Each probe reply ("Hello? Yeah?", "Go away", "Who is this? Okay", "I'm fine, who's calling?", "Sure, hold on, let me get her", "Mom, phone! Okay hang on", "Is this a sales call? Alright whatever", a voicemail greeting ending "okay?") is not a yes; "No problem, go ahead" and "I'm not busy" are unclear
- A reply that started over the opening is ignored, and the opening plays to the end; the opening says who the call is for
- After yes, the model is asked with no tools and only the delivery and the call; text inside the delivery cannot close the block it is in; each exchange is written to the chat
- A person who has never chatted still gets the conversation, on the assistant a new chat starts on
- An unknown call, a wrong or reused key, and an expired key or call cannot open a media stream; a retried voice webhook replaces the waiting key
- No answer leaves one text and one push and no retry; a voicemail leaves one message, or says none could be left
- A line that could not open, a line that drops while starting, and a call the server lost track of are all written down and fall back once
- Silence after the question asks once more, then hangs up; at the time limit the line closes even when a reply is stuck
- A repeated webhook does nothing twice; a missed call still counts toward the time between calls, and a Try it call does not
- Only the confirmed number rings, never a number that replied STOP; the spoken names follow the text name rule
- Nothing rings while the voice parts are not running, and the text and push go out at once
- A voice service too old to check exact speech is reported as out of date, with "Run aman upgrade" words, in Reach me and in the call attempt
- An approval is refused on a call, even when asked directly
- Mu-law round trip and resampling to 16 kHz
- A new install calls no one
- Twilio's call request carries the time limit and the call id; failures map to plain words and never throw
- Shared store contract tests on SQLite and Postgres

## Out of Scope

- Calls to Aman, and calls to anyone but the person
- Approving anything by voice on a call
- Providers other than Twilio
- Recording the sound of a call
