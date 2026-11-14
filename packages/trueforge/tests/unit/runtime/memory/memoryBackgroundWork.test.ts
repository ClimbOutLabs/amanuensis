import {
  memoryBackgroundWorkSettled,
  trackMemoryBackgroundWork,
} from '../../../../src/runtime/memory/memoryBackgroundWork';

function held(): { work: Promise<void>; release: () => void; fail: () => void } {
  let release: () => void = () => undefined;
  let fail: () => void = () => undefined;
  const work = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = () => {
      reject(new Error('the work failed'));
    };
  });
  return { work, release, fail };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('memory background work', () => {
  it('returns at once when nothing is running', async () => {
    const startedAt = Date.now();
    await memoryBackgroundWorkSettled({ timeoutMs: 10_000 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('waits for counted work, and for work that starts while it waits', async () => {
    const first = held();
    const second = held();
    void trackMemoryBackgroundWork(first.work);
    let settled = false;
    const waiting = memoryBackgroundWorkSettled({ timeoutMs: 10_000 }).then(() => {
      settled = true;
    });

    // The first piece of work starts a second one as it ends, the way a warm-up starts an index build.
    void trackMemoryBackgroundWork(second.work);
    first.release();
    await pause(30);
    expect(settled).toBe(false);

    second.release();
    await waiting;
    expect(settled).toBe(true);
  });

  it('does not throw when counted work fails, and hands the failure back to its caller', async () => {
    const failing = held();
    const handedBack = trackMemoryBackgroundWork(failing.work);
    failing.fail();
    await expect(handedBack).rejects.toThrow('the work failed');
    await expect(memoryBackgroundWorkSettled({ timeoutMs: 10_000 })).resolves.toBeUndefined();
  });

  it('gives up at its time limit when work is stuck', async () => {
    const stuck = held();
    void trackMemoryBackgroundWork(stuck.work);
    const startedAt = Date.now();
    await memoryBackgroundWorkSettled({ timeoutMs: 60 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    stuck.release();
    await memoryBackgroundWorkSettled({ timeoutMs: 10_000 });
  });
});
