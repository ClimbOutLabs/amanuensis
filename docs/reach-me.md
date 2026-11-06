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

Calendar events count only when they are your own. On a Google calendar, that means you made and organised them, you accepted them, or no one else is on them. An invite from someone else that names you as its organizer does not count. A meeting someone else made for you counts only if you accepted it. If it names you as its organizer, it does not count even then, because an invite from outside can say you accepted it. It can only become a quiet note. On the shared Calendar connector, it means no one else is on them, because anyone who sends an invite can write that you accepted it. Anything else can only ever become a quiet note.

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
- If Google is busy, your mail server is down, the connection drops, or a check runs out of time, Aman stops at the message it could not read and keeps what it found before it. A busy server never makes Aman skip a message.
- If a message fails for another reason, Aman tries it once more after reading another message. A message that fails again 3 checks in a row is skipped, so one bad message does not hold up the rest of your mail. If it looked like a bill, or came from someone you marked always important, Aman tells you it could not read it.
- If a message has held up your mail for 3 hours after Reach me showed the problem, Aman skips it the same way.
- If one broken message stops the mail server from sending the list of new mail, Aman finds the few seconds that hold it. With the shared Email connector it skips only that message. Otherwise it skips those few seconds after 3 checks. Only the log says so.
- A check stops starting new work after about a minute. With the shared Email connector, a check that ran out of time looks at a shorter stretch of time on the next check, so it keeps moving. Otherwise it starts where it stopped.
- After a long outage, Aman does not go back further than a day, so older mail is not looked at.
- If the shared Email connector takes too long to list new mail (it gives up after about a minute), Aman stops that check and tries again with a shorter stretch of time next time.
- If mail could not be checked for about an hour, Reach me says so at the top, with the time it first failed and one thing to do. If your mail server answers too slowly, ask whoever runs your mail to check it. For any other problem, open Settings, Connectors, and check that your mail is still connected. The notice goes away after a check that reads all your new mail. It also shows when the shared Email connector is set up but cannot be reached, or when your Google login has to be redone.
- If Aman cannot check whether a bill was paid, it keeps the bill and tries again on the next checks, before it looks at new mail. When the bill is due within a day, Aman tells you about it anyway. If you paid it, you may still get a reminder.
- If hundreds of messages arrive within a few seconds, Aman reads only the ones from people you marked always important. With the shared Email connector it skips them all, because senders cannot be confirmed there.
- Reach me says which mail Aman is watching. Your Google mail comes first. The shared Email connector is used only if you have no Google mail connected. If your Google login has to be redone, Aman does not switch to the connector. It shows the problem instead.
- If a page says your settings could not be read, reload the page.

See [Privacy](privacy) for what is sent where.
