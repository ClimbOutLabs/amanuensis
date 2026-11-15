/**
 * A terminal key signing a request: the last-used write is bookkeeping, so its
 * failure must never fail the request itself. Nora and her terminal Pippa are made up.
 */
import { Writable } from 'node:stream';
import { createLogger, format, transports } from 'winston';
import { hashTerminalKey, mintTerminalKey, terminalKeyRequestContext } from '../../../src/auth/terminalKey';
import type { ITerminalKeyStore, TerminalKeyRecord } from '../../../src/db/terminalKeyStore';

const KEY = mintTerminalKey();
const RECORD: TerminalKeyRecord = {
  id: 'pippa-key',
  tenant_id: 'default',
  subject_id: 'nora',
  subject_type: 'user',
  subject_display_name: 'Nora',
  device_name: 'Pippa',
  key_hash: hashTerminalKey(KEY),
  created_at: '2026-11-15T10:00:00.000Z',
  last_used_at: '2026-11-15T10:00:00.000Z',
  revoked_at: null,
};

/** A store holding the one live key, whose last-used write always fails. */
function storeWithFailingMarkUsed(): ITerminalKeyStore {
  return {
    create: async () => {},
    findByKeyHash: async key_hash => (key_hash === RECORD.key_hash ? RECORD : undefined),
    listForOwner: async () => [RECORD],
    markUsed: async () => {
      throw new Error('the database is read only just now');
    },
    revoke: async () => false,
    revokeAllForOwner: async () => 0,
  };
}

/** A logger writing its lines to memory, so a test can read what was logged. */
function memoryLogger(): { logger: ReturnType<typeof createLogger>; lines: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({
    format: format.json(),
    transports: [new transports.Stream({ stream })],
  });
  return { logger, lines: () => chunks.join('') };
}

describe('terminal key request context', () => {
  it('still signs the request in when the last-used write fails', async () => {
    const context = await terminalKeyRequestContext({ store: storeWithFailingMarkUsed(), bearerToken: KEY });
    expect(context?.terminal_key_id).toBe('pippa-key');
    expect(context?.subject.id).toBe('nora');
  });

  it('logs the failed write with the key id and no key material', async () => {
    const { logger, lines } = memoryLogger();
    const context = await terminalKeyRequestContext({ store: storeWithFailingMarkUsed(), bearerToken: KEY, logger });
    expect(context?.terminal_key_id).toBe('pippa-key');
    // Winston's stream writes on a later tick; let it flush before reading the lines.
    await new Promise(resolve => setImmediate(resolve));
    const logged = lines();
    expect(logged).toContain('pippa-key');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(RECORD.key_hash);
  });
});
