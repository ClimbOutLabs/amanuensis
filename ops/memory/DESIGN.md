# LKOS memory integration for TF Aman

Branch `claude/lkos-memory` from main `4f133d7a`. Nothing here is pushed or
deployed until the owner has seen the work.

## What this is

LKOS (LocalKnowledgeOS, the owner's Rust knowledge archive) becomes TF Aman's
memory: registered as a remote MCP server, retrieval-only in v1, reached over
Streamable HTTP on host loopback from the container via host.docker.internal
(reachability verified empirically). Aman-side memory behavior is ordinary
gated tool use: the model calls retrieval tools, results appear in the event
stream, nothing is injected invisibly.

Carried over from the original Amanuensis prior art, deliberately: recall is
user-visible byte for byte; one dispatch path, no side channel; empty recall
returns a distinguishable empty, never filler; credentials by reference,
never by value.

## The fix this rides on: secret references

TF stores MCP auth header values plaintext in the manifest jsonb (confirmed:
redaction is wire-only; the DB value is the live secret). The LKOS bearer
token will not join it.

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
  header name, never the value. Failure behavior is then TF's existing
  degradation: non-preloaded server skipped at init, mid-session call
  returns a model-visible error and the turn continues.
- Wire redaction: reference strings are pointers, not secrets, and pass
  through unredacted so the user can see and edit them. The PUT merge rule
  (redacted stand-in keeps the stored secret) must treat a reference as an
  ordinary new value: writing a reference replaces a stored literal, and the
  redacted stand-in never matches a reference.
- No store changes: the manifest still persists verbatim; what changes is
  that the persisted value can now be a pointer.

Deliberately not in v1: `${keyring:}` (no Credential Manager inside the
Linux container; add as a host-mode kind when a host deployment needs it)
and `${exec:}` (running arbitrary commands to obtain secrets is a larger
trust decision than this feature needs).

## Registration shape

    name: lkos
    type: remote
    url:  http://host.docker.internal:<port>/mcp
    auth: header
      Authorization: ${file:/data/secrets/lkos-token}

The token file lives in the container's /data volume with 0600 permissions,
written once by the registration runbook, which pipes it from the LKOS
client-registration response without ever displaying it. The DB carries only
the reference.

## Trust classification

TF's gate is fail-closed: unannotated tools pause for approval every call,
and only inspect-effect tools are chat-grantable. LKOS retrieval tools must
therefore declare `readOnlyHint: true, openWorldHint: false`. If LKOS does
not annotate today, the fix belongs in LKOS, not in a TF-side exemption:
the read-only client cannot call write tools anyway, and weakening the gate
to accommodate missing metadata is exactly the reassuring-default mistake
this project already removed once.

## Acceptance axes, from the dossier

Tested against an extended inert MCP fixture exposing retrieval-shaped
tools, so the axes are provable in CI without a live LKOS:

1. Success: annotated retrieval tool call flows, result lands in the event
   stream, chat grant is offered and honored.
2. Abstention: an empty retrieval result arrives as a distinguishable,
   non-error empty; nothing in the harness converts it into an error or
   invites fabrication.
3. Pause: server unreachable mid-session degrades (model-visible error,
   turn continues); unreachable at init with preload off is skipped.
4. Resume: server back up, next call succeeds without re-registration.
5. Restart: registration and reference survive server restart; the token
   file outlives the container; resolution picks up a rotated token without
   re-registration.

## Live-wiring blockers, owner decisions

Recorded, not blocking the TF-side build:

1. **Certified-binary hash mismatch.** The dossier's LKOS exe hash
   `741DA544...` matches none of the fifteen binaries on this machine; the
   newest release build hashes `99631C87...` (built Aug 23). Either locate
   the binary that hash came from or approve a rebuild from pinned source
   with a freshly recorded hash. The runbook refuses to start LKOS until
   the expected hash is confirmed.
2. **Port.** LKOS's default MCP port 43112 is occupied by Docker
   (forwarding to an Amanuensis container). The runbook takes an explicit
   port parameter and refuses the default.
3. **Host header.** LKOS validates loopback Host/Origin; requests from the
   container arrive with `Host: host.docker.internal:<port>`, and fetch
   cannot override Host. Recommended: a small `--allow-host` allowlist flag
   in LKOS. Alternative (worse): a host-side proxy rewriting Host.
4. **Read-only client.** The LKOS CLI grants the full assistant scope set;
   read-only scoping exists only via the LKOS web API. The runbook uses the
   web API and verifies the resulting client's scopes are read-only before
   wiring anything.

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
