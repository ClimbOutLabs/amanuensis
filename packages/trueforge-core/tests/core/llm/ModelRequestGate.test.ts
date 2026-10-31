import { ModelRequestGate } from '../../../src/core/llm/ModelRequestGate';

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Whether a promise has resolved yet, after queued microtasks have run. */
async function hasResolved(promise: Promise<void>): Promise<boolean> {
  let resolved = false;
  void promise.then(() => {
    resolved = true;
  });
  await pause(0);
  return resolved;
}

describe('ModelRequestGate', () => {
  it('grants at once while places are free, and queues past the limit', async () => {
    const gate = new ModelRequestGate();
    const first = gate.begin({ key: 'm', limit: 1 });
    expect(first.queued).toBe(false);
    await expect(hasResolved(first.granted)).resolves.toBe(true);

    const second = gate.begin({ key: 'm', limit: 1 });
    expect(second.queued).toBe(true);
    await expect(hasResolved(second.granted)).resolves.toBe(false);

    first.release();
    await expect(hasResolved(second.granted)).resolves.toBe(true);
    second.release();
  });

  it('hands places over first come first served', async () => {
    const gate = new ModelRequestGate();
    const holder = gate.begin({ key: 'm', limit: 1 });
    const second = gate.begin({ key: 'm', limit: 1 });
    const third = gate.begin({ key: 'm', limit: 1 });

    holder.release();
    await expect(hasResolved(second.granted)).resolves.toBe(true);
    await expect(hasResolved(third.granted)).resolves.toBe(false);

    second.release();
    await expect(hasResolved(third.granted)).resolves.toBe(true);
    third.release();
  });

  it('keeps different models independent', async () => {
    const gate = new ModelRequestGate();
    const a = gate.begin({ key: 'a', limit: 1 });
    const b = gate.begin({ key: 'b', limit: 1 });
    expect(a.queued).toBe(false);
    expect(b.queued).toBe(false);
    a.release();
    b.release();
  });

  it('allows as many in flight as the limit says', async () => {
    const gate = new ModelRequestGate();
    const one = gate.begin({ key: 'm', limit: 2 });
    const two = gate.begin({ key: 'm', limit: 2 });
    const three = gate.begin({ key: 'm', limit: 2 });
    expect(one.queued).toBe(false);
    expect(two.queued).toBe(false);
    expect(three.queued).toBe(true);
    one.release();
    await expect(hasResolved(three.granted)).resolves.toBe(true);
    two.release();
    three.release();
  });

  it('a cancelled wait leaves the queue without taking a place', async () => {
    const gate = new ModelRequestGate();
    const holder = gate.begin({ key: 'm', limit: 1 });
    const waiter = gate.begin({ key: 'm', limit: 1 });
    const next = gate.begin({ key: 'm', limit: 1 });
    waiter.cancel();
    holder.release();
    await expect(hasResolved(waiter.granted)).resolves.toBe(false);
    await expect(hasResolved(next.granted)).resolves.toBe(true);
    next.release();
  });

  it('cancelling after the place was handed over hands it back', async () => {
    const gate = new ModelRequestGate();
    const holder = gate.begin({ key: 'm', limit: 1 });
    const waiter = gate.begin({ key: 'm', limit: 1 });
    holder.release();
    // The handover already happened synchronously; the waiter's await has not run yet.
    waiter.cancel();
    const after = gate.begin({ key: 'm', limit: 1 });
    expect(after.queued).toBe(false);
    after.release();
  });

  it('release is safe to call more than once', async () => {
    const gate = new ModelRequestGate();
    const first = gate.begin({ key: 'm', limit: 1 });
    const second = gate.begin({ key: 'm', limit: 1 });
    first.release();
    first.release();
    await expect(hasResolved(second.granted)).resolves.toBe(true);
    const third = gate.begin({ key: 'm', limit: 1 });
    expect(third.queued).toBe(true);
    second.release();
    await expect(hasResolved(third.granted)).resolves.toBe(true);
    third.release();
  });
});
