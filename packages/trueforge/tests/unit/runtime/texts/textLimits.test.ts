import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { TextContactStore } from '../../../../src/db/textContactStore';
import {
  claimTextLimits,
  HOUR_MS,
  numberLimitKey,
  textLimitsRoom,
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

  it('keeps a limit already passed spent when a later one refuses, and names the one that refused', async () => {
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
    await expect(contacts.textSendRoom({ ...first, max: 1, now: later })).resolves.toMatchObject({ ok: false });
  });

  it('tells whether every limit has room without counting a send', async () => {
    const contacts = await store();
    const limit = { key: 'k', window_ms: HOUR_MS, max: 1 };
    for (let look = 0; look < 3; look += 1) {
      await expect(textLimitsRoom({ store: contacts, limits: [limit], at: AT })).resolves.toEqual({ ok: true });
    }
    await claimTextLimits({ store: contacts, limits: [limit], at: AT });
    await expect(textLimitsRoom({ store: contacts, limits: [limit], at: AT })).resolves.toEqual({
      ok: false,
      limit,
      retry_in_minutes: 60,
    });
  });

  it('keys a number with the secret, so the count never holds the number', () => {
    const key = numberLimitKey({ secret: 'secret', scope: 'number-day', phone: '+15550111' });
    expect(key).toMatch(/^number-day:[0-9a-f]{64}$/);
    expect(key).not.toContain('5550111');
    expect(numberLimitKey({ secret: 'other', scope: 'number-day', phone: '+15550111' })).not.toBe(key);
  });
});
