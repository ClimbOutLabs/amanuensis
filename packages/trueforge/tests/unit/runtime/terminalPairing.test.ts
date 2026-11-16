/**
 * The pairing service on its own, with an in-memory key store: the races and lapses
 * the routes cannot easily stage. Nora owns the instance and Pippa is her terminal.
 * Everyone here is made up.
 */
import type { ITerminalKeyStore, TerminalKeyRecord } from '../../../src/db/terminalKeyStore';
import { TerminalPairingService, type TerminalPairingOwner } from '../../../src/runtime/terminalPairing';

const OWNER: TerminalPairingOwner = {
  tenant_id: 'default',
  subject_id: 'nora',
  subject_type: 'user',
  subject_display_name: 'Nora',
};

/** The key store as a map, with a create that can be slowed to stage a race. */
class MemoryTerminalKeyStore implements ITerminalKeyStore {
  readonly records = new Map<string, TerminalKeyRecord>();
  createDelayMs = 0;

  async create(record: TerminalKeyRecord): Promise<void> {
    if (this.createDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.createDelayMs));
    }
    this.records.set(record.id, { ...record });
  }

  async findByKeyHash(key_hash: string): Promise<TerminalKeyRecord | undefined> {
    return [...this.records.values()].find(record => record.key_hash === key_hash);
  }

  async listForOwner(input: { tenant_id: string; subject_id: string }): Promise<TerminalKeyRecord[]> {
    return [...this.records.values()].filter(
      record => record.tenant_id === input.tenant_id && record.subject_id === input.subject_id,
    );
  }

  async markUsed(): Promise<void> {}

  async revoke(input: { tenant_id: string; subject_id: string; id: string; revoked_at: string }): Promise<boolean> {
    const record = this.records.get(input.id);
    if (
      record === undefined ||
      record.tenant_id !== input.tenant_id ||
      record.subject_id !== input.subject_id ||
      record.revoked_at !== null
    ) {
      return false;
    }
    record.revoked_at = input.revoked_at;
    return true;
  }

  async revokeAllForOwner(input: { tenant_id: string; subject_id: string; revoked_at: string }): Promise<number> {
    let revoked = 0;
    for (const record of this.records.values()) {
      if (
        record.tenant_id === input.tenant_id &&
        record.subject_id === input.subject_id &&
        record.revoked_at === null
      ) {
        record.revoked_at = input.revoked_at;
        revoked += 1;
      }
    }
    return revoked;
  }
}

describe('terminal pairing service', () => {
  it('mints exactly one key when two confirms race', async () => {
    const store = new MemoryTerminalKeyStore();
    store.createDelayMs = 25;
    const service = new TerminalPairingService({ terminalKeyStore: store });
    const started = await service.start({ device_name: 'Pippa' });

    const results = await Promise.all([
      service.confirm({ code: started.code, owner: OWNER }),
      service.confirm({ code: started.code, owner: OWNER }),
    ]);

    expect(results.filter(result => result !== undefined)).toHaveLength(1);
    const rows = await store.listForOwner({ tenant_id: OWNER.tenant_id, subject_id: OWNER.subject_id });
    expect(rows).toHaveLength(1);
  });

  it('drops a pairing after five failed completions, so the code stops naming anything', async () => {
    const store = new MemoryTerminalKeyStore();
    const service = new TerminalPairingService({ terminalKeyStore: store });
    const started = await service.start({ device_name: 'Pippa' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await service.complete({ pairing_id: started.pairing_id, code: 'ZZZZ-ZZZZ' })).toBeUndefined();
    }

    // The pairing is gone: the right code now names nothing, at completion or at confirm.
    expect(await service.complete({ pairing_id: started.pairing_id, code: started.code })).toBeUndefined();
    expect(await service.confirm({ code: started.code, owner: OWNER })).toBeUndefined();
  });

  it('keeps a pairing alive through four failed completions', async () => {
    const store = new MemoryTerminalKeyStore();
    const service = new TerminalPairingService({ terminalKeyStore: store });
    const started = await service.start({ device_name: 'Pippa' });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.complete({ pairing_id: started.pairing_id, code: 'ZZZZ-ZZZZ' })).toBeUndefined();
    }

    expect(await service.complete({ pairing_id: started.pairing_id, code: started.code })).toEqual({
      status: 'waiting',
    });
    const confirmed = await service.confirm({ code: started.code, owner: OWNER });
    expect(confirmed?.device_name).toBe('Pippa');
    const completion = await service.complete({ pairing_id: started.pairing_id, code: started.code });
    expect(completion?.status).toBe('paired');
  });

  it('revokes the stored key when a confirmed pairing lapses unclaimed', async () => {
    let nowMs = Date.parse('2026-11-15T10:00:00.000Z');
    const store = new MemoryTerminalKeyStore();
    const service = new TerminalPairingService({ terminalKeyStore: store, now: () => nowMs });
    const started = await service.start({ device_name: 'Pippa' });
    await service.confirm({ code: started.code, owner: OWNER });

    nowMs += 6 * 60_000;
    // The terminal polls after the pairing has lapsed: nothing to claim any more.
    expect(await service.complete({ pairing_id: started.pairing_id, code: started.code })).toBeUndefined();

    const rows = await store.listForOwner({ tenant_id: OWNER.tenant_id, subject_id: OWNER.subject_id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it('revokes the stored key of a lapsed pairing when a later start prunes it', async () => {
    let nowMs = Date.parse('2026-11-15T10:00:00.000Z');
    const store = new MemoryTerminalKeyStore();
    const service = new TerminalPairingService({ terminalKeyStore: store, now: () => nowMs });
    const started = await service.start({ device_name: 'Pippa' });
    await service.confirm({ code: started.code, owner: OWNER });

    nowMs += 6 * 60_000;
    await service.start({ device_name: 'Pippa Two' });

    const rows = await store.listForOwner({ tenant_id: OWNER.tenant_id, subject_id: OWNER.subject_id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it('keeps the stored key live when the terminal claims it in time', async () => {
    const store = new MemoryTerminalKeyStore();
    const service = new TerminalPairingService({ terminalKeyStore: store });
    const started = await service.start({ device_name: 'Pippa' });
    await service.confirm({ code: started.code, owner: OWNER });

    const completion = await service.complete({ pairing_id: started.pairing_id, code: started.code });
    expect(completion?.status).toBe('paired');

    const rows = await store.listForOwner({ tenant_id: OWNER.tenant_id, subject_id: OWNER.subject_id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it('names the waiting terminal at lookup while the pairing is still pending', async () => {
    const store = new MemoryTerminalKeyStore();
    const service = new TerminalPairingService({ terminalKeyStore: store });
    const started = await service.start({ device_name: 'Pippa' });

    await expect(service.lookup({ code: started.code })).resolves.toEqual({ device_name: 'Pippa' });
    // A lookup only reads: the pairing still confirms afterwards.
    const confirmed = await service.confirm({ code: started.code, owner: OWNER });
    expect(confirmed?.device_name).toBe('Pippa');
  });

  it('names nothing at lookup for an unknown, a used or an expired code', async () => {
    let nowMs = Date.parse('2026-11-15T10:00:00.000Z');
    const store = new MemoryTerminalKeyStore();
    const service = new TerminalPairingService({ terminalKeyStore: store, now: () => nowMs });
    const started = await service.start({ device_name: 'Pippa' });

    await expect(service.lookup({ code: 'ZZZZ-ZZZZ' })).resolves.toBeUndefined();

    await service.confirm({ code: started.code, owner: OWNER });
    // The code is used now: a lookup must not name the terminal any more.
    await expect(service.lookup({ code: started.code })).resolves.toBeUndefined();

    const second = await service.start({ device_name: 'Pippa Two' });
    nowMs += 6 * 60_000;
    await expect(service.lookup({ code: second.code })).resolves.toBeUndefined();
  });
});
