# Memory runbook

This runbook covers the memory pages and the evaluation-only Prompt Guard sidecar
that can screen recall and tool output.

## Memory pages

A vault is one folder under `MEMORY_MARKDOWN_DIR`.
The pages and their format are described in [the design](DESIGN.md#pages). You can edit pages by hand, and in a chat Aman can add, change or forget a single fact when you ask.

### A page is not loaded

If the server log warns that page files were skipped, some files in `people/` or `matters/` do not have a lowercase
page name. The log gives a count, not names. Look for such files and rename them, for example
`people/Nora.md` to `people/nora.md`. Aman picks it up on the next turn.

### Moving pages to a new server

`aman export-data` and `aman import-data` carry each vault's `people/` and `matters/` pages. Run them
as usual; there is nothing extra to copy. After an import, the summary lists the pages that came
along. If it says some pages have a name that is not all lowercase, rename each one to its lowercase
name in the memory folder, for example `people/Nora.md` to `people/nora.md`; Aman reads it on the next
turn. If it says other files were not copied, they were not `.md` pages; copy them by hand if you need
them. If it says pages were left out because memory is kept in a different way, pages only work with the
Markdown memory backend. `.memory-state/` and `.memory-history/` are not exported. The cache is
rebuilt on the new server. The history starts again there, with your edits and Aman's later changes.

### Files in `.memory-state/`

- `aliases.json` is a cache of page names. Deleting it is safe. It is rebuilt on the next turn that
  needs it.
- `lock.<n>` and `lock.<n>.beat` are the lock that keeps two writers from changing pages at once. Leave
  them alone while Aman is running. If every process is stopped and you still see them, delete them all.

### The lock is busy

A chat that asks Aman to remember something while another change is running waits up to 10 seconds, then
Aman says it could not save and asks you to try again. If a process crashed while it held the lock, the
next writer takes over after 30 seconds of silence. You do not need to do anything.

### The page history

Every change Aman makes to `people/` or `matters/` is one commit in `<vault>/.memory-history`. It is
separate from any git repository your memory folder is already part of, and it never changes that one.
The next time Aman writes, it first commits anything you changed by hand as "Your edits". If git is not
installed on the server, pages are still saved but there is no history, and the log says so once. Install
git to turn it back on.

If your memory folder is also a git repository of your own, `git status` there lists `.memory-history/` as a new
folder. Aman never changes your repository or your `.gitignore`. If you want git to stop listing it, add this one
line to your own `.gitignore`:

    .memory-history/

A `.gitignore` of yours never hides pages from Aman's history.

To look at the history, use the same two folders every time. Replace `VAULT` with the vault's folder:

    git --git-dir=VAULT/.memory-history --work-tree=VAULT log --stat
    git --git-dir=VAULT/.memory-history --work-tree=VAULT show HEAD

To undo Aman's last change to one page, stop Aman first so that no write is running, then put the page
back from the commit before it:

    git --git-dir=VAULT/.memory-history --work-tree=VAULT checkout HEAD~1 -- people/nora.md
    git --git-dir=VAULT/.memory-history --work-tree=VAULT commit -m "Undo by hand" people/nora.md

Change `HEAD~1` to any commit from the log to go further back. If you skip the second command, Aman
commits the restored page as "Your edits" the next time it writes. A forgotten fact is not lost: it sits
under "Earlier" with an end date, so you can also move the line back by hand. If a history call keeps
failing, check that the disk has room. Deleting `.memory-history` only removes the history, never the pages.

## Evaluation-only Prompt Guard sidecar

The classifier assets and reproducible container build live in
`ops/prompt-guard/`. They are not part of the Aman image or startup graph. Read
that directory's README and ADR before running it; the pinned artifact remains
under the Llama 4 license and is not approved as a production control.

Both recall and live tool-output screening use the same classifier connection:

```text
MEMORY_SCREEN_URL=http://<classifier-host>:8080
MEMORY_SCREEN_AUTH_TOKEN=<bearer secret>
MEMORY_SCREEN_THRESHOLD=0.5
```

Recall screening is on or off per the memory bank's `screen_enabled` setting
in Settings > Memory, which defaults to `MEMORY_SCREEN_ENABLED` when the bank
has not set it — so an existing deployment's behaviour does not change until
someone flips the switch. Live tool results are controlled by
`TOOL_OUTPUT_SCREEN_ENABLED` (env only, no per-bank setting) and bounded by
`TOOL_OUTPUT_SCREEN_TIMEOUT_MS` (default 1500). Both default off. Do not
expose the sidecar publicly, do not place the bearer token in Git, and do not
turn on either until the model provenance and local threshold have been
accepted.

Recall screening stays off by default. It needs a classifier sidecar that the
installer does not start, so a default of "on" would have nothing to screen
against: with no service reachable, every memory that came from something Aman
read would be withheld. With it on, each recalled item and each page costs one
classifier request per turn (run in parallel, up to the concurrency setting,
each bounded by `MEMORY_SCREEN_TIMEOUT_MS`); the recorded runs show a median of
about 21 ms, but a 95th percentile of about 6 s on CPU and about 0.7 s on GPU.
Without the screen, recalled items that came from content the person's assistant read are
labelled "from something read for the person" and the model is told they are not the
user's words, not verified fact, and never instructions.

The Settings > Memory switch is disabled, with the reason "No screening
service configured", whenever `MEMORY_SCREEN_URL` is unset — flipping it would
have nothing to screen against. The user's own stated memories are never
withheld by the screen; it only checks memories that came from tools,
documents, or email before they reach the model.

The Memory settings page shows:

- recall screening: effective on/off state, whether a classifier service is
  configured, and non-secret threshold only;
- live tool-output screening: on/off state, non-secret threshold, and
  non-secret timeout.

The classifier URL and bearer token remain server-side and are never returned
by `/api/v1/capabilities`.

With live screening enabled, only results marked `open_world_hint: true` are
classified. A withheld result remains expandable in its tool card and its
terminal event carries the screen status. If the classifier is missing,
unreachable, slow, malformed, or oversized, that eligible result fails closed:
the raw output remains visible to the user but does not enter model context.
