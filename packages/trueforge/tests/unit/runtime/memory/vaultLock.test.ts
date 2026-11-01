import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  VAULT_LOCK_FILE,
  VaultBusyError,
  withVaultLock,
  type VaultLockRecord,
} from '../../../../src/runtime/memory/vaultLock';

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'vault-lock-'));
}

function isLockRecord(value: unknown): value is VaultLockRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'pid') === 'number' &&
    typeof Reflect.get(value, 'acquired_at') === 'string'
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

describe('withVaultLock', () => {
  it('holds the lock during the work and removes it after', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    const result = await withVaultLock({ vaultDir, pid: 4242 }, async () => {
      const raw: unknown = JSON.parse(await readFile(lockFile, 'utf8'));
      expect(isLockRecord(raw) && raw.pid === 4242).toBe(true);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await exists(lockFile)).toBe(false);
  });

  it('removes the lock when the work throws, and rethrows', async () => {
    const vaultDir = await makeVault();
    await expect(
      withVaultLock({ vaultDir }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await exists(path.join(vaultDir, VAULT_LOCK_FILE))).toBe(false);
  });

  it('makes a second caller wait for the first', async () => {
    const vaultDir = await makeVault();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = withVaultLock({ vaultDir }, async () => {
      order.push('first start');
      await held;
      order.push('first end');
    });
    while (order.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const second = withVaultLock({ vaultDir }, async () => {
      order.push('second');
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(order).toEqual(['first start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });

  it('serialises many concurrent writers in one process', async () => {
    const vaultDir = await makeVault();
    const counter = path.join(vaultDir, 'counter');
    await writeFile(counter, '0');
    await Promise.all(
      Array.from({ length: 30 }, () =>
        withVaultLock({ vaultDir, waitMs: 120_000 }, async () => {
          const value = Number(await readFile(counter, 'utf8'));
          await new Promise(resolve => setTimeout(resolve, 1));
          await writeFile(counter, String(value + 1));
        }),
      ),
    );
    expect(await readFile(counter, 'utf8')).toBe('30');
  });

  it('takes over a stale lock', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    const stale: VaultLockRecord = { pid: 1, acquired_at: new Date(Date.now() - 120_000).toISOString() };
    await writeFile(lockFile, JSON.stringify(stale));
    let ran = false;
    await withVaultLock({ vaultDir, staleAfterMs: 60_000 }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(await exists(lockFile)).toBe(false);
  });

  it('takes over an unreadable lock', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, 'not json');
    await expect(withVaultLock({ vaultDir }, async () => 'ok')).resolves.toBe('ok');
  });

  it('gives up with a plain error when a fresh lock is held elsewhere for the whole wait', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    let clock = 1_000_000;
    const fresh: VaultLockRecord = { pid: 99, acquired_at: new Date(clock).toISOString() };
    await writeFile(lockFile, JSON.stringify(fresh));
    const slept: number[] = [];
    await expect(
      withVaultLock(
        {
          vaultDir,
          waitMs: 1_000,
          staleAfterMs: 60_000,
          now: () => clock,
          sleep: async ms => {
            slept.push(ms);
            clock += ms;
          },
        },
        async () => 'never',
      ),
    ).rejects.toBeInstanceOf(VaultBusyError);
    expect(slept.length).toBeGreaterThan(1);
    expect(Math.max(...slept)).toBeLessThanOrEqual(250);
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(1_000);
    expect(await readFile(lockFile, 'utf8')).toBe(JSON.stringify(fresh));
  });

  it('creates the state folder when missing', async () => {
    const vaultDir = path.join(await makeVault(), 'fresh');
    await withVaultLock({ vaultDir }, async () => undefined);
    expect(await exists(path.join(vaultDir, '.memory-state'))).toBe(true);
  });
});
