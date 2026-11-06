---
id: privacy
title: Where your data lives and privacy
covers:
---

Aman runs on your computer. Your chats, your personas, your agents and your settings are kept in a database file on the same computer. Your memory is plain Markdown files on the same computer.

Some things leave your computer, and only when needed:

- The model you chose. Each chat goes to that model. A local model keeps everything on your computer.
- The web search service. The search words and the pages Aman opens.
- The map service. Places and routes, after you approve the card.
- Google. What a connected email or calendar action sends, after you approve it.
- The model a new chat starts on, when Aman notices something new for you, such as a calendar clash. It gets a short description of that one thing, to suggest how loudly to tell you. Nothing is sent when nothing is new.
- Your browser's push service, only for devices where you turned notices on. It gets an item number and a short title such as "Reminder", never the text.
- Twilio and the phone company, only if you set up texts or calls. Your phone number, each text, and the sound of each call. The voice and the transcript of a call are made on your computer.

Voice input and voice mode run on your computer. Voice mode ends by itself after 2 minutes of quiet, so the microphone is not left open. Memory search runs on your computer too.

Backups are written to a folder on your computer.
