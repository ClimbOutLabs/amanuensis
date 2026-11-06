import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  VaultBusyError,
  VaultLockLostError,
  withVaultLock,
  type VaultLockScheduler,
} from '../../../../src/runtime/memory/vaultLock';

const STALE_MS = 1000;

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'lock-'));
}

/** A clock that moves only when a caller sleeps, so staleness is tested without waiting. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms: number): Promise<void> => {
      time += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** A heartbeat the test drives by hand. */
function manualBeat() {
  const ticks: (() => Promise<void>)[] = [];
  const schedule: VaultLockScheduler = tick => {
    ticks.push(tick);
    return () => undefined;
  };
  return { schedule, beat: async () => Promise.all(ticks.map(tick => tick())) };
}

const stateFiles = async (vaultDir: string): Promise<string[]> =>
  (await readdir(path.join(vaultDir, '.memory-state'))).sort();

/** Small seeded generator so a failing run can be replayed from its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('withVaultLock', () => {
  it('runs the work, returns its result and leaves only a released marker behind', async () => {
    const vaultDir = await makeVault();
    const result = await withVaultLock({ vaultDir }, () => Promise.resolve('done'));
    expect(result).toBe('done');
    expect(await stateFiles(vaultDir)).toHaveLength(1);
    const [marker] = await stateFiles(vaultDir);
    expect(JSON.parse(await readFile(path.join(vaultDir, '.memory-state', marker ?? ''), 'utf8'))).toMatchObject({
      released: true,
    });
  });

  it('releases the lock when the work throws', async () => {
    const vaultDir = await makeVault();
    await expect(withVaultLock({ vaultDir }, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(withVaultLock({ vaultDir, waitMs: 0 }, () => Promise.resolve('again'))).resolves.toBe('again');
  });

  it('records who holds it: token, process, host, start time and number', async () => {
    const vaultDir = await makeVault();
    await withVaultLock({ vaultDir, holder: { pid: 4242, host: 'box-1' } }, async () => {
      const [name] = await stateFiles(vaultDir);
      const record: unknown = JSON.parse(await readFile(path.join(vaultDir, '.memory-state', name ?? ''), 'utf8'));
      expect(record).toMatchObject({ pid: 4242, host: 'box-1', generation: 1, released: false });
      expect(record).toEqual(expect.objectContaining({ token: expect.any(String), started_at: expect.any(String) }));
    });
  });

  it('makes a second caller wait, then gives up with a plain message', async () => {
    const vaultDir = await makeVault();
    const clock = fakeClock();
    const { schedule } = manualBeat();
    await withVaultLock({ vaultDir, schedule, staleAfterMs: STALE_MS, now: clock.now }, async () => {
      const waiting = withVaultLock(
        { vaultDir, waitMs: 200, staleAfterMs: STALE_MS, now: clock.now, sleep: clock.sleep },
        () => Promise.resolve('never'),
      );
      await expect(waiting).rejects.toThrow(VaultBusyError);
      await expect(waiting).rejects.toThrow('Memory is busy right now. Try again in a moment.');
    });
  });

  describe('many callers at once', () => {
    it('lets one at a time in: 100 seeded callers, no lost update, no overlap', async () => {
      const seed = Number(process.env['LOCK_TEST_SEED'] ?? Math.floor(Math.random() * 2 ** 31));
      const random = seeded(seed);
      const vaultDir = await makeVault();
      const counterFile = path.join(vaultDir, 'counter');
      await writeFile(counterFile, '0');
      let inside = 0;
      let overlaps = 0;
      const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, Math.floor(random() * 3)));
      const callers = Array.from({ length: 100 }, (_unused, index) =>
        withVaultLock(
          {
            vaultDir,
            waitMs: 120_000,
            sleep: () => pause(),
            holder: { pid: index, host: `replica-${String(index % 4)}` },
          },
          async lock => {
            inside += 1;
            if (inside > 1) {
              overlaps += 1;
            }
            const before = Number(await readFile(counterFile, 'utf8'));
            await pause();
            await lock.assertHeld();
            await writeFile(counterFile, String(before + 1));
            inside -= 1;
          },
        ),
      );
      try {
        await Promise.all(callers);
        expect({ overlaps, counter: Number(await readFile(counterFile, 'utf8')) }).toEqual({
          overlaps: 0,
          counter: 100,
        });
      } catch (error) {
        throw new Error(`Lock test failed with seed ${String(seed)} (set LOCK_TEST_SEED to replay)`, { cause: error });
      }
    }, 60_000);

    it('never shows a reader an empty or partial lock file', async () => {
      const vaultDir = await makeVault();
      const stateDir = path.join(vaultDir, '.memory-state');
      let reading = true;
      const bad: string[] = [];
      const reader = (async () => {
        while (reading) {
          for (const name of await readdir(stateDir).catch(() => [])) {
            if (/^lock\.\d+$/.test(name)) {
              const raw = await readFile(path.join(stateDir, name), 'utf8').catch(() => undefined);
              if (raw !== undefined) {
                try {
                  JSON.parse(raw);
                } catch {
                  bad.push(`${name}: ${raw}`);
                }
              }
            }
          }
          await new Promise(resolve => setImmediate(resolve));
        }
      })();
      await Promise.all(
        Array.from({ length: 30 }, () =>
          withVaultLock({ vaultDir, waitMs: 60_000, sleep: () => new Promise(resolve => setTimeout(resolve, 1)) }, () =>
            Promise.resolve(),
          ),
        ),
      );
      reading = false;
      await reader;
      expect(bad).toEqual([]);
    }, 30_000);
  });

  describe('a holder that crashed', () => {
    it('is taken over only after the waiter has seen no sign of life for the whole stale time', async () => {
      const vaultDir = await makeVault();
      const clock = fakeClock();
      const crashed = manualBeat();
      // The holder starts and never finishes: its beat is never run.
      void withVaultLock(
        { vaultDir, schedule: crashed.schedule, staleAfterMs: STALE_MS, now: clock.now },
        () => new Promise<void>(() => undefined),
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      const early = withVaultLock(
        { vaultDir, waitMs: STALE_MS / 2, staleAfterMs: STALE_MS, now: clock.now, sleep: clock.sleep },
        () => Promise.resolve('early'),
      );
      await expect(early).rejects.toThrow(VaultBusyError);
      // The count carries over between tries, so a later try finishes it.
      const later = await withVaultLock(
        { vaultDir, waitMs: STALE_MS, staleAfterMs: STALE_MS, now: clock.now, sleep: clock.sleep },
        () => Promise.resolve('taken over'),
      );
      expect(later).toBe('taken over');
    });

    it('tells the old holder it lost the lock, and its release does not remove the new holder', async () => {
      const vaultDir = await makeVault();
      const clock = fakeClock();
      const oldBeat = manualBeat();
      let finishOld: () => void = () => undefined;
      let oldLock: { assertHeld(): Promise<void> } | undefined;
      const old = withVaultLock(
        { vaultDir, schedule: oldBeat.schedule, staleAfterMs: STALE_MS, now: clock.now },
        lock => {
          oldLock = lock;
          return new Promise<void>(resolve => {
            finishOld = resolve;
          });
        },
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      let newCheck: Promise<void> | undefined;
      await withVaultLock(
        { vaultDir, waitMs: 5 * STALE_MS, staleAfterMs: STALE_MS, now: clock.now, sleep: clock.sleep },
        async lock => {
          await expect(oldLock?.assertHeld()).rejects.toThrow(VaultLockLostError);
          finishOld();
          await old;
          // The old holder has released by now; the new holder still owns the lock.
          newCheck = lock.assertHeld();
          await newCheck;
          await expect(
            withVaultLock({ vaultDir, waitMs: 10, now: clock.now, sleep: clock.sleep }, () => Promise.resolve()),
          ).rejects.toThrow(VaultBusyError);
        },
      );
      await expect(newCheck).resolves.toBeUndefined();
    });

    it('lets exactly one of many waiters take over the same stale lock', async () => {
      const vaultDir = await makeVault();
      // Real time here: the waiters must see the taker's heartbeat while it works.
      const real = {
        staleAfterMs: 300,
        waitMs: 60_000,
        sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 10))),
      };
      void withVaultLock(
        { vaultDir, schedule: manualBeat().schedule, staleAfterMs: real.staleAfterMs },
        () => new Promise<void>(() => undefined),
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      let inside = 0;
      let overlaps = 0;
      let winners = 0;
      await Promise.all(
        Array.from({ length: 20 }, () =>
          withVaultLock({ vaultDir, ...real }, async lock => {
            winners += 1;
            inside += 1;
            if (inside > 1) {
              overlaps += 1;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
            await lock.assertHeld();
            inside -= 1;
          }),
        ),
      );
      expect({ winners, overlaps }).toEqual({ winners: 20, overlaps: 0 });
    }, 30_000);

    it('treats a lock file nobody can read as held until it has stood still for the stale time', async () => {
      const vaultDir = await makeVault();
      const stateDir = path.join(vaultDir, '.memory-state');
      await withVaultLock({ vaultDir }, () => Promise.resolve());
      await writeFile(path.join(stateDir, 'lock.9'), '');
      const clock = fakeClock();
      await expect(
        withVaultLock({ vaultDir, waitMs: 100, staleAfterMs: STALE_MS, now: clock.now, sleep: clock.sleep }, () =>
          Promise.resolve(),
        ),
      ).rejects.toThrow(VaultBusyError);
      await expect(
        withVaultLock(
          { vaultDir, waitMs: 2 * STALE_MS, staleAfterMs: STALE_MS, now: clock.now, sleep: clock.sleep },
          () => Promise.resolve('ok'),
        ),
      ).resolves.toBe('ok');
    });

    it('ignores temp files a crash left behind', async () => {
      const vaultDir = await makeVault();
      await withVaultLock({ vaultDir }, () => Promise.resolve());
      await writeFile(path.join(vaultDir, '.memory-state', 'lock.tmp-dead-1'), '{"half');
      await expect(withVaultLock({ vaultDir, waitMs: 0 }, () => Promise.resolve('ok'))).resolves.toBe('ok');
    });
  });

  describe('a holder whose clock is wrong', () => {
    async function holdWithClock({ vaultDir, startedAt }: { vaultDir: string; startedAt: string }) {
      // The holder wrote its own wall clock into its record. Nothing may depend on it.
      const stateDir = path.join(vaultDir, '.memory-state');
      const [name] = await stateFiles(vaultDir);
      const file = path.join(stateDir, name ?? '');
      const record: Record<string, unknown> = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...record, started_at: startedAt }));
    }

    it('cannot make a live lock look stale by writing a time long ago', async () => {
      const vaultDir = await makeVault();
      const clock = fakeClock();
      const holder = manualBeat();
      await withVaultLock({ vaultDir, schedule: holder.schedule, staleAfterMs: STALE_MS, now: clock.now }, async () => {
        await holdWithClock({ vaultDir, startedAt: '1970-01-01T00:00:00.000Z' });
        let waiterResult: Promise<string> | undefined;
        // Every sleep of the waiter is also a moment the holder shows it is alive.
        const sleepAndBeat = async (ms: number) => {
          clock.advance(ms);
          await holder.beat();
        };
        waiterResult = withVaultLock(
          { vaultDir, waitMs: 5 * STALE_MS, staleAfterMs: STALE_MS, now: clock.now, sleep: sleepAndBeat },
          () => Promise.resolve('stole it'),
        );
        await expect(waiterResult).rejects.toThrow(VaultBusyError);
      });
    });

    it('cannot keep a dead lock alive by writing a time far ahead', async () => {
      const vaultDir = await makeVault();
      const clock = fakeClock();
      void withVaultLock(
        { vaultDir, schedule: manualBeat().schedule, staleAfterMs: STALE_MS, now: clock.now },
        () => new Promise<void>(() => undefined),
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      await holdWithClock({ vaultDir, startedAt: '2999-01-01T00:00:00.000Z' });
      await expect(
        withVaultLock(
          { vaultDir, waitMs: 5 * STALE_MS, staleAfterMs: STALE_MS, now: clock.now, sleep: clock.sleep },
          () => Promise.resolve('taken over'),
        ),
      ).resolves.toBe('taken over');
    });
  });

  it('keeps the lock while the holder keeps beating, however long the work takes', async () => {
    const vaultDir = await makeVault();
    const clock = fakeClock();
    const holder = manualBeat();
    await withVaultLock({ vaultDir, schedule: holder.schedule, staleAfterMs: STALE_MS, now: clock.now }, async lock => {
      for (let round = 0; round < 10; round += 1) {
        clock.advance(STALE_MS / 2);
        await holder.beat();
        await lock.assertHeld();
      }
      await expect(
        withVaultLock({ vaultDir, waitMs: 50, staleAfterMs: STALE_MS, now: clock.now, sleep: clock.sleep }, () =>
          Promise.resolve(),
        ),
      ).rejects.toThrow(VaultBusyError);
    });
  });
});
