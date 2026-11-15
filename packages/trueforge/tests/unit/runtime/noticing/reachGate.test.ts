import winston from 'winston';

import { withReachLease, type ReachGateDeps } from '../../../../src/runtime/noticing/reachGate';

const OWNER = { tenant_id: 't1', created_by: 'alice' };
const AT = new Date('2026-11-05T10:00:00.000Z');

function gate(store: ReachGateDeps['store']): ReachGateDeps {
  return {
    store,
    history: { countSince: () => Promise.resolve(0), lastCreatedAt: () => Promise.resolve(undefined) },
    logger: winston.createLogger({ silent: true }),
    now: () => AT,
    sleep: () => Promise.resolve(),
  };
}

describe('withReachLease', () => {
  it('takes the lease for two minutes, runs the work and hands the lease back', async () => {
    const taken: Date[] = [];
    const store: ReachGateDeps['store'] = {
      acquireReachLease: ({ until }) => {
        taken.push(until);
        return Promise.resolve(true);
      },
      releaseReachLease: jest.fn(() => Promise.resolve()),
    };
    await expect(
      withReachLease({ deps: gate(store), owner: OWNER, work: () => Promise.resolve('done') }),
    ).resolves.toEqual({ held: true, value: 'done' });
    expect(taken).toEqual([new Date(AT.getTime() + 120_000)]);
    expect(store.releaseReachLease).toHaveBeenCalledTimes(1);
  });

  it('hands the lease back when the work fails', async () => {
    const store: ReachGateDeps['store'] = {
      acquireReachLease: () => Promise.resolve(true),
      releaseReachLease: jest.fn(() => Promise.resolve()),
    };
    await expect(
      withReachLease({ deps: gate(store), owner: OWNER, work: () => Promise.reject(new Error('send failed')) }),
    ).rejects.toThrow('send failed');
    expect(store.releaseReachLease).toHaveBeenCalledTimes(1);
  });

  it('gives up when someone else holds the lease every time', async () => {
    const work = jest.fn(() => Promise.resolve('done'));
    const store: ReachGateDeps['store'] = {
      acquireReachLease: () => Promise.resolve(false),
      releaseReachLease: () => Promise.resolve(),
    };
    await expect(withReachLease({ deps: gate(store), owner: OWNER, work })).resolves.toEqual({ held: false });
    expect(work).not.toHaveBeenCalled();
  });
});
