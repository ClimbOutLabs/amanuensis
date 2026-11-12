---
title: 'Privacy'
description: 'What leaves your machine and what stays on it.'
---

Aman runs on your computer. Your memory is plain Markdown files on your disk, and your chats, personas and settings are kept in a database file on the same machine.

If you use a hosted model, the company running it sees each chat: your messages, what Aman knows about you, the memories it recalls, and anything Aman reads for you, such as emails and files. To keep chats on your computer, use only local models. Web searches, maps and connectors still reach their own services, as listed below.

## What leaves your machine

- **To the model you chose:** your message, the chat so far, what Aman knows about you, the memories Aman recalls for that message, and the results of any tools Aman used. With a local model, this stays on your computer.
- **To the model you chose, when Aman uses its browser:** the text of each page Aman reads. With a model that reads images, also the screenshots Aman takes, with password, card and one-time-code fields, and anything a page embeds from elsewhere, covered. The live browser's pictures never go to the model. What you leave on a page is in Aman's next read of it, apart from those fields; see [Aman's browser](/browser).
- **To the web search service:** the search words, and the links Aman opens from the results, when Aman searches the web. The service also sees this computer's internet address.
- **To the map service:** the places and routes Aman looks up. They go only to the map service that Aman is set up to use. Maps run without asking unless you turn off the **Maps** switch in Settings. With the switch off, a map shows a card first.
- **To your browser's push service (Google, Apple or Mozilla), only for devices where you turned notices on:** a sealed notice holding an item number and a generic title such as "Reminder", never the reminder text. The service also sees this computer's internet address and the project's public page as the sender's contact.
- **To the model a new chat starts on, only when something new happens:** Aman notices new events, such as mail from someone you marked always important, a calendar clash, a bill due soon or an approval that has waited. For each one, it sends that one event's short description to the model, such as a sender, a subject and the start of the message. The model only suggests how loudly to tell you. Nothing is sent when nothing is new. If no model can answer, these events arrive as quiet notes. This install's shared Email and Calendar connectors are watched for the owner only. Everyone else is watched only through their own Google connection.
- **To a connector's service:** whatever a connector call sends, such as an email you approved. Calls that send or change something show a card first; see [Safety story](/safety).
- **To package sources (npm, PyPI, Go and Rust), when a skill you approved installs packages:** the names and versions of those packages.
- **To Hugging Face, once:** a request for the memory search model's files the first time Aman starts. Nothing about you is in it, and Aman checks each file against a fixed fingerprint before using it.

The browser loads nothing from third parties: fonts and icons are bundled with Aman. Apart from the services above, the server contacts nothing. Every outside address in Aman's code is on a reviewed list, [scripts/external-hosts.allowlist.json](https://github.com/ClimbOutLabs/amanuensis/blob/main/scripts/external-hosts.allowlist.json), and CI fails if a new one appears.

## What stays on your machine

- Voice input and voice mode. Speech is turned into text by a small model running on your computer, and replies are read aloud by a voice running on your computer. Nothing you say is saved except the message in your chat. The small speech-detection model it needs ships inside the Aman image. Voice mode ends by itself after 2 minutes without you speaking, and after 30 minutes in any case, so a forgotten tab does not keep the microphone open. See [Voice input](/voice-input).
- Memory search. Aman finds related memories with a small model running on your computer.
- Backups. They are written to a folder on your computer; see [Backups](/backup).

## Incognito chats

An incognito chat is a chat Aman forgets. Choose **Start incognito chat** on a new chat, before you send the first message. A chat cannot become incognito later, and an incognito chat cannot become a normal one.

While an incognito chat is open:

- Aman can still read what it already knows, such as your memories and its persona's notes.
- Aman saves nothing from it. It writes no memories and no daily notes, learns nothing about you from it, and adds nothing to past-chat search, the brief or Home.
- Aman cannot make or change anything of its own that would outlive the chat: no spaces, no reminders, no schedules, no new personas and no notes in your notes folder. It can still read them, and switch to a persona you already have. Ask in a normal chat for anything you want kept.
- Through a connector you added, Aman can only look things up. It refuses anything else it would do through one, and tells you to ask in a normal chat. It also refuses a lookup it does not know by name, because a connector's own word that a tool only reads is not enough here.
- Your own email and calendar work as in any chat. Sending a message, saving a draft and adding an event each ask you first.
- The web browser is off, because it keeps its history and sign-ins between chats.
- Text you type but do not send is not saved in the browser tab.
- It shows in the Chats list with an **Incognito** label, only in the browser tab that started it. It never shows in search, and it cannot be put in a folder.
- A bug report sent from it leaves the chat out.

A line above the message box says where your words go. With a local model it reads "Nothing from this chat is kept. It never leaves this machine." With a hosted model it names the company, for example "Nothing from this chat is kept here. It is answered by Anthropic, so the words do leave this machine." The line is checked again after each reply and when you switch persona, so it follows a switch to a persona on another model. Tools such as web search and connectors still reach their own services when Aman uses them.

**Close and delete** removes the chat for good: its messages, pictures and saved files. If you leave it open, or close the tab, Aman deletes it 24 hours after its last reply. A reload of the page also forgets it in that tab, and the 24-hour deletion still happens. Nightly backups leave out incognito chats, and exports skip them.

Some things stay on purpose, because they are the record of what Aman did:

- The approval records of actions you approved, such as an email Aman sent.
- The activity log of tool calls. It keeps a short line about each action, which can repeat its words, for example the address an email went to.
- Anything a tool changed in the world, such as a sent email or a calendar event.
- Token counts and cost per model, for the usage summary. These keep no words and do not name the chat.

## Choosing a model

You can use a hosted model or a local one, and switch any time in Settings. You can also give helper jobs, such as memory summaries, their own model.
