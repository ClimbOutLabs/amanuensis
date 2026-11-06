---
title: 'What Aman can do to you'
description: 'What Aman can and cannot do on its own, and what keeps each limit in place.'
---

Aman acts for you, so you should know what it can do without asking. This page says that plainly, one part at a time. For each part it names what holds the limit in place: a rule in the code, a locked-down container, or a file on your disk.

For the detail behind each part, follow the links. [Safety story](/safety) covers approvals, [Privacy](/privacy) covers what leaves your machine, and [Deployment security](/deployment-security) covers sign-in and the network.

## Reading runs, doing waits

Aman sorts every action before it runs. The sorting is done by the app, on the tool itself. The model cannot skip it or talk its way past it.

- **Runs on its own:** reading and searching. That covers your mail, calendar, files and memory, web searches, opening a page, and connector tools that only read.
- **Waits for your OK:** sending mail or messages, deleting, installing, running code, writing files, and any connector tool that could change something. Aman shows a card that says exactly what will happen, and nothing runs until you press **Approve**.
- **Refused outright:** a send whose destination Aman cannot check, a card that would hide a recipient or cut off what is sent, and anything that needs the network while offline mode is on.

Sending mail or a message asks every time. You can never tell Aman to always allow sends, deletes or installs in every chat.

A scheduled run has nobody watching it, so it never sends or changes anything. Anything that would need your OK is held and listed for you at the end of the run. [Safety story](/safety) has the full rules.

## What Aman reads is never an order

Aman reads mail from other people, web pages, files and connector results. All of that is treated as information to report on, not as instructions.

Aman also keeps track of where each link and email address in a chat came from: from you, or only from something it read. When something it read chose where a message or a link goes, Aman holds that action with a card, even if it would normally run. The card tells you where the address came from, so you can see it was not your idea.

A search, page or map that would carry a password, an API key or a card number is held too, whatever its source.

## Skills run in a locked box

A skill is a folder of instructions, and sometimes small scripts, that teaches Aman a task.

- **There is no skill marketplace.** Aman only uses skills from the short list it ships with, or from a git repository you add yourself in **Settings**, then **Skills**. Nothing installs a skill for you.
- **Skills run in the sandbox,** a locked-down container that is separate from your files and from the rest of your computer. A command that changes anything there asks first.
- **The sandbox has no open internet.** Package downloads go only to the package sites Aman allows, such as PyPI and GitHub. Private networks and cloud servers' internal addresses are blocked.
- **A skill can only reach the sites you approve.** A skill that needs a website lists its sites. Aman shows them in **Settings**, then **Skills**, and does nothing until you press **Allow**. After that, a chat using the skill can reach those sites and no others, over secure connections (port 443) only, and only at public addresses. Every refused connection is logged.

Approving a skill's sites is real trust. The skill can send any data from that chat to those sites without asking each time, and Aman warns you when one of them can send email. Only allow a skill you trust, and press **Remove network access** in the same place to take it back.

## Your memory is files you can open

Aman's memory is a folder of plain Markdown files on your computer. There is no hidden store behind it.

You can open the files in any text editor, change them or delete them. Aman reads the files each time it recalls, so it uses your version. Memories are notes about you, and Aman is told never to treat them as instructions. [Memory](/memory) explains where the folder is and how it is organised.

## What leaves your machine

Your chats, memory, personas and settings stay on your computer. A few things go out, and only to the services you chose.

- **The model provider,** only when you choose a hosted model. That company sees each chat: your messages, what Aman knows about you, and anything it reads for you. To keep chats on your computer, use a local model.
- **The web search service,** when Aman searches the web. It sees the search words and your internet address. Turn on offline mode to stop it.
- **Map lookups and connector calls,** such as an email you approved.

Voice input and memory search run on small models on your computer. [Privacy](/privacy) lists every case.

## Where your keys are kept today

Model keys and connector sign-ins you add in Settings are kept in Aman's database file on your computer. A key you gave the installer is kept in the instance's settings file, which only your user can read. Aman does not encrypt either one yet. Encrypting them is in progress.

Until then, your computer's disk encryption is what protects them: BitLocker on Windows, FileVault on a Mac, or an encrypted disk on Linux. Turn it on if it is off.

Backups hold the same keys and are not encrypted either. Keep them on a drive only you can read; [Backups](/backup) shows how.

## What Aman cannot protect you from

- **Someone with full control of your computer.** Anyone with administrator rights or Docker access on it can read Aman's data. Keep that access to yourself.
- **The hosted model you choose.** It sees what you send it. Use a local model for chats that must stay on your computer.
- **A skill or connector you chose to trust.** Once you allow it, it can do what you allowed. Review what you have allowed in Settings from time to time, and remove what you no longer use.
- **Approving a card without reading it.** The card says exactly what will happen. Read it before you press **Approve**.
