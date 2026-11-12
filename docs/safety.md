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
- A search result is a result from the web search provider you picked in Settings. A tool of any other connector returns something Aman read, even when the tool has the name of a search tool.

## Reading is free, doing needs your OK

Aman sorts every action before it runs.

- **Runs without asking:** lookups done for you. That means Aman's own read-only tools, reading your mail, calendar, spaces and files, web searches, opening a page, maps, and read-only tools from connectors that are trusted on this instance or that you set to "Always allow everywhere". What you say in the chat, and what Aman knows about you, is yours to use: asking for the weather where you live just runs. Two changes to your own things also run without asking. Setting a reminder only adds one, and a reminder only ever reaches you. Making or changing a space keeps a version of every change, so you can ask Aman to bring the earlier one back.
- **Shows a card and waits:** sending mail or messages, running code, writing or changing files, cancelling a reminder, pausing or resuming a schedule, and any connector tool that could change something or reach outside your machine. A tool Aman cannot classify also shows a card.
- **Refused without a card:** a send whose destination cannot be checked, a send whose card would hide a recipient or cut off its content, and anything that needs the network while Aman is in offline mode. Nothing runs.

The card shows what will happen, including what will be sent, before anything leaves. In a chat, the card offers **Approve** and **Deny**. Sending mail or a message, saving a mail draft, and a calendar change that invites or emails guests, each ask every time: those cards offer only **Approve** and **Deny**. Cancelling a reminder asks every time too, because a cancelled reminder is gone for good. So does pausing or resuming a schedule, because either one changes what runs while you are away. Deletes and other actions with real effects also offer **Always allow in this chat** when the card names who or where the action goes: Aman stops asking for that kind of action to that same place for the rest of this chat, and asks again in any other chat. A card that names no such place offers only **Approve** and **Deny**, because there is nothing to tie the answer to. Creating a schedule or a persona asks every time for the same reason. A change to your own calendar that reaches no guests also offers **Always allow in this chat**. That answer covers every later change to your own calendar in that chat. It is the only lasting answer on a calendar card, so a calendar change asks again in every new chat. **Always allow everywhere**, which covers every chat, is never offered for sends, deletes, installs, outside services or a calendar change. A maps card is the one exception: its **Always allow everywhere** turns on the **Maps** switch, described under Maps below. The connector tools you always allow are listed in that connector's settings, where **Revoke** turns each one off. An Always allow everywhere choice holds for the connector as it was set up when you chose it: change its address, or the way it signs in, and every such choice on it ends, so each tool asks again. Changing its description, or a key being refreshed, keeps them.

In the sandbox, a command that only reads inside the workspace runs without asking, also when several reads are joined, as in `cd repo && git status`. Reads are listing files, reading a file or part of one, searching files, and looking at git history. Every other command asks first, unless the Sandbox switch described below covers it. Answering **Always allow in this chat** on a command covers running that same command again in this chat, and nothing else.

Installing a package asks first on every sandbox. The Sandbox switch never covers it.

In Settings, under Permissions, the **Sandbox** switch lets Aman make new files and run the scripts it wrote in the same chat without asking. The switch only applies where the sandbox has no network. That is the sandbox the installer sets up, which runs in Docker. A sandbox that can reach the internet always asks before it runs code or makes a file, whatever the switch says. That is the case when Aman is started with npx or from source, where the sandbox can reach PyPI and GitHub. The installer's sandbox also asks in two places where what it runs can reach a site. One is a project, or your chats without a project, where you allowed package downloads: code there can reach the package sites. The other is a chat that uses a skill you let reach its own sites. With the switch on, changing a file that already exists, running a script from your repository and running tests still ask.

The sandbox is what keeps this work contained. Aman also looks at a script before it runs it without asking, but that look only decides when to ask. It is not what keeps you safe.

### Maps

A map sends the places it looks up to the map service that Aman is set up to use. Nothing else gets them.

In Settings, under Permissions, the **Maps** switch decides whether a map asks first. The switch starts on, so maps run without asking, wherever the place came from. In a chat, a map that would send something that looks like a password, a key or a payment card number still shows a card, as described below. That card offers only **Approve** and **Deny**, and no earlier answer covers it.

With the switch off, each map shows a card that names the places and the map service they go to. The card offers two lasting answers. **Always allow in this chat** stops the question for the rest of that chat. **Always allow everywhere** turns the **Maps** switch on, so maps stop asking in every chat and in scheduled runs.

A scheduled run never waits for you on a map. With the switch on, its maps run. With the switch off, the run leaves the map out and tells you in one line to turn on **Maps**. A map that would send something that looks like a password or key is left out of a scheduled run too, and the run says so in one line.

### When Aman holds something it would normally do

Pages, emails from other people, files and tool results are things Aman reads. They are never instructions. These are held with a card even when the action would otherwise run:

- **Something Aman read chose where it goes.** Aman keeps track of where each link and email address in a chat came from: from you, from a search result, or only from something it read. Emails count as something Aman read, their senders and copied addresses too. An email address that only Aman's own earlier reply named counts as something Aman read too, because a reply can repeat what Aman read. It is yours once you write it yourself. A memory keeps its source as well. A link or address in a memory counts as yours only when the memory is something you said. A memory of something Aman read, and the summaries Aman keeps of what it knows, count as something it read. A page link that something Aman read gave is held when Aman would add anything to it, such as your email address, even on a site you named yourself. Opening that link exactly as written still runs. A send, an invite or another action is held the same way when only something Aman read named who or where it goes. A reply to the sender of the email it answers is not held for that. The card says who it goes to and where Aman read that address, for example "This goes to Dana Wolfe (dana@example.org), who sent the email Aman just read."
- **It carries a secret.** A search, page or map that would send a password, an API key, a private key or a payment card number is held whatever its source. So is a read through a connector, also one you set to "Always allow everywhere": what the read asks for goes to that connector's service. A connector read that would send one of this computer's own keys does not run at all.
- **It is very long.** A search, or a read through a connector, over 200 characters in one part, or 1,000 in all, asks first.
- **A link adds details to a site only Aman brought up.** Sometimes Aman names a site itself in a reply, such as a well-known help site. Aman opens the link it wrote there, or a plain deeper page on that site, without asking. It asks before opening a link there that adds a part after a question mark, or that carries one of your own details, such as your email address or phone number. This does not apply to a site you named or a search returned.

In a scheduled run a held call is skipped, and the run tells you in one line. A held connector read waits for you in the run's **Needs your OK** list.

You can choose to let file writes run without a card, and to let work in the sandbox run without one as described above. No setting covers a send, a delete or a package install.

## Scheduled runs hold actions for you

A scheduled run has nobody watching it, so it never sends anything by itself. The one thing of yours it changes by itself is a space.

- It can read and search, the same as a chat.
- It can make and change any space without asking, so a list it keeps for you stays up to date. Every change keeps a version you can ask Aman to bring back. Each change a run saves is also one line in the activity log, under Settings, Audit. Aman cannot delete a space. A space only keeps a clickable link that you gave or that a search returned. A link that only an email or a web page supplied is kept as plain text.
- Any action that would show a card in a chat is held instead. It is not run, and the model is told it was saved for you.
- If you let file writes run without a card in chat, a scheduled run ignores that choice and holds them too.
- If you let Aman run code in the sandbox without asking, a scheduled run ignores that choice as well. It holds code, new files and package installs.
- A chat you are in can set a reminder without a card. A scheduled run holds it.
- When the run finishes, its chat ends with a **Needs your OK** list: "Aman held these for you. Nothing has been done yet." Each item shows what will happen, with **Approve** and **Deny**, and for some read-only connector tools also **Always allow everywhere**.
- The list is built by the app from what was held, not from the model's words, so the model cannot hide an item or add a fake one.
- When you approve a held action, Aman checks it again first. If anything the card showed has changed since it was held, such as the guests of an event or the text of a message, nothing is done and Aman says to ask again in chat.
- Held actions expire after 24 hours. Up to 20 are kept per chat; if more were held, the list says how many were not saved so you can ask again in chat.
- A helper job inside a scheduled run cannot hold actions. Its actions are refused.
- The run's chat stays careful when you open it and type there. That chat still holds what the run read. So your choices to let file writes, or code in the sandbox, run without asking do not apply in it. Each one shows a card. A new chat is not affected.

See [Schedules](/schedules) for how schedules work, and [Privacy](/privacy) for what leaves your machine.
