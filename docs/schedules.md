---
title: 'How schedules hold actions'
description: 'What a scheduled run may do by itself, and what it holds for your OK.'
---

A scheduled run happens while nobody is watching. This page explains what such a run may do on its own, what it holds for you, and how reminders and the morning brief fit in. For the everyday steps, see [Schedules](../packages/trueforge/guide/topics/schedules.md) and [Reminders](../packages/trueforge/guide/topics/reminders.md).

## Words we use

Tasks
: Things to do once. Ask for them in a chat.

Schedules
: Things that repeat. Make them on the **Schedules** page, or by asking in a chat.

Reminders
: A note Aman gives you at a set time. It only ever reaches you.

Skills
: Instructions that teach Aman how to do a kind of job. Add them under **Settings**, **Skills**, or ask Aman in a chat to add one.

## How a schedule runs

- Each schedule has a job to do (the **Task** field) and a repeat pattern. Runs are at least one hour apart.
- Each run is saved as a chat, so you can open it and see what Aman found.
- After you save a schedule on the Schedules page, it is paused. You can give it a test run, then activate it.
- You can pause or resume a schedule on the Schedules page, or by asking in a chat. In a chat, a card shows the schedule and when it runs, and waits for your OK every time.
- Creating or deleting a schedule in a chat also shows a card every time. Listing your schedules doesn't ask.
- A schedule made in a chat keeps the persona the chat was using. What it may use is set on its card; see the next section.
- An incognito chat can list schedules and reminders, but it can't make, change or cancel them.

## A schedule made in a chat

When you ask for a schedule in a chat, a card shows it before anything is saved. Creating a schedule asks every time.

- The card lists what the schedule may use: your connectors, your skills, running code, and memory. Aman ticks the ones it thinks the task needs.
- You can change any tick. A skill needs running code, so that box stays ticked while a skill is ticked. After a change, click **Update the card**. Aman shows the card again with your choices, and you approve that card. What you approve is exactly what the card shows.
- Aman saves your choices as a new agent named after the schedule. If that name is taken, it adds a number, such as `morning-brief-2`. The agent is on the Agents page, where you can change its tools, instructions or model. Each schedule gets its own agent, so changing one never changes another.
- Deleting the schedule leaves the agent in place. Delete it on the Agents page if you no longer want it.
- If the chat already uses one of your agents, the schedule runs as that agent. The card shows that agent's tools, with nothing to tick.
- An older schedule made in a chat keeps running as it did. Change its tools on the Schedules page.

## Scheduled runs don't interrupt you

A scheduled run sends no notice. Its results wait in its chat until you open it.

## Nothing is sent or changed without you

Aman can think all day. Doing things needs your OK.

### What a run can do by itself

A scheduled run can read and search, the same as a chat. It never sends anything by itself.

The one thing of yours it changes by itself is a space. It can make and change any space without asking, so a list it keeps for you stays up to date.

### Spaces

- Every change keeps a version you can ask Aman to bring back.
- Each change a run saves is also one line in the activity log, under **Settings**, **Audit**.
- Aman can't delete a space.
- A space only keeps a clickable link that you gave or that a search returned. A link that only an email or a web page supplied is kept as plain text.

### What is held

Anything that would need your OK in a chat is held. It is not run, and Aman is told it was saved for you.

A run also holds a few things a chat may do without asking:

- Running code, new files and package installs in the sandbox, even if you let the sandbox run without asking.
- Writing files, even if you let file writes run without a card.
- Setting a reminder.

Some actions are skipped instead of held, and the run tells you in one line. That happens when only something Aman read chose where an action goes. A held read through a connector still waits for you.

Gmail is stricter. A scheduled run can read your Gmail, but it never saves a Gmail draft or sends Gmail mail.

### The Needs your OK list

When the run finishes, its chat ends with a **Needs your OK** list: "Aman held these for you. Nothing has been done yet."

- Each item shows what will happen, with **Allow** and **Deny**. Some read-only connector tools also offer **Always allow everywhere**.
- The app builds the list from what was held, not from the model's words. The model can't hide an item or add a fake one.
- When you approve an item, Aman checks it again first. If anything the card showed has changed since, such as the guests of an event or the text of a message, nothing is done and Aman says to ask again in chat.
- Held items expire after 24 hours.
- Up to 20 items are kept per chat. If more were held, the list says how many were not saved, so you can ask again in chat.
- A helper job inside a scheduled run can't hold actions. Its actions are refused.

### Typing in a run's chat

A run's chat stays careful when you open it and type there, because it still holds what the run read. Your choices to let file writes or sandbox code run without asking don't apply in it, so each one shows a card. A new chat is not affected.

## The morning brief

A schedule is a morning brief when its name is `morning-brief`, or when its task starts with "Give me my morning brief." A brief made by asking in a chat always uses Aman's standard brief instructions.

- Each brief run reads what is new since the last brief, or from the last 24 hours. It also reads today's and the next 7 days' calendar, the lists in your spaces, and what Aman remembers about you.
- Items you marked done in the last 7 days are left out.
- A brief run can read files and spaces, but it isn't offered tools that write reports, files or spaces. The brief itself is the answer.

## Reminders

A reminder is for something that should happen at a set time. In any chat, ask with a time, such as "Remind me at 5 pm to call the pharmacy". A reminder can also repeat daily, on weekdays, or weekly on the days you choose.

- Setting a reminder needs no card, because it only adds a note for you. It is written to the activity log.
- When it is due, the reminder shows under the **For you** bell with the reason you got it. It also reaches you the way you chose in Settings, Reach me, such as a notice on your devices or, if you set them up, [texts](/text-messages). Its line also appears at the end of the chat you set it in.
- To mark a reminder urgent, say so when you ask, such as "Remind me at 5 pm to call the pharmacy, it's urgent". An urgent reminder can call you once [phone calls](/phone-calls) are set up and you allow it.
- If Aman is still answering in that chat, the line waits until the answer ends.
- No model is called to deliver a reminder, so it costs nothing.
- A reminder whose chat was deleted still shows in the bell.
- Reminders don't show on the Schedules page. To see them all, click Reminders in the left panel. It lists what is coming up and what has already reminded you, with the persona that set each one. Each row shows the day, how far off it is, and whether it repeats or is paused. Click a reminder that says **Open chat** to go to the chat you set it in; a reminder set outside a chat, or whose chat was deleted, says **No chat to open**. To change or cancel one, ask in a chat, such as "What reminders do I have?"
- Before Aman cancels one, a card shows the reminder and waits for your OK. A canceled reminder is gone for good.

## Related

- [Safety story](safety.md#scheduled-runs-hold-actions-for-you), for how every action is checked.
- [Approval cards](../packages/trueforge/guide/topics/approvals.md)
- [Privacy](privacy.md), for what leaves your machine.
