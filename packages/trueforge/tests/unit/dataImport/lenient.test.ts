import { z } from 'zod';

import {
  countingLeftOut,
  internal,
  mixedList,
  noteLeftOut,
  readInternal,
  readVisible,
} from '../../../src/dataImport/lenient';

const label = 'detail';
const StatsSchema = z.object({
  items: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

/** Everything the reader left out, as one total across labels. */
function total(leftOut: ReadonlyMap<string, number>): number {
  return [...leftOut.values()].reduce((sum, count) => sum + count, 0);
}

describe('readInternal', () => {
  it('keeps a value that fits, and reports nothing', () => {
    const { result, leftOut } = countingLeftOut(() => readInternal(StatsSchema, { items: 2 }, { label }));
    expect(result).toEqual({ items: 2 });
    expect(total(leftOut)).toBe(0);
  });

  it('reads a value written before a required field was added, by giving that field a neutral value', () => {
    // Fields a later version adds: an archive from today does not carry them.
    const LaterSchema = z.object({ ...StatsSchema.shape, added_later: z.string(), retries: z.number() });
    const { result, leftOut } = countingLeftOut(() => readInternal(LaterSchema, { items: 2 }, { label }));
    expect(result).toEqual({ items: 2, added_later: '', retries: 0 });
    // One garbled value, however many of its fields were filled in.
    expect(leftOut).toEqual(new Map([[label, 1]]));
  });

  it('never invents an enum value: a record that needs one is left out, and reported', () => {
    const DecisionSchema = z.object({ id: z.string(), decision: z.enum(['allow', 'deny']) });
    const { result, leftOut } = countingLeftOut(() =>
      readInternal(DecisionSchema, { id: 'd1', decision: 'deny_forever' }, { label }),
    );
    expect(result).toBeUndefined();
    expect(leftOut).toEqual(new Map([[label, 1]]));
  });

  it('keeps every field that still fits and drops the ones that do not', () => {
    const { result } = countingLeftOut(() =>
      readInternal(StatsSchema, { items: -1, reason: 7, renamed_field: true }, { label }),
    );
    expect(result).toEqual({ items: 0 });
  });

  it('repairs nested records: one bad list item is left out, and a bad optional object keeps what fits', () => {
    const OuterSchema = z.object({
      items: z.array(z.object({ id: z.string(), status: z.enum(['open', 'done']) })),
      detail: StatsSchema.optional(),
    });
    const { result, leftOut } = countingLeftOut(() =>
      readInternal(
        OuterSchema,
        {
          items: [
            { id: 'a', status: 'open' },
            { id: 'b', status: 'archived-in-a-later-version' },
          ],
          detail: { items: 3, reason: 9 },
        },
        { label },
      ),
    );
    expect(result).toEqual({ items: [{ id: 'a', status: 'open' }], detail: { items: 3 } });
    expect(leftOut).toEqual(new Map([[label, 2]]));
  });
});

describe('every repair is reported', () => {
  const ItemSchema = z.object({ id: z.string(), state: z.enum(['open', 'done']) });
  const RecordSchema = z.object({
    count: z.number(),
    note: z.string().optional(),
    nested: z.object({ flag: z.boolean() }).optional(),
    items: z.array(ItemSchema),
    choice: z.enum(['a', 'b']).optional(),
  });

  it.each([
    ['a required field given a neutral value', { items: [] }, 1],
    ['an optional field that no longer fits, left out', { count: 1, note: 3, items: [] }, 1],
    ['a field inside an optional object, given a neutral value', { count: 1, nested: { flag: 'x' }, items: [] }, 1],
    ['a list item that no longer fits, left out', { count: 1, items: [{ id: 'i', state: 'gone' }] }, 1],
    [
      'each list item that no longer fits, left out',
      {
        count: 1,
        items: [
          { id: 'i', state: 'gone' },
          { id: 'j', state: 'gone' },
          { id: 'k', state: 'open' },
        ],
      },
      2,
    ],
    ['list items repaired inside, once for the value', { count: 1, items: [{ state: 'open' }, { state: 'done' }] }, 1],
    ['an optional enum that no longer fits, left out', { count: 1, items: [], choice: 'z' }, 1],
    ['a value that is not a record at all, rebuilt once', 'not a record', 1],
    [
      'several repairs in one record: once for the value, plus each list item left out',
      { note: 3, items: [{ id: 'i', state: 'gone' }], choice: 'z' },
      2,
    ],
  ])('%s', (_case, value, expected) => {
    const { result, leftOut } = countingLeftOut(() => readInternal(RecordSchema, value, { label }));
    expect(RecordSchema.safeParse(result).success).toBe(true);
    expect(total(leftOut)).toBe(expected);
  });

  it('a record left out whole, and a fallback used, are each reported', () => {
    const NeedsChoice = z.object({ choice: z.enum(['a', 'b']) });
    expect(total(countingLeftOut(() => readInternal(NeedsChoice, { choice: 'z' }, { label })).leftOut)).toBe(1);
    expect(
      total(
        countingLeftOut(() => readInternal(NeedsChoice, { choice: 'z' }, { label, fallback: { choice: 'a' } })).leftOut,
      ),
    ).toBe(1);
  });

  it('a reader that leaves something out on its own reports it too', () => {
    expect(countingLeftOut(() => noteLeftOut({ label })).leftOut).toEqual(new Map([[label, 1]]));
  });
});

describe('readVisible', () => {
  const MessageSchema = z.object({
    text: z.string(),
    tool_info: z.object({ name: z.string(), hint: z.string() }),
  });

  it('repairs only the internal enrichment inside what people see, and reports it', () => {
    const { result, leftOut } = countingLeftOut(() =>
      readVisible(MessageSchema, { text: 'Hello', tool_info: { name: 'search' } }, { label }),
    );
    expect(result.success && result.data).toEqual({ text: 'Hello', tool_info: { name: 'search', hint: '' } });
    expect(total(leftOut)).toBe(1);
  });

  it('drops telemetry that no longer fits instead of making up its values', () => {
    const WithUsage = z.object({
      text: z.string(),
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
    });
    const { result, leftOut } = countingLeftOut(() =>
      readVisible(WithUsage, { text: 'Hello', usage: { input_tokens: 'many' } }, { label }),
    );
    expect(result.success && result.data).toEqual({ text: 'Hello' });
    expect(total(leftOut)).toBe(1);
  });

  it('leaves out an approval card that no longer fits, inside enrichment or not, never filling it with blanks', () => {
    const CardSchema = z.object({ plain_what: z.string(), plain_why: z.string().nullable() });
    const WithCards = z.object({
      text: z.string(),
      tier3_card: CardSchema.optional(),
      tool_info: z.object({ name: z.string(), tier3_card: CardSchema.optional() }).optional(),
    });
    const broken = { plain_what: 7, plain_why: null };
    const visibleCard = countingLeftOut(() => readVisible(WithCards, { text: 'Hello', tier3_card: broken }, { label }));
    expect(visibleCard.result.success && visibleCard.result.data).toEqual({ text: 'Hello' });
    expect(total(visibleCard.leftOut)).toBe(1);
    const enrichedCard = countingLeftOut(() =>
      readVisible(WithCards, { text: 'Hello', tool_info: { name: 'search', tier3_card: broken } }, { label }),
    );
    expect(enrichedCard.result.success && enrichedCard.result.data).toEqual({
      text: 'Hello',
      tool_info: { name: 'search' },
    });
    expect(total(enrichedCard.leftOut)).toBe(1);
  });

  it('refuses a change to what people see', () => {
    expect(readVisible(MessageSchema, { text: 42, tool_info: { name: 'search', hint: 'x' } }, { label }).success).toBe(
      false,
    );
  });
});

describe('mixedList', () => {
  const EventSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('message'), text: z.string() }),
    z.object({ type: z.literal('usage'), tokens: z.number() }),
  ]);
  const Events = mixedList({
    schema: EventSchema,
    isVisible: event => typeof event === 'object' && event !== null && Reflect.get(event, 'type') === 'message',
    label: 'note',
    visibleLabel: 'tool detail',
  });

  it('leaves out an internal record of an unknown type, never recasting it as another type', () => {
    const { result, leftOut } = countingLeftOut(() =>
      Events.parse([{ type: 'message', text: 'Hi' }, { type: 'usage' }, { type: 'from-a-later-version', tokens: 2 }]),
    );
    // A record people may see is never filled in: the usage record without its count is left out too.
    expect(result).toEqual([{ type: 'message', text: 'Hi' }]);
    expect(leftOut).toEqual(new Map([['note', 2]]));
  });

  it('refuses a visible record that no longer fits', () => {
    expect(Events.safeParse([{ type: 'message', text: 3 }]).success).toBe(false);
  });
});

describe('internal', () => {
  it('reads a field the archive leaves out instead of failing on it', () => {
    const RecordSchema = z.object({ id: z.string(), stats: internal(StatsSchema, { label }) });
    const { result, leftOut } = countingLeftOut(() => RecordSchema.parse({ id: 'r1' }));
    expect(result).toEqual({ id: 'r1', stats: { items: 0 } });
    expect(total(leftOut)).toBe(1);
  });

  it('uses the fallback when nothing else fits', () => {
    const StateSchema = z.discriminatedUnion('status', [
      z.object({ status: z.literal('running') }),
      z.object({ status: z.literal('done'), completed_at: z.iso.datetime() }),
    ]);
    const { result } = countingLeftOut(() =>
      internal(StateSchema, { label, fallback: { status: 'running' } }).parse({ status: 'paused-for-a-new-reason' }),
    );
    expect(result).toEqual({ status: 'running' });
  });
});
