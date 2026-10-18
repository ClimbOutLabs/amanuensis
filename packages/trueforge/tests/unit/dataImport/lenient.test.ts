import { z } from 'zod';

import { countingLeftOut, internal, mixedList, readInternal, readVisible } from '../../../src/dataImport/lenient';

const StatsSchema = z.object({
  items: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

describe('readInternal', () => {
  it('keeps a value that fits, and counts nothing', () => {
    const { result, leftOut } = countingLeftOut(() => readInternal(StatsSchema, { items: 2 }));
    expect(result).toEqual({ items: 2 });
    expect(leftOut).toBe(0);
  });

  it('reads a value written before a required field was added, by giving that field a neutral value', () => {
    // A field a later version adds: an archive from today does not carry it.
    const LaterSchema = z.object({ ...StatsSchema.shape, added_later: z.string(), retries: z.number() });
    const { result, leftOut } = countingLeftOut(() => readInternal(LaterSchema, { items: 2 }));
    expect(result).toEqual({ items: 2, added_later: '', retries: 0 });
    expect(leftOut).toBe(2);
  });

  it('never invents an enum value: a record that needs one is left out, and counted', () => {
    const DecisionSchema = z.object({ id: z.string(), decision: z.enum(['allow', 'deny']) });
    const { result, leftOut } = countingLeftOut(() =>
      readInternal(DecisionSchema, { id: 'd1', decision: 'deny_forever' }),
    );
    expect(result).toBeUndefined();
    expect(leftOut).toBe(1);
  });

  it('keeps every field that still fits and drops the ones that do not', () => {
    const { result } = countingLeftOut(() => readInternal(StatsSchema, { items: -1, reason: 7, renamed_field: true }));
    expect(result).toEqual({ items: 0 });
  });

  it('repairs nested records: one bad list item is left out, and a bad optional object keeps what fits', () => {
    const OuterSchema = z.object({
      items: z.array(z.object({ id: z.string(), status: z.enum(['open', 'done']) })),
      detail: StatsSchema.optional(),
    });
    const { result, leftOut } = countingLeftOut(() =>
      readInternal(OuterSchema, {
        items: [
          { id: 'a', status: 'open' },
          { id: 'b', status: 'archived-in-a-later-version' },
        ],
        detail: { items: 3, reason: 9 },
      }),
    );
    expect(result).toEqual({ items: [{ id: 'a', status: 'open' }], detail: { items: 3 } });
    expect(leftOut).toBe(2);
  });
});

describe('readVisible', () => {
  const MessageSchema = z.object({
    text: z.string(),
    tool_info: z.object({ name: z.string(), hint: z.string() }),
  });

  it('repairs only the internal enrichment inside what people see', () => {
    const parsed = readVisible(MessageSchema, { text: 'Hello', tool_info: { name: 'search' } });
    expect(parsed.success && parsed.data).toEqual({ text: 'Hello', tool_info: { name: 'search', hint: '' } });
  });

  it('refuses a change to what people see', () => {
    expect(readVisible(MessageSchema, { text: 42, tool_info: { name: 'search', hint: 'x' } }).success).toBe(false);
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
  });

  it('leaves out an internal record of an unknown type, never recasting it as another type', () => {
    const { result, leftOut } = countingLeftOut(() =>
      Events.parse([{ type: 'message', text: 'Hi' }, { type: 'usage' }, { type: 'from-a-later-version', tokens: 2 }]),
    );
    expect(result).toEqual([
      { type: 'message', text: 'Hi' },
      { type: 'usage', tokens: 0 },
    ]);
    expect(leftOut).toBe(2);
  });

  it('refuses a visible record that no longer fits', () => {
    expect(Events.safeParse([{ type: 'message', text: 3 }]).success).toBe(false);
  });
});

describe('internal', () => {
  it('reads a field the archive leaves out instead of failing on it', () => {
    const RecordSchema = z.object({ id: z.string(), stats: internal(StatsSchema) });
    const { result, leftOut } = countingLeftOut(() => RecordSchema.parse({ id: 'r1' }));
    expect(result).toEqual({ id: 'r1', stats: { items: 0 } });
    expect(leftOut).toBe(1);
  });

  it('uses the fallback when nothing else fits', () => {
    const StateSchema = z.discriminatedUnion('status', [
      z.object({ status: z.literal('running') }),
      z.object({ status: z.literal('done'), completed_at: z.iso.datetime() }),
    ]);
    const { result } = countingLeftOut(() =>
      internal(StateSchema, { status: 'running' }).parse({ status: 'paused-for-a-new-reason' }),
    );
    expect(result).toEqual({ status: 'running' });
  });
});
