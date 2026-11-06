import winston from 'winston';

import { withReachLease, type ReachGateDeps } from '../../../../src/runtime/noticing/reachGate';

const OWNER = { tenant_id: 't1', created_by: 'alice' };

describe('withReachLease', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds the lease longer while slow work runs, and hands it back after', async () => {
    jest.useFakeTimers();
    const renewals: Date[] = [];
    const store: ReachGateDeps['store'] = {
      acquireReachLease: () => Promise.resolve(true),
      renewReachLease: ({ until }) => {
        renewals.push(until);
        return Promise.resolve(true);
      },
      releaseReachLease: jest.fn(() => Promise.resolve()),
    };
    const deps: ReachGateDeps = {
      store,
      history: { countSince: () => Promise.resolve(0), lastCreatedAt: () => Promise.resolve(undefined) },
      logger: winston.createLogger({ silent: true }),
      now: () => new Date(Date.now()),
      sleep: () => Promise.resolve(),
    };
    const slow = withReachLease({
      deps,
      owner: OWNER,
      work: () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 90_000)),
    });
    await jest.advanceTimersByTimeAsync(90_000);
    await expect(slow).resolves.toEqual({ held: true, value: 'done' });
    expect(renewals.length).toBeGreaterThanOrEqual(4);
    expect(store.releaseReachLease).toHaveBeenCalledTimes(1);

    // No renewal is left running once the work is done.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(renewals.length).toBeLessThanOrEqual(5);
  });
});
