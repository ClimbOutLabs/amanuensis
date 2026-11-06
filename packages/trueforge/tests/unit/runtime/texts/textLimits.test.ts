import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { TextContactStore } from '../../../../src/db/textContactStore';
import {
  claimTextLimits,
  codeTextLimits,
  deliveryTextLimits,
  HOUR_MS,
  MAX_TEST_CALLS_PER_DAY,
  testCallLimits,
  testTextLimit,
  waitWords,
} from '../../../../src/runtime/texts/textLimits';

const AT = new Date('2026-11-06T10:00:00.000Z');

async function store() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return new TextContactStore(db);
}

describe('text limits', () => {
  it('says the wait in minutes under two hours, and in hours after that', () => {
    expect(waitWords(1)).toBe('1 minute');
    expect(waitWords(45)).toBe('45 minutes');
    expect(waitWords(119)).toBe('119 minutes');
    expect(waitWords(120)).toBe('about 2 hours');
    expect(waitWords(1261)).toBe('about 21 hours');
  });

  it('counts none of the limits when one refuses, and names the one that refused', async () => {
    const contacts = await store();
    const first = { key: 'first', window_ms: HOUR_MS, max: 5 };
    const full = { key: 'full', window_ms: HOUR_MS, max: 1 };
    await claimTextLimits({ store: contacts, limits: [full], at: AT });
    const later = new Date(AT.getTime() + 15 * 60_000);
    await expect(claimTextLimits({ store: contacts, limits: [first, full], at: later })).resolves.toEqual({
      ok: false,
      limit: full,
      retry_in_minutes: 45,
    });
    // A limit of one still has room, so the refused send counted nothing against the first limit.
    await expect(claimTextLimits({ store: contacts, limits: [{ ...first, max: 1 }], at: later })).resolves.toEqual({
      ok: true,
    });
  });

  it('keeps each family of limits under its own keys, and a number only as a keyed hash', () => {
    const owner = { tenant_id: 'default', created_by: 'alice' };
    const phone = '+15550111';
    const code = codeTextLimits({ secret: 'secret', owner, phone, confirmed_by_owner: false }).map(limit => limit.key);
    const text = deliveryTextLimits({ owner, phone, settings: { number_key: 'secret', max_texts_per_day: 500 } });
    const keys = [...code, text.person.key, text.number.key, text.server.key, testTextLimit(owner).key];
    expect(keys.map(key => key.split(':')[0])).toEqual([
      'code',
      'code',
      'code',
      'code',
      'code',
      'text',
      'text',
      'text',
      'test',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.join(' ')).not.toContain('5550111');
    expect(text.number.key).toMatch(/^text:number-day:[0-9a-f]{64}$/);
    const other = deliveryTextLimits({ owner, phone, settings: { number_key: 'other', max_texts_per_day: 500 } });
    expect(other.number.key).not.toBe(text.number.key);
  });

  it('holds back the person who confirmed a number only by their own code limits', () => {
    const owner = { tenant_id: 'default', created_by: 'alice' };
    const own = codeTextLimits({ secret: 'secret', owner, phone: '+15550111', confirmed_by_owner: true });
    expect(own.map(limit => limit.key.split(':')[1])).toEqual(['person-hour', 'person-day']);
  });

  it('keeps one person’s test calls apart from another’s, with a short gap and a day’s cap', () => {
    const alice = testCallLimits({ tenant_id: 'default', created_by: 'alice' });
    const bob = testCallLimits({ tenant_id: 'default', created_by: 'bob' });
    expect(alice.gap).toMatchObject({ window_ms: 2 * 60_000, max: 1 });
    expect(alice.day).toMatchObject({ window_ms: 24 * HOUR_MS, max: MAX_TEST_CALLS_PER_DAY });
    expect(new Set([alice.gap.key, alice.day.key, bob.gap.key, bob.day.key]).size).toBe(4);
    expect(alice.gap.key.startsWith('test:')).toBe(true);
  });
});
