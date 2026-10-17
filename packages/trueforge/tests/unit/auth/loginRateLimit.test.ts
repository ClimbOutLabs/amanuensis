import { LoginAttemptLimiter } from '../../../src/auth/loginRateLimit';

const DAY = 24 * 60 * 60_000;

describe('login attempt limiter', () => {
  let clock: number;
  const limiter = (options = {}) => new LoginAttemptLimiter({ now: () => clock, ...options });

  /** One finished attempt from the address. */
  function attempt(
    l: LoginAttemptLimiter,
    key: string,
    outcome: 'success' | 'failure' | 'abandon' = 'failure',
    account = '',
  ) {
    const permit = l.begin(key, account);
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
    expect(l.begin('a')).toEqual({ allowed: false, retryAfterSeconds: 30, scope: 'address' });
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
    expect(l.begin('a')).toEqual({ allowed: false, retryAfterSeconds: 30, scope: 'address' });
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
    expect(l.begin('a')).toEqual({ allowed: false, retryAfterSeconds: 30, scope: 'address' });
  });

  it('makes unknown addresses wait when failures from all addresses pile up, but not an address that signed in today', () => {
    const l = limiter({ maxGlobalFailures: 6 });
    attempt(l, 'device', 'success');
    for (let i = 0; i < 6; i += 1) {
      attempt(l, `ip${String(i)}`);
    }
    expect(l.begin('someone-new')).toEqual({ allowed: false, retryAfterSeconds: 30, scope: 'address' });
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
        attempt(l, `ip${String(i)}`, 'failure', `person${String(i)}`);
      }
    }
    expect(l.begin('ip4', 'person4').allowed).toBe(false);
    expect(l.begin('ip0', 'person0').allowed).toBe(true);
  });

  it('allows plenty of sign-in page requests, then asks the address to wait until the minute is over', () => {
    const l = limiter({ maxPageStartsPerMinute: 3 });
    expect([1, 2, 3].map(() => l.allowPageStart('a').allowed)).toEqual([true, true, true]);
    expect(l.allowPageStart('a')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(l.allowPageStart('b').allowed).toBe(true);
    clock += 60_000;
    expect(l.allowPageStart('a').allowed).toBe(true);
  });

  it('does not let a sign-in to one account start the guessing over for another', () => {
    const l = limiter();
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) {
        expect(attempt(l, 'a', 'failure', 'owner@example.com').allowed).toBe(true);
      }
      expect(attempt(l, 'a', 'success', 'member@example.com').allowed).toBe(true);
      expect(attempt(l, 'a', 'failure', 'owner@example.com')).toMatchObject({ allowed: true });
      expect(l.begin('a', 'owner@example.com').allowed).toBe(false);
      clock += 31 * 60_000;
    }
  });

  it('keeps the lockout history of guesses at one account when another account signs in', () => {
    const l = limiter();
    for (let i = 0; i < 5; i += 1) {
      attempt(l, 'a', 'failure', 'owner@example.com');
    }
    clock += 31_000;
    attempt(l, 'a', 'success', 'member@example.com');
    for (let i = 0; i < 5; i += 1) {
      attempt(l, 'a', 'failure', 'owner@example.com');
    }
    expect(l.begin('a', 'owner@example.com')).toEqual({ allowed: false, retryAfterSeconds: 60, scope: 'address' });
  });

  it('clears an account the person signs in to after their own typing mistakes', () => {
    const l = limiter();
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) {
        expect(attempt(l, 'a', 'failure', 'Me@Example.com').allowed).toBe(true);
      }
      expect(attempt(l, 'a', 'success', 'me@example.com').allowed).toBe(true);
    }
  });

  it('forgives the lockout history of an account that earned it once that account signs in', () => {
    const l = limiter();
    for (let i = 0; i < 5; i += 1) {
      attempt(l, 'a', 'failure', 'me@example.com');
    }
    clock += 31_000;
    attempt(l, 'a', 'success', 'me@example.com');
    for (let i = 0; i < 5; i += 1) {
      attempt(l, 'a', 'failure', 'me@example.com');
    }
    expect(l.begin('a', 'me@example.com')).toEqual({ allowed: false, retryAfterSeconds: 30, scope: 'address' });
  });
  describe('budget per account', () => {
    const spread = (l: LoginAttemptLimiter, account: string, from: number, count: number) => {
      for (let i = from; i < from + count; i += 1) {
        attempt(l, `ip${String(i)}`, 'failure', account);
      }
    };

    it('locks unknown addresses out of an account after 10 wrong passwords from different addresses', () => {
      const l = limiter({ maxGlobalFailures: 1000 });
      spread(l, 'owner@example.com', 0, 10);
      expect(l.begin('ip-new', 'owner@example.com')).toEqual({
        allowed: false,
        retryAfterSeconds: 300,
        scope: 'account',
      });
      expect(l.begin('ip-new', 'someone-else@example.com').allowed).toBe(true);
    });

    it('does not let a burst of guesses at one account through beyond the budget', () => {
      const l = limiter({ maxGlobalFailures: 1000 });
      const permits = Array.from({ length: 60 }, (_, i) => l.begin(`ip${String(i)}`, 'Owner@Example.com '));
      expect(permits.filter(p => p.allowed)).toHaveLength(10);
    });

    it('keeps working for an address that signed in during the last day', () => {
      const l = limiter({ maxGlobalFailures: 1000 });
      attempt(l, 'home', 'success', 'owner@example.com');
      spread(l, 'owner@example.com', 0, 10);
      expect(l.begin('home', 'owner@example.com').allowed).toBe(true);
      expect(l.begin('fresh', 'owner@example.com').allowed).toBe(false);
    });

    it('doubles the wait each time, up to the cap, and starts over after a day without failures', () => {
      const l = limiter({ maxGlobalFailures: 1000, maxAccountLockoutMs: 20 * 60_000 });
      const waits: number[] = [];
      for (let round = 0; round < 4; round += 1) {
        spread(l, 'owner@example.com', round * 10, 10);
        const check = l.begin('fresh', 'owner@example.com');
        waits.push(check.allowed ? 0 : check.retryAfterSeconds);
        clock += 21 * 60_000;
      }
      expect(waits).toEqual([300, 600, 1200, 1200]);
      clock += DAY + 1;
      spread(l, 'owner@example.com', 100, 10);
      const again = l.begin('fresh', 'owner@example.com');
      expect(again.allowed ? 0 : again.retryAfterSeconds).toBe(300);
    });

    it('forgets old failures after an hour', () => {
      const l = limiter({ maxGlobalFailures: 1000 });
      spread(l, 'owner@example.com', 0, 9);
      clock += 61 * 60_000;
      spread(l, 'owner@example.com', 20, 9);
      expect(l.begin('fresh', 'owner@example.com').allowed).toBe(true);
    });

    it('is not cleared by a sign-in, so a lucky guess does not give the next guesser a fresh budget', () => {
      const l = limiter({ maxGlobalFailures: 1000 });
      spread(l, 'owner@example.com', 0, 9);
      attempt(l, 'ip-lucky', 'success', 'owner@example.com');
      spread(l, 'owner@example.com', 20, 1);
      expect(l.begin('fresh', 'owner@example.com').allowed).toBe(false);
    });
  });
});
