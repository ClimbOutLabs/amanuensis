---
title: 'Schedules'
description: 'Things that repeat, and how a scheduled run holds actions for you.'
---

A schedule asks Aman to do the same job again and again, for example every weekday morning.

## Words we use

- **Tasks** are things to do once. Ask for them in a chat.
- **Schedules** are things that repeat. Set them up on the Schedules page, or ask for one in a chat.
- **Skills** teach Aman how to do a kind of job. Add them under Settings, Skills, or ask Aman in a chat to add one.

## How a schedule runs

- Each schedule has a job to do (the **Task** field) and a repeat pattern. Runs are at least one hour apart.
- Each run is saved as a chat, so you can open it and see what Aman found.
- After you save a schedule, you can give it a test run.
- You can pause or resume a schedule on the Schedules page, or by asking in a chat. In a chat, a card shows the schedule and when it runs, and waits for your OK every time.

## A schedule made in a chat

When you ask for a schedule in a chat, a card shows it before anything is saved. Creating a schedule asks every time.

- The card lists what the schedule may use: your connectors, your skills, running code, and memory. Aman ticks the ones it thinks the task needs.
- You can change any tick. A skill needs running code, so that box stays ticked while a skill is ticked. After a change, click **Update the card**. Aman shows the card again with your choices, and you approve that card. What you approve is exactly what the card shows.
- Aman saves your choices as a new agent named after the schedule. If that name is taken, it adds a number, such as `morning-brief-2`. The agent is on the Agents page, where you can change its tools, instructions or model. Each schedule gets its own agent, so changing one never changes another.
- Deleting the schedule leaves the agent in place. Delete it on the Agents page if you no longer want it.
- If the chat already uses one of your agents, the schedule runs as that agent. The card shows that agent's tools, with nothing to tick.
- An older schedule made in a chat keeps running as it did. Change its tools on the Schedules page.

## Reminders

A reminder is for something that should happen once. In any chat, ask with a time, such as "Remind me at 5 pm to call the pharmacy".

When it is due, the reminder shows in the bell with the reason you got it. It also reaches you the way you chose in Settings, Reach me, such as a notice on your devices. Its line also appears at the end of the chat you set it in. If Aman is still answering in that chat, the line waits until the answer ends. A reminder whose chat was deleted still shows in the bell.

To mark a reminder urgent, say so when you ask, such as "Remind me at 5 pm to call the pharmacy, it's urgent". An urgent reminder can call you once phone calls are set up and you allow it.

Reminders do not show on the Schedules page. To see them all, click Reminders in the left panel. It lists what is coming up and what has already reminded you, with the persona that set each one. Click a reminder to open the chat you set it in; a reminder set outside a chat, or whose chat was deleted, has no link. The list only shows reminders. To change or cancel one, ask in a chat, such as "What reminders do I have?". Before Aman cancels one, a card shows the reminder and waits for your OK. A cancelled reminder is gone for good.

## Scheduled runs do not interrupt you

A scheduled run sends no notice. Its results wait in its chat until you open it.

## Nothing is sent or changed without you

Aman can think all day. Doing things needs your OK.

A scheduled run can read and search, but it never sends anything by itself. The one thing of yours it changes by itself is a space. It can make and change any space without asking, so a list it keeps for you stays up to date. Every change keeps a version you can ask Aman to bring back. Each change a run saves is also one line in the activity log, under Settings, Audit. Aman cannot delete a space. A space only keeps a clickable link that you gave or that a search returned. A link that only an email or a web page supplied is kept as plain text. It also holds a few things a chat does without asking: running code in the sandbox and setting a reminder. Anything that would need your OK in a chat is held, and the run's chat ends with a **Needs your OK** list. Approve or deny each item there. Held items expire after 24 hours. See [Safety story](/safety) for the details.
