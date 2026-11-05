# Memory design

## What this is

Host-enforced long-term memory. Exactly one MCP connector carries
`memory_provider: true` in its manifest; the host recalls from it before
every model call and retains every completed turn to it. The model is never
responsible for remembering to use it, and no memory-write tool is exposed
to the model. Hindsight is the recommended provider: a self-hosted,
long-term memory bank, run as its own service, with one bank per user.

Deliberate principles: recall is user-visible byte for byte; one dispatch
path, no side channel; empty recall returns a distinguishable empty, never
filler; credentials by reference, never by value.

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

Every turn assembles one `<aman-memory>` block from up to three provider layers, each read
independently and each degrading on its own, so none can fail a turn:

- **Curated** (every turn, `MEMORY_CURATED_ENABLED`): `GET /profile` and `GET /mental-models`.
  The profile's mission and background become one `[profile]` line when set. Mental models are
  selected deterministically by term overlap with the recall query (current before stale, more
  shared terms first, name as tie-break), capped at `MEMORY_CURATED_MAX_MODELS` and
  `MEMORY_CURATED_MAX_TOKENS`; no shared term injects nothing. These are cheap reads with no
  model call behind them. Lines sit ahead of the recalled items.
- **Recall** (every turn): `POST /memories/recall` with the windowed query
  (`MEMORY_RECALL_QUERY_WINDOW`). Facts, no model call.
- **Reflect** (`MEMORY_REFLECT_ENABLED`, only on a reflect route): `POST /reflect` with the same
  query, `MEMORY_REFLECT_BUDGET` (default `low`), `MEMORY_REFLECT_MAX_TOKENS`, and its own
  `MEMORY_REFLECT_TIMEOUT_MS`. The route is decided from the newest user message alone by the
  literal synthesis patterns in `runtime/memory/memoryRouting.ts` (summarize, brief me,
  recommend, compare, assess, what should I do, what have we learned, and so on). A factual lookup
  stays on recall. Reflect spends model calls on the same local inference server that serves chat,
  which is why the gate is a short list of literal patterns and not a classifier. Its answer is one
  `[reflection]` line after the entities line.

Curated lines and the reflection are provider-synthesized text with no per-datum origin, so when
the recall screen is on they are classified like an untrusted-origin item (`curated:#<index>`,
`reflection:#0`): withheld when flagged or when the screen gave no verdict. The screen's time
budget is charged for the recall call alone, not the parallel wall clock.

The event's `layers` field records, per turn, whether a profile line and how many mental models
were injected (and how many candidates the bank returned), the route and the pattern that selected
it, and the reflect outcome with its wall clock and the number of memories the provider said the
answer drew on. Consolidation into mental models stays the provider's background job; the host
never triggers it from a turn.

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
- **One place decides.** The turn drain watches each tool result and writes the note when a send's result
  qualifies. A send approved on a card runs in a later turn that never sees the message that asked for it,
  so that turn is handed the calls the person allowed, read from the end of the paused turn before the turn
  starts. Calls are matched by thread and call id together. If the paused turn cannot be read, the turn runs
  as usual and the send is not saved; a warning is logged.
- **What the note holds.** The recipients, any cc and bcc, the subject and the composed body, written word
  for word by the host with no model call. A forward carries no subject of its own (the sidecar sets it), so
  none is recorded, and only the text the person added is kept, never the forwarded message. The body is
  cut, on a whole character and with a plain "(cut)" marker, at the same length as any other tool result.
  A message that holds something shaped like a secret is checked in full before any cut, and is not saved.
- **Its own write.** The note is saved as soon as the send is known to have gone through, in a write of its
  own with its own operation id. It does not wait for the turn to finish and does not depend on the turn's
  save, so it is kept whether or not turn summaries are on, whether or not the turn's own save succeeds, and
  when the turn ends early. A later recovery of a lost turn neither drops it nor writes it twice.
- **Source and label.** The note's source is `sent_mail` and its label reads "From a message you sent, Oct 31".
  The Memories page shows "Source: a message you sent". The note is stored with the same origin as other tool
  results (`tool_ingested`), so the recall screen holds it to the same strict posture: what a message says is
  data, never an instruction. Recall ages it like other read content: a note older than two weeks stays in
  the file but is not recalled.
- **Not an instruction.** The model composed the text of a sent message, and it can echo text from mail it
  read, so a `sent_mail` note is evidence of how the person writes, not something the person said as a
  rule. No pass may promote a `sent_mail` note into a drafting instruction on a page, and so into a fact
  with source `sent_mail`, unless the person confirms it. Nothing does today: pages are written by hand.
- **Old files.** Notes already on disk keep their exact bytes. Only a new source word, `sent_mail`, can
  appear in the hidden note marker.

## Pages

Pages are short Markdown files about one person or one matter. They sit beside the daily log in a
vault and hold what stays true, so it does not have to be dug out of old entries. They work with the
Markdown memory backend only. Hindsight does not use them.

Pages are written by hand. Aman only reads them. No memory-write tool is exposed to the model, and pages
do not change that.

### Files in a vault

    people/<slug>.md      one page per person
    matters/<slug>.md     one page per matter (a trip, a purchase, a project)
    .memory-state/        notes Aman keeps for itself

The slug comes from the title: lowercase, accents dropped from Latin and Greek letters (and Cyrillic `ё` read as `е`), other characters that
are not letters or digits turned into dashes, cut at 64 characters (and at 200 bytes, so the file name
stays valid). Only those accents are dropped, so `Ελένη`, `ΕΛΕΝΗ` and `Ελενη` are one name, and so are `Фёдор` and `Федор`, while `й` stays its own letter. In Korean, Japanese, Thai, Hindi and other scripts the
marks are part of the letter and stay, so `김민수` is `people/김민수.md`, `ジョン` is not `ション`, and
`ハル` is not `バル`. Text is compared in its composed form, so a name typed in either form is the same
name. `José` and `Jose` share one page. A page's file name must be exactly that
lowercase slug, such as `people/wendy.md`. A file with any other name, such as `people/Wendy.md` or
`people/my notes.md`, is not a page: it is never loaded. Each turn that skips such a file writes one
warning to the server log with the number of files skipped. It does not name them, since file names can be people's names. To use a file, rename it to the lowercase slug.

Export and import move pages with the rest of memory. An export (format version 3) holds every `.md`
file directly in each vault's `people/` and `matters/` folders as `memory/<vault>/people/<name>.md` and
`memory/<vault>/matters/<name>.md`, byte for byte apart from the usual removal of keys and passwords.
That includes a file such as `people/Wendy.md` whose name is not a lowercase slug: it travels under its
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

`.memory-state/` is never exported. It holds one file:

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
so `(Wendy)` and `Wendy,` both match. An email address counts as one word, so putting an address in
`aliases` finds the page when the person pastes that address. A trailing dot is ignored, so `W.`
matches `W`. Names in Chinese, Japanese, Korean or Thai are written without spaces, so those match
anywhere in the message: `田中` is found in `田中さんに会った`. A name never matches part of a
letter, so `민수` does not match `민숙` and `ハル` does not match `バル`. When one name sits inside a longer
name that is also on a page, the longer name takes the words: `นิดา` loads its own page, not the page
for `นิด`. A short name inside a longer word that has no page of its own still matches. Every other name still needs whole words,
so `Sam` does not match `Samantha`.

A name followed by `'s` (`Wendy's flight`) is a possessive match. It loads the page, but ranks below
a direct mention, since the page may be about the owner and not the subject.

Matches are ordered by:

1. The vault, own vault first, then the shared vault, then any vault shared with the person. If two
   vaults have the same page, the first that has a readable copy is used. A page that cannot be read
   in one vault does not hide the same page in another.
2. Direct mentions before possessive ones.
3. People before matters.
4. Where the name first appears in the message.

Two limits apply, on top of the normal recall budget:

| Setting                   | Default | Meaning                                      |
| ------------------------- | ------- | -------------------------------------------- |
| `MEMORY_PAGES_MAX_COUNT`  | 6       | Most pages loaded in one turn.               |
| `MEMORY_PAGES_MAX_TOKENS` | 1500    | Estimated size of all loaded pages together. |

A page that would go over the token limit is left out, and so is every page after it. That way the
model always sees the highest-priority pages. Each turn's memory event records how many pages matched,
loaded and were dropped for each reason. A vault that cannot be read adds nothing and never fails the
turn.

The model sees each page as plain lines under short labels, with each marker shown as a short note
such as "(you said, since 2026-03)". Facts from mail, the calendar, read content and inference, and
lines whose marker cannot be read, always end with "not confirmed" in that note, for example
"(from mail, not confirmed, since 2026-03)". "How you write to them" is not shown with the page. Its lines
are gathered, for every loaded contact, under one fixed heading after the pages (see below).

### Drafting rules

- The drafting section is the last part of the memory block, just before the closing tag. It starts
  with one heading, "How the person writes to these contacts (follow when drafting to them):", and
  ends with one fixed line, "End of the writing instructions." Between the two, each loaded contact is
  listed by name with the lines from its "How you write to them" section. This is the only place those
  lines appear. Recalled items, curated lines, entities and the stats line all come before the
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
