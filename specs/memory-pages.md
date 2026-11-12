# Spec: Memory pages

**Status:** draft

## Problem

Aman remembers by saving short notes to a daily log. Before each reply it searches that log. Three things go wrong.

- A fact that changed is still in the log. Aman finds the old value as easily as the new one, and nothing says which one is true now.
- A question asked in other words finds nothing. "Who is my plumber?" does not find "Sam fixed the leak under the sink".
- Almost any message shares a word with some note, so notes are shown for messages that have nothing to do with them.

The memory test (`docs/evals/memory-recall.md`) measures all three on a made-up household. Every change under this spec is judged on that test.

## Solution

The daily log stays as the journal: everything that was said, in order, never rewritten. What stays true moves to pages: one short Markdown file per person or matter. Before each reply Aman reads pages first and uses the log only for what no page covers yet.

Everything stays in plain Markdown files in the memory folder. There is no database and no separate service. This works with the Markdown memory backend only. `ops/memory/DESIGN.md` holds the detailed design, and each PR under this spec updates it.

## 1. Pages

- `people/<slug>.md` and `matters/<slug>.md`, as today.
- Under the title, one line says who or what the page is about. This is the summary line.
- Other names for the page can be role words, such as "plumber" or "wife", so a message that names the role finds the page.
- One statement per bullet, in the sections Now, Decided, Open, Unconfirmed and Earlier. A person's page can also have "How you write to them".
- Each statement carries where it came from and its dates: when it became true, and when it stopped being true.
- A page is always safe to edit by hand. A line the person types is read as their own words.

## 2. What Aman reads before each reply

In this order, each within its own size limit:

1. **The pages the message names**, whole. A name, another name, or a role word counts.
2. **Statements found by meaning.** Up to six statements from other pages that are about the same thing as the message, each shown under its page's title. A statement is indexed together with its page's title and summary line, so a short statement is found by what it is about. The summary line is the line under the title; when the person wrote none, it is the first statement under Now that is the person's own words. A statement from mail or anything read is never the summary.
3. **Notes from the daily log, found by meaning**, from the whole log, for what is on no page: notes that have not been sorted onto pages yet, and the person's own words. At most four.
4. **Two tools to look pages up.** The list of pages is not put in the prompt. When the person asks about something and no page was shown for it, Aman asks for the list with `list_pages` and opens a page with `read_page`. `list_pages` gives each page's kind, title and summary line, the most recently changed first, at most 50 a call; it says how many were left out and that `search` narrows it. `read_page` shows one page exactly as it is shown in item 1, within the same size limit, and has the same effect on the turn: a page that holds a line from outside stops the turn from writing. A page counts as having a name of the person's own only when it holds at least one line in their own words. Pages without one are listed apart, under "Pages Aman made from things it read. You have not confirmed these names.", and their page header says "name not confirmed by you". Neither tool is offered in an incognito chat.

A statement whose end date has passed is not shown as current. It is shown under the Earlier label, with its dates, for 30 days. After that it is shown only when the message asks about the past. A page named in an earlier message of the same chat is read too, after the pages the newest message names.

## 3. When a memory is shown

Each statement and each note has a floor of its own. Aman keeps a fixed list of ordinary messages that have nothing to do with anyone's life, such as "What is the capital of Canada?". For each memory it measures how close those messages come to it. The memory is shown only when the person's message comes clearly closer than they do: above their average by three times their spread.

A second rule works on the whole message. Aman keeps a list of 460 such ordinary messages. For each of them it records the best standing any statement or any eligible note reaches: how far above its own average its closeness is. A message gets statements and notes by meaning only when its own best standing, over statements and notes together, is above the 95th percentile of those 460 numbers. With hundreds of memories, the first rule alone lets something through for about one unrelated message in six, because there are so many chances. This second rule fixes the rate for the whole message. It is worked out once for each message, and the pages and the log both use that one answer. With fewer than 5 statements and eligible notes together there is too little to judge, and the log is searched by shared words as before.

A note is eligible when the sorter has not handled it yet. A note the sorter put on a page is not eligible, whoever wrote it, because its statements speak for it, with their end dates. A note the sorter handled and put on no page is eligible only when it is the person's own words. At most 4 notes are shown for one message, or 6 when no page holds any statement yet.

This replaces two rules. The check that compared the best match with the average match is removed. Notes that only share a word with the message are no longer shown while the rules can judge. The log is searched from its first day to its last, not only the newest two weeks.

When the meaning model is still downloading or cannot run, Aman searches the daily log by shared words, as it does today, and still reads the pages the message names. The same holds while there is too little to judge, so a new vault still recalls its first notes.

The meaning model becomes `multilingual-e5-base`. It runs on the machine, like the model it replaces. Notes and statements already saved are indexed again in the background.

## 4. How pages get written

- **By hand.** The person can write and edit pages in any editor.
- **In a chat.** Aman gets three tools that write: remember, update and forget. A statement is written as the person's own only when it is made of words they typed in the message the turn answers; text they pasted into their message counts as theirs. Anything else the person asks to keep is saved at once as a current statement marked as read content, on the page it is about, and a page is made when none exists. Such a statement is never an instruction, never replaces or removes a statement of the person's own, and is never a "How you write to them" line. A turn that has read outside text, such as mail, a web page or a file, changes or forgets a statement of the person's own only when their message shares that statement's words. A new or changed statement, or the name of a new page, that holds something shaped like a password, a key or a card number is refused, whoever said it; forgetting such a statement still works. Two more tools only read (item 4 in section 2).
- **When a turn is saved.** One model call reads the new note and the pages it could belong to. It answers with a decision for each fact: new, the same as one already there, changes one, ends one, not confirmed, or nothing to keep. The host applies the decision. The model never writes a file.
- **Only the person's own words become confirmed statements.** What Aman read in mail, on the web or in a file goes under Unconfirmed, with its source, and is never an instruction. A link or address in an Unconfirmed statement, or in a note from a turn that read outside text, counts as something Aman read in every later chat.
- **Every write is kept.** A history of the page folders lets any change be undone. A lock keeps two writers from changing a page at once.
- **A list of handled notes.** The sorter writes each note it has handled to `.handled-notes` in the vault folder: one line with the note id, a tab, and `page` (it put the note's facts on a page) or `none` (it put nothing on any page). The file is only ever added to, and a later line for the same note wins. No file means no note is handled yet. Recall reads it, and a line with no outcome, an unknown outcome or an id that is not a note id is skipped.
- **A small nightly job** moves ended statements to Earlier, sorts notes that were missed, and lists statements that contradict each other for the person to settle. It changes nothing else.
  - **When.** Once per calendar day for each vault (the shared one and each persona's), in the server's quiet hours (02:00 to 05:00 on the server's clock). The day is checked and written under the vault lock, so with two server processes only one runs it. A crash halfway is repeated the next day. A failure in one vault is logged and the others go on. It starts off. The person turns it on in Settings (a stored switch that beats the `MEMORY_NIGHTLY_JOB` default, which is off), and the timer reads it each time it looks at the clock, so no restart is needed. The job is not tied to a chat, so it never runs in or for an incognito chat, which saves nothing anyway.
  - **Step 1, ended statements.** A statement under Now, Decided or Open whose end day is before today moves to Earlier with that end day, for all pages in one history entry such as "Aman moved 3 ended lines to Earlier". Unconfirmed and "How you write to them" are not touched. Nothing is written when nothing ended. No model; runs in every sorting mode, `off` included.
  - **Step 2, missed notes.** Notes of the last 14 days that are not in the handled list, not deleted and not erased are sorted oldest first, at most 40 a run, one at a time, with the same sorter and the mode from `MEMORY_PAGE_SORTING`. In `report` mode a note with a line in the report is not asked again. A note that fails three nights in a row is left alone. Skipped with sorting `off` or no model.
  - **Step 3, statements that disagree.** For each page changed since the last look (at most 20 a run), one model call gets the page's current statements with ids and returns pairs of ids that cannot both be true now, each with a short reason. The host refuses a reply that does not parse or names an id that was not shown, keeps at most 5 pairs, and drops a pair when either line has since changed or ended. Pairs are kept in `.memory-state/disagreements.json`: ids, a fingerprint of each line, the day found and the reason. No page changes. Skipped with sorting `off` or no model.
  - **The model.** There is no chat turn, so the job uses the model new chats start on, or the persona's own model for a persona's vault, and it follows the same on/off switch for summaries and the same token budget as turns.

- **Three modes, one setting.** `MEMORY_PAGE_SORTING` is `off` (nothing runs), `report` (the model is called and its decisions are checked as in `on`, but no page and no ledger line is written; each result is appended as one JSON line to `.sorter-report.jsonl` in the vault folder, with the note id, the day, the decisions after the host's rules and why anything was refused, never the note's text; a note's lines are dropped when the person deletes or edits that note; the file is capped by dropping its oldest lines) or `on` (pages and the ledger are written). It starts at `off`. A stored setting from Settings beats the `MEMORY_PAGE_SORTING` default, and the sorter reads it after each save, so a change needs no restart. Both stored settings travel with an export of an administrator's data and fill in on import only where the new server has none.
- **What the host allows depends on the note's origin, never on its text.** The person's own words: all six decisions, new and changed statements written as `you_said`. A message the person sent: new statements written as `sent_mail`, only under "How you write to them" for the person it was sent to, and no change to a `you_said` or `you_edited` statement. Anything else (read content, the assistant's reply, no readable origin): every new, changed or ended decision becomes an Unconfirmed statement with the matching source, and nothing confirmed is changed, ended or removed.
- **One note, one write.** All decisions for a note are applied together, as one history entry that says in plain words what was sorted. A reply that does not parse, names an unknown statement or page, or has more than 8 decisions is refused whole: nothing is written and the note stays unhandled. The ledger gets `page` when at least one decision wrote or confirmed something and `none` when every decision was ignore.

Sorting at save time starts off. The person may switch it to `report` or `on` in Settings. We advise `on` only after it gets at least 9 of 10 decision cases right, with a hosted model and with a local one.

## 5. Settings

A Pages tab sits beside Memories and Sharing in Settings, then Memory, and on the standalone Memory page. It shows only with the Markdown memory.

- **Summary shown on screen.** The line the person wrote under the title; else the `about` line in the settings block, which Aman writes through `page_summary` on `remember_fact` and `update_fact` (at most 140 characters, dropped when it holds a link, an address or a secret shape); else the person's first own statement. The `about` line is shown on the screen only. It is never put in a prompt, never indexed and never counts as the person's words.
- **List.** People and matters in two groups. Each row has the title, the summary line, the day the page last changed and a count of lines waiting to be confirmed. A search box matches the title and the other names. With no pages it says what a page is and that Aman fills pages as the person talks. Files in the page folders with names Aman cannot read are listed, with what to do.
- **One page.** The day it last changed and the summary on top, then the sections in order as bullets. The person's own lines are plain. The person's own lines say `From you`. A line that is not theirs says `External source:` and where it came from (`a message you sent`, `email`, `calendar`, `read content` or `Aman’s guess`), the same words a note uses. A line under Unconfirmed says it is not confirmed and has Confirm and Dismiss. Earlier is collapsed.
- **Edit.** The page as Markdown text, with Save and Cancel. A save is one history entry and is treated exactly like a hand edit in the file. It is refused, with a message that says what to do, when the page changed since it was opened or when the text is not a page.
- **Delete page.** Held for 10 seconds with Undo, then sent. The history keeps the page.
- **Lines that disagree.** When the nightly check finds two lines that cannot both be true, the list row says how many pairs disagree. The page shows a block "These lines disagree" with both lines, the reason and a "Not a problem" button. The button drops the pair for good, for those two lines as they are. The person settles a real one by editing the page. Nothing on the page changes by itself.
- **Sorting and tidying.** Two controls in Settings, then Memory, beside the turn summaries switch, shown only with the Markdown memory (otherwise they are off and say why). "Sort what Aman saves onto pages" has three choices, Off, "Only note what it would do" (`report`) and On, each with one sentence; under On it says that what Aman read can only ever be added as not confirmed. "Tidy pages once a day" is a switch. Both say they use the model while the person is not chatting, and both start off.
- **Copy, Edit, Delete.** Under each row in the list and at the bottom of an open page, the same three a memory has. Copy puts the page on the clipboard as plain text. The screen shows no log of changes; the history stays in the vault, and the changes and undo routes stay for other callers.

Incognito chats are not involved: this is Settings.

## Scope

- Summary line and role words.
- Search over page statements, the floor, and end dates.
- Daily log as the fallback, and the change of meaning model.
- The chat tools (three that write, two that read), the history and the lock.
- Sorting at save time and the nightly job.
- The Settings screen.
- Docs for each of the above in the PR that adds it.

## Privacy

- Pages, the log, the index and the history are files in the memory folder on the person's machine. Nothing is sent to a new service.
- The meaning model runs locally. Its one download is the model file.
- Sorting at save time sends the new note and the pages it could belong to, to the same model the chat already uses. With a local model nothing leaves the machine.
- An incognito chat reads pages and writes none. Every writer here asks the same question every other writer asks.
- Text Aman read elsewhere is kept apart from the person's own words, is labelled with its source in the words a note uses (`External source: ...`), and is never treated as an instruction. A note's origin is read from its closing line: a note with no line, or an older "no record" line, is read content for sorting, and one closing with `From you`, or reviewed as theirs, is the person's own.
- Pages travel with an export and come back on import. The history and the index stay behind and are rebuilt.

## Testing

Tests use synthetic data only, never a person's real memories.

- **The memory test.** A made-up household over sixty days with 76 messages: questions with a known answer, questions about values that changed, questions asked in other words, and messages with nothing to recall. It counts answers found, old values shown as current, and memories shown for unrelated messages. A PR that changes one of the recorded numbers updates it in the same PR.
- **Decision cases.** Notes with the decision a careful reader would make, used to score sorting at save time.
- **Unit tests** for the page format, the index, the floor, end dates, the tools, the history and the lock.

## Out of scope

- A separate memory service or a graph database.
- Importing memories from other assistants.
- Changes to the learned profile.
