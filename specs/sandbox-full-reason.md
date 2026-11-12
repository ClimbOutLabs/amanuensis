# Sandbox full reason in capabilities

Status: approved; the full-sandbox part is superseded by stage 3 of [sandbox parked workspaces](sandbox-parked-workspaces.md), which removed the per-slot chat count, so the full reason and its log line no longer exist. The reason channel stays and carries every other reason the sandbox is off.

## Problem

On an install that runs the sandbox on slots, each slot holds one workspace per
chat, up to as many chats as its disk fits. When every slot is full, the sandbox
stops being available, but nothing a person can see says so. The capabilities
answer reports the sandbox off with no reason, the chat Add-ons picker says only
that the sandbox is not available on this server, the skill capability says the
sandbox is not configured, and the server logs nothing. The Settings page and
the doctor command keep saying the sandbox is ready, because their readiness
check does not count how many chats each slot already holds. A person whose
sandbox fills up has no way to learn that deleting old chats is the way out.

The sandbox provider already works out the true reason. When the slots are full
it reports: "The sandbox is full: every slot already holds as many chats as its
disk fits. Delete old chats, then try again." That reason is dropped on the way
to the capabilities answer, which keeps only the bare build status.

## The change

The reason travels with the status from the provider to the person.

- The sandbox entry in the capabilities answer gains an optional `reason`,
  present when the sandbox is off and the build failed with a reason.
- The skill entry uses that same reason when skills are off because the build
  failed with one, instead of saying the sandbox is not configured. The
  "still being prepared" wording for a pending build stays as it is, and a
  failure with no reason keeps the "not configured" wording.
- The chat Add-ons picker shows the sandbox reason when one is present, and
  falls back to its current line when there is none.
- When every slot is full, the provider logs one warning with each slot's
  session count and capacity, like its other failure warnings, so the state
  can be found in the server logs.

## Design decisions

- The reason comes only from the provider's own build report. No new wording
  is written for the person; the strings that already exist are carried
  through unchanged.
- When the sandbox is on, the capabilities answer is exactly what it is
  today: no reason field appears.
- No decision changes. Capacity is counted the same way, chats keep their
  workspaces until they are deleted, and a full sandbox still refuses new
  work. Only the reporting changes.
- The sandbox capability schema is a wire shape for one response, not
  persisted JSON, so adding an optional field needs no data migration. Older
  readers ignore a field they do not know.

## Out of scope

- Changing how many chats a slot holds, or freeing workspaces any way other
  than deleting chats.
- Making the Settings page or the doctor command count capacity.
- Any new wording for the picker or the skill line beyond showing the
  provider's reason.

## Privacy

No new data flows. The reason is a fixed status sentence the provider already
produces on the person's own instance. It names no chats, no files and no
person, and it is returned only to signed-in callers of the capabilities
route, like the rest of that answer.

## Testing

Tests use synthetic data only, never a person's real chats or instance. The
capabilities suites gain cases for: slots full, where the sandbox and skill
entries both carry the full reason; slots not ready, where both carry the
not-ready reason; slots ready, where no reason appears; and the local build
path failing with a stored reason and failing with none. The slot provider
suite gains a case that the full path logs one warning carrying each slot's
session count and capacity. The generated client is refreshed with the usual
SDK generation step before merge, and the UI typecheck is expected to pass
once it has run.
