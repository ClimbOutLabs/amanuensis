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

## Pages

Pages are short Markdown files about one person or one matter. They sit beside the daily log in a
vault and hold what stays true, so it does not have to be dug out of old entries. They work with the
Markdown memory backend only. Hindsight does not use them.

Pages are written by hand for now. Tidying them automatically is planned, but nothing does it yet.
No memory-write tool is exposed to the model, and pages do not change that.

### Files in a vault

    people/<slug>.md      one page per person
    matters/<slug>.md     one page per matter (a trip, a purchase, a project)
    .memory-state/        notes Aman keeps for itself
    .git/, .gitignore     the vault's own history of its pages

The slug comes from the title: lowercase, accents dropped, other characters turned into dashes, cut
at 64 characters. `José` and `Jose` share one page. A page's file name must be exactly that
lowercase slug, such as `people/wendy.md`. A file with any other name, such as `people/Wendy.md` or
`people/my notes.md`, is not a page: it is never loaded and never touched. To use it, rename the file
to the lowercase slug.

`.memory-state/` is never in git and never exported. It holds:

- `timezone`: the time zone the vault counts "today" in, taken from the newest chat made in a
  browser. Scheduled and other unattended runs never change it. This is state.
- `aliases.json`: a cache of every page's title and other names. It is rebuilt whenever a page
  changes, so it is safe to delete.
- `lock`: present only while pages are being written. See below.
- `README`: a short note saying what the folder is. The file text lives in `memoryState.ts`.

The vault becomes a git repo the first time Aman writes a page. Each write is one commit. The
`.gitignore` is a whitelist: it ignores everything except `.gitignore`, `people/` and `matters/`. So
the daily log and `.memory-state/` are never in the history, and undoing a commit can never touch the
log.

### The page format

A page starts with a block of settings between two `---` lines:

| Key         | Meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| `kind`      | `person` or `matter`.                                           |
| `title`     | The page's name. The `# ` heading in the body is never used.    |
| `aliases`   | Other names, nicknames and email addresses that mean this page. |
| `household` | People only. `true` for someone the person lives with.          |
| `status`    | Matters only. `active` or `done`.                               |

Keys it does not know are kept as they are. After the settings come a `# ` heading and a one-line
summary, then sections. Each is a `## ` heading:

| Section               | Kind   | What goes there                                                  |
| --------------------- | ------ | ---------------------------------------------------------------- |
| How you write to them | person | How the person likes to write to this contact.                   |
| Now                   | both   | What is true at the moment.                                      |
| Decided               | matter | What has been settled.                                           |
| Open                  | matter | What is still undecided.                                         |
| Unconfirmed           | both   | Things read somewhere that the person has not confirmed.         |
| Earlier               | both   | Things that were true and no longer are. They carry an end date. |

Keeping a page short, by moving the oldest "Earlier" lines into an archive file, is planned. Nothing
does it yet.

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
read. A leading byte order mark is allowed. Reading a page and writing it back returns the same bytes
unless a line was changed on purpose.

A bullet that carries a hidden comment the host cannot read as a marker (an unknown key, a bad date, a
repeated key, a misspelt `fact`) is kept as it is but never trusted. It counts as not confirmed, not
as the person's own words. Only a bullet with no hidden comment at all is a hand edit.

### How pages are loaded before each turn

Before recall, the host looks at the person's message for names. It compares each page's title and
other names with the message as whole words. Case, accents and punctuation around a name are ignored,
so `(Wendy)` and `Wendy,` both match. An email address counts as one word, so putting an address in
`aliases` finds the page when the person pastes that address. A trailing dot is ignored, so `W.`
matches `W`.

A name followed by `'s` (`Wendy's flight`) is a possessive match. It loads the page, but ranks below
a direct mention, since the page may be about the owner and not the subject.

Matches are ordered by:

1. The vault, own vault first, then the shared vault, then any vault shared with the person. If two
   vaults have the same page, only the first is used.
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
such as "(you said, since 2026-03)". "How you write to them" is not shown with the page. Its lines
are gathered, for every loaded contact, under one fixed heading after the pages (see below).

### Drafting rules

- After the pages, the memory block has one heading, "How the person writes to these contacts
  (follow when drafting to them):". Under it, each loaded contact is listed by name with the lines
  from its "How you write to them" section. This is the only place those lines appear.
- A line there is an instruction only when the person said it, wrote it or sent it (`you_said`,
  `you_edited`, `sent_mail`), or when it is a plain bullet with no hidden comment, which is the
  person's own hand edit.
- A line there from mail, the calendar, read content or inference is not an instruction. A line
  whose marker cannot be read is not one either. Both are shown with the unconfirmed facts, labelled
  as not confirmed, so something an email said can never steer how Aman writes.
- A page with `household: true` adds one fixed line under its name: bookings and plans from this
  person are shared plans, not mail to answer. Aman notes them or puts them on the calendar.
- The drafting lines of a page that is left out, because of the page limits or the recall screen, are
  left out with it.
- The rest of the block is data, not instructions.
- Facts from mail, the calendar, read content and inference are labelled as not confirmed.

### Hand edits

A page is a plain file, so the person can edit it. Any page that differs from the last commit counts
as a hand edit. Before Aman writes any page, it takes the hand edits in first and commits them on
their own with the message "Your edits". Then it makes its own change as a separate commit. Two
things happen to markers:

- A bullet whose text changed keeps its id and dates, and its source becomes `you_edited`.
- A bullet in a known section with no marker gets a new id, the source `you_edited` and today's date as
  `since`.

Everything else on the page is left alone. Because history is kept in the vault, any change can be
looked at, or undone, with ordinary git commands.

### The lock

Only one writer touches a vault's pages at a time. The lock is the file `.memory-state/lock`. It is
held only around page writes and git calls. Appending to the daily log never takes it. A writer that
finds the vault busy waits up to 10 seconds, then fails with "Memory is busy right now. Try again in a
moment." A lock older than 60 seconds is taken to belong to a crashed writer and is taken over
automatically, in a way that two writers cannot both do at once. A lock file that cannot be read is
treated as stale only by its age.
