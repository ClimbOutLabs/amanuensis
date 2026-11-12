---
id: privacy
title: Where your data lives and privacy
covers: route:privateChat
---

Aman runs on your computer. Your chats, your personas, your agents and your settings are kept in a database file on the same computer. Your memory is plain Markdown files on the same computer.

Some things leave your computer, and only when needed:

- The model you chose. Each chat goes to that model. A local model keeps everything on your computer.
- The web search service. The search words and the pages Aman opens.
- The map service. Places and routes. With the **Maps** switch off in Settings, only after you approve the card.
- Google. What a connected email or calendar action sends, after you approve it.
- The model a new chat starts on, when Aman notices something new for you, such as a calendar clash. It gets a short description of that one thing, to suggest how loudly to tell you. Nothing is sent when nothing is new.
- Your browser's push service, only for devices where you turned notices on. It gets an item number and a short title such as "Reminder", never the text.

Voice input and voice mode run on your computer. Voice mode ends by itself after 2 minutes of quiet, so the microphone is not left open. Memory search runs on your computer too.

Backups are written to a folder on your computer.

## Incognito chats

An incognito chat is a chat Aman forgets. To start one, open a new chat and press **Start incognito chat** before your first message.

Aman can still read what it already knows. It writes nothing new to memory, your persona notes or the daily brief. The chat is left out of your chat list search and of past chat search.

Aman cannot make anything of its own that would outlive the chat. It cannot make or change spaces, reminders, schedules, personas or notes there, and the web browser is off. It can still read your spaces, reminders and notes, and switch to a persona you already have. Through a connector you added, Aman can only look things up there. Your own email and calendar still ask first, as in any chat. For anything you want kept, ask in a normal chat.

The line above the message box says where your words go. With a hosted model, they still go to that model's company. With a local model, they never leave your computer. The line is checked again after each reply and when you switch persona.

To end it, press **Close and delete**, then **Delete for good**. Every message, picture and file in the chat is gone, and it cannot be brought back. An incognito chat you leave open is deleted on its own a day after its last message.

Some things are kept on purpose. If you approve an action, such as sending an email, the record of that approval stays. The email itself was really sent. The activity log keeps a short line about each action, which can repeat its words.
