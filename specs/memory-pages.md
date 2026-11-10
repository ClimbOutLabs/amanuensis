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
3. **Notes from the daily log, found by meaning**, for what is on no page: notes that have not been sorted onto pages yet, and the person's own words that belong on no page.
4. **A short list of pages**, one line each (title and summary line), the most recently changed first, within a fixed size.

A statement whose end date has passed is not shown as current. It is shown under the Earlier label, with its dates, for 30 days. After that it is shown only when the message asks about the past. A page named in an earlier message of the same chat is read too, after the pages the newest message names.

## 3. When a memory is shown

Each statement and each note has a floor of its own. Aman keeps a fixed list of ordinary messages that have nothing to do with anyone's life, such as "What is the capital of Canada?". For each memory it measures how close those messages come to it. The memory is shown only when the person's message comes clearly closer than they do: above their average by three times their spread.

A second rule works on the whole message. Aman keeps a list of 460 such ordinary messages. For each of them it records the best standing any statement reaches: how far above its own average its closeness is. A message gets statements by meaning only when its own best standing is above the 95th percentile of those 460 numbers. With hundreds of statements, the first rule alone lets some statement through for about one unrelated message in six, because there are so many chances. This second rule fixes the rate for the whole message. With fewer than 5 statements nothing is found by meaning.

This replaces two rules. The check that compared the best match with the average match is removed. Notes that only share a word with the message are no longer added after the matches by meaning.

When the meaning model is still downloading or cannot run, Aman searches the daily log by shared words, as it does today, and still reads the pages the message names.

The meaning model becomes `multilingual-e5-base`. It runs on the machine, like the model it replaces. Notes and statements already saved are indexed again in the background.

## 4. How pages get written

- **By hand.** The person can write and edit pages in any editor.
- **In a chat.** Aman gets three tools: remember, update and forget. They write the person's own words from that turn. A turn that has read outside text, such as mail, a web page or a file, cannot write a statement as the person's own.
- **When a turn is saved.** One model call reads the new note and the pages it could belong to. It answers with a decision for each fact: new, the same as one already there, changes one, ends one, not confirmed, or nothing to keep. The host applies the decision. The model never writes a file.
- **Only the person's own words become confirmed statements.** What Aman read in mail, on the web or in a file goes under Unconfirmed, with its source, and is never an instruction. A link or address in an Unconfirmed statement, or in a note from a turn that read outside text, counts as something Aman read in every later chat.
- **Every write is kept.** A history of the page folders lets any change be undone. A lock keeps two writers from changing a page at once.
- **A small nightly job** moves ended statements to Earlier, sorts notes that were missed, and lists statements that contradict each other for the person to settle. It changes nothing else.

Sorting at save time ships switched on only when it gets at least 9 of 10 decision cases right, with a hosted model and with a local one. Below that it runs in a mode that writes nothing and only reports what it would have done.

## 5. Settings

A Memory pages screen lists the pages, shows one, and lets the person edit, delete and undo.

## Scope

- Summary line, role words, and the list of pages.
- Search over page statements, the floor, and end dates.
- Daily log as the fallback, and the change of meaning model.
- The three chat tools, the history and the lock.
- Sorting at save time and the nightly job.
- The Settings screen.
- Docs for each of the above in the PR that adds it.

## Privacy

- Pages, the log, the index and the history are files in the memory folder on the person's machine. Nothing is sent to a new service.
- The meaning model runs locally. Its one download is the model file.
- Sorting at save time sends the new note and the pages it could belong to, to the same model the chat already uses. With a local model nothing leaves the machine.
- An incognito chat reads pages and writes none. Every writer here asks the same question every other writer asks.
- Text Aman read elsewhere is kept apart from the person's own words, is labelled with its source, and is never treated as an instruction.
- Pages travel with an export and come back on import. The history and the index stay behind and are rebuilt.

## Testing

Tests use synthetic data only, never a person's real memories.

- **The memory test.** A made-up household over sixty days with 76 messages: questions with a known answer, questions about values that changed, questions asked in other words, and messages with nothing to recall. It counts answers found, old values shown as current, and memories shown for unrelated messages. A PR that changes one of the recorded numbers updates it in the same PR.
- **Decision cases.** Notes with the decision a careful reader would make, used to score sorting at save time.
- **Unit tests** for the page format, the index, the floor, end dates, the tools, the history and the lock.

## Out of scope

- The Hindsight backend.
- A separate memory service or a graph database.
- Importing memories from other assistants.
- Changes to the learned profile.
