# How memory works

This page explains where Aman keeps memories, how it picks what to save, and how it finds them again. To read, change or forget your memories, see [Memory](../packages/trueforge/guide/topics/memory.md).

## Memories are ordinary files

Aman saves memories as plain text files in Markdown, a simple text format. They live in a memory folder on the computer that runs Aman. By default that is `./data/memory`, next to the server. There is no separate database: you can open the files and read them.

The folder is set by `MEMORY_MARKDOWN_DIR`, relative to the server's working folder. **Settings**, **Memory**, **Settings** shows the folder this Aman uses.

!!! warning "Keep the memory folder safe"

    If you run Aman with Docker, store the memory folder on a persistent volume. Without one, your memories and the downloaded search helper disappear whenever the container is recreated.

## What Aman saves

Memory is on by default. Before every reply, Aman looks up the memories that fit what you asked. After every finished turn, it saves what is worth keeping. The model never has to remember to do either.

With **Turn summaries** on, Aman keeps only lasting facts: facts about you, plans, preferences, decisions and anything you asked it to remember. A turn with nothing lasting saves nothing. If a summary can't be made, nothing is saved for that turn, and the **Memories** tab says so.

Each fact is a short note that starts with what it is about, such as "Sister Lexie is allergic to shellfish", without your name in front. Aman uses your name only where a note would be unclear without it. Notes saved before this change keep their wording.

With **Turn summaries** off, Aman saves each turn word for word, as two notes. Your words are one note. Aman's reply is a second note, marked `> External source: assistant reply`, so what Aman said is never saved as something you said. The summaries use the **Background model** from [A model for each job](model-roles.mdx), and each one costs an extra model call.

### What Aman learns about you

What Aman learns about you lives in your profile, not in memory. The learned profile lives in **Settings**, **Memory**, on the **Learned profile** tab, and is added to every reply from there. It has a size limit. When it is full, its oldest fact about you is moved into memory, word for word, to make room for the new one, so nothing is lost and there is nothing for you to tidy. Earlier versions also saved a copy of it as a note in memory. When you clear the learned profile or delete your profile, Aman stops using that copy at once, it no longer shows in your memories, and its text is removed from your disk like any memory you delete.

### Messages you send

When you send an email through Aman, it keeps one note of it in the daily log: who it went to, the subject and what you wrote. Aman does not ask a model to write this note, so it is saved even when turn summaries are off. If you forward a message, only the words you added are kept, never the message you forwarded. A draft is not kept, and neither is a message that did not go out or whose delivery was uncertain. A message you send from an incognito chat is not kept either. A very long message is cut, and the note says so. Each note closes with `> External source: a message you sent`, and the Memories page shows those words. Notes an older version saved with `> Source: a message you sent` show the same new words. [Memory design](../ops/memory/DESIGN.md#messages-the-person-sends) has the details.

## How Aman finds memories

Aman searches your memories by meaning, not just by matching words. So "where did we stay in Paris" finds the hotel note even if it says "Hotel Lumiere" and never mentions Paris.

To do that, Aman downloads a small memory model once, about 120 MB. The download starts in the background when the server starts, so it is usually done before you need it. There is nothing to install or click.

- After that one download, memory search works fully offline, and everything stays on your server.
- The memory model is kept inside the memory folder, so the two travel together.
- If the download can't finish, Aman finds memories with keywords instead and keeps retrying in the background.

**Settings**, **Memory**, **Settings** shows the helper's state: Starting, Downloading, Indexing, Ready or Keywords only.

Recall is limited in size, so a large memory can't crowd out the conversation. Each recalled block is recorded in that turn's events as `aman.memory.recall`, so you can check what the model saw.

### When a memory is shown

Aman looks through every saved note, from the whole log and not only the last two weeks, and compares what each note means with what you wrote. It shows a note only when your message is clearly about it. A message that only shares a word with a note, such as "remember", shows nothing. Aman shows at most four notes for one message, or six when no page holds any fact yet. A note that Aman has already sorted onto a page is left out of this search, because the page already holds it and keeps track of what has changed. Your own words that Aman found no page for stay in the search. When very little is saved, fewer than five notes and facts together, Aman cannot tell what is clearly about something, so it finds notes by shared words as well. It does the same while the memory model is not ready.

Aman looks through everything it has saved, however long ago. One kind of note is different. Notes that Aman took from something it read for you, such as an email or a web page, are brought up for 14 days. After that they stay in your files, but Aman no longer brings them up on its own.

## Pages about people and matters

Beside the saved notes, the memory folder can hold short pages, such as `people/wendy.md` or `matters/lisbon-trip.md`. A page's file name must be the lowercase name, so rename a file such as `Wendy.md` to `wendy.md` or Aman will not read it; the server log warns when a file is skipped for this reason. When your message names someone who has a page, Aman reads that page first, so it starts the reply already knowing the basics. A name in one of your earlier messages in the same chat counts too, so "What can she not eat?" finds the page for the person you named a moment ago. Aman can also find a single fact on a page by its meaning: "Who lives next door to us?" finds "Aiko Tanaka is the neighbour at number 14" even though the page is not named. It shows up to six such facts, each under its page, and shows nothing when your message has nothing to do with what it remembers. A fact that has ended is shown as earlier, and only for a month unless you ask about the past, for example with "used to". Finding facts by meaning needs the memory model; until it is ready, Aman reads only the pages you name. Each fact on a page is one line, and a hidden note on that line records where it came from: something you said, something you wrote by hand, or something read in mail. Only your own words count as instructions for how to write to a person. Aman does not list your pages in every reply. When you ask about something and no page was shown for it, such as "What am I waiting on?", Aman can look at the list of pages and open one that looks relevant. It shows the same lines, with the same labels, as when your message names a page. A page that holds a line Aman read is treated like any page shown to it: in that reply Aman changes or forgets a line of your own only when your message names that line. Pages with no line of your own are listed apart, and their name is marked as not confirmed by you, because a model chose it from something it read. None of this happens in an incognito chat. You can write pages by hand. You can also tell Aman in a chat to remember, change or forget a fact about someone, and it keeps that on their page. What you type in that message is saved as yours, marked `From you`. You can also ask Aman to save something it read for you, such as an address from an email, with "Save that". Aman saves it on the page straight away, with no extra step, and marks the line `External source: read content`. It makes a new page if there is none yet. Aman does not save a line that looks like a password, a key or a card number onto a page, even when you ask. It tells you it did not save it. A line marked this way is never treated as your instruction, and it never replaces a line of your own: when the two differ, Aman keeps both. To replace your own line, say the new fact yourself. How you like to write to someone is saved only from your own words. In a reply where Aman has read mail, the web or a file, it changes or forgets a line of your own only when your message names that line, as in "forget that Wendy plays tennis". A link or email address in a memory that came from something Aman read, such as a mail, a web page or a file, still counts as something Aman read whenever it is recalled in a later chat, so Aman may check with you before it sends something to it. Each change Aman makes is kept in a history next to your pages, so it can be undone. Your own edits are noted the next time Aman writes. Pages travel with an export and come back on import, so moving to a new computer does not lose them. Pages work with the default Markdown memory only. [Memory design](../ops/memory/DESIGN.md#pages) has the details.

### Seeing and fixing your pages

Open **Settings**, **Memory**, **Pages** to read the pages Aman keeps. People and matters are in two groups, and you can search by a name or another name for the page. Each row in the list shows the name, a short summary and the day the page last changed. Aman writes the summary when it makes a page: one line on what the page covers and when it is worth reading. It is a description for you only. Aman is never shown it as something you said. Open a page to see the summary and then its facts, one short line each. Each line that is not yours says `External source:` and then where it came from, such as email, calendar, read content or a message you sent. A line of your own says `From you`. Lines under Unconfirmed say they are not confirmed, and you can **Confirm** or **Dismiss** each one. A confirmed line becomes yours. You can also edit a page as text. The text shows the page's name on the first line, then each heading and its lines. It leaves out the hidden notes and the settings at the top of the file, so an edit cannot break them. Changing the first line renames the page. A line you leave alone keeps where it came from and its dates. A line you change or add counts as coming from you, from today. If the page changed while you were editing, Aman asks you to reload it and try again. **Delete** removes a page, and for a few seconds you can undo it. Under each page you have **Copy**, **Edit** and **Delete**, the same as under a memory. Every change to a page is kept in a history next to your pages on disk. This tab shows only with the default Markdown memory.

### Sorting what Aman saves onto pages

Aman can sort each note it saves onto your pages: a new fact goes on the right page, a changed fact moves the old one to Earlier, and a fact that is already there is only marked as seen again. A message is put on your pages only once. When you ask Aman in a chat to remember something and it writes the page line there and then, the note from that same message stays on the Memories tab and is not sorted onto pages a second time. This is off until you turn it on. Open **Settings**, **Memory**, **Settings** and find **Sort what Aman saves onto pages**. Choose **Off**, **Only note what it would do** or **On**. The change counts from the next note Aman saves, with no restart. It uses the model while you are not chatting. With **Only note what it would do**, Aman writes the plan to a file called `.sorter-report.jsonl` in the memory folder and changes no page. The report holds the plan in Aman's own short words, never the note itself. When you delete or edit a memory, what Aman planned for it leaves the report too. With **On**, Aman writes the pages, but we advise waiting until it has passed our tests. A server can set the starting choice with `MEMORY_PAGE_SORTING` (`off`, `report` or `on`, default `off`). What you choose in Settings wins over it. The controls show only with the default Markdown memory. Aman treats your own words and what it read differently. A fact from your own words can be confirmed. A fact from mail, the web, a file or Aman's own reply is only ever added as unconfirmed. Aman never changes, ends or removes something you confirmed because of what it read, and never writes how you write to someone from it. When Aman sorts a note of your own words, it may tidy the wording. If the new wording picks up a word that is only in something Aman read, such as a car model from an email, the line is not marked `From you`. It waits under Unconfirmed as `External source: Aman’s guess`, and your own line stays as it was. Nothing is sorted in an incognito chat.

### A small tidy once a day

This is off until you turn it on. Open **Settings**, **Memory**, **Settings** and switch on **Tidy pages once a day**. The change counts from the next time Aman looks at the clock, with no restart. Once a day Aman then tidies your pages, and it uses the model while you are not chatting. It starts at midnight unless you pick another hour under **Start the daily tidy-up at**. The hour is the time on the computer Aman runs on. Aman starts within three hours of that hour and before the day ends. To tidy straight away, choose **Tidy now**. It works at any hour, also while the daily tidy is switched off, and when it has finished it tells you what it did. When nothing changed, it says why: sorting is off, no model was found, the model took too long to answer, or its answers could not be read. The tidy-up waits for a slow model as long as it is still answering, up to ten minutes for each try, and tries twice. To change the ten minutes, pick another time under **Wait for the model up to**, from 1 minute to 20 minutes. The same wait counts when Aman sorts a note after a chat. You can leave the page while it works. When you come back within the hour, the page shows that it is still tidying, or what it did. Choosing **Tidy now** many times never makes Aman give up on a note. It does three things. It moves a line to Earlier when the end day you or Aman gave it has passed. It sorts notes from the last 14 days that were missed, as far as your sorting choice allows. With sorting off, it skips this and the next step. It looks for two lines on a page that cannot both be true, and lists them for you. On the page you see "These lines disagree" with both lines and a reason. Edit the page to fix the line that is wrong, or choose **Not a problem** and Aman will not list that pair again. Aman never changes the words of a line, never removes a line, and never decides which of two lines is right. It does the same for each persona's pages. To turn the tidy off, switch **Tidy pages once a day** off. A server can set the starting choice with `MEMORY_NIGHTLY_JOB` (`true` or `false`, default `false`). What you choose in Settings wins over it. It needs the same model as your memory notes, so it does nothing in those steps when no model is set up. Nothing is tidied because of an incognito chat.

### The model that does the background work

After each chat Aman does some work in the background. It picks out what to remember, files it on your pages, tidies the pages and names the chat. All of this uses one model, the background model. Unless you choose one, it is the main chat model. To choose one, open **Settings**, **Roles and Personas**, and pick a model under **Background model**. A smaller, faster model works well here. The choice counts from the next chat, with no restart. Choose **Default** to go back to the main chat model.

Aman keeps this work small in two ways.

- It reads each thing once. When the model found nothing worth keeping in a message, Aman remembers that. If the very same message comes again, Aman does not ask the model about it again. So if the model once missed something in a message, sending the exact same words again will not save it. Say it in other words, or ask Aman to remember it. A new model reads everything fresh.
- It does not ask twice. Some models think before they answer and run out of room. Aman then asks once more with more room. After that it gives that model the larger room from the start, until Aman restarts.

## Where each memory came from

Every note ends with one line that says where it came from. The Memories tab shows this label only when a note came from somewhere else. A note with no label there is one you said yourself.

- `> From you` means you said it in a chat.
- `> External source: ...` means it came from somewhere else. The line names the source: `email`, `calendar`, `web page`, `attachment`, `tool result`, `assistant reply`, `a message you sent`, `read content` or `imported file`.
- `> External source: assistant reply, nothing read before it` is a note of Aman's own reply from a chat where Aman had read nothing from outside up to that reply: no email, page, file, tool result or external memory. Aman treats it as its own earlier reply and not as other people's content. An email address in it still counts as something Aman read. If you edit the note, it becomes a plain `assistant reply` note.

Aman treats a note as your own words only when it ends with `> From you`. Everything else counts as something Aman read. Aman still remembers it, but it asks you before it uses a link or an address from it. See [Safety](safety.md).

Aman never guesses a source. A note that would be saved without one is not saved at all. A note with no source line counts as external.

- **Notes saved before this.** The first time this version starts, Aman adds a line to every older note that has none. The line is `> External source: no record`, because nothing shows where those notes came from. Each daily file is copied to a `.before-source-lines` folder in its vault before it is changed. Aman does this one vault at a time, while it holds that vault's lock, so a note saved at the same moment is not lost. A note you deleted stays erased and is not given a line. To make a fact your own again, say it to Aman in a chat, or review your older notes once (see below).
- **Reviewing older notes.** Some older notes were saved in a chat where Aman had read nothing from outside and you had attached no file. The Memories page shows a notice for these, with a **Review older notes** button. The list shows each note with its day, its text and the title of its chat. Nothing is ticked at the start. Tick the notes that are your own words, then click **Mark the ticked notes as from me**. Aman treats those notes as your own words from then on, and acts on them without asking, as it does for things it read. A note is left out of the list when its chat read something from outside, when you attached a file in that chat, when its chat is gone, or when you edited or forgot the note. A note you mark is not rewritten. Aman records your choice in a `.reviewed-from-you` file in the vault and shows the note as `> From you` while its text stays the same. If you edit the note later, it still counts as from you. A full export carries that file, so a restore keeps your review.
- **Imports.** Notes you bring in with the Memories import are saved as `> External source: imported file`. When you import a full export made by an older version, its notes get the same line as older notes. You can review them too, if their chats came over in the same import.
- **`MEMORY.md`.** A `MEMORY.md` file you write by hand counts as external unless its last line is `> From you`.
- **Editing and deleting.** Changing a note on the Memories page changes what it says. It never changes where it came from. A note you reviewed as your own still says `> From you` after you edit it, in the list, in recall and in the file. A note from somewhere else cannot become yours by editing it. A deleted note is erased from the file, and a review you made of it has no effect on any other note.
- **Other memory services.** With a memory service other than Markdown files, a memory with no recorded source counts as external too.

## Editing and deleting a memory

When you delete a memory on the Memories page, Aman removes its text from your disk. When you edit one, the old wording is replaced by the new wording. A backup or an export you made earlier still holds what it held, so delete those too if you want the words gone from them.

## Personas and shared notes

Memories are kept per persona, in separate vaults (folders of notes).

- While a persona answers, what it learns goes into that persona's own vault. It stays private to that persona until you share it.
- With no persona active, memories go into the shared vault, which every persona can read.
- A persona recalls from its own vault, the shared vault, and any vault shared with it on the **Sharing** tab.
- Renaming or deleting a persona never deletes its vault.

## Incognito chats

An incognito chat reads memory but never writes to it. Aman recalls as usual, but saves nothing from the chat, in any persona, and the chat never joins past-chat search. See [Privacy](privacy.md#incognito-chats).

## Searching past chats

Past-chat search is off until you turn it on in **Settings**, **Memory**, **Settings**. While it is off, nothing from your chats is added to the search.

- When you turn it on, Aman adds your earlier chats in the background, then adds each new chat as it finishes.
- When you turn it off, everything it added is removed.
- It covers what you typed and Aman's final replies. The current chat is never included.

The search follows the same rule as memory. A persona finds its own chats, chats with the main assistant, and chats of personas whose vault is shared with it. A chat with a persona whose vault is not shared stays out.

### Searching your chats yourself

The **Search chats** box at the top of your chat list matches titles first. Below them, under **In messages**, come chats where a message holds your words, each with a short piece of that message. This covers all your own chats, whichever persona answered, because you can already open every chat in your list. It needs the past-chat search switch: while that is off, the box matches titles only.

A message matches when it contains every word you searched for, as a whole word. Small filler words such as "the" are ignored. "Trip", "trips" and "tripped" count as the same word, while different words such as "made" and "mad" stay apart.

## Safety screens

Two optional Prompt Guard screens can check content before it reaches the model. Both are off by default.

- **Recall screening** checks memories recalled from the bank. Turn it on in **Settings**, **Memory**, **Settings**. It needs a classifier URL set up and reachable first. Your own stated memories are never held back; it only applies to memories that came from tools, documents or email.
- **Tool-output screening** checks tool results before they go back to the model. It shares the same classifier URL, token and threshold as recall screening.

The settings are `MEMORY_SCREEN_ENABLED`, `MEMORY_SCREEN_URL`, `MEMORY_SCREEN_AUTH_TOKEN`, `MEMORY_SCREEN_THRESHOLD`, `TOOL_OUTPUT_SCREEN_ENABLED` and `TOOL_OUTPUT_SCREEN_TIMEOUT_MS`. See [Deployment security](deployment-security.mdx#prompt-guard-screens) for the full setup.

For the full design of recall and saving, see [Memory design](../ops/memory/DESIGN.md).
