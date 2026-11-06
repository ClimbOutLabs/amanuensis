---
title: 'Reach me'
description: 'What Aman watches for, how loudly it tells you, and how to change that in Settings, Reach me.'
---

Aman can tell you about things without waiting for you to open a chat. You choose what may reach you and how, in **Settings, Reach me**.

## What Aman watches for

- **Mail from people you marked always important.** It counts only when your mail server confirms the sender. Mail that only claims to be from them is treated as ordinary mail. A sender whose own mail domain does not ask servers to check it can never be confirmed.
- **Bills and deadlines** named in new mail. Aman tells you when one is due within three days. It stays quiet when a later message in the same thread says it was paid.
- **Two things on your calendar at the same time** in the next 24 hours.
- **Time to leave** for an event with a place, inside the lead time you choose.
- **An approval waiting for you** longer than the time you choose.

Calendar events count only when they are your own. On a Google calendar, that means you organised them, you accepted them, or no one else is on them. On the shared Calendar connector, it means no one else is on them, because anyone who sends an invite can write that you accepted it. Anything else can only ever become a quiet note.

Mail is checked every 10 minutes, the calendar every 30 minutes, and approvals every 5 minutes.

## How loudly

Everything lands under the bell with the reason you got it.

- **Note:** a quiet item under the bell. It never makes a sound. Most things are notes.
- **Nudge:** a notice on the devices where you turned notices on, and a text if you set up texts and switched them on. See [Text messages](/text-messages).
- **Call:** a phone call, if the owner set up Twilio, the voice parts of Aman are running, and you switched calls on. Until then, something that would call you comes as a nudge. See [Phone calls](/phone-calls).

A model reads a short description of each new thing and suggests how loudly to tell you. It can only suggest. Your settings decide. A waiting approval can nudge you but never call. A bill can nudge you only when it came from someone you marked always important and your mail server confirmed the sender, and it never calls. Words in a message, such as "urgent", can never make it louder than a note.

## Your settings

- **Ways to reach you.** In the app is always on. Notices are turned on per device. Texts work once the owner sets up Twilio, and you confirm your number. Until then they show what to do to set them up. Phone calls ring the number you confirmed for texts. Until Twilio is set up, they say what to do to set them up. While the voice parts of Aman are not running, they say to start them.
- **Mail that always matters.** Add the people whose mail you always want to hear about. Aman may suggest people it found in what it remembers. Nothing is added until you say so.
- **How often and how early.** The most nudges in one day (5 to start with). After that, things wait as notes. Reminders you set never count toward this limit. Your time zone decides when your day starts. You also choose how early to hear about leaving, and how long an approval may wait.

Settings that only matter for calls appear once the owner sets up phone calls. Those are which kinds of event may call you, quiet hours, the fewest hours between two calls, and calls for reminders you mark urgent.

## Try it

Each way to reach you has a **Try it** button. It sends a test item under the bell. For notices, it also says how many devices the notice reached. For calls, it rings your phone. A test never counts toward your daily nudges, and a test call never counts toward the time between calls. Each test text costs money, so Try it sends at most 3 test texts an hour, and they count toward the 30 texts a day each person can get. Each test call costs money too, so Try it rings at most once every 2 minutes and 5 times a day.

## When something goes wrong

- If the model cannot be asked, or has used its limit for the day, things still arrive as quiet notes.
- If a delivery fails, Aman tries again on the next check. After five tries it stops trying that item.
- If a page says your settings could not be read, reload the page.

See [Privacy](privacy) for what is sent where.
