import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  VAULT_LOCK_FILE,
  VaultBusyError,
  VaultLockLostError,
  withVaultLock,
  type VaultLockRecord,
  type VaultLockScheduler,
} from '../../../../src/runtime/memory/vaultLock';

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'vault-lock-'));
}

function isLockRecord(value: unknown): value is VaultLockRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'pid') === 'number' &&
    typeof Reflect.get(value, 'acquired_at') === 'string' &&
    typeof Reflect.get(value, 'token') === 'string'
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
    const stale: VaultLockRecord = {
      pid: 1,
      acquired_at: new Date(Date.now() - 120_000).toISOString(),
      token: 'old-holder',
    };
    await writeFile(lockFile, JSON.stringify(stale));
    let ran = false;
    await withVaultLock({ vaultDir, staleAfterMs: 60_000 }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(await exists(lockFile)).toBe(false);
  });

  it('takes over an unreadable lock once the file is older than the stale age', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, 'not json');
    const old = new Date(Date.now() - 120_000);
    await utimes(lockFile, old, old);
    await expect(withVaultLock({ vaultDir, staleAfterMs: 60_000 }, async () => 'ok')).resolves.toBe('ok');
  });

  it('treats an empty or partial lock file with a fresh mtime as held', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    for (const content of ['', '{"pid":12,"acq']) {
      await writeFile(lockFile, content);
      await expect(
        withVaultLock({ vaultDir, waitMs: 100, staleAfterMs: 60_000 }, async () => 'never'),
      ).rejects.toBeInstanceOf(VaultBusyError);
      expect(await readFile(lockFile, 'utf8')).toBe(content);
    }
  });

  it('never has two holders when two waiters race to take over one stale lock', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    const stale: VaultLockRecord = { pid: 1, acquired_at: new Date(Date.now() - 120_000).toISOString(), token: 'dead' };
    await writeFile(lockFile, JSON.stringify(stale));
    let inside = 0;
    let maxInside = 0;
    let finished = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        withVaultLock({ vaultDir, staleAfterMs: 60_000, waitMs: 30_000 }, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise(resolve => setTimeout(resolve, 20));
          inside -= 1;
          finished += 1;
        }),
      ),
    );
    expect(finished).toBe(4);
    expect(maxInside).toBe(1);
    expect(await exists(lockFile)).toBe(false);
  });

  it('takes over past a claim left by a crashed taker, with one holder at a time, and clears the claims', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    const stale: VaultLockRecord = { pid: 1, acquired_at: new Date(Date.now() - 120_000).toISOString(), token: 'dead' };
    await writeFile(lockFile, JSON.stringify(stale));
    // A taker crashed while holding the first-generation claim on the stale lock.
    const crashedClaim = `${lockFile}.takeover-dead-1`;
    await writeFile(crashedClaim, '');
    const old = new Date(Date.now() - 120_000);
    await utimes(crashedClaim, old, old);
    let inside = 0;
    let maxInside = 0;
    let finished = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withVaultLock({ vaultDir, staleAfterMs: 60_000, waitMs: 30_000 }, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise(resolve => setTimeout(resolve, 20));
          inside -= 1;
          finished += 1;
        }),
      ),
    );
    expect(finished).toBe(6);
    expect(maxInside).toBe(1);
    expect(await readdir(path.join(vaultDir, '.memory-state'))).toEqual([]);
  });

  it('waits rather than taking over while a fresh claim on the stale lock is held', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    const stale: VaultLockRecord = { pid: 1, acquired_at: new Date(Date.now() - 120_000).toISOString(), token: 'dead' };
    await writeFile(lockFile, JSON.stringify(stale));
    await writeFile(`${lockFile}.takeover-dead-1`, '');
    await expect(
      withVaultLock({ vaultDir, staleAfterMs: 60_000, waitMs: 100 }, async () => 'never'),
    ).rejects.toBeInstanceOf(VaultBusyError);
    expect(await readFile(lockFile, 'utf8')).toBe(JSON.stringify(stale));
  });

  it('does not delete a lock that another holder took over', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    const newer: VaultLockRecord = { pid: 2, acquired_at: new Date().toISOString(), token: 'new-holder' };
    await withVaultLock({ vaultDir }, async () => {
      await writeFile(lockFile, JSON.stringify(newer));
    });
    expect(await readFile(lockFile, 'utf8')).toBe(JSON.stringify(newer));
  });

  it('leaves no temp or claim files behind', async () => {
    const vaultDir = await makeVault();
    await withVaultLock({ vaultDir }, async () => undefined);
    expect(await readdir(path.join(vaultDir, '.memory-state'))).toEqual([]);
  });

  it('keeps an exact count across real processes', async () => {
    const vaultDir = await makeVault();
    const counter = path.join(vaultDir, 'counter');
    await writeFile(counter, '0');
    const modulePath = path.resolve(__dirname, '../../../../src/runtime/memory/vaultLock.ts');
    const script = `
      import { readFile, writeFile } from 'node:fs/promises';
      const { withVaultLock } = await import(process.argv[1]);
      const [vaultDir, counter, times] = process.argv.slice(2);
      for (let i = 0; i < Number(times); i += 1) {
        await withVaultLock({ vaultDir, waitMs: 120000 }, async () => {
          const value = Number(await readFile(counter, 'utf8'));
          await new Promise(resolve => setTimeout(resolve, 1));
          await writeFile(counter, String(value + 1));
        });
      }
    `;
    const processes = 5;
    const times = 20;
    const exits = await Promise.all(
      Array.from(
        { length: processes },
        () =>
          new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                script,
                modulePath,
                vaultDir,
                counter,
                String(times),
              ],
              { cwd: path.resolve(__dirname, '../../../..'), stdio: ['ignore', 'ignore', 'pipe'] },
            );
            let stderr = '';
            child.stderr.on('data', chunk => {
              stderr += String(chunk);
            });
            child.on('error', reject);
            child.on('close', code => resolve({ code, stderr }));
          }),
      ),
    );
    expect(exits.map(exit => exit.stderr).join('')).toBe('');
    expect(exits.map(exit => exit.code)).toEqual(Array(processes).fill(0));
    expect(await readFile(counter, 'utf8')).toBe(String(processes * times));
  });

  it('gives up with a plain error when a fresh lock is held elsewhere for the whole wait', async () => {
    const vaultDir = await makeVault();
    const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
    await mkdir(path.dirname(lockFile), { recursive: true });
    let clock = 1_000_000;
    const fresh: VaultLockRecord = { pid: 99, acquired_at: new Date(clock).toISOString(), token: 'other-holder' };
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

  describe('renewal and fencing', () => {
    it('keeps a slow holder from being taken over by a waiter with a short stale age', async () => {
      const vaultDir = await makeVault();
      let waiterRan = false;
      const holder = withVaultLock({ vaultDir, staleAfterMs: 200 }, async lock => {
        await new Promise(resolve => setTimeout(resolve, 800));
        await lock.assertHeld();
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      const waiter = withVaultLock({ vaultDir, staleAfterMs: 200, waitMs: 500 }, async () => {
        waiterRan = true;
      });
      await expect(waiter).rejects.toBeInstanceOf(VaultBusyError);
      await holder;
      expect(waiterRan).toBe(false);
    });

    it('renews the record with a fresh time on each tick', async () => {
      const vaultDir = await makeVault();
      const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
      let tickNow: () => Promise<void> = async () => undefined;
      let intervalSeen = 0;
      const schedule: VaultLockScheduler = (tick, intervalMs) => {
        tickNow = tick;
        intervalSeen = intervalMs;
        return () => undefined;
      };
      let clock = 1_000_000;
      await withVaultLock({ vaultDir, staleAfterMs: 60_000, now: () => clock, schedule }, async lock => {
        clock += 40_000;
        await tickNow();
        const record: unknown = JSON.parse(await readFile(lockFile, 'utf8'));
        expect(isLockRecord(record) && Date.parse(record.acquired_at)).toBe(clock);
        await lock.assertHeld();
      });
      expect(intervalSeen).toBe(15_000);
      expect(await readdir(path.join(vaultDir, '.memory-state'))).toEqual([]);
    });

    it('tells a holder whose lock was taken over, and does not overwrite the new holder', async () => {
      const vaultDir = await makeVault();
      const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
      let tickNow: () => Promise<void> = async () => undefined;
      const schedule: VaultLockScheduler = tick => {
        tickNow = tick;
        return () => undefined;
      };
      const newer: VaultLockRecord = { pid: 2, acquired_at: new Date().toISOString(), token: 'new-holder' };
      let caught: unknown;
      await withVaultLock({ vaultDir, schedule }, async lock => {
        await writeFile(lockFile, JSON.stringify(newer));
        await tickNow();
        try {
          await lock.assertHeld();
        } catch (error) {
          caught = error;
        }
      });
      expect(caught).toBeInstanceOf(VaultLockLostError);
      expect(caught instanceof Error && caught.message).toBe(
        'Memory was busy for too long and another writer took over. Nothing more was saved. Try again.',
      );
      expect(await readFile(lockFile, 'utf8')).toBe(JSON.stringify(newer));
    });

    it('notices a takeover on assertHeld even before a renewal tick runs', async () => {
      const vaultDir = await makeVault();
      const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
      await withVaultLock({ vaultDir, schedule: () => () => undefined }, async lock => {
        await lock.assertHeld();
        await writeFile(lockFile, JSON.stringify({ pid: 2, acquired_at: new Date().toISOString(), token: 'x' }));
        await expect(lock.assertHeld()).rejects.toBeInstanceOf(VaultLockLostError);
      });
    });

    it('keeps a renewal failure from crashing and reports it through assertHeld', async () => {
      const vaultDir = await makeVault();
      const lockFile = path.join(vaultDir, VAULT_LOCK_FILE);
      let tickNow: () => Promise<void> = async () => undefined;
      const schedule: VaultLockScheduler = tick => {
        tickNow = tick;
        return () => undefined;
      };
      let caught: unknown;
      await withVaultLock({ vaultDir, schedule }, async lock => {
        const record: unknown = JSON.parse(await readFile(lockFile, 'utf8'));
        if (!isLockRecord(record)) {
          throw new Error('no record');
        }
        // A folder where the renewal's temp record goes makes the renewal fail.
        await mkdir(`${lockFile}.${record.token}.renew`);
        await tickNow();
        try {
          await lock.assertHeld();
        } catch (error) {
          caught = error;
        }
      });
      expect(caught).toBeInstanceOf(VaultLockLostError);
      expect(caught instanceof Error && caught.cause).toBeDefined();
    });

    it('stops its timer and leaves nothing running after it returns', async () => {
      const vaultDir = await makeVault();
      let stopped = 0;
      const schedule: VaultLockScheduler = () => () => {
        stopped += 1;
      };
      await withVaultLock({ vaultDir, schedule }, async () => undefined);
      await expect(
        withVaultLock({ vaultDir, schedule }, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(stopped).toBe(2);
      const spy = jest.spyOn(global, 'clearInterval');
      await withVaultLock({ vaultDir }, async () => undefined);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });
});
