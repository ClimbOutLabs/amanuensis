# Spec: Turn-Status Sprites (v1)

**Status:** implemented

## Problem

The wait-queue indicator showed a small CSS blob for four stations. Six turn states exist, but the visuals did not tell them apart, so the indicator could not show found memories or still writing.

## Solution

Show a panda per turn state, drawn in code as an inline SVG and selected by the pure `spriteStateFor` mapping. Fills come from theme tokens; motion is CSS only. No new runtime or stream events.

## State model

Six sprite states. `WaitStationId` (four stations) is unchanged; `TurnSpriteId` is the wider type owned by `waitQueueJourney.ts`.

| Sprite         | Enters when                                                                                                               | Leaves when                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| listening      | `activeStation === 'listening'` (turn running, no parts, no recall yet)                                                   | any part or recall lands                        |
| remembering    | no station is active: thinking gaps before recall lands, after recall with 0 items, timeout, error, or memory unavailable | recall lands, a tool starts, or text starts     |
| found-memories | recall landed with outcome ok and items > 0, and no tool or text part exists yet                                          | first tool (doing) or text (writing) part       |
| doing          | `activeStation === 'doing'`: a tool is running or approval is pending                                                     | tools settle                                    |
| writing        | `activeStation === 'writing'`: a text part is streaming and elapsed < `LONG_WAIT_MS`                                      | text settles, or the long-wait threshold passes |
| still-writing  | `activeStation === 'writing'` and `elapsedMs >= LONG_WAIT_MS`                                                             | text settles                                    |

Signal sources are the existing ones: recall is polled every 2 s while a turn runs, so found-memories may be brief or skipped; the sprite never claims a recall before it lands. Long wait uses the per-turn clock already behind the "Still writing" note, so sprite and text agree.

## Design Decisions

- Drawn in code, not raster images. An inline SVG follows the theme, needs no image loader, data URIs, CSP change, or asset pipeline.
- Theme tokens: `--sprite-face`, `--sprite-dark`, `--sprite-accent` are defined on `.aui-theme-root` (light) and `.aui-theme-root.dark`. The dark face is muted cream, not white, so it does not glow.
- One 2rem box for all six states, so the row never shifts. Per-state accents (sparkle for found-memories, pencil for writing and still-writing) are SVG groups shown by the state class.
- Motion runs only under `@media (prefers-reduced-motion: no-preference)` and `.aui-wait-queue:not(.aui-wait-queue--static)`. Otherwise the panda holds a static pose; the remembering pupils look up as a fixed offset.
- `spriteStateFor({ activeStation, recallJustLanded, longWait })` in `waitQueueJourney.ts` is the one owner of the mapping and of `TurnSpriteId`.
- The sprite is decorative (`aria-hidden`). The `role="status"` microcopy line remains the accessible signal.

## Rendering

- `StateSprite` keeps its contract: root `span` with `data-testid="state-sprite"`, `aria-hidden="true"`, class `aui-state-sprite--<state>`, optional `className`. The body is one `svg` (viewBox `0 0 64 64`).
- Motion per state: head tilt and ear perk (listening), head sway (remembering), sparkle pop (found-memories), paw tap (doing), pencil bob (writing, still-writing), eye blink (still-writing).

## Scope

- Six states, the pure mapping, the inline SVG panda, theme tokens, and CSS animation.
- Removal of the earlier raster sprites, their build script and loader, and their NOTICE line.

## Non-goals

- New stream or runtime events, or a "recall running" state.
- Changing the station track, microcopy, ticks, or `LONG_WAIT_MS`.
- Per-persona mascots or user-selectable sprite sets.
- Minimum-dwell timers for found-memories.

## Privacy

No user data is involved. The panda is a static inline SVG in the bundle. The mapping reads only existing in-memory turn state. Nothing new is stored, logged, or sent, and no network fetch is added.

## Testing

All tests use synthetic parts, recall stats, and elapsed values.

- `test/atoms/StateSprite.test.tsx`: each of the six states renders one SVG under the state class with `data-testid="state-sprite"` and no `img`; extra className; modifier swap on rerender; the `.aui-state-sprite` rule is 2rem by 2rem with no per-state size; every sprite animation sits inside the `prefers-reduced-motion: no-preference` block and under `.aui-wait-queue:not(.aui-wait-queue--static)`; state accents show only for their states.
- `test/atoms/WaitQueueIndicator.test.tsx`: reduced motion sets `aui-wait-queue--static` and the sprite stays an SVG; the sprite box is the same in every state.

## Out of Scope

- Stream or runtime events, a recall-running state, minimum-dwell timers, per-persona mascots, and any change to the station track, microcopy, ticks, or `LONG_WAIT_MS`.
