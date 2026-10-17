---
title: 'Safety story'
description: 'What Aman does on its own and what waits for your OK.'
---

Aman can think all day. Doing things needs your OK.

This page says, in plain words, what Aman does on its own and what waits for you.

## What Aman reads is information, never instructions

Aman reads mail, web pages, files, and whatever a connector sends back. All of that is treated as information to report on, never as orders to follow.

- Every chat tells the model that content from tools, files, web pages and repositories is data, not instructions. If that content asks Aman to do something, Aman is told to tell you instead of doing it.
- Memories Aman recalls are marked the same way: they are notes about you, not commands.
- What Aman learns about you from chats is kept as information about you, not as instructions.
- An extra screen can check web results and hold back any that look like an attack. It is off by default; turn it on with `TOOL_OUTPUT_SCREEN_ENABLED`.

## Reading is free, doing needs your OK

Aman sorts every action before it runs.

- **Runs without asking:** Aman's own read-only tools, web searches with the search service you picked, and read-only tools from connectors that are trusted on this instance or that you set to "Always allow".
- **Shows a card and waits:** sending mail or messages, running code, writing or changing files, and any connector tool that could change something or reach outside your machine. A tool Aman cannot classify also shows a card.
- **Refused without a card:** a send whose destination cannot be checked, a send whose card would hide a recipient or cut off its content, and anything that needs the network while Aman is in offline mode. Nothing runs.

The card shows what will happen, including what will be sent, before anything leaves. You can approve once, deny, or (for some read-only tools) choose "Always allow". "Always allow" is never offered for sends, deletes, installs or outside services. You can review and revoke your "Always allow" choices in the connector's settings.

You can choose to let file writes run without a card. That is the only kind of action you can relax this way.

## Scheduled runs never act on their own

A scheduled run has nobody watching it, so it never sends or changes anything by itself.

- It can read and search, the same as a chat.
- Any action that would show a card in a chat is held instead. It is not run, and the model is told it was saved for you.
- If you let file writes run without a card in chat, a scheduled run ignores that choice and holds them too.
- When the run finishes, its chat ends with a **Needs your OK** list: "Aman held these for you. Nothing has been done yet." Each item shows the same card you would see in chat, with Approve and Deny.
- The list is built by the app from what was held, not from the model's words, so the model cannot hide an item or add a fake one.
- Held actions expire after 24 hours. Up to 20 are kept per chat; if more were held, the list says how many were not saved so you can ask again in chat.
- A helper job inside a scheduled run cannot hold actions. Its actions are refused.

See [Schedules](/schedules) for how schedules work, and [Privacy](/privacy) for what leaves your machine.
