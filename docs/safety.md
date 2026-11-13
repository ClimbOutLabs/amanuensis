---
title: 'Safety rules in detail'
description: 'Every rule Aman follows on what it does by itself and what waits for your OK.'
---

# Safety rules in detail

Aman reads, searches and remembers on its own. Sending, deleting and installing wait for your OK. This page lists every rule behind that, in plain words.

For the everyday view, start with [Approval cards](../packages/trueforge/guide/topics/approvals.md) and [Permissions and offline mode](../packages/trueforge/guide/topics/permissions.md).

## What Aman reads is information, never instructions

Aman reads mail, web pages, files, and whatever a connector sends back. A connector is an app or service you linked to Aman. Aman treats all of it as information to report on, never as orders to follow.

- Every chat tells the model that what comes from tools, files, web pages and code projects is information, not instructions. If that content asks Aman to do something, Aman is told to tell you instead of doing it.
- Memories Aman recalls are marked the same way. They are notes about you, not commands.
- What Aman learns about you from chats is kept as information about you, not as instructions.
- A search result counts as a search result only when it comes from the web search service you picked in Settings. A tool of any other connector returns something Aman read, even when the tool is named like a search tool.

## Reading is free, doing needs your OK

Aman sorts every action into one of three groups before it runs.

??? note "Runs without asking"

    Lookups Aman does for you:

    - Aman's own read-only tools.
    - Reading your mail, calendar, spaces and files.
    - Web searches, opening a page, and maps.
    - Read-only tools from connectors that are trusted on this computer, or that you set to **Always allow everywhere**.

    What you say in the chat, and what Aman knows about you, is yours to use. Asking for the weather where you live just runs.

    Two changes to your own things also run without asking:

    - Setting a reminder. It only adds one, and a reminder only ever reaches you.
    - Making or changing a space. Aman keeps a version of every change, so you can ask it to bring the earlier one back.

??? note "Shows a card and waits"

    - Sending mail or messages.
    - Running code.
    - Writing or changing files.
    - Canceling a reminder.
    - Pausing or resuming a schedule.
    - Any connector tool that could change something or reach outside your computer.
    - A tool Aman can't sort into a group.

??? note "Refused without a card"

    Nothing runs for these:

    - A send whose destination can't be checked.
    - A send whose card would hide a recipient or cut off its content.
    - Anything that needs the internet while offline mode is on.

### What the card offers

The card shows what will happen, including what will be sent, before anything leaves your computer. In a chat, the card offers **Allow** and **Not now**. A held action in a scheduled run's list offers **Allow** and **Deny**.

These ask every time, so their cards offer only a yes or a no:

- Sending mail or a message.
- Saving a mail draft.
- A calendar change that invites or emails guests.
- Canceling a reminder, because a canceled reminder is gone for good.
- Pausing or resuming a schedule, because either one changes what runs while you're away.

Deletes and other actions with real effects also offer **Always allow in this chat** when the card names who or where the action goes. Aman then stops asking for that kind of action, to that same place, for the rest of the chat. It asks again in any other chat.

A card that names no such place offers only a yes or a no, because there's nothing to tie a lasting answer to. Making a schedule or a persona asks every time for the same reason. Adding a skill asks every time too.

A change to your own calendar that reaches no guests also offers **Always allow in this chat**. That answer covers every later change to your own calendar in that chat. It's the only lasting answer on a calendar card, so a calendar change asks again in every new chat.

**Always allow everywhere** covers every chat. It's never offered for sends, deletes, installs, outside services or a calendar change. A maps card is the one exception: its **Always allow everywhere** turns on the **Maps** switch, described under Maps below. The connector tools you always allow are listed in that connector's page under **Settings**, **Connectors**, where **Revoke** turns each one off.

An **Always allow everywhere** choice holds for the connector as it was set up when you chose it. If you change its address, or the way it signs in, every such choice on it ends, and each tool asks again. Changing its description, or a key being refreshed, keeps them.

### Maps

A map sends the places it looks up to the map service that Aman is set up to use. Nothing else gets them.

In Settings, under Permissions, the **Maps** switch decides whether a map asks first. The switch starts on, so maps run without asking, wherever the place came from. In a chat, a map that would send something that looks like a password, a key or a payment card number still shows a card. That card offers only a yes or a no, and no earlier answer covers it.

With the switch off, each map shows a card that names the places and the map service they go to. The card offers two lasting answers. **Always allow in this chat** stops the question for the rest of that chat. **Always allow everywhere** turns the **Maps** switch on, so maps stop asking in every chat and in scheduled runs.

A scheduled run never waits for you on a map. With the switch on, its maps run. With the switch off, the run leaves the map out and tells you in one line to turn on **Maps**. A map that would send something that looks like a password or key is left out of a scheduled run too, and the run says so in one line.

### Adding a skill

A skill is a set of instructions, sometimes with scripts, that someone else wrote and that Aman follows. You can ask Aman in a chat to add one from a public GitHub repository.

Aman always shows a card first. Aman itself reads the skill on GitHub, so the name and description on the card are the skill's own, not words the model chose. The card also shows the repository, the folder and the exact version. The skill's own instructions sit under **Details**. A starter skill that comes with Aman is added as shipped, and its card says so. The card offers only a yes or a no, and no earlier answer covers it.

What you approve is what is added. The skill is saved at the exact version on the card, so a later change to the repository isn't picked up. If the repository changes between the card and your answer, nothing is added and Aman asks again.

Adding a skill gives it nothing else. Its scripts run in the sandbox under the same rules as any other code. A skill that wants to reach sites still needs your OK in Settings, under Skills. From a chat, Aman can only add a skill. It can't change or remove one.

An incognito chat can't add a skill. A scheduled run can't add one either, because the tool isn't there.

### Commands in the sandbox

The sandbox is the sealed-off space on your computer where Aman runs code.

In the sandbox, a command that only reads inside the workspace runs without asking. That's still true when several reads are joined, as in `cd repo && git status`. Reads are listing files, reading a file or part of one, searching files, and looking at git history.

Every other command asks first, unless the **Sandbox** switch covers it. Answering **Always allow in this chat** on a command covers running that same command again in this chat, and nothing else.

Installing a package asks first on every sandbox. The **Sandbox** switch never covers it.

??? note "What the Sandbox switch covers"

    In **Settings**, **Permissions**, the **Sandbox** switch lets Aman make new files and run the scripts it wrote in the same chat without asking. The switch only applies where the sandbox has no internet. That's the sandbox the installer sets up, which runs in Docker.

    A sandbox that can reach the internet always asks before it runs code or makes a file, whatever the switch says. That's the case when Aman is started with npx or from source, where the sandbox can reach PyPI and GitHub.

    The installer's sandbox also asks in two places where what it runs can reach a site:

    - A project, or your chats without a project, where you allowed package downloads. Code there can reach the package sites.
    - A chat that uses a skill you let reach its own sites.

    With the switch on, changing a file that already exists, running a script from your project and running tests still ask.

The sandbox is what keeps this work contained. Aman also looks at a script before it runs it without asking, but that look only decides when to ask. It isn't what keeps you safe.

### When Aman holds something it would normally do

Pages, emails from other people, files and tool results are things Aman reads. They're never instructions. Aman holds these with a card, even when the action would otherwise run.

??? note "Something Aman read chose where it goes"

    Aman keeps track of where each link and email address in a chat came from: from you, from a search result, or only from something it read.

    - Emails count as something Aman read, and so do their senders and copied addresses.
    - An email address that only Aman's own earlier reply named counts as something Aman read too, because a reply can repeat what Aman read. It's yours once you write it yourself.
    - A memory keeps its source as well. A link or address in a memory counts as yours only when the memory is something you said. A memory of something Aman read, and the summaries Aman keeps of what it knows, count as something it read.
    - A page link that something Aman read gave is held when Aman would add anything to it, such as your email address, even on a site you named yourself. Opening that link exactly as written still runs.
    - A send, an invite or another action is held the same way when only something Aman read named who or where it goes. A reply to the sender of the email it answers isn't held for that.

    The card says who it goes to and where Aman read that address, for example "This goes to Dana Wolfe (dana@example.org), who sent the email Aman just read."

??? note "It carries a secret"

    A search, page or map that would send a password, an API key, a private key or a payment card number is held, whatever its source.

    So is a read through a connector, even one you set to **Always allow everywhere**, because what the read asks for goes to that connector's service. A connector read that would send one of this computer's own keys doesn't run at all.

??? note "It's very long"

    A search, or a read through a connector, asks first when one part is over 200 characters, or all of it is over 1,000.

??? note "A link adds details to a site only Aman brought up"

    Sometimes Aman names a site itself in a reply, such as a well-known help site. Aman opens the link it wrote there, or a plain deeper page on that site, without asking.

    It asks before it opens a link there that adds a part after a question mark, or that carries one of your own details, such as your email address or phone number.

    This doesn't apply to a site you named or a search returned.

In a scheduled run, a held call is skipped, and the run tells you in one line. A held connector read waits for you in the run's **Needs your OK** list.

You can let file writes run without a card, and let work in the sandbox run without one as described above. No setting covers a send, a delete or a package install.

## Skills and the network

A skill can name the sites it needs to reach. Naming a site grants nothing on its own, and a skill can only ever reach named sites it has been allowed.

- The first time a skill with named sites runs in a chat, a card asks whether the skill may reach the sites it names. **Allow once** covers this chat only. **Always allow** remembers the sites for that skill in every chat. **Deny** remembers the refusal. You can change any of these later in Settings, then Skills.
- Turning down one named site does not switch off the others. The sites you approved still work, and the turned-down site stays out. Clearing its refusal in Settings grants nothing by itself, because your approval never named that site. A card asks about the list again first.
- If a command tries to reach a site no skill named, the connection is refused and a card asks about that one site. The card names no skill, because a refused connection cannot show which skill, if any, made the attempt. Its Always choice names the skill the answer is kept under.
- Connections to bare addresses are always refused, and no card can allow them. That covers addresses on your own machine, such as 127.0.0.1, addresses on your home network, and the address a cloud machine keeps its own settings behind.
- No card ever waits inside a connection. The connection is refused first, and the question is asked in the chat.
- Approving a card runs the held command again, unless the command needs an approval of its own. Then that approval is asked for on its own card, and only your answer about the sites is kept.

## Scheduled runs hold actions for you

A scheduled run has nobody watching it, so it never sends anything by itself. The one thing of yours it changes by itself is a space.

??? note "Every rule for scheduled runs"

    - It can read and search, the same as a chat.
    - It can make and change any space without asking, so a list it keeps for you stays up to date. Every change keeps a version you can ask Aman to bring back. Each change a run saves is also one line in the activity log, under **Settings**, **Audit**.
    - Aman can't delete a space.
    - A space only keeps a clickable link that you gave or that a search returned. A link that only an email or a web page supplied is kept as plain text.
    - Any action that would show a card in a chat is held instead. It doesn't run, and the model is told it was saved for you.
    - If you let file writes run without a card in chat, a scheduled run ignores that choice and holds them too.
    - If you let Aman run code in the sandbox without asking, a scheduled run ignores that choice as well. It holds code, new files and package installs.
    - A chat you're in can set a reminder without a card. A scheduled run holds it.
    - A helper job inside a scheduled run can't hold actions. Its actions are refused.

### The Needs your OK list

When the run finishes, its chat ends with a **Needs your OK** list: "Aman held these for you. Nothing has been done yet." Each item shows what will happen, with **Allow** and **Deny**. Some read-only connector tools also offer **Always allow everywhere**.

- The app builds the list from what was held, not from the model's words. So the model can't hide an item or add a fake one.
- When you approve a held action, Aman checks it again first. If anything the card showed has changed since it was held, such as the guests of an event or the text of a message, nothing is done. Aman says to ask again in chat.
- Held actions expire after 24 hours.
- Up to 20 are kept per chat. If more were held, the list says how many weren't saved, so you can ask again in chat.

The run's chat stays careful when you open it and type there, because that chat still holds what the run read. Your choices to let file writes, or code in the sandbox, run without asking don't apply in it. Each one shows a card. A new chat isn't affected.

## Related

- [Schedules](schedules.md) explains how schedules work.
- [Privacy in detail](privacy.md) lists what leaves your computer.
- [Activity log](../packages/trueforge/guide/topics/activity-log.md) shows what Aman did.
