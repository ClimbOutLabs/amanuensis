import { z } from 'zod';

import { countingLeftOut, internal, internalList, readInternal } from '../../../src/dataImport/lenient';

const StatsSchema = z.object({
  items: z.number().int().nonnegative(),
  outcome: z.enum(['ok', 'empty']),
  reason: z.string().optional(),
});

describe('readInternal', () => {
  it('keeps a value that fits, and counts nothing', () => {
    const { result, leftOut } = countingLeftOut(() => readInternal(StatsSchema, { items: 2, outcome: 'empty' }));
    expect(result).toEqual({ items: 2, outcome: 'empty' });
    expect(leftOut).toBe(0);
  });

  it('reads a value written before a required field was added, by giving that field a neutral value', () => {
    // A field a later version adds: an archive from today does not carry it.
    const LaterSchema = z.object({ ...StatsSchema.shape, added_later: z.string(), budget: z.enum(['normal', 'half']) });
    const { result, leftOut } = countingLeftOut(() => readInternal(LaterSchema, { items: 2, outcome: 'ok' }));
    expect(result).toEqual({ items: 2, outcome: 'ok', added_later: '', budget: 'normal' });
    expect(leftOut).toBe(1);
  });

  it('keeps every field that still fits and drops the ones that do not', () => {
    const { result } = countingLeftOut(() =>
      readInternal(StatsSchema, { items: -1, outcome: 'ok', reason: 7, renamed_field: true }),
    );
    expect(result).toEqual({ items: 0, outcome: 'ok' });
  });

  it('never invents a discriminator, so an event of an unknown type is left out', () => {
    const EventSchema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('a'), value: z.number() }),
      z.object({ type: z.literal('b'), label: z.string() }),
    ]);
    const { result, leftOut } = countingLeftOut(() =>
      z
        .array(z.unknown())
        .pipe(internalList(EventSchema))
        .parse([{ type: 'a', value: 1 }, { type: 'b' }, { type: 'from-a-later-version', value: 2 }]),
    );
    expect(result).toEqual([
      { type: 'a', value: 1 },
      { type: 'b', label: '' },
    ]);
    expect(leftOut).toBe(2);
  });
});

describe('internal', () => {
  it('reads a field the archive leaves out instead of failing on it', () => {
    const RecordSchema = z.object({ id: z.string(), stats: internal(StatsSchema) });
    const { result, leftOut } = countingLeftOut(() => RecordSchema.parse({ id: 'r1' }));
    expect(result).toEqual({ id: 'r1', stats: { items: 0, outcome: 'ok' } });
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
