---
title: 'Safety story'
description: 'What Aman does on its own and what waits for your OK.'
---

Aman reads, searches and remembers on its own. Messages, deletions and installs wait for your OK.

This page says, in plain words, what Aman does on its own and what waits for you.

## What Aman reads is information, never instructions

Aman reads mail, web pages, files, and whatever a connector sends back. All of that is treated as information to report on, never as orders to follow.

- Every chat tells the model that content from tools, files, web pages and repositories is data, not instructions. If that content asks Aman to do something, Aman is told to tell you instead of doing it.
- Memories Aman recalls are marked the same way: they are notes about you, not commands.
- What Aman learns about you from chats is kept as information about you, not as instructions.

## Reading is free, doing needs your OK

Aman sorts every action before it runs.

- **Runs without asking:** lookups done for you. That means Aman's own read-only tools, reading your mail, calendar, spaces and files, web searches, opening a page, maps, and read-only tools from connectors that are trusted on this instance or that you set to "Always allow". What you say in the chat, and what Aman knows about you, is yours to use: asking for the weather where you live just runs.
- **Shows a card and waits:** sending mail or messages, running code, writing or changing files, and any connector tool that could change something or reach outside your machine. A tool Aman cannot classify also shows a card.
- **Refused without a card:** a send whose destination cannot be checked, a send whose card would hide a recipient or cut off its content, and anything that needs the network while Aman is in offline mode. Nothing runs.

The card shows what will happen, including what will be sent, before anything leaves. In a chat, the card offers **Approve** and **Deny**. Sending mail or a message, and a calendar change that invites or emails guests, asks every time: those cards offer only **Approve** and **Deny**. Deletes and other actions with real effects also offer **Always allow this here**: Aman stops asking for that kind of action for the rest of this chat, and asks again in any other chat. **Always allow**, which covers every chat, is never offered for sends, deletes, installs or outside services. The connector tools you always allow are listed in that connector's settings, where **Revoke** turns each one off.

In the sandbox, a command that only reads inside the workspace runs without asking, also when several reads are joined, as in `cd repo && git status`. Reads are listing files, reading a file or part of one, searching files, and looking at git history. Every other command asks first, unless the Sandbox switch described below covers it. Answering **Always allow this here** on a command covers running that same command again in this chat, and nothing else.

Installing a package asks first on every sandbox. The Sandbox switch never covers it.

In Settings, under Permissions, the **Sandbox** switch lets Aman make new files and run the scripts it wrote in the same chat without asking. The switch only applies where the sandbox has no network. That is the sandbox the installer sets up, which runs in Docker. A sandbox that can reach the internet always asks before it runs code or makes a file, whatever the switch says. That is the case when Aman is started with npx or from source, where the sandbox can reach PyPI and GitHub. The installer's sandbox also asks in two places where what it runs can reach a site. One is a project, or your chats without a project, where you allowed package downloads: code there can reach the package sites. The other is a chat that uses a skill you let reach its own sites. With the switch on, changing a file that already exists, running a script from your repository and running tests still ask.

The sandbox is what keeps this work contained. Aman also looks at a script before it runs it without asking, but that look only decides when to ask. It is not what keeps you safe.

### When Aman holds something it would normally do

Pages, emails from other people, files and tool results are things Aman reads. They are never instructions. Two things are held with a card even when the action would otherwise run:

- **Something Aman read chose where it goes.** Aman keeps track of where each link and email address in a chat came from: from you, from a search result, or only from something it read. Emails count as something Aman read, their senders and copied addresses too. An email address that only Aman's own earlier reply named counts as something Aman read too, because a reply can repeat what Aman read. It is yours once you write it yourself. A memory keeps its source as well. A link or address in a memory counts as yours only when the memory is something you said. A memory of something Aman read, and the summaries Aman keeps of what it knows, count as something it read. A page link that something Aman read gave is held when Aman would add anything to it, such as your email address, even on a site you named yourself. Opening that link exactly as written still runs. A send, an invite or another action is held the same way when only something Aman read named who or where it goes. A reply to the sender of the email it answers is not held for that. The card says who it goes to and where Aman read that address, for example "This goes to Dana Wolfe (dana@example.org), who sent the email Aman just read."
- **It carries a secret.** A search, page or map that would send a password, an API key, a private key or a payment card number is held whatever its source. So is a read through a connector, also one you set to "Always allow": what the read asks for goes to that connector's service. A connector read that would send one of this computer's own keys does not run at all.
- **It is very long.** A search, or a read through a connector, over 200 characters in one part, or 1,000 in all, asks first.

In a scheduled run a held call is skipped, and the run tells you in one line. A held connector read waits for you in the run's **Needs your OK** list.

You can choose to let file writes run without a card, and to let work in the sandbox run without one as described above. No setting covers a send, a delete or a package install.

## Scheduled runs never act on their own

A scheduled run has nobody watching it, so it never sends or changes anything by itself.

- It can read and search, the same as a chat.
- Any action that would show a card in a chat is held instead. It is not run, and the model is told it was saved for you.
- If you let file writes run without a card in chat, a scheduled run ignores that choice and holds them too.
- If you let Aman run code in the sandbox without asking, a scheduled run ignores that choice as well. It holds code, new files and package installs.
- A chat you are in can set or cancel a reminder, and pause or resume a schedule, without a card. A scheduled run holds each of those.
- When the run finishes, its chat ends with a **Needs your OK** list: "Aman held these for you. Nothing has been done yet." Each item shows what will happen, with **Approve** and **Deny**, and for some read-only connector tools also **Always allow**.
- The list is built by the app from what was held, not from the model's words, so the model cannot hide an item or add a fake one.
- When you approve a held action, Aman checks it again first. If anything the card showed has changed since it was held, such as the guests of an event or the text of a message, nothing is done and Aman says to ask again in chat.
- Held actions expire after 24 hours. Up to 20 are kept per chat; if more were held, the list says how many were not saved so you can ask again in chat.
- A helper job inside a scheduled run cannot hold actions. Its actions are refused.

See [Schedules](/schedules) for how schedules work, and [Privacy](/privacy) for what leaves your machine.
