import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { TextContactStore } from '../../../../src/db/textContactStore';
import { claimTestCall } from '../../../../src/runtime/calls/testCallClaim';

const OWNER = { tenant_id: 'default', created_by: 'alice' };
const AT = new Date('2026-11-06T10:00:00.000Z');
const minutes = (n: number) => new Date(AT.getTime() + n * 60_000);

async function store() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return new TextContactStore(db);
}

describe('claiming a test call', () => {
  it('allows one call every 2 minutes, and says how long to wait', async () => {
    const contacts = await store();
    await expect(claimTestCall({ store: contacts, owner: OWNER, at: AT })).resolves.toEqual({ ok: true });
    await expect(claimTestCall({ store: contacts, owner: OWNER, at: minutes(1) })).resolves.toEqual({
      ok: false,
      message: 'That was a test call just now. Wait 1 minute, then try again.',
    });
    await expect(claimTestCall({ store: contacts, owner: OWNER, at: minutes(2) })).resolves.toEqual({ ok: true });
  });

  it('allows 5 calls a day, and says how long until the next', async () => {
    const contacts = await store();
    for (let n = 0; n < 5; n += 1) {
      await expect(claimTestCall({ store: contacts, owner: OWNER, at: minutes(n * 2) })).resolves.toEqual({ ok: true });
    }
    const sixth = await claimTestCall({ store: contacts, owner: OWNER, at: minutes(10) });
    expect(sixth).toEqual({ ok: false, message: expect.stringContaining('That was 5 test calls today.') });
  });

  it('counts a call the day’s cap turned away against neither limit, so the gap it would have started is not there', async () => {
    const contacts = await store();
    for (let n = 0; n < 5; n += 1) {
      await claimTestCall({ store: contacts, owner: OWNER, at: minutes(n * 2) });
    }
    // Turned away by the day's cap half a minute before the day's window ends.
    const refused = await claimTestCall({ store: contacts, owner: OWNER, at: minutes(24 * 60 - 0.5) });
    expect(refused.ok).toBe(false);
    // A minute later the window is new. Had the refused call started a gap, this would wait.
    await expect(claimTestCall({ store: contacts, owner: OWNER, at: minutes(24 * 60 + 0.5) })).resolves.toEqual({
      ok: true,
    });
  });

  it('keeps each person’s test calls apart', async () => {
    const contacts = await store();
    await claimTestCall({ store: contacts, owner: OWNER, at: AT });
    await expect(
      claimTestCall({ store: contacts, owner: { tenant_id: 'default', created_by: 'bob' }, at: minutes(1) }),
    ).resolves.toEqual({ ok: true });
  });
});
