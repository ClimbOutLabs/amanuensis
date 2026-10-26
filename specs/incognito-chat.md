# Spec: Incognito Chat

**Status:** draft

## Problem

Every chat teaches Aman something. Memory retain runs after each turn, profile learning rewrites the learned profile, the chat sits in history, and its files stay on disk. Sometimes you want to ask something once and leave no trace: a medical question, a gift, a draft you do not want remembered. Today the only way is to turn memory off in Settings and delete the chat by hand, and even then profile learning and leftover files remain.

## Solution

A chat you start on purpose that Aman is forbidden to remember. The server enforces every guarantee below from a flag on the session row; nothing depends on the model behaving.

## 1. What incognito guarantees

In plain words, when a chat is incognito:

- **Nothing from it is remembered.** No fact from the chat is written to any memory vault, and the learned profile is not updated. Settings › Memory shows nothing new afterwards.
- **It still knows you.** Aman reads your memory and your profile, as in a normal chat, but only reads. Recommendation: reads on. Trade-off: with reads on the chat is as helpful as usual and nothing extra is stored; with reads off you get a stranger who cannot use what it already knows, and the only gain is that the recall lookup is not run (a lookup that stays on your computer with the Markdown backend, and goes to the Hindsight server if you use that). A per-chat switch "Use what Aman knows about me" on the start dialog, default on, lets you pick.
- **It is not kept.** It never appears in your chat list. It is deleted the moment you end it, switch to another chat, or close the tab. If the tab vanishes without saying goodbye, the server deletes the chat after 1 hour without activity, and deletes every leftover incognito chat each time it starts.
- **Nothing outlives it.** No schedule can be created from it (chats cannot create schedules today, and a scheduled run can never be incognito). Any approval it asks is answered now or dropped with the chat. "Allow in this chat" grants die with it. "Always allow" is not offered.
- **Files go with it.** Uploads, sandbox working folders, and files Aman produced are deleted when the chat is deleted. Anything you already downloaded to your computer is yours and stays.
- **Connectors and search still work, and still leave the machine.** A web search sends the query to the search provider. A Gmail action reads or sends real mail. Incognito changes what Aman keeps, not what it sends. The banner says so.

## 2. What it cannot guarantee

- **The model provider sees the chat.** A hosted model receives every message and may log it under its own policy. A local Ollama model does not send anything.
- **Search and connector providers see what they are sent.** The query, the URL, the mail you asked for.
- **Actions taken are real.** A mail sent, a file written outside the sandbox, a calendar event created: all stay done.
- **Someone at your screen can read it while it is open.** Incognito is about memory, not about hiding the screen.

## 3. UX

**Starting one.** The New Chat button in the sidebar rail, the drawer, and the thread list gains a small menu: "New chat" and "New incognito chat". The keyboard shortcut is `Ctrl/Cmd+Shift+X` (the browser owns `Ctrl+Shift+N`, so a page cannot use it). Picking it opens a short start card: one line on what is and is not guaranteed, the "Use what Aman knows about me" switch, and "Start". The persona and model pickers work as usual.

**The visual mode.** A banner sits directly under the chat header, above the messages, for the whole life of the chat. Left: the `venetian-mask` icon and "Incognito chat". Middle: "Not remembered. Deleted when you leave. Searches and connectors still send data." Right: "End chat". The composer border and the send button use the same accent. The header title reads "Incognito chat" and is never auto-generated. Styling uses new theme tokens only, defined for both the light and dark blocks in `styles.css` next to the approval banner tokens: `--incognito-banner-bg`, `--incognito-banner-fg`, `--incognito-banner-border`, `--incognito-banner-accent`. Light: a muted slate on the warm paper; dark: a deeper slate with the same accent. Lengths in `rem`: banner min height `2.75rem`, padding `0.5rem 1rem`, border `0.0625rem`, radius `var(--radius)`.

**Ending.** "End chat" asks once: "Delete this incognito chat now? Nothing was saved to memory." Confirm shows an end card in place of the thread: the icon, "Incognito chat ended. Nothing was kept.", and two buttons, "New incognito chat" and "New chat". Switching to another chat or closing the tab ends it without the card; the server-side deletion is the same.

**Converting to a normal chat.** Recommendation: no. A one-way mode is easy to explain and easy to trust. Conversion would need to replay retain and learning for turns that were never meant to be kept, and the model provider already has them anyway. Instead the banner menu offers "Copy chat as text", done entirely in the browser.

**Phone layout.** In the drawer layout the banner collapses to one line: icon, "Incognito", and "End" on the right; the explanation moves into a tap-to-expand line. It stays pinned under the header while the thread scrolls. The 1rem side gutter is kept, nothing scrolls sideways, and the end card fills the thread area.

## 4. Server enforcement

Each guarantee is enforced on the server from `session.incognito`. Paths are under `packages/`.

**The flag on the wire.** `CreateSessionRequestSchema` in `trueforge/src/schemas/session.ts` gains `incognito: z.boolean().default(false)`, and `SessionSchema` in `trueforge-core/src/agent-session/schemas/session.ts` returns `incognito`. `UpdateSessionRequestSchema` does not accept it: the flag is set at birth and never changes. A new `memory_reads: z.boolean().default(true)` field on the create request carries the start-card switch; it is only honored when `incognito` is true. The frontend sends both from `createSession` in `trueforge-ui/src/plugins/trueforge-agent-server-adapter/chatServer.ts`. A session metadata key is deliberately not used: metadata is a client-editable map and can be changed by `PUT`.

**Store and migration.** A new column `incognito BOOLEAN NOT NULL DEFAULT false` and `memory_reads BOOLEAN NOT NULL DEFAULT true` on `session`, added by one migration file with the same name in `trueforge/src/db/postgres/migrations/` and `trueforge/src/db/sqlite/migrations/`, following `20260904_000002_session_source.ts` (nullable-free `ADD COLUMN`, no rebuild), with a partial index on `incognito = true` for the sweeps. `SessionRecord`, `CreateSessionInput`, and `ListSessionsInput` in `trueforge-core/src/agent-session/store/ISessionStore.ts` carry the fields; `mapRowToSessionRecord`, `createSession`, and `listSessions` in both `queries/sessions.ts` files, `InMemorySessionStore`, and `storeContractSuite.ts` change together, per the store `AGENTS.md`. `listSessions` never returns incognito rows unless the caller passes `incognito: true`, which only the sweeps do. `updateSession` rejects any change to the two columns.

**Memory retain and profile learning skip.** In the create-turn handler of `createTurnsRouter` in `trueforge/src/apis/turns.ts`, when the session is incognito: `memoryClient` for the drain is `undefined`, `profileLearning` is `undefined`, and `memorySummarize` is `undefined`. That leaves `runTurnEventDrain` with nothing to call, so `submitRetainWithVerification` in `trueforge/src/runtime/memory/memoryRetain.ts` and `submitProfileLearning` in `trueforge/src/runtime/profileLearning.ts` never run for the turn, and `mirrorLearnedProfile` cannot run either. The same gate is applied in `beginTurnExecution` and `startTurnInProcess`, which must refuse an incognito session with a `409` since those paths serve scheduled runs. `MemoryTurnContext` in `createTurnResolver` is built with `retainEnabled: false`, so `HindsightMemoryProcessor` in `memoryCapability.ts` never seeds or sweeps pending retains and `resolveVanishedPreviousTurn` is a no-op; `recallEnabled` follows `session.memory_reads`. Each guarantee is checked by a server-side assertion in the drain, not by trusting the resolver.

**Memory reads.** With `memory_reads` true the resolver runs recall as today and the `aman.memory.recall` event is written to `session_event`, which cascades on delete. `withMemoryProviderNarrowedToReads` in `MemoryTurnResourceResolver.ts` already limits provider tools to reads. `buildPersonalizationContext` and persona knowledge retrieval are read-only and unchanged.

**History and title.** `listSessionsHandler` in `trueforge/src/apis/sessions.ts` never passes `incognito: true`. `getSession` stays owner-only so the open tab can resume. The title is fixed at create time to "Incognito chat" and `useSyncSessionTitle` skips incognito sessions.

**Deletion.** `deleteSessionHandler` grows an `incognito` cleanup path shared with the sweeps: `deleteSession` (cascades turns, events, persona log, grants), then `deleteArtifactsBySession` (new on `ITurnArtifactStore` in `trueforge/src/db/turnArtifactStore.ts`, removing `turn_artifact` rows and blobs no other row references), then `removeLocalSandboxSession` (new in `trueforge/src/sandbox/local/provider/LocalSandboxProvider.ts`, deleting `<appData>/sandboxes/<sessionId>`), `removeSlotWorkspace` when slots are on, and `destroySandbox` on any provider that implements it. A new `endIncognitoSessionRoute` (`POST /api/v1/sessions/{session_id}/end`) does the same for the "End chat" button and the unload beacon; it is idempotent.

**Sweeps.** `sweepIncognitoSessions` in `trueforge/src/main.ts`, next to `sweepExpiredTurnArtifacts`: at boot it deletes every incognito session; every 5 minutes it deletes those whose `last_activity_timestamp_ms` is older than `INCOGNITO_IDLE_TTL_MS` (default one hour, read through `config.ts`). A turn in flight is cancelled first through the active-turn registry. Redis turn streams expire on their own TTL.

**Approvals and grants.** In `AgentThread.ts`, `can_always_allow` on `ToolApprovalRequiredEvent` is forced to `false` for incognito sessions, and a `USER_TOOL_APPROVAL` with `scope: 'always'` is rejected before `recordToolGrant` is reached, so no `mcp_tool_grant` row is ever written. `scope: 'chat'` works and lives in `session.approval_grants`, which is deleted with the row.

**Schedules and held actions.** `createScheduleRoute` handlers in `trueforge/src/apis/schedules.ts` and `dispatchScheduledRuns` refuse an incognito source. `forUnattendedRun` is never applied to incognito sessions, so `holdApprovalCalls` never holds, and no `approval_token` is minted.

**Audit log.** `SentinelAuditStore.record` writes incognito rows with tool and connector names, outcome, and time only, with no arguments and `incognito = true`; `deleteSessionHandler` leaves the rows in place. Recommendation: keep this short trail so a search or a mail send is still accounted for without keeping what was said.

## 5. Edge cases

- **Approvals** show the normal card without "Always allow". A card left unanswered when the chat ends is dropped with the turn; nothing is retried later.
- **Always-allow made inside incognito** does not persist (above). Recommendation: do not even offer it, rather than offer and discard, so the user is never misled.
- **Export and import.** `exportMemoryVaultRoute` is unaffected because nothing was retained. `createSessionBugReportRoute` answers `409` for an incognito session. The internal `importSessionRoute` rejects a record with `incognito: true`. Any future chat export reuses one guard, `assertSessionExportable`, in `apis/sessions.ts`.
- **Crashes.** The boot sweep and the idle sweep clean rows, artifacts, and sandbox folders. A crash mid-turn leaves no retain, because the drain input never held a memory client.
- **One account per instance.** Aman is single-user, so there is no other user to hide the chat from. Owner checks still apply: `getSession` is owner-only and the list hides incognito rows for everyone. With the login profile off, anyone who reaches the port is the owner, so incognito does not protect an open chat from someone at the machine.
- **Persona in incognito.** Allowed. The persona vault is read, never written; the `session_persona` log cascades on delete.
- **Settings › Memory** gains one line: "Incognito chats are never written here."

## 6. Tests

All tests use synthetic data, never the owner's real memory. Each guarantee has a server test in `packages/trueforge/tests/` and the UI parts a test in `packages/trueforge-ui/test/`.

- **Retain skipped.** Create an incognito session, run a turn with a memorable fact, assert the Markdown vault has no new entry and `retainOperationId` was never submitted. Repeat with the Hindsight client stubbed. Then a normal session proves retain still runs.
- **Learning skipped.** With `learning_enabled` on, an incognito turn emits no `aman.profile.learned` event and leaves the profile revision unchanged; a normal turn advances it.
- **Reads honored.** With `memory_reads` true a seeded fact appears in `injected_block`; with it false `aman.memory.recall` reports `disabled_by_user`.
- **Hidden from history.** `GET /api/v1/sessions` omits the incognito row; `GET /{id}` returns it to the owner; `PUT` with `incognito` or `memory_reads` is rejected; the title is fixed.
- **Deleted on end.** `POST /{id}/end` removes the session, events, `turn_artifact` rows, orphan blobs, and the local sandbox folder, and a second call is a `204` no-op.
- **Sweeps.** A row older than the idle TTL is deleted by the interval sweep; any incognito row is deleted at boot; a referenced blob survives.
- **No grants.** The approval event carries `can_always_allow: false`; a `scope: 'always'` answer is rejected and `mcp_tool_grant` stays empty; `scope: 'chat'` works and vanishes with the row.
- **No schedules or holds.** Schedule creation and dispatch from an incognito source fail; `holdApprovalCalls` is never reached.
- **Audit shape.** Audit rows for an incognito session hold no arguments.
- **Export guards.** Bug report and ops import refuse incognito sessions.
- **Store contract.** `storeContractSuite` covers the new fields on all three stores, and the migration tests cover both backends.
- **UI.** The menu, the shortcut, the banner in light and dark, the end card, the drawer layout at phone width, and that an incognito thread never appears in the thread list after reload.

## 7. Build plan

Small PRs, each green on its own, in this order:

1. **Schema and store.** Columns, migrations for both backends, `SessionRecord` and DTO fields, list filter, contract suite.
2. **Turn gates.** Drain inputs set to `undefined`, `retainEnabled`, scheduled-path refusal, fixed title, drain assertions and tests.
3. **End route and cleanup.** `endIncognitoSessionRoute`, artifact and sandbox deletion, boot and idle sweeps, config value.
4. **Approvals and audit.** `can_always_allow` off, `scope: 'always'` rejected, audit row shape, export and import guards.
5. **UI.** New-chat menu, shortcut, start card, banner and tokens, end card, history hiding, unload beacon, phone layout.
6. **Docs.** A short page under `docs/` and the Settings › Memory line.

## Privacy

Incognito narrows what Aman keeps: no vault write, no learned-profile write, no history, no files, no grants. It does not narrow what leaves the machine: model, search, and connector traffic is unchanged and the banner says so. Memory and profile are read only when the owner leaves reads on. Audit rows keep only names and times.

## Out of scope

- Converting an incognito chat into a normal one.
- Hiding the screen, locking the app, or an encrypted vault.
- Per-tool network blocking inside incognito (see private-by-architecture).
