import { LoginAttemptLimiter } from '../../../src/auth/loginRateLimit';

const DAY = 24 * 60 * 60_000;

describe('login attempt limiter', () => {
  let clock: number;
  const limiter = (options = {}) => new LoginAttemptLimiter({ now: () => clock, ...options });

  /** One finished attempt from the address. */
  function attempt(l: LoginAttemptLimiter, key: string, outcome: 'success' | 'failure' | 'abandon' = 'failure') {
    const permit = l.begin(key);
    if (permit.allowed) {
      permit.finish(outcome);
    }
    return permit;
  }

  beforeEach(() => {
    clock = 1_000;
  });

  it('allows an address until it has failed five times, then locks it out for 30 seconds', () => {
    const l = limiter();
    for (let i = 0; i < 5; i += 1) {
      expect(attempt(l, 'a').allowed).toBe(true);
    }
    expect(l.begin('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(attempt(l, 'b').allowed).toBe(true);
    clock += 30_001;
    expect(l.begin('a').allowed).toBe(true);
  });

  it('lets no more attempts reach the service than the limit, however many arrive before any answer', () => {
    const l = limiter();
    const permits = Array.from({ length: 60 }, () => l.begin('a'));
    expect(permits.filter(p => p.allowed)).toHaveLength(5);
    expect(permits.filter(p => !p.allowed)).toHaveLength(55);
  });

  it('keeps the global limit for a burst of unknown addresses too', () => {
    const l = limiter({ maxGlobalFailures: 8 });
    const permits = Array.from({ length: 20 }, (_, i) => l.begin(`ip${String(i)}`));
    expect(permits.filter(p => p.allowed)).toHaveLength(8);
  });

  it('gives a slot back when the service did not answer, without counting a failure', () => {
    const l = limiter();
    for (let i = 0; i < 20; i += 1) {
      expect(attempt(l, 'a', 'abandon').allowed).toBe(true);
    }
  });

  it('doubles the lockout each time and stops growing at the cap', () => {
    const l = limiter({ maxLockoutMs: 100_000 });
    const waits: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < 5; i += 1) {
        attempt(l, 'a');
      }
      const check = l.begin('a');
      waits.push(check.allowed ? 0 : check.retryAfterSeconds);
      clock += 200_000;
    }
    expect(waits).toEqual([30, 60, 100, 100, 100]);
  });

  it('forgets failures older than the window', () => {
    const l = limiter();
    for (let i = 0; i < 4; i += 1) {
      attempt(l, 'a');
    }
    clock += 6 * 60_000;
    attempt(l, 'a');
    expect(l.begin('a').allowed).toBe(true);
  });

  it('forgets the lockout history after a day without a failure', () => {
    const l = limiter();
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 5; i += 1) {
        attempt(l, 'a');
      }
      clock += 700_000;
    }
    clock += DAY;
    for (let i = 0; i < 5; i += 1) {
      attempt(l, 'a');
    }
    expect(l.begin('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it('clears the failures and the lockout history of an address that signed in', () => {
    const l = limiter();
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 5; i += 1) {
        attempt(l, 'a');
      }
      clock += 700_000;
    }
    for (let i = 0; i < 4; i += 1) {
      attempt(l, 'a');
    }
    attempt(l, 'a', 'success');
    for (let i = 0; i < 5; i += 1) {
      attempt(l, 'a');
    }
    expect(l.begin('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it('makes unknown addresses wait when failures from all addresses pile up, but not an address that signed in today', () => {
    const l = limiter({ maxGlobalFailures: 6 });
    attempt(l, 'device', 'success');
    for (let i = 0; i < 6; i += 1) {
      attempt(l, `ip${String(i)}`);
    }
    expect(l.begin('someone-new')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(l.begin('device').allowed).toBe(true);
    clock += 31_000;
    expect(l.begin('someone-new').allowed).toBe(true);
  });

  it('stops exempting a device a day after it signed in', () => {
    const l = limiter({ maxGlobalFailures: 3 });
    attempt(l, 'device', 'success');
    clock += DAY + 1;
    for (let i = 0; i < 3; i += 1) {
      attempt(l, `ip${String(i)}`);
    }
    expect(l.begin('device').allowed).toBe(false);
  });

  it('remembers a bounded number of addresses', () => {
    const l = limiter({ maxKeys: 3 });
    for (let i = 0; i < 5; i += 1) {
      for (let k = 0; k < 5; k += 1) {
        attempt(l, `ip${String(i)}`);
      }
    }
    expect(l.begin('ip4').allowed).toBe(false);
    expect(l.begin('ip0').allowed).toBe(true);
  });

  it('allows plenty of sign-in page requests, then asks the address to wait until the minute is over', () => {
    const l = limiter({ maxPageStartsPerMinute: 3 });
    expect([1, 2, 3].map(() => l.allowPageStart('a').allowed)).toEqual([true, true, true]);
    expect(l.allowPageStart('a')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(l.allowPageStart('b').allowed).toBe(true);
    clock += 60_000;
    expect(l.allowPageStart('a').allowed).toBe(true);
  });
});
