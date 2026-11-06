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
- **To the map service:** the places and routes Aman looks up, after you approve the card.
- **To your browser's push service (Google, Apple or Mozilla), only for devices where you turned notices on:** a sealed notice holding an item number and a generic title such as "Reminder", never the reminder text. The service also sees this computer's internet address and the project's public page as the sender's contact.
- **To Twilio and the phone company, only if you set up texts and switch them on:** your phone number and each text. In Private mode, the default, a text holds only the assistant's name and the kind of thing, such as "a reminder is due", with no names, amounts or message content. In Full mode it holds the one-sentence message. The confirmation code is texted once, to prove the number is yours. Aman never writes the number, the text or Twilio's auth token to its logs. See [Text messages](/text-messages).
- **To Twilio and the phone company, only if you set up calls and switch them on:** your phone number and the sound of each call. The assistant's voice and the transcript are made on your computer, and no speech service on the internet is used. A call says only who is calling, who it is for and the kind of thing until you give a short yes, and a voicemail says only that something needs you. After your yes, the assistant on the call knows only the thing it called about. It cannot see your mail, calendar, memories or files, and it cannot change anything; what it is sent is that one thing and what was said on the call. Aman keeps no recording, and never writes your number or what was said to its logs. What was said is written only in the call's chat. See [Phone calls](/phone-calls).
- **To the model a new chat starts on, only when something new happens:** Aman notices new events, such as mail from someone you marked always important, a calendar clash, a bill due soon or an approval that has waited. For each one, it sends that one event's short description to the model, such as a sender, a subject and the start of the message. The model only suggests how loudly to tell you. Nothing is sent when nothing is new. If no model can answer, these events arrive as quiet notes. This install's shared Email and Calendar connectors are watched for the owner only. Everyone else is watched only through their own Google connection.
- **To a connector's service:** whatever a connector call sends, such as an email you approved. Calls that send or change something show a card first; see [Safety story](/safety).
- **To package sources (npm, PyPI, Go and Rust), when a skill you approved installs packages:** the names and versions of those packages.
- **To Hugging Face, once:** a request for the memory search model's files the first time Aman starts. Nothing about you is in it, and Aman checks each file against a fixed fingerprint before using it.

The browser loads nothing from third parties: fonts and icons are bundled with Aman. Apart from the services above, the server contacts nothing. Every outside address in Aman's code is on a reviewed list, [scripts/external-hosts.allowlist.json](https://github.com/ClimbOutLabs/amanuensis/blob/main/scripts/external-hosts.allowlist.json), and CI fails if a new one appears.

## What stays on your machine

- Voice input and voice mode. Speech is turned into text by a small model running on your computer, and replies are read aloud by a voice running on your computer. Nothing you say is saved except the message in your chat. The small speech-detection model it needs ships inside the Aman image. Voice mode ends by itself after 2 minutes without you speaking, and after 30 minutes in any case, so a forgotten tab does not keep the microphone open. See [Voice input](/voice-input).
- Memory search. Aman finds related memories with a small model running on your computer.
- Backups. They are written to a folder on your computer; see [Backups](/backup).

## Choosing a model

You can use a hosted model or a local one, and switch any time in Settings. You can also give helper jobs, such as memory summaries, their own model.
