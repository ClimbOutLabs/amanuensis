---
title: 'Privacy in detail'
description: 'Every service Aman talks to, what each one sees, and what stays on your computer.'
---

# Privacy in detail

Aman runs on your computer. Your memory is a set of plain text files (Markdown) on your disk. Your chats, personas and settings are kept in a database file on the same computer.

For a short overview, see [Your privacy](../packages/trueforge/guide/topics/privacy.md).

!!! warning "The model sees what you send it"

    If you use a hosted model, the company running it sees each chat. That includes your messages, what Aman knows about you, the memories it recalls, and anything Aman reads for you, such as emails and files.

    To keep chats on your computer, use only local models. Web searches, maps and connectors still reach their own services, as listed below.

## What leaves your computer

??? note "To the model you chose"

    - Your message and the chat so far.
    - What Aman knows about you.
    - The memories Aman recalls for that message.
    - The results of any tools Aman used.

    With a local model, all of this stays on your computer.

??? note "To the model you chose, when Aman uses its browser"

    - The text of each page Aman reads.
    - With a model that reads images, also the screenshots Aman takes. Password, card and one-time-code fields are covered, and so is anything a page embeds from elsewhere.
    - The live browser's pictures never go to the model.
    - What you leave on a page is in Aman's next read of it, apart from those fields. See [Aman's browser](browser.md).

??? note "To the web search service"

    The search words, and the links Aman opens from the results, when Aman searches the web. The service also sees this computer's internet address.

??? note "To the map service"

    The places and routes Aman looks up. They go only to the map service that Aman is set up to use. Maps run without asking unless you turn off the **Maps** switch in Settings. With the switch off, a map shows a card first.

??? note "To the model a new chat starts on, only when something new happens"

    Aman notices new events, such as mail from someone you marked always important, a calendar clash, a bill due soon or an approval that has waited. For each one, it sends that one event's short description to the model, such as a sender, a subject and the start of the message. The model only suggests how loudly to tell you. Nothing is sent when nothing is new. If no model can answer, these events arrive as quiet notes.

    This install's shared Email and Calendar connectors are watched for the owner only. Everyone else is watched only through their own Google connection.

??? note "To your browser's push service, only on devices where you turned notices on"

    The push service belongs to your browser's maker: Google, Apple or Mozilla.

    - It gets a sealed notice holding an item number and a plain title such as "Reminder". It never gets the reminder text.
    - It also sees this computer's internet address.
    - It sees the project's public page as the sender's contact.

??? note "To Twilio and the phone company, only if you set up texts and switch them on"

    Twilio and the phone company get your phone number and each text.

    - In Private mode, the default, a text holds only the assistant's name and the kind of thing, such as "a reminder is due". It has no names, amounts or message content.
    - In Full mode, a reminder's text holds the reminder, but only when every word is one Aman knows.
    - Anything your assistant noticed gets the Private words, never the model's own words.
    - The confirmation code is texted once, to prove the number is yours.
    - Aman never writes the number, the text or Twilio's auth token to its logs.

    See [Text messages](/text-messages).

??? note "To Twilio and the phone company, only if you set up calls and switch them on"

    Twilio and the phone company get your phone number and the sound of each call.

    - The assistant's voice and the transcript are made on your computer. No speech service on the internet is used.
    - A call says only who is calling, who it is for and the kind of thing until you give a short yes. A voicemail says only that something needs you.
    - After your yes, the assistant on the call knows only the thing it called about. It cannot see your mail, calendar, memories or files, and it cannot change anything. What it is sent is that one thing and what was said on the call.
    - Aman keeps no recording, and never writes your number or what was said to its logs.
    - What was said is written only in the call's chat, as a quoted record of the call, never as your own request.
    - Whoever says yes hears the message, because the phone cannot tell if it is you. If a kind of thing is too private for that, untick it under "What may call you".

    See [Phone calls](/phone-calls).

??? note "To a connector's service"

    Whatever a connector call sends, such as an email you approved. Calls that send or change something show a card first. See [Safety rules in detail](safety.md).

??? note "To GitHub, when you ask Aman in a chat to add a skill"

    The address of that skill and a request to read it. Nothing about you is in it. GitHub also sees this computer's internet address.

??? note "To package sources, when a skill you approved installs packages"

    The names and versions of those packages go to the package sources: npm, PyPI, Go and Rust.

??? note "To Hugging Face, once"

    The first time Aman starts, it asks Hugging Face for the files of the memory search model. Nothing about you is in that request. Aman checks each file against a fixed fingerprint before it uses it.

The browser loads nothing from other companies. Fonts and icons come bundled with Aman.

Apart from the services above, Aman's server contacts nothing. Every outside address in Aman's code is on a reviewed list, [scripts/external-hosts.allowlist.json](https://github.com/ClimbOutLabs/amanuensis/blob/main/scripts/external-hosts.allowlist.json). An automatic check fails if a new one appears.

## What stays on your computer

- **Voice input and voice mode.** A small model on your computer turns your speech into text, and a voice on your computer reads replies aloud. Nothing you say is saved, except the message in your chat. The small speech-detection model it needs ships inside Aman. Voice mode ends by itself after 2 minutes without you speaking, and after 30 minutes in any case, so a forgotten tab doesn't keep the microphone on. See [Voice input](voice-input.mdx).
- **Memory search.** A small model on your computer finds related memories.
- **Backups.** They're written to a folder on your computer. See [Back up and restore](backup.md).

## Incognito chats

An incognito chat is a chat Aman forgets. [Incognito chat](../packages/trueforge/guide/topics/incognito.md) shows how to start and end one. Here is everything it keeps and doesn't keep.

You choose **Start incognito chat** on a new chat, before you send the first message. A chat can't become incognito later, and an incognito chat can't become a normal one.

??? note "While an incognito chat is open"

    - Aman can still read what it already knows, such as your memories and its persona's notes.
    - Aman saves nothing from it. It writes no memories and no daily notes, learns nothing about you from it, and adds nothing to past-chat search, the brief or Home.
    - Aman can't make or change anything of its own that would outlive the chat: no spaces, no reminders, no schedules, no new personas and no notes in your notes folder. It can still read them, and switch to a persona you already have. Ask in a normal chat for anything you want kept.
    - Through a connector you added, Aman can only look things up. It refuses anything else it would do through one, and tells you to ask in a normal chat. It also refuses a lookup it doesn't know by name, because a connector's own word that a tool only reads isn't enough here.
    - Your own email and calendar work as in any chat. Sending a message, saving a draft and adding an event each ask you first.
    - The web browser is off, because it keeps its history and sign-ins between chats.
    - Text you type but don't send isn't saved in the browser tab.
    - It shows in the Chats list with an **Incognito** label, only in the browser tab that started it. It never shows in search, and it can't be put in a folder.
    - A bug report sent from it leaves the chat out.

??? note "Where your words go"

    A line above the message box says where your words go.

    - With a local model it reads "Nothing from this chat is kept. It never leaves this machine."
    - With a hosted model it names the company, for example "Nothing from this chat is kept here. It is answered by Anthropic, so the words do leave this machine."

    The line is checked again after each reply and when you switch persona, so it follows a switch to a persona on another model.

    Tools such as web search and connectors still reach their own services when Aman uses them.

??? note "When an incognito chat ends"

    **Close and delete** removes the chat for good: its messages, pictures and saved files.

    If you leave it open, or close the tab, Aman deletes it 24 hours after its last reply. Reloading the page also forgets it in that tab, and the 24-hour deletion still happens.

    Nightly backups leave out incognito chats, and exports skip them.

??? note "What an incognito chat keeps on purpose"

    Some things stay, because they're the record of what Aman did:

    - The approval records of actions you approved, such as an email Aman sent.
    - The activity log of tool calls. It keeps a short line about each action, which can repeat its words, for example the address an email went to.
    - Anything a tool changed in the world, such as a sent email or a calendar event.
    - Token counts and cost per model, for the usage summary. These keep no words and don't name the chat.

## Choosing a model

You can use a hosted model or a local one, and switch any time. You add models in **Settings**, **Models**. In **Settings**, **Roles and Personas**, you can also give helper jobs, such as memory summaries, their own model.

## Related

- [Your privacy](../packages/trueforge/guide/topics/privacy.md)
- [Safety rules in detail](safety.md)
- [Permissions and offline mode](../packages/trueforge/guide/topics/permissions.md)
