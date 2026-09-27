import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';

describe('TurnDrainRegistry', () => {
  it('shutdownAndWait resolves immediately when nothing is tracked', async () => {
    const registry = new TurnDrainRegistry();
    await expect(registry.shutdownAndWait({ timeoutMs: 1000 })).resolves.toBeUndefined();
  });

  it('waits for an in-flight drain and unregisters it once it settles', async () => {
    const registry = new TurnDrainRegistry();
    const { promise: drain, resolve: finishDrain } = Promise.withResolvers<void>();
    registry.track({ sessionId: 's1', turnId: 't1', drain });
    expect(registry.size).toBe(1);

    let settled = false;
    const waiting = registry.shutdownAndWait({ timeoutMs: 5000 }).then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    finishDrain();
    await waiting;
    expect(settled).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('gives up after the timeout instead of waiting forever', async () => {
    const registry = new TurnDrainRegistry();
    registry.track({ sessionId: 's1', turnId: 't1', drain: new Promise<void>(() => {}) });
    const start = Date.now();
    await registry.shutdownAndWait({ timeoutMs: 50 });
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('unregisters rejected drains and never throws', async () => {
    const registry = new TurnDrainRegistry();
    // track() attaches its settle hook synchronously, so this rejection is observed.
    registry.track({ sessionId: 's1', turnId: 't1', drain: Promise.reject(new Error('drain blew up')) });
    await expect(registry.shutdownAndWait({ timeoutMs: 1000 })).resolves.toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(registry.size).toBe(0);
  });
});
