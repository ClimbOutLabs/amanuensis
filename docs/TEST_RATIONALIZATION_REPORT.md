# Test rationalization report

Status: implemented and validated on `codex/test-rationalization`, based on
`edcdc889`.

This report is the required review point before changing tests. It inventories the
suite, separates protected deterministic coverage from duplication, and limits the
first implementation to changes with an explicit retained boundary.

## Baseline

`pnpm verify` runs 1,985 tests across 261 files. The repository also contains 608
generated SDK unit tests across 47 files that are not invoked by the root `test`
script. Counting both populations gives 2,593 tests across 308 files before the
optional backend matrices.

| Package or matrix            | Type                             |            Tests |       Files |           Measured runner time | Protected behavior / overlap                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------- | ---------------: | ----------: | -----------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trueforge-core`             | Jest unit and contract           |              488 |          54 |                          9.8 s | Agent state machines, model wire protocol, tool reliability, approvals, compaction, command classification, sandbox identity. Keep.                                                                                                     |
| `trueforge-ui`               | Vitest component and integration |              894 |         137 |                         61.9 s | 296 atom, 214 container, 153 public-export, 46 adapter, 42 server-context, 36 theme, 34 routing, and 73 other tests. This is the main rationalization target.                                                                           |
| `trueforge`                  | Jest API and service unit        |              395 |          46 |                         32.2 s | Authentication, authorization, tenant boundaries, approval flow, route contracts, model/provider validation, runtime resources. Keep.                                                                                                   |
| generated SDK wire           | Vitest wire contract             |              186 |          19 |                          5.9 s | Generated client request/response shapes. Keep and regenerate, never hand-edit.                                                                                                                                                         |
| bundled frontend             | Node test runner                 |               22 |           5 |                          0.7 s | Browser authentication and Aman-specific persona/personalization adapters. Keep.                                                                                                                                                        |
| generated SDK unit           | Vitest generated unit            |              608 |          47 |                         11.9 s | Generator runtime, schemas, fetch, retry, redaction, signals. Outside `pnpm verify`; owned by the generator. Keep.                                                                                                                      |
| SQLite store matrix          | Jest backend contract            |              128 |           9 |                         17.1 s | Persistence and data integrity. Keep.                                                                                                                                                                                                   |
| in-memory event subscription | Jest backend contract            |                5 |           1 |                          0.3 s | Event ordering and delivery. Keep.                                                                                                                                                                                                      |
| local sandbox contract       | Jest backend contract            |                8 |           2 | not valid on this Windows host | Execution/filesystem contract. Keep. The suite currently fails before assertions because Windows cannot satisfy its POSIX mode check and its unsupported-platform skip calls an unavailable `pending` helper. This predates this audit. |
| Postgres / Redis matrices    | Jest backend contracts           | shared contracts | 10 wrappers |       not run; services absent | Persistence and cross-replica behavior. Keep. Duplication across backends is intentional contract reuse.                                                                                                                                |

The dominant CI costs are per-file JSDOM startup, repeated package builds, and
SQLite migration setup, not assertion count alone. A professional reduction must
therefore remove redundant files or consolidate equivalent assertions without
weakening safety coverage.

## Classification

### KEEP

The following areas are not candidates for journey substitution:

- All PermissionGate, tool approval, audit/provenance, authorization, tenant and
  cross-session isolation tests.
- All session/store contract suites and every SQLite/Postgres/Redis implementation
  wrapper.
- Agent-loop state machines, cancellation, replay/idempotency, failure recovery,
  context/compaction, command classification, destructive-action, and sandbox
  execution tests.
- Model-provider request/stream/tool/reasoning parsers and generated SDK wire tests.
- Routing parsers, schema validators, error parsers, accessibility behavior, and
  reusable UI primitives whose public contract is not exercised at a stronger
  boundary.
- `packages/trueforge-ui/test/containers/TrueForgeUI.test.tsx`,
  `ThreadContainer.test.tsx`, `ToolCallContainer.test.tsx`,
  `ComposerContainer.test.tsx`, and routing integration suites. These are the
  closest existing tests to user journeys and are replacement coverage, not bloat.

### MERGE now

| File                                                      | Before | After | Why coverage is unchanged                                                                                                                              |
| --------------------------------------------------------- | -----: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/trueforge-ui/test/publicUiExports.test.ts`      |    153 |     1 | The exact sorted export-key assertion already proves membership. Fold the defined-value loop into the same test instead of reporting one case per key. |
| `packages/trueforge-ui/test/theme/ThemeProvider.test.tsx` |     17 |     9 | Keep every token and welcome-treatment assertion, but execute the six palette cases and four visual-treatment cases as two explicit matrices.          |

### REPLACE WITH RETAINED JOURNEY now

None. A source-level review after the inventory found that the four apparent atom
duplicates also protect public composition contracts that their container tests do
not expose:

- `MessageErrorBanner.test.tsx` protects host class composition and its clamped
  message wrapper.
- `HistoryLoader.test.tsx` protects its forwarded ref, host class, live-region
  semantics, and slot marker.
- `Skeletons.test.tsx` protects host class composition and placeholder structure.
- `ToolGroupCard.test.tsx` protects its controlled callback and active progress
  state independently of assistant-message orchestration.

They remain `KEEP`. Removing them would trade away deterministic public-component
coverage rather than replace it with a stronger journey.

### DELETE without replacement

None. No test is being deleted solely to lower a number.

### DEFER until a real browser journey exists

Simple atom tests that assert classes or markup are tempting deletion candidates,
but many also protect focus, keyboard, ARIA, callback, and public-package behavior.
Do not remove them until an actual browser journey covers the same interaction.
Priority future journeys are:

1. Start a chat, send a message, observe streaming, cancel, and recover after a
   refresh.
2. Approve, approve for this chat, deny with a reason, and verify the visible
   terminal receipt.
3. Open sessions on desktop and mobile, change settings/theme, and return to the
   active chat without obstruction or focus loss.

Those should extend the existing harness rather than introduce a second test
framework. Only after they are stable should individual primitive/presentation
files be reconsidered.

## Implemented result

- Root verification: 1,985 to 1,825 tests, a reduction of 160 (8.1%).
- Root test files: unchanged at 261.
- Whole checked-in Vitest/Jest/Node population, including generated SDK unit tests:
  2,593 to 2,433.
- The full UI runner improved from 61.93 seconds to 58.81 seconds in these local
  runs, a 5.0% reduction. The complete gate was not benchmarked under controlled
  cache conditions, so no full-CI speedup is claimed. The main benefit is lower
  reporting noise while retaining the same assertions.

## Risks and controls

- The four reviewed atoms remain because their public composition contracts are not
  fully exercised through containers.
- Consolidated matrices report one enclosing test rather than one test per data
  row. Assertions retain the row's input in failure messages.
- If UI coverage thresholds fall, a removed suite is restored rather than lowering
  the threshold.
- No safety, persistence, authorization, migration, cancellation, replay, or
  destructive-action test is changed.

## Validation

- Focused Vitest: `publicUiExports.test.ts` passed 1/1 and
  `ThemeProvider.test.tsx` passed 9/9.
- Full UI Vitest: 137/137 files and 734/734 tests passed in 58.81 seconds. Existing
  React `act(...)` warnings remain in unrelated tests.
- Authoritative `pnpm verify`: passed private-data scanning, formatting, ESLint,
  every TypeScript typecheck, all production builds, and all five root test
  populations. The resulting root total is 1,825 passing or explicitly skipped
  tests under the package runners.
- Optional baseline matrices were inventoried before the change: SQLite 128 tests
  passed and in-memory event subscription 5 tests passed. The optional local
  sandbox contract remains in its pre-existing Windows-incompatible state and is
  outside `pnpm verify`; this UI-only change does not alter it.
- `git diff --check` passed.
