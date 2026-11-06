---
title: 'Reach me'
description: 'What Aman watches for, how loudly it tells you, and how to change that in Settings, Reach me.'
---

Aman can tell you about things without waiting for you to open a chat. You choose what may reach you and how, in **Settings, Reach me**.

## What Aman watches for

- **Mail from people you marked always important.** It counts only when your mail server confirms the sender. Mail that only claims to be from them is treated as ordinary mail. A sender whose own mail domain does not ask servers to check it can never be confirmed. This needs a Google account. With the shared Email connector, senders cannot be confirmed yet, so their mail is treated as ordinary mail.
- **Bills and deadlines** named in new mail. Aman tells you when one is due within three days. It stays quiet when a later message in the same thread says it was paid.
- **Two things on your calendar at the same time** in the next 24 hours.
- **Time to leave** for an event with a place, inside the lead time you choose.
- **An approval waiting for you** longer than the time you choose.

Calendar events count only when they are your own. On a Google calendar, that means you made and organised them, you accepted them, or no one else is on them. An invite from someone else that names you as its organizer does not count. A meeting someone else made for you, even with you named as organizer, counts only if you accepted it, and otherwise can only become a quiet note. On the shared Calendar connector, it means no one else is on them, because anyone who sends an invite can write that you accepted it. Anything else can only ever become a quiet note.

Mail is checked every 10 minutes, the calendar every 30 minutes, and approvals every 5 minutes.

## How loudly

Everything lands under the bell with the reason you got it.

- **Note:** a quiet item under the bell. It never makes a sound. Most things are notes.
- **Nudge:** a notice on the devices where you turned notices on, and a text if you set up texts and switched them on. See [Text messages](/text-messages).
- **Call:** a phone call. Calls are not set up yet. Until they are, nothing calls you.

A model reads a short description of each new thing and suggests how loudly to tell you. It can only suggest. Your settings decide. A waiting approval can nudge you but never call. A bill can nudge you only when it came from someone you marked always important and your mail server confirmed the sender, and it never calls. Words in a message, such as "urgent", can never make it louder than a note.

The model also suggests the words of the item. Those words show only under the bell in the app, and only when they hold no link, phone number or address. Otherwise Aman uses a plain sentence about what it found. A notice on your phone only names the kind of thing, such as a bill. It never carries the model's words. A [text](/text-messages) about something Aman noticed names only the kind of thing too, even in Full mode. Only a reminder's text can carry its own words, and only in Full mode.

## Your settings

- **Ways to reach you.** In the app is always on. Notices are turned on per device. Texts work once the owner sets up Twilio, and you confirm your number. Until then they show what to do to set them up. Phone calls show "not set up yet" until they exist.
- **Mail that always matters.** Add the people whose mail you always want to hear about. Aman may suggest people it found in what it remembers. Nothing is added until you say so.
- **How often and how early.** The most nudges in one day (5 to start with). After that, things wait as notes. Reminders you set never count toward this limit. Your time zone decides when your day starts. You also choose how early to hear about leaving, and how long an approval may wait.

Settings that only matter for calls appear once phone calls are set up. Those are which kinds of event may call you, quiet hours, the fewest hours between two calls, and calls for reminders you mark urgent.

## Try it

Each way to reach you has a **Try it** button. It sends a test item under the bell. For notices, it also says how many devices the notice reached. A test never counts toward your daily nudges. Each test text costs money, so Try it sends at most 3 test texts an hour, and they count toward the 30 texts a day each person can get.

## When something goes wrong

- If the model cannot be asked, or has used its limit for the day, things still arrive as quiet notes.
- If a delivery fails, Aman tries again on the next check. After five tries it stops trying that item.
- If Aman stopped in the middle of sending something, it sends it again on the next check. Rarely, a notice or a text can then reach you twice.
- If one message cannot be read, for example because it was deleted or is too large, Aman skips it and reads the rest.
- If Google is busy, your mail server is down, or the connection drops, Aman stops at the message it could not read. It keeps what it found before that message and starts there on the next check. It keeps trying for as long as that lasts, and skips no mail because of it.
- If one message fails 3 checks in a row while the server answers other requests, Aman skips it so the rest of your mail is not held up. After it skips one, the next message that fails in the same run is skipped after a single check.
- If the shared Email connector takes too long to list new mail (it gives up after about a minute), Aman skips that check. It tries the same mail again next time.
- If mail could not be checked for about an hour, Reach me says so at the top, with the time it first failed and one thing to do. If your mail server answers too slowly, ask whoever runs your mail to check it. For any other problem, open Settings, Connectors, and check that your mail is still connected. The notice goes away after the next check that works. It also shows when the shared Email connector is set up but cannot be reached.
- A bill whose conversation was deleted for good cannot be checked for a payment, so Aman tells you about it. If you paid it and then emptied the trash, you may still get a reminder.
- If hundreds of messages arrive within a few seconds, Aman reads only the ones from people you marked always important. With the shared Email connector it skips them all, because senders cannot be confirmed there.
- If a page says your settings could not be read, reload the page.

See [Privacy](privacy) for what is sent where.
