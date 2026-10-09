# Spec: Turn-Status Sprites (v1)

**Status:** draft

## Problem

The wait-queue indicator shows a small CSS blob for four stations, but six panda sprite images exist and are not yet used. Two of them, "found memories" and "still writing", have no state to attach to.

## Solution

Replace the CSS-only `StateSprite` visuals with six WebP panda images, one per state, selected from signals that already reach the UI. No new runtime or stream events.

## State model

Six sprite states. `WaitStationId` (4 stations, `waitQueueJourney.ts:12`) is unchanged; the sprite id is a new, wider type.

| Sprite         | Enters when                                                                                                                                                                                                        | Leaves when                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| listening      | `activeStation === 'listening'` (turn running, no parts, no recall yet; `:225-234`)                                                                                                                                | any part or recall lands                          |
| remembering    | the fallback when no station is active (`WaitQueueIndicator.tsx:27-32`): thinking gaps before recall lands, after recall with 0 items, timeout or error, in later gaps after tools, and when memory is unavailable | recall lands, a tool starts, or text starts       |
| found-memories | recall landed with outcome ok and items > 0 (same test as the "Found N memories" tick, `waitQueueJourney.ts:164-168`) and no tool or text part exists yet                                                          | first tool (doing) or text (writing) part appears |
| doing          | `activeStation === 'doing'`: a tool is running or approval is pending (`:225-229`)                                                                                                                                 | tools settle                                      |
| writing        | `activeStation === 'writing'`: a text part is streaming (`:182`) and elapsed < `LONG_WAIT_MS`                                                                                                                      | text settles, or the long-wait threshold passes   |
| still-writing  | `activeStation === 'writing'` and `elapsedMs >= LONG_WAIT_MS` (`waitQueueJourney.ts:24`)                                                                                                                           | text settles                                      |

Signal sources:

- Recall: `listMemoryTurnContext` polled every 2 s while running (`MemoryTurnContextProvider.tsx:12,89,113`), read in `useWaitQueue.ts:95-101` as `WaitQueueMemory`. Landing can lag the event by up to one poll interval, so found-memories is bounded by the 2 s poll and may be brief or skipped; that is expected, and the sprite never claims a recall before it lands.
- Long wait: per-turn clock in `useWaitQueue.ts:47-120`, already exposed as `elapsedMs`/`longWait` (`:134`). The existing note reads "Still writing - Ns so far" in this same condition (`buildLongWaitNote`), so sprite and text agree. A turn that spends 20 s in tools and then starts writing shows still-writing at once; the text says the same.
- `remembering` stays event-sourced only: it is never "active" because no signal says recall is running (`waitQueueJourney.ts:222-224`). Found-memories is the only recall-aware sprite.
- Zero-item, empty, timeout, and error recalls keep the remembering sprite, matching the calm tick policy (`:157-173`).

Implementation shape: `deriveWaitQueue` adds `recallJustLanded: boolean` to `WaitQueueSnapshot`. A pure exported `spriteStateFor({ activeStation, recallJustLanded, longWait })` in `waitQueueJourney.ts` is the canonical owner of the mapping and of the `TurnSpriteId` type. `StateSprite` imports it; the private copy in `WaitQueueIndicator.tsx` is deleted, and `StateSpriteState` (`StateSprite.tsx:6`) is deleted in favor of `TurnSpriteId` (`StateSprite` is not exported from `index.ts`, so no re-export is needed).

New event types are not needed, so no change to trueforge-core, frontend, trueforge, or patches. If a future need adds a recall-started event, its canonical owner is `@truefoundry/assistant-ui-runtime` (`src/server/events.ts`), with all four layers updated together.

## Rendering

- `StateSprite` keeps its contract: root `span` with `data-testid="state-sprite"`, `aria-hidden="true"`, class `aui-state-sprite--<state>`, optional `className`. Body and fx spans become one `<img alt="" draggable={false}>`.
- Size 2rem square (source 128 px, 4x for dense displays), replacing the 1.25rem blob. `.aui-wait-queue__line` has `min-height: 1.25rem` (`styles.css:744-749`), so the row grows to 2rem; the indicator is slightly taller in the thread, and the layout must not shift between states (all sprites share one box).
- Inlined data URIs need `img-src data:` if the hosting app sets a CSP. `alt=""` keeps a failed image invisible.
- Reduced motion: motion comes only from a CSS hop on the root under `prefers-reduced-motion: no-preference` and `:not(.aui-wait-queue--static)`. Otherwise the image is the static frame. The old body, fx, and keyframe CSS (`styles.css:807-1151`, from the sprite comment block to the end of the file) is removed in the same change.
- Assets live in `packages/trueforge-ui/src/assets/turn-status/` (`listening`, `remembering`, `found-memories`, `doing`, `writing`, `still-writing`, `.webp`). The library cannot import from `packages/frontend`, so only the downscaled files ship; the 1600 px originals (about 1.55 MB, currently under `packages/frontend/src/assets/turn-status/`) are not kept as a second copy (one canonical owner, no dead copies).
- Downscale to 128 px max, WebP, each under 15 KB (about 90 KB total, down from about 1.55 MB). A repeatable root script (e.g. `sprites:build`) does the resize so it is not an ad hoc command.
- Bundling: the ui build has no image loader, and fonts are inlined as data URIs because relative URLs break in a host document. Add a `.webp` dataurl loader to `tsup.config.ts`, plus a `*.webp` module declaration. Vite handles the import in tests.
- Provenance: the source WebPs carry an XMP tag (IPTC `DigitalSourceType=trainedAlgorithmicMedia`). The resize script must keep it. Add one line to `packages/trueforge-ui/NOTICE`: "Turn-status panda sprites are AI-generated project artwork, licensed with this package."

## Accessibility

The visible `role="status"` microcopy line stays the accessible signal. Sprites are decorative (`aria-hidden`, empty `alt`). No new copy: found-memories is already announced by the "Found N memories" tick, and still-writing by the existing long-wait announcement. The sprite never changes what is announced.

## Scope

- Six sprites, one pure mapping function, asset pipeline, CSS cleanup, test updates.

## Non-goals

- New stream or runtime events, or a "recall running" state.
- Changing station track, microcopy, ticks, or `LONG_WAIT_MS`.
- Per-persona mascots or user-selectable sprite sets.
- Minimum-dwell timers for found-memories (they would delay real progress).

## Privacy

No user data is involved. Sprites are static bundled images; the mapping reads only existing in-memory turn state (part statuses, recall counts, elapsed time). Nothing new is stored, logged, or sent, and no network fetch is added (images are inlined).

## Testing

All tests use synthetic parts, recall stats, and elapsed values; no real user data.

- `test/atoms/StateSprite.test.tsx` (updated, not deleted): each of the 6 states renders an `img` with `alt=""` under the `--<state>` class and `aria-hidden`; extra className; modifier swap on rerender. The body/fx assertions become image assertions.
- `test/utils/waitQueueJourney.test.ts`: `spriteStateFor` and `recallJustLanded` cases: listening; thinking gap with no recall (remembering); recall items 2 before any part (found-memories); items 0, empty, timeout (remembering); recall then tool (doing); recall then text (writing); writing at 14_999 vs 15_000 ms (writing, still-writing); approval pending keeps doing.
- `test/atoms/WaitQueueIndicator.test.tsx`: transitions remembering -> found-memories -> doing/writing via rerender; writing -> still-writing when `elapsedMs` crosses `LONG_WAIT_MS`; reducedMotion adds `--static` and the sprite stays an image; status line text unchanged per state.
- `WaitQueueIndicator` row-height test: the `.aui-wait-queue__line` sprite box is the same size in all six states.
- Transition test: a recall landing after a first tool or text part exists stays out of found-memories.
- New asset test (reads the files via `fs`): all six files exist, each is WebP, is at most 15 KB, is at most 128 px wide, and contains the `trainedAlgorithmicMedia` XMP tag.
- `AssistantMessageContainer.test.tsx` stays green with the new sprite markup.

## Upstream impact

The wait-queue files (`StateSprite.tsx`, `WaitQueueIndicator.tsx`, `waitQueueJourney.ts`, `useWaitQueue.ts`) are fork-owned (not in `DIVERGENCE.md`). `trueforge-ui` is ESM-only, so the packed CJS/ESM consumer rule applies to core and the SDK, not here. The shared surfaces are `styles.css` (a contiguous block is deleted) and `tsup.config.ts` (one loader line). Keep the diff contained: no edits to upstream-originated components, a single contiguous CSS deletion, and the new images under a new directory. If the styles or tsup edits conflict on a sync, add rows to `DIVERGENCE.md` in the same PR.

## Decisions

- Memories are recalled once, before the first part of a turn, so found-memories shows only before the first tool or text part and never in later gaps.
