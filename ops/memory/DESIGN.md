# Memory design

## What this is

Host-enforced long-term memory, kept as Markdown files on the server. The host
recalls from it before every model call and retains every completed turn to it.
The model is never responsible for remembering to use it. The one exception is the page
tools described under [Writing pages](#writing-pages), three of which keep short facts
the person asked for on a page.

Deliberate principles: recall is user-visible byte for byte; one dispatch
path, no side channel; empty recall returns a distinguishable empty, never
filler; credentials by reference, never by value.

## Where a note came from, and the one-time review

Each Markdown note closes with `> From you` or `> External source: <what>`. A note with no such line counts as external. The start-up step gave older notes `> External source: no record`. It takes the vault lock for each vault and writes each file through a temporary file and a rename, as the erase does. It leaves an erased entry (`## [erased]`) byte for byte as it is, so no erased note gets a line and later notes keep their ids. A sent-mail note closes with `> External source: a message you sent`; the older `> Source: a message you sent` is still read as external sent mail and shown in the new words.

The person can review older notes once. A note is offered only when all of these hold, and any check that cannot be made refuses it:

- It closes with exactly `> External source: no record`, names a chat and carries no note marker.
- It has no edit or delete marker.
- Its chat still exists, belongs to the same person and ran under the persona whose vault holds the note.
- The turn that saved the note is found by its finish time. That turn and every turn before it in the chat attached no file and received no tool result from outside. `runtime/memory/turnOutsideInput.ts` owns that rule. The live save and the review both ask it. Turns after the saving turn do not count.

Marking never rewrites a dated file. `markReviewedNotesFromYou` appends one line per note to `.reviewed-from-you` in the vault: the entry id, a tab, and the SHA-256 of the entry's text as the dated file holds it. `scanNamespaceEntries` applies the marks to each scanned entry before vault markers, so recall, the Memories page, the search index, the vault export and an edit all see `> From you`. A mark counts only while the hash still matches and the note still closes with exactly `> External source: no record`; otherwise it is ignored, so a forged or stale line does nothing. The full export carries the file and the import retargets its ids like vault markers.

The review routes are `GET` and `POST /api/v1/memory/vault/review`. The list examines at most 200 notes per request and returns a cursor. The apply route takes at most 200 ids, and runs the full check again for each id before it records anything. There is no route that marks notes without ids the person sent.

## Secret references

The server stores MCP auth header values plaintext in the manifest jsonb
(redaction is wire-only; the DB value is the live secret). Bearer tokens
do not join it.

Header values gain reference syntax, resolved at connect time and never
persisted resolved:

    ${env:NAME}    resolved from the server process environment
    ${file:PATH}   resolved from a file readable by the server process,
                   trimmed of trailing newline

Contract:

- Detection is exact: a header value matching `^\$\{(env|file):.+\}$` is a
  reference. Anything else is a literal, unchanged behavior.
- Resolution happens in `getMcpConnection` (`sessionResources.ts`), the
  single choke point both turn execution and the admin tools listing already
  use, by returning the async `RemoteMcpHeaders` resolver form that the DCR
  path already exercises. Resolution runs per operation, so rotation is
  picking up the new value with no restart.
- A reference that fails to resolve (missing env var, unreadable file) fails
  the connection with an McpConnectionError naming the reference and the
  header name, never the value. Failure behavior is then the harness's
  existing degradation: non-preloaded server skipped at init, mid-session
  call returns a model-visible error and the turn continues.
- Wire redaction: reference strings are pointers, not secrets, and pass
  through unredacted so the user can see and edit them. The PUT merge rule
  (redacted stand-in keeps the stored secret) must treat a reference as an
  ordinary new value: writing a reference replaces a stored literal, and the
  redacted stand-in never matches a reference.
- No store changes: the manifest still persists verbatim; what changes is
  that the persisted value can now be a pointer.

Deliberately excluded: `${keyring:}` (no Credential Manager inside the
Linux container; add as a host-mode kind when a host deployment needs it)
and `${exec:}` (running arbitrary commands to obtain secrets is a larger
trust decision than this feature needs).

## Prompt-injection screening boundary

Memory recall and live open-world tool output can share one classifier, but
they remain separate host capabilities. Recall screening runs while memory is
assembled. Tool-output screening runs after PermissionGate dispatch and before
the result is appended to model context. It therefore cannot approve, deny, or
execute a tool and does not create a second action path.

When enabled, the live screen applies only to completed results carrying the
host-owned `open_world_hint: true` annotation. The exact provider output remains
in `tool.response.v2.result` for audit and UI inspection. A malicious or unknown
classification places a deterministic host-authored withholding marker in the
model-facing tool message and records the screen decision on the same terminal
event. A benign result enters context unchanged. This split preserves visible
provenance without handing attacker-authored instructions to the model.

`TOOL_OUTPUT_SCREEN_ENABLED` defaults to false. The evaluation in
`ops/prompt-guard/ADR.md` does not justify enabling the third-party quantized
model by default. Unannotated third-party tools and text a subagent creates from
previously admitted content are outside this first structural boundary.

## Recall layers per turn

Every turn assembles one `<aman-memory>` block from up to two layers, read independently, so
neither can fail a turn:

- **Pages** (every turn, `MEMORY_PAGES_MAX_COUNT`, `MEMORY_PAGES_MAX_TOKENS`): the people and matter
  pages the message names, loaded in full and placed ahead of the recalled items.
- **Recall** (every turn): the note files searched with the windowed query
  (`MEMORY_RECALL_QUERY_WINDOW`). Facts, no model call.

When the recall screen is on, each recalled item (`item:#<index>`) and each page (`page:#<index>`) is
classified: withheld when flagged or when the screen gave no verdict, unless it is the person's own
words. The screen's time budget is charged for the recall call alone, not the parallel wall clock.

The Markdown store writes a source line on every note: `> From you` for the person's own words and
`> External source: <what>` for the rest. At recall it hands back each note with its origin: `user_stated`
for a note that closes with `> From you`, `tool_ingested` for any other, including a note with no line. So the
recall screen and the record of where links came from treat a person's own note the same way on both memory
stores.

A note of the assistant's reply can also carry `reply_read_nothing`. The save sets it only when the turn read
nothing from outside and the chat's record says no earlier turn, recalled note or summary did either. Memory
shown in an earlier turn is not in the chat's messages, so the memory capability keeps one flag in its
cross-turn state (`recalled_outside_text`) once a block it built held anything but the person's own words,
and `chatSawOutsideText` reads it. The
store writes it as the closing line `> External source: assistant reply, nothing read before it`, and reads it
back only when the hidden note line also says the note is a reply. Body text that looks like either line is
escaped, an edit turns the note back into a plain reply note, and an import never sets it. At recall such a
note is recorded as the assistant's own earlier reply: its sites are the reply's own, its addresses count as
read, and it does not mark the chat as having read outside content. Its origin stays `tool_ingested`.

The event's `layers` field records, per turn, how many pages the message named, how many made it into
the block, and how many were left out by the page count cap, the page budget or the recall screen. It is
absent when the turn loaded no pages.

## Messages the person sends

When the person sends a message through the Email connector, Aman saves it as one note in the daily log, so
the nightly pass can learn how the person writes to each contact.

- **What counts.** A call to `send_email` or `forward_email` on the Email connector (the names come from
  `MAIL_SEND_TOOL_NAMES` in the core mail connector contract) whose result is `executed_ok` and whose text says the message went out. The sidecar reports a failed or
  uncertain delivery as a normal result, so the host reads the text and not only the result status. Clean
  results read "Email sent successfully to ..." or "Email forwarded successfully to ...". A result that
  starts "Email delivery [" or "Email forward [" lists each recipient as `succeeded`, `failed` or
  `unknown`, and counts as sent only when every recipient is `succeeded`. That includes a message that
  went out but whose copy in the Sent folder could not be filed (`sent-copy: failed` or `unknown`): the
  recipients have it, so it is saved. A failed or uncertain recipient is not saved. A denied, blocked or
  failed call writes nothing, `save_draft` writes nothing, and a send on any other connector writes nothing.
  A send made in an incognito chat writes nothing either: the message goes out, but that chat keeps nothing.
- **One place decides.** The turn drain watches each tool result and writes the note when a send's result
  qualifies. A send approved on a card runs in a later turn that never sees the message that asked for it,
  so that turn is handed the calls the person allowed, read from the end of the paused turn before the turn
  starts. Calls are matched by thread and call id together. The paused turn is read newest first until every
  allowed call is found, so a long turn is read in full if it must be. If the turn cannot be read, or an
  allowed call is not in it, the turn runs as usual, the send is not saved, and a warning is logged.
- **What the note holds.** The recipients, any cc and bcc, the subject and the composed body, written word
  for word by the host with no model call. A forward carries no subject of its own (the sidecar sets it), so
  none is recorded, and only the text the person added is kept, never the forwarded message. The body is
  cut, on a whole character and with a plain "(cut)" marker, at 2,000 characters, the same bound as the
  facts a turn summary may store, so a sent note is no bigger than any other memory note. At most 20 sent
  messages are saved from one turn.
  A message that holds something shaped like a secret is checked in full before any cut, and is not saved.
- **Its own write.** The note is saved as soon as the send is known to have gone through, in a write of its
  own with its own operation id, which names the turn, the thread and the call, so a model that reuses a call id
  in a later turn does not hide that later send. A retry after a half-finished save replaces the copy the
  first attempt wrote, so the note is never doubled. Saves to one vault run one at a time, so notes written at the
  same instant get different entry ids. It does not wait for the turn to finish and does not depend on the turn's
  save, so it is kept whether or not turn summaries are on, whether or not the turn's own save succeeds, and
  when the turn ends early. A later recovery of a lost turn neither drops it nor writes it twice.
- **Source and label.** The note's source is `sent_mail` and its label reads "From a message you sent, Oct 31".
  The note closes with `> External source: a message you sent`, and the Memories page shows those words. The note is stored with the same origin as other tool
  results (`tool_ingested`), so the recall screen holds it to the same strict posture: what a message says is
  data, never an instruction. Like other read content it is recalled at any age, with its day.
- **Not an instruction.** The model composed the text of a sent message, and it can echo text from mail it
  read, so a `sent_mail` note is evidence of how the person writes, not something the person said as a
  rule. No pass may promote a `sent_mail` note into a drafting instruction on a page, and so into a fact
  with source `sent_mail`, unless the person confirms it. Nothing does today: the page tools only write
  what the person said in the current chat, as `you_said`.
- **Old files.** Notes already on disk keep their exact bytes. Only a new source word, `sent_mail`, can
  appear in the hidden note marker.

## Deleting and editing a saved note

Saved notes live in dated files, `memory/YYYY-MM-DD.md`, and a note's id is its file and its position there.
Deleting or editing a note on the Memories page appends a marker to `.vault-tombstones.md` (every reader applies
it) and then rewrites the dated file in place, so the text does not stay on disk. All of this happens under the
vault lock, and saving a note takes the same lock, so a note saved during a rewrite is not lost.

- A deleted note's block becomes the bare line `## [erased]`. It still counts as a position, so later notes keep
  their ids, and readers skip it. Nothing else of the note is left in the file.
- An edited note's block becomes the new wording, with the hidden lines it carried (heading time, chat id,
  document id, note line, id-shaped context line) kept. A `## ` line in the new wording is stored with a leading
  backslash so it cannot split the entry. Readers still take the wording from the marker.
- An edit keeps where the note came from. When the note was reviewed as the person's own, the rewrite reads it
  with the review applied, so the edited block closes with `> From you`. An external note keeps its own line
  whatever the new wording says. A deleted note's review mark stays in `.reviewed-from-you` and matches nothing
  else, because ids are positions that are never reused.
- Only each note's latest marker is kept in the marker file, so an earlier edit's wording does not stay there.
- The file is written whole to a temporary file in the same folder and renamed over the old one.
- The marker is written first, then the erase. If the erase fails, the person sees "try again", the marker
  stays, and a retry of the same delete or edit, or the next save to the vault, finishes the erase.
- Notes deleted or edited before this existed are cleaned the same way the next time the vault is written to,
  when its marker file has changed since the last full run in this process. Running it again changes nothing.

Other copies of note text on disk: `.embeddings.json` and `.statement-embeddings.json` hold a hash and a vector per
entry, never the text; a deleted note's vector is dropped at the next index pass and an edited note's is
replaced. `.memory-history` tracks only `people/` and `matters/`, never the dated files. Exports made earlier,
and backups, keep what they held.

## Pages

Pages are short Markdown files about one person or one matter. They sit beside the daily log in a
vault and hold what stays true, so it does not have to be dug out of old entries.

Pages can be written by hand, and in a chat Aman can add, change and forget single facts with three
tools, and look pages up with two more (see [Writing pages](#writing-pages)). Every change Aman makes is a commit in a history that sits
beside the pages, so a page can always be put back. This reverses the earlier rule that no memory-write
tool is exposed to the model. It is safe because of two rules: a line counts as the person's own only when
it is made of words they typed in the current message, and every other line is marked as read content and can
never replace or remove a line of their own.

### Files in a vault

    people/<slug>.md      one page per person
    matters/<slug>.md     one page per matter (a trip, a purchase, a project)
    .memory-state/        notes Aman keeps for itself, and the lock
    .memory-history/      a git history of the two page folders
    .handled-notes        daily-log notes the sorter handled: note id, tab, then page or none; only added to
    .sorter-report.jsonl  what the sorter would have done, one JSON line per note, in report mode only

The slug comes from the title: lowercase, accents dropped from Latin and Greek letters (and Cyrillic `ё` read as `е`), other characters that
are not letters or digits turned into dashes, cut at 64 characters (and at 200 bytes, so the file name
stays valid). Only those accents are dropped, so `Ελένη`, `ΕΛΕΝΗ` and `Ελενη` are one name, and so are `Фёдор` and `Федор`, while `й` stays its own letter. In Korean, Japanese, Thai, Hindi and other scripts the
marks are part of the letter and stay, so `김민수` is `people/김민수.md`, `ジョン` is not `ション`, and
`ハル` is not `バル`. Text is compared in its composed form, so a name typed in either form is the same
name. `José` and `Jose` share one page. A page's file name must be exactly that
lowercase slug, such as `people/nora.md`. A file with any other name, such as `people/Nora.md` or
`people/my notes.md`, is not a page: it is never loaded. Each turn that skips such a file writes one
warning to the server log with the number of files skipped. It does not name them, since file names can be people's names. To use a file, rename it to the lowercase slug.

Export and import move pages with the rest of memory. An export (format version 3) holds every `.md`
file directly in each vault's `people/` and `matters/` folders as `memory/<vault>/people/<name>.md` and
`memory/<vault>/matters/<name>.md`, byte for byte apart from the usual removal of keys and passwords.
That includes a file such as `people/Nora.md` whose name is not a lowercase slug: it travels under its
own name, so a move loses nothing, and the loader keeps skipping it with the same warning until it is
renamed. Only regular files are exported, a folder that is a link is skipped, and a hidden name or one
with control characters stays behind.
Import puts each page into the matching vault of the new instance under the same name. A lowercase
name typed in decomposed form is read in its composed form, so it lands under the name the loader looks
for. Files that are not `.md` pages, deeper folders and hidden or unsafe names are never written, and a
second spelling of the same name refuses the import. The summary says how many pages came along, how
many of them have a name Aman will not read until it is renamed to lowercase, and how many other files
were not copied.
An older export has no pages and imports as before. An instance that already holds pages counts as
holding memories, so the import refuses it like any instance with data. A memory backend that is not
Markdown files cannot hold pages, and the summary says how many were left out.

`.memory-state/` and `.memory-history/` are never exported, and neither is ever read as a page. The
history can be rebuilt only by starting again, so keep a backup of the memory folder if you want it
(the pages themselves travel with an export). `.memory-state/` holds the cache below and the lock files
(`lock.<n>` and `lock.<n>.beat`, see [Writing pages](#writing-pages)):

- `aliases.json`: a cache of every page's title and other names. It is rebuilt whenever a page
  changes, so it is safe to delete. A page is read again only when its size or modification time
  changes (including its change time, which cannot be set back), or it was changed in the last two
  seconds. The kept hashes cover the 64 vaults read most recently.

### The page format

A page starts with a block of settings between two `---` lines:

| Key         | Meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| `kind`      | `person` or `matter`. Ignored: the folder decides.              |
| `title`     | The page's name. The `# ` heading in the body is never used.    |
| `aliases`   | Other names, nicknames and email addresses that mean this page. |
| `household` | People only. `true` for someone the person lives with.          |
| `status`    | Matters only. `active` or `done`.                               |

The kind of a page is always its folder's: a page in `people/` is a person even if `kind: matter`
is written in it. Keys it does not know are ignored. After the settings come a `# ` heading and a one-line
summary, then sections. Each is a `## ` heading:

| Section               | Kind   | What goes there                                                             |
| --------------------- | ------ | --------------------------------------------------------------------------- |
| How you write to them | person | How the person likes to write to this contact. Never read on a matter page. |
| Now                   | both   | What is true at the moment.                                                 |
| Decided               | matter | What has been settled.                                                      |
| Open                  | matter | What is still undecided.                                                    |
| Unconfirmed           | both   | Things read somewhere that the person has not confirmed.                    |
| Earlier               | both   | Things that were true and no longer are. They carry an end date.            |

Each fact is one bullet. The end of the line holds a hidden marker that the page does not show when
read in a Markdown viewer:

    - Prefers short emails. <!-- fact: id=f_k3x9a0bq2m src=you_said since=2026-03 -->

- The text is one line. It cannot hold a line break or the characters `<!--`.
- `id` is `f_` and up to 16 lowercase letters or digits. It stays with the fact for life.
- `src` says where the fact came from (below).
- `since`, `until` and `seen` are dates, as a year (`2026`), a month (`2026-03`) or a day. `since` and
  `until` bound when a fact was true. `seen` is for unconfirmed facts and says when they were last
  seen.

The source values:

| `src`          | Meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `you_said`     | The person said it in chat.                             |
| `you_edited`   | The person wrote or changed the line by hand.           |
| `sent_mail`    | A message the person sent through Aman.                 |
| `mail`         | Read in an email.                                       |
| `calendar`     | Read on the calendar.                                   |
| `read_content` | Read on a web page, in a document or in another result. |
| `inferred`     | Worked out by Aman, not stated anywhere.                |

The host sets the source from where the information arrived. The model never picks it. `you_said` and
`you_edited` are the person's own words and are meant to be kept as written.

A page never has to be tidy. One with no settings, no headings, or bullets with no marker is still
read. A leading byte order mark is allowed. Reading a page and rendering it again returns the same
bytes.

A line that carries a hidden comment the host cannot read as a marker (an unknown key, a bad date, a
repeated key, a misspelt `fact`, a comment that does not end on its line or a stray `-->`) is kept as
it is but never trusted. Every line inside a comment that stays open, and a bullet right above a line
that starts a comment, are not trusted either, so a marker wrapped onto the next line cannot turn the
bullet above it into the person's own words. It counts as not confirmed, not
as the person's own words. A line with no hidden comment at all is the person's hand-written line,
whether it is a bullet or plain text.

### How pages are loaded before each turn

Before recall, the host looks at the person's message for names. It compares each page's title and
other names with the message as whole words. Case, Latin and Greek accents and punctuation around a name are ignored,
so `(Nora)` and `Nora,` both match. An email address counts as one word, so putting an address in
`aliases` finds the page when the person pastes that address. A trailing dot is ignored, so `W.`
matches `W`. Names in Chinese, Japanese, Korean or Thai are written without spaces, so those match
anywhere in the message: `田中` is found in `田中さんに会った`. A name never matches part of a
letter, so `민수` does not match `민숙` and `ハル` does not match `バル`. When one name sits inside a longer
name that is also on a page, the longer name takes the words: `นิดา` loads its own page, not the page
for `นิด`. A short name inside a longer word that has no page of its own still matches. Every other name still needs whole words,
so `Sam` does not match `Samantha`.

Names are looked for in the newest message first, then in the person's earlier messages of the same
chat that the recall query already holds. A page named only in an earlier message ranks below every
page named in the newest one, so a question such as "What can she not eat?" still loads the page for
the person named a message ago.

A name followed by `'s` (`Nora's flight`) is a possessive match. It loads the page, but ranks below
a direct mention, since the page may be about the owner and not the subject.

Matches are ordered by:

1. A name in the newest message before a name only in an earlier message.
2. The vault, own vault first, then the shared vault, then any vault shared with the person. If two
   vaults have the same page, the first that has a readable copy is used. A page that cannot be read
   in one vault does not hide the same page in another.
3. Direct mentions before possessive ones.
4. People before matters.
5. Where the name first appears in the message.

Two limits apply, on top of the normal recall budget:

| Setting                   | Default | Meaning                                      |
| ------------------------- | ------- | -------------------------------------------- |
| `MEMORY_PAGES_MAX_COUNT`  | 6       | Most pages loaded in one turn.               |
| `MEMORY_PAGES_MAX_TOKENS` | 1500    | Estimated size of all loaded pages together. |

One more setting decides whether saved notes are sorted onto pages at all:

| Setting               | Default | Meaning                                                                                        |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `MEMORY_PAGE_SORTING` | `on`    | `off` does nothing. `report` only records what sorting would do. `on` writes pages. See below. |
| `MEMORY_NIGHTLY_JOB`  | `true`  | Once a day per vault, tidies pages from the hour set in Settings. See "The nightly job".       |

Both are only the starting choice. Settings, then Memory, stores an override in the global settings store
(`memory_page_sorting_mode`, `memory_nightly_job_enabled`) that wins over the environment value, and clearing it
falls back to the environment value. `memoryPageSortingSettings.ts` and `memoryNightlySettings.ts` own the read, in
the style of `memorySummarizeSettings.ts`, and apply the Markdown-only rule for the effective value. The routes are
`/api/v1/settings/memory-page-sorting` and `/api/v1/settings/memory-nightly`. Both keys travel with an
administrator's export and are filled in on import only where the new server has none.

A page that would go over the token limit is left out, and so is every page after it. That way the
model always sees the highest-priority pages. Each turn's memory event records how many pages matched,
loaded and were dropped for each reason. A vault that cannot be read adds nothing and never fails the
turn.

The model sees each page as plain lines under short labels, with each marker shown as a short note
such as "(you said, since 2026-03)". Facts from mail, the calendar, read content and inference, and
lines whose marker cannot be read, always end with "not confirmed" in that note, for example
"(from mail, not confirmed, since 2026-03)". "How you write to them" is not shown with the page. Its lines
are gathered, for every loaded contact, under one fixed heading after the pages (see below).

A statement whose end date has passed is not shown as current. A statement under Now, Decided or Open
whose `until` day is before today is shown under the Earlier label, with its dates, and the page file
is not changed. Today is the calendar day in the time zone the chat already has, so a statement that
ends today is still current.

#### Single statements found by meaning

After the named pages, the host looks for single statements that the newest message is about, on pages
it did not name. It needs the meaning model (see `embeddingRetrieval.ts`); when the model is not ready
it carries on without this step and never waits for a download.

- **What is indexed.** Every statement bullet and every bullet typed by hand in Now, Decided, Open,
  Unconfirmed and Earlier, one vector each. Not the lines under "How you write to them", and not a line
  whose marker cannot be read. The vectors sit in `.statement-embeddings.json` in the vault folder, next to
  the daily log's `.embeddings.json`, as ids, a hash of the embedded text and the vector, never the text.
  The index is brought up to date on every turn: a changed statement is embedded again and a removed one is
  dropped.
- **What is embedded.** `Title (summary): statement`, where the summary is the line under the page title, or
  else the first statement under Now that is the person's own. When the statement is itself the summary, or
  there is no summary, it is `Title: statement`.
- **When a statement may be shown.** Scores from the model cannot be compared between statements, so each
  statement is measured against 460 fixed, ordinary messages (`comparisonMessages.ts`) that have nothing to
  do with anyone's memory. Its standing for a message is how many standard deviations the message is closer
  than those messages are on average. Rule 1: a statement is shown only when its standing is above 3.
  Rule 2: for each of the 460 messages the best standing over all statements and eligible log notes
  (see [Log notes by meaning](#log-notes-by-meaning)) is kept; the message gets statements and notes only when
  its own best standing is above the 95th percentile of those 460 numbers. With fewer than 5 statements and
  eligible notes together nothing is found by meaning. Rule 2 uses the best standing over every vault the
  person may read. The standing numbers, the percentile bar and the 460 messages belong to `standing.ts`,
  and statements and notes share them.
- **What is shown.** The best 6 statements by standing, leaving out pages already shown whole and showing
  the same words on one page once. A statement that has ended (under Earlier, or `until` before today) is
  left out unless it ended in the last 30 days or the message asks about the past ("used to", "before",
  "originally" and a few more English words). The statements are grouped by page, pages in order of their
  best statement, and each group is drawn by the same code as a whole page, with only the chosen lines and
  no drafting lines. A group counts as a loaded page in the turn's memory event and shares the page token
  limit; one that does not fit is dropped whole.

#### Log notes by meaning

The daily log is searched under the same two rules, from the whole log: a note's age never decides whether
it can be found. Shared words alone never show a note while the rules can judge.

- **One gate per message.** `meaningGate.ts` works out, once for each message, the standing of every
  statement and every eligible note, the percentile bar over all of them together, and whether the message
  is clearly about something remembered. The capability asks the client for it once (`meaningGate`) and hands
  the same answer to `recall` (the log) and `loadPages` (the pages), so the two paths cannot disagree. A page
  the message names, now or earlier in the chat, is read whatever the gate says.
- **Standing of a note.** A note's closeness to each of the 460 messages, their mean and their spread are
  worked out from the vector the log's own store (`.embeddings.json`) already holds, so no note is embedded
  twice and the embedded text is unchanged. `noteIndex.ts` keeps these numbers in memory for each vault
  and model and measures again only the notes that were added or changed; removed notes are dropped. The
  first search of a log with 5,000 notes takes about two seconds; the next about 0.1 seconds on the test
  machine. No file format changed.
- **Which notes are eligible.** A note the sorter has not handled yet is eligible. A note the sorter put
  on a page (`page` in `.handled-notes`) is not, whoever wrote it: its statements speak for it, with their
  end dates. A note the sorter handled and put on no page (`none`) is eligible only when it is the person's
  own words (`user_stated`; `recallMetadata` in `markdownMemoryFiles.ts` reads a note's origin). Notes from
  the chat being answered are never eligible. Age never makes a note ineligible. `handledNotes.ts`
  owns the file: each line is the note id, a tab and the outcome, and a later line for a note wins; a line
  with no outcome, an unknown outcome or a bad id is skipped (see `specs/memory-pages.md`, section 4).
- **What is shown.** Notes with a standing above 3, best first, at most 4, or at most 6 when no vault has a
  page statement. A note that names a person the message asks about moves to the front of those (the name
  boost); it never adds a note. The token budget, the recall screen and the rule that
  the same text is shown once apply afterwards as before.
- **Too little to judge.** With fewer than 5 statements and eligible notes together, the log is searched as
  before: shared words, fused with meaning behind the peak test (`VECTOR_PEAK_THRESHOLD`), so a new vault
  still recalls its first notes. A vault whose log vectors are not all built yet is searched the same way.
- **Model not ready.** The log is searched by shared words and pages are read by name.

### Drafting rules

- The drafting section is the last part of the memory block, just before the closing tag. It starts
  with one heading, "How the person writes to these contacts (follow when drafting to them):", and
  ends with one fixed line, "End of the writing instructions." Between the two, each loaded contact is
  listed by name with the lines from its "How you write to them" section. This is the only place those
  lines appear. Recalled items and the stats line all come before the
  heading, so nothing from recall, mail or the calendar can sit inside the section.
- The heading and the end line are reserved. Before the block is built, the host replaces the words
  of either with "[reserved text removed]" wherever they appear in a page or in recalled text. The
  match ignores case, full-width and other compatibility letters, accents on Latin letters, invisible
  and combining characters (zero-width, soft hyphen, direction marks), line breaks and runs of spaces
  inside the phrase, the final punctuation of the end line, and common Cyrillic and Greek letters that
  look like Latin ones. A look-alike from some other script is not covered. The model is told the same
  two lines, and that the same words anywhere else carry no instruction.
- Every single-line field a page supplies (title, other names, summary, section headings, fact text) is
  cut to one line before it is shown: line breaks become spaces and control, zero-width and direction
  characters are removed, so a title or name cannot start a fact line or a page line. A page line that
  reads as "[page:" at its start, in any width or spacing, gets "(" in place of its bracket, so the only
  page header in the block is the host's own.
- A line there is an instruction only when the person said it, wrote it or sent it (`you_said`,
  `you_edited`, `sent_mail`), or when it is a line with no hidden comment, which is the person's own
  hand edit. That covers a plain bullet and a plain sentence. Blank lines and `#` headings are not
  instructions. Only a person page has this section; on a matter page it is shown like any other
  section and never reaches drafting.
- A line there from mail, the calendar, read content or inference is not an instruction. A line
  whose marker cannot be read is not one either. Both are shown with the unconfirmed facts, labelled
  as not confirmed, so something an email said can never steer how Aman writes.
- A page with `household: true` adds one fixed line under its name: bookings and plans from this
  person are shared plans, not mail to answer. Aman notes them or puts them on the calendar.
- The drafting lines of a page that is left out, because of the page limits or the recall screen, are
  left out with it. The heading and end line count once against `MEMORY_PAGES_MAX_TOKENS`.
- The rest of the block is data, not instructions.
- Facts from mail, the calendar, read content and inference are labelled as not confirmed.

### Writing pages

Three tools let Aman keep short facts on pages: `remember_fact({about, text})`, `update_fact({about,
old_text, new_text})` and `forget_fact({about, text})`. Each also takes an optional `kind` (`person` or
`matter`), and `remember_fact` an optional `about_writing`. They are offered only when memory is on for the
chat, the memory backend is Markdown files, and the thread is the main one. A chat with memory switched
off, an unattended run, a sub-agent and any other memory backend get none, and the memory instruction
then keeps saying that no memory-write tool is available. A private chat gets none either, because nothing
from it is saved. If a call arrives anyway, it is refused with a sentence that says the chat is private and
that the person can ask again in an ordinary chat.

**Which page.** `about` is looked up only in the vault this chat writes to (the persona's own vault, else the
shared one), by title or other name, with case, accents and punctuation ignored. A persona's chat
never sees, changes or creates a page in another vault. Two pages with the same name (a person and a
matter) are refused with a plain question for the model to put to the person.

**Person or matter.** When no page matches, a page is created only if the tool call says `kind`. Without
it the call is refused and the model asks the person. Aman never guesses the kind from the name. An
existing page keeps its own kind.

**Whose words.** A fact is the person's own when `isPersonsOwnStatement` finds it in what they typed in the
message the turn answers (`personTypedText`; text the host wrapped around the message does not count, text
they pasted does). Every link, mail address and run of digits must be there, every name as the same word,
in each clause most content words, and at most two content words in all may be missing. A page's name is
theirs when a line of their own already stands under it or when it passes the same test now; under any other
name the line is not theirs, so their words never confirm a name they did not give. A fact that fails is still saved when the person asked for it, as `src=read_content`: it loads
and recalls as read content, is never an instruction and never a "How you write to them" line. A page made
for such a fact has a name of at most 60 characters with no link or mail address, and one reply makes at
most three of them. Its name is shown as not confirmed. A turn with no typed message saves nothing.

**Which section.** A new fact goes in `Now` with `since` set to today in the person's time zone, as
`src=you_said` or `src=read_content`. The person's own words are added as a new line even when a read line
already says the same; a read line is never upgraded. It goes under "How you write to them" only when `about_writing` is true, which the instruction
defines as how the person likes to write to this contact: tone, length, greeting, sign-off, language. A
matter has no such section, so that call is refused. A fact that is already on the page (ignoring case,
accents and spacing) is not added twice.

**Update and forget.** The old line is found by its text among the page's current facts. A fact already under
`Earlier` is not a target. A missing or repeated line is refused and nothing changes. `update_fact` moves the
old line to `Earlier` with `until` set to today and adds the new text as a new line in the old line's
section (a line that was unconfirmed goes to `Now`). Only words the person typed replace a line of their
own: when the new text is not theirs, their line stays and the new text is added beside it as read content.
`forget_fact` moves the line to `Earlier` with `until` set to today. Nothing is ever deleted, so the old
text and its id stay on the page.

**Reading pages.** Two more tools only read, from the same vault and with the same lookup. They are offered in the same chats as the writing tools, except that a private chat gets neither, so no call has to be refused. `list_pages({kind?, search?})` answers with `pages`, each `{kind, title, summary?}`, the most recently changed first (by file time), at most 50 a call; past that it adds `left_out` and says `search` narrows the list. `search` is matched with the alias index (`matchAliases`), so a page is found by its title or another name. The answer holds titles and summary lines only, never a line that is not the person's own, a path or a slug. `read_page({about, kind?})` finds the page with the writing tools' lookup. Two matches give a plain answer naming them so the model can ask. One match is shown by `renderPageForModel` and nothing else, so the person's "How you write to them" lines are not shown (they reach the model only through the closed drafting section) and lines that are not confirmed carry the same labels as in the memory block. It is cut by the memory block's limit for one page (`MEMORY_PAGES_MAX_TOKENS`): a longer page is not shown. Both tools pass every title, summary and page line through `sanitizeMemoryText`, the one function that also cleans the memory block. A page's name counts as the person's own (`pageNameIsOwn`) only when the page holds a line in their own words, a hand-typed bullet included. A page without one was made by the sorter from something read, and its title comes from a slug a model chose. Such pages are listed apart under a plain label, and their header in the memory block and in `read_page` says "name not confirmed by you". That header counts as read content, like the page's read lines, so a link or address in such a name is never the person's. Other names for a page are only ever added by the person, by hand or on the Pages screen. `read_page` tells the turn watch what it showed: a page that holds outside text (`pageHoldsOutsideText`) has the same effect as when the loader shows it, so a line of the person's own is then not changed or forgotten in that reply. `list_pages` does the same when it shows a name that is not confirmed. The two tools are host-only by name, so a call to them does not count as reading outside text, and the turn's saved note is labelled as it is when the loader shows the same page. They run without an approval card and write no activity-log line.

**The text.** A fact or a name is one line of at most 500 and 120 characters. A line break, `<!--` or `-->` is
refused. Control and invisible characters are removed. A fact that holds the drafting heading or the
drafting end line is refused, using the same match as the loader, instead of being rewritten. A tool answer
never repeats text from a page, only a fixed sentence.

**The taint rule.** `update_fact` and `forget_fact` leave a line of the person's own alone when the turn
holds anything that is not the person's own words, unless the person's message shares that line's words
(`keepFactsFromPerson`, the looser match, because the line only moves to Earlier and can be undone). A line
that is read content can be changed or forgotten in any turn. Two things count, and they are checked in the host, not left to the model.

- _Read in this turn._ Before every model step the host checks whether the turn, from the person's latest
  message on, has read text from outside the chat: any tool result other than a host-only one, an attached
  file or image, or a summary of earlier chat. Memory tool results and task-state results are host-only and
  do not count (`read_page` reports what it showed to the watch itself, see Reading pages); a connector tool that merely has the same name, or the same name reached through
  `call_tool`, does count. A tool call is judged on what the model had seen when it wrote the call, so a call
  written in the same step as a mail read is judged on the step before it.
- _Recalled into the memory block._ When the memory block built for the turn holds a recalled note whose origin
  is not the person's own words (mail, web, documents, read content, messages they sent, the assistant's
  earlier replies), or a page line whose source is
  mail, calendar, read content, inferred or a sent message, or whose marker cannot be read, the turn counts
  as tainted. Only notes stated by the person and page lines with source `you_said`, `you_edited` or no marker
  count as their own. The block builder sets this when it builds the block, from what it actually put
  there (the same label that marks a line "from something read for the person"), so there is one owner of what
  counts as outside text for notes (`itemSourceLabel`) and one for pages (`pageHoldsOutsideText`). A note that
  was withheld by the recall screen or left out of the block does not count.

Once a turn is tainted it stays that way. A change to a line of the person's own is then refused, nothing is
written, and the model is told what to say: that it did not change the line, and to ask the person to say in their own
words which line to change or forget. That is what keeps mail, web pages and documents, now or recalled from months ago, from removing
the person's own words, and the own-words test keeps them from being saved as the person's. The one limit
that remains is the person's own message: it can of course ask for something unwise. The tools need no
approval card: a line is either the person's own words or marked as read content, it stays on their machine,
and each write is a commit that can be undone.

**Every change is one commit.** Under the vault lock the host does these steps. It makes the history ready.
It takes in the person's hand edits (below). It makes the change. It commits the change with a message such
as `Aman saved: Likes tulips. (Nora)`, `Aman changed: ... to ... (Nora)` or `Aman removed: ... (Nora)`.
Each call also adds an entry to the activity log. The daily log is never written by these tools.
If the history fails before the change, nothing is written and the model is told to try again. If it fails
after, the page is already saved and the failure is logged. If git is not installed, pages are still
written, without history, and the log says so once.

**Hand edits.** Before any change Aman makes, every page that differs from the last commit is committed
as "Your edits". In those pages a fact whose text changed keeps its id and dates and gets `src=you_edited`
(its text is not touched). A bullet with no marker gets a new id, `src=you_edited` and `since` set to
today. A line whose marker cannot be read is left alone, so it stays unreadable and not confirmed.

**The history.** It is a git folder, `<vault>/.memory-history`, with the vault as its work tree. Only
`people/*.md` and `matters/*.md` are tracked, by an exclude file inside that folder. A vault that is
already a git repository is never touched: its `.git`, `.gitignore` and settings stay as they are, and
it will show `.memory-history/` as an untracked folder (the RUNBOOK says how the person can hide it). A
`.gitignore` in the vault does not hide pages from the history: pages are staged by name with
`git add --force`, restricted to `.md` files directly in `people/` and `matters/`. Git is run with no shell, its own commit name, no hooks, no signing and no files read from
the machine's git settings.

**The lock.** One lock per vault covers `people/`, `matters/`, `.memory-state/` and the history, and is shared
between processes, so a nightly pass and a chat cannot write at once. It is made of numbered files,
`lock.<n>`, in `.memory-state/`. A new owner must create file `n+1`, which is also how a dead owner is
replaced. The owner refreshes `lock.<n>.beat`. A waiter decides that the owner is dead only by watching
the lock stay unchanged for 30 seconds on its own clock, never by comparing file times, so a clock that
is wrong cannot steal a live lock. After a crash, the next writer therefore waits up to 30 seconds. A
writer gives up after 10 seconds and the model is told to try again. The daily-log append path does not
take this lock.

### The Pages screen

Settings, then Memory, then Pages (and the standalone Memory page) lets the person read and fix pages. The tab is offered only when the server reports the Markdown backend and has the pages routes. The routes are under `/api/v1/memory/pages` and take the same optional `namespace` query as the saved-notes routes: the shared vault by default, `persona:<name>` for a persona's vault. The vault folder is the tenant's own, so another person's pages are unreachable. With any other backend each route answers 501.

- **List** returns each page's kind, name, title, other names, summary line, the day the file last changed (UTC) and the number of lines under Unconfirmed, plus the `.md` files in the page folders whose names are not page names.
- **Read** returns the sections in order. Each line has its text, its id (none for a line typed by hand that has no marker yet), its source in plain words, its dates and `own`, which is `lineSide` from the page loader, so the screen and the model's prompt agree on what counts as the person's own. It also returns the page's Markdown and a `version`, the SHA-256 of that text.
- **Save an edit** takes the new Markdown and the `version` it started from. A page that differs from that version is refused with a 409 that says to reload; a difference in hidden markers alone, which comes from taking in earlier hand edits, is not a change. The text must start with a settings block that has a title, must not be empty or longer than 60,000 characters, and must not add a hidden note that cannot be read. The save runs in `commitPageChange` as one history entry, and `markEditedPage` marks it as a hand edit made in the file: new or changed lines become `you_edited`.
- **Confirm** moves an Unconfirmed line to a section the page's kind has (Now by default) as `you_edited`, keeping its id and setting `since` to the day. **Dismiss** removes it. Each is one history entry. A line without an id cannot be addressed and is changed in the editor.
- **Delete** removes the file in `commitPageChange`; the history keeps it.
- **Changes and undo.** The list shows the last 10 history entries. Undo of an entry puts each page it touched back as it was just before the entry (or removes a page the entry added) and commits that as a new entry, so history is never rewritten. It is refused with a 409 when a later entry left any of those pages different from how the entry left them, and the message names that entry. Entries that cancel each other, such as an undo and the change it undid, do not block. Entries are named by their full commit id. With no git on the server, the list is marked unavailable and an undo is refused.

The screen's delete waits 10 seconds on the client before the request is sent, like forgetting a saved note, and uses the same hook. A refusal from the server is shown as written.

### Sorting a saved note

After a turn's notes are saved, each new note can be sorted onto pages. This is `pageSorter.ts`. It runs
after the reply, never in front of it: the save returns first, a failure is logged and never fails the
save, and at most two sorting or summary calls run at once, because it uses the summarizer's model call and its
limit. It uses the summarizer's model, so with no model set nothing is sorted. A private chat saves nothing, so
it sorts nothing. A message the person sent is sorted the same way once its note is saved. Each persona's notes
are sorted into that persona's own pages.

**Three modes, one setting.** `MEMORY_PAGE_SORTING` is `off`, `report` or `on`, and defaults to `on`. The sorter reads the stored setting after each
save (the turn's summary context carries the settings store), so a change in Settings counts from the next save.
`off` calls no model. `report` calls the model and checks the answer exactly as `on` does, but writes no page
and no line in `.handled-notes`. It adds one JSON line to `.sorter-report.jsonl` in the vault folder: the note
id, its day, the decisions after the host's rules, and why a reply was refused or a call failed. It never holds
the note's text, but a decision can repeat a fact from the note, so deleting or editing a note in the vault also
drops that note's lines from the report. A new page made from a note that is not the person's own words is named
from its slug, never by the model. The file is kept under 256 KiB by dropping its oldest lines. `on` writes pages and the list of
handled notes. The default stays `report` until sorting gets at least 9 of 10 decision cases right with a hosted
model and with a local one (see the memory recall test). There is no Settings control and no API field yet.

**The question.** One model call per note. The model gets the note, its day and where it came from; up to five
pages shown whole, each statement with an id in square brackets; and a list of every page with its kind, title
and summary line. The five are the pages the note names by title or other name, then the pages whose
statements are closest in meaning to the note when the meaning search is ready. The prompt is bounded by the
summarizer's input limit: a note is cut in the middle, and a page that does not fit is left out whole, and the
prompt says which. The reply is `{"decisions": [...]}` with at most eight decisions, each `new`, `same`,
`changed`, `ended`, `unconfirmed` or `ignore`. An existing statement is named by its id, never by its text.
The model never names a file or a source.

**What the host allows.** The host decides from the note's stored origin and source, never from its text.

| The note is                            | Allowed                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The person's own words (`user_stated`) | All six decisions. New and changed statements are written as `you_said`.                                                                                                                                                                                         |
| A message the person sent              | A new line under "How you write to them" is written as `sent_mail`. Any other new fact is unconfirmed. It cannot change or end a `you_said` or `you_edited` statement.                                                                                           |
| Anything else, or no readable origin   | New, changed and ended all become an unconfirmed line with the note's source: `mail`, `calendar`, `read_content`, or `inferred` for the assistant's reply. Nothing confirmed is changed, ended or removed, and nothing is written under "How you write to them". |

A `same` decision only moves the statement's `seen` day. A decision that would write a line a page already
holds becomes `same`. A reply that does not parse, names a page that does not exist, names an id that was not
shown (or is already under Earlier), has a slug that is not a page name, holds more than eight decisions or
holds a line that is not plain text is refused whole: nothing is written, the note is not marked handled, and
the reason is logged.

**Applying.** All decisions for one note are applied in one `commitPageChange`, so the person's hand edits are
taken in first and the change is one history entry such as `Aman sorted a saved note onto pages (1 new, 1 changed)`.
A `changed` decision moves the old statement to Earlier with its end day and adds the new one. The page is read
again under the lock; if a statement the model named has changed since the prompt, nothing is written. After a
successful write the note is added to `.handled-notes` as `page` when anything was written or confirmed, and
`none` when every decision was `ignore` or the list was empty. A refused reply, a failed call or a failed write
adds nothing, so the note stays unsorted and recall keeps showing it from the log.

## The nightly job

`nightlyService.ts` starts a timer with the server (Markdown backend) that looks at the server's clock every ten
minutes. Each look first reads the stored tidy-up setting (`MEMORY_NIGHTLY_JOB` is only its default, on), the stored
hour (`memory_nightly_job_hour`, 0 to 23, midnight when unset) and the stored sorting setting, so a change in Settings
counts without a restart. From that hour and for up to three hours, never past the end of the day (server time),
`runNightlyJob` goes through the
shared vault and each persona's vault one after the other and stops starting vaults when the hours end. A failure in one
vault is logged and does not stop the others. The job is not part of any chat, so an incognito chat neither starts it nor
feeds it. `POST /api/v1/settings/memory-nightly/run` runs the same steps now for every vault and answers with the
counts. It runs at any hour and with the switch off, neither checks nor takes the day, and answers `busy` while a run
is under way in this process.

**Once a day per vault.** `claimNightlyDay` reads and writes `last_run_day` in `.memory-state/nightly.json` under the
vault lock. Two processes starting together cannot both take the day. The day is taken before any work, so a crash halfway
is repeated the next day, and every step is safe to repeat. A vault that stays busy for 3 seconds is skipped and tried at
the next look. The lock is taken for each small change and never around a model call, so a save or a page edit is not held up.

**The model without a turn.** `nightlyService.ts` builds the summarizer's context by hand: it respects the summaries switch
(`readMemorySummarizeSetting`), uses the persona's own model for a persona's vault and otherwise the model new chats start
on (`resolveDefaultChatModel`), and goes through `summaryModelFor`, so the same client, light-reasoning request, time
budget, limit on calls at once and token budget apply. A turn's own summary model setting on its agent is not known here.
With no model, steps 2 and 3 are skipped.

**Step 1: ended statements, no model, every mode.** A fact under Now, Decided or Open whose `until` is before today
(`endedBefore`: `2026-10` ends on 31 October) moves to Earlier with that `until`, through `moveFactToEarlier`, for all pages in
one `commitPageChange` that says "Aman moved 3 ended lines to Earlier". Unconfirmed and "How you write to them" are not
touched. When nothing ended, nothing is written, not even a history.

**Step 2: missed notes.** Entries of the last 14 days from the daily log (deleted ones are resolved away, erased ones are
not entries), not in `.handled-notes`, and, in `report` mode, with no line in `.sorter-report.jsonl`, oldest first, at most 40,
each through `sortNote` with the configured mode. `off` asks nothing. A note whose sorting fails is counted in
`note_tries`; after three nights it is left alone, and three failures in a row end the step for the night.

**Step 3: statements that disagree.** Pages whose fingerprint differs from `looked_at` in `nightly.json`, at most 20 a run.
Pages with fewer than two current statements are marked looked at with no call. The reply is
`{"pairs":[{"a":"<id>","b":"<id>","reason":"<one line, at most 200 characters>"}]}`. A reply that does not parse, is longer than 4000
characters, has more than 10 pairs, names an id that was not shown or names one line twice is refused whole and the page is
marked looked at. A failed call ends the step and the page is tried again next time. The host keeps at most 5 pairs, and
after the call it reads the page again and drops a pair whose line changed or ended. `disagreements.json` holds, per pair,
the page, both ids with a fingerprint of the text, the day found and the reason, plus the pairs the person dismissed. The
Pages routes show a pair only while both lines are current and unchanged and the pair is not dismissed. The page is never
written.

## Recall from the Markdown backend

Recall reads every live entry in the vault, from the newest daily file to the oldest. How long ago
something was saved never decides whether it can be found. When the meaning model is ready and there
are at least five statements and eligible notes to judge, notes are chosen by meaning under the two
rules described under [Log notes by meaning](#log-notes-by-meaning); otherwise they are ranked by shared
words, fused with meaning behind the peak test. The token budget decides how much of that is shown.

- **Reading the log.** A scan checks each daily file's size, change time and identity, and reads a
  file again only when one of them differs from the last read. A file changed in the last two seconds
  is always read again, because a second change could carry the same time. So a hand edit or a restore
  is seen on the next recall. The parsed text is kept per process, capped at 64 MiB, and the files read
  longest ago are dropped first.
- **Read content has no age limit.** A finding from a mail, a page or a document is recalled however old
  it is, like everything else. Each recalled item carries its day, and the instructions say a finding may
  be out of date and must be checked against its source before acting on it.
- **Notes are journal entries.** Every recalled line reads `[day, age, who it came from] text`, for example
  `[2024-11-02, 2 years ago, said by the person] ...`. The host computes the age from the person's calendar
  day (`memoryAge`), so nothing rests on the model subtracting dates, and the person's own words carry a
  label like every other source, so no line reads as a bare present fact. An undated line, or one dated
  after today, carries no age. The instructions define the lines once, for every kind of note: an entry
  says what was so that day and may or may not still be so. They name no kinds of facts. They also say
  that when two entries disagree the later one is current. Pages, not notes, state what holds now. The
  right rail reads the same lines and skips the age.
- **Copies.** When the same text was saved on several days, recall shows its best-ranked copy once.
- **Cost.** On a test vault of 1,000 daily files and 20,000 entries, a recall after the first one takes
  100 to 200 ms on one core. The first recall after a start reads every file and takes about half a
  second. A vault of 100 daily files takes about 30 ms.
