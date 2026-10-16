import { LoginAttemptLimiter } from '../../../src/auth/loginRateLimit';

describe('login attempt limiter', () => {
  let clock: number;
  const limiter = (options = {}) => new LoginAttemptLimiter({ now: () => clock, ...options });

  beforeEach(() => {
    clock = 0;
  });

  it('allows an address until it has failed five times, then locks it out for 30 seconds', () => {
    const l = limiter();
    for (let i = 0; i < 4; i += 1) {
      l.recordFailure('a');
      expect(l.check('a')).toEqual({ allowed: true });
    }
    l.recordFailure('a');
    expect(l.check('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(l.check('b')).toEqual({ allowed: true });
    clock = 30_001;
    expect(l.check('a')).toEqual({ allowed: true });
  });

  it('doubles the lockout each time and stops growing at the cap', () => {
    const l = limiter({ maxLockoutMs: 100_000 });
    const waits: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < 5; i += 1) {
        l.recordFailure('a');
      }
      const check = l.check('a');
      waits.push(check.allowed ? 0 : check.retryAfterSeconds);
      clock += 200_000;
    }
    expect(waits).toEqual([30, 60, 100, 100, 100]);
  });

  it('forgets failures older than the window', () => {
    const l = limiter();
    for (let i = 0; i < 4; i += 1) {
      l.recordFailure('a');
    }
    clock = 6 * 60_000;
    l.recordFailure('a');
    expect(l.check('a')).toEqual({ allowed: true });
  });

  it('makes everyone wait when the failures from all addresses pile up', () => {
    const l = limiter({ maxGlobalFailures: 6 });
    for (let i = 0; i < 6; i += 1) {
      l.recordFailure(`ip${String(i)}`);
    }
    expect(l.check('someone-new')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    clock = 31_000;
    expect(l.check('someone-new')).toEqual({ allowed: true });
  });

  it('clears the failures of an address that signed in', () => {
    const l = limiter();
    for (let i = 0; i < 4; i += 1) {
      l.recordFailure('a');
    }
    l.recordSuccess('a');
    l.recordFailure('a');
    expect(l.check('a')).toEqual({ allowed: true });
  });

  it('remembers a bounded number of addresses', () => {
    const l = limiter({ maxKeys: 3 });
    for (let i = 0; i < 5; i += 1) {
      for (let k = 0; k < 5; k += 1) {
        l.recordFailure(`ip${String(i)}`);
      }
    }
    expect(l.check('ip4').allowed).toBe(false);
    expect(l.check('ip0').allowed).toBe(true);
  });
});
