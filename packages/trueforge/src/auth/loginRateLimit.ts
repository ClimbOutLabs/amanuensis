const DAY_MS = 24 * 60 * 60_000;

export interface LoginAttemptLimiterOptions {
  /** Password attempts, finished or still in flight, one address may have inside the window before it is locked out. */
  maxFailuresPerKey?: number;
  /** The same for all addresses together; an address that signed in during the last day is not held by it. */
  maxGlobalFailures?: number;
  windowMs?: number;
  baseLockoutMs?: number;
  maxLockoutMs?: number;
  /** Most account names one address is tracked for; the rest share one entry. */
  maxAccountsPerKey?: number;
  /** Sign-in page requests one address may make per minute. */
  maxPageStartsPerMinute?: number;
  /** Most addresses remembered at once; the oldest are forgotten first. */
  maxKeys?: number;
  now?: () => number;
}

interface KeyState {
  /** Failures of every account tried from this address together; each account's own count is in `accounts`. */
  failures: number;
  accounts: Map<string, number>;
  /** Accounts whose failures earned the lockouts so far; the history is forgotten when all of them have signed in. */
  culprits: Set<string>;
  inflight: number;
  windowStart: number;
  lockedUntil: number;
  lockouts: number;
  lastFailure: number;
  /** Zero until this address has signed in. */
  lastSuccess: number;
}

type Permit =
  | { allowed: true; finish: (outcome: 'success' | 'failure' | 'abandon') => void }
  | { allowed: false; retryAfterSeconds: number };

export type LoginAttemptPermit = Permit;

/**
 * Slows password guessing against the sign-in form. An attempt takes a slot before it is passed on and counts toward
 * the limit while it is in flight, so a burst cannot get more than the limit through. One address that keeps failing
 * is locked out for longer each time; a flood from many addresses makes unknown addresses wait briefly, while an address
 * that signed in during the last day keeps working. State is in memory and lost on restart.
 */
export class LoginAttemptLimiter {
  readonly #maxFailuresPerKey: number;
  readonly #maxGlobalFailures: number;
  readonly #windowMs: number;
  readonly #baseLockoutMs: number;
  readonly #maxLockoutMs: number;
  readonly #maxPageStarts: number;
  readonly #maxAccountsPerKey: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #keys = new Map<string, KeyState>();
  readonly #pageStarts = new Map<string, { count: number; windowStart: number }>();
  #globalFailures = 0;
  #globalInflight = 0;
  #globalWindowStart = 0;
  #globalLockedUntil = 0;

  constructor(options: LoginAttemptLimiterOptions = {}) {
    this.#maxFailuresPerKey = options.maxFailuresPerKey ?? 5;
    this.#maxGlobalFailures = options.maxGlobalFailures ?? 30;
    this.#windowMs = options.windowMs ?? 5 * 60_000;
    this.#baseLockoutMs = options.baseLockoutMs ?? 30_000;
    this.#maxLockoutMs = options.maxLockoutMs ?? 10 * 60_000;
    this.#maxPageStarts = options.maxPageStartsPerMinute ?? 30;
    this.#maxAccountsPerKey = options.maxAccountsPerKey ?? 20;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Takes a slot for one password attempt on an account, or says how long to wait. The slot is given back by `finish`.
   * A sign-in clears only that account's failures from this address: guesses at another account stay counted, so a
   * login of one's own cannot be used to start over.
   */
  begin(key: string, account = ''): Permit {
    const now = this.#now();
    const state = this.#state(key, now);
    const known = state.lastSuccess > 0 && now - state.lastSuccess < DAY_MS;
    const until = Math.max(known ? 0 : this.#globalLockedUntil, state.lockedUntil);
    if (until > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
    this.#expireWindows(state, now);
    if (state.failures + state.inflight >= this.#maxFailuresPerKey) {
      return { allowed: false, retryAfterSeconds: Math.ceil(this.#baseLockoutMs / 1000) };
    }
    if (!known && this.#globalFailures + this.#globalInflight >= this.#maxGlobalFailures) {
      return { allowed: false, retryAfterSeconds: Math.ceil(this.#baseLockoutMs / 1000) };
    }
    state.inflight += 1;
    this.#globalInflight += 1;
    let finished = false;
    return {
      allowed: true,
      finish: outcome => {
        if (finished) {
          return;
        }
        finished = true;
        state.inflight -= 1;
        this.#globalInflight -= 1;
        const name = this.#accountName(state, account);
        if (outcome === 'failure') {
          this.#recordFailure(state, name);
        } else if (outcome === 'success') {
          state.failures = Math.max(0, state.failures - (state.accounts.get(name) ?? 0));
          state.accounts.delete(name);
          state.culprits.delete(name);
          if (state.failures === 0 && state.culprits.size === 0) {
            state.lockouts = 0;
          }
          state.lastSuccess = this.#now();
        }
      },
    };
  }

  /** Counts one request for a sign-in page against the address; a person needs a handful, so the limit is generous. */
  allowPageStart(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = this.#now();
    const entry = this.#pageStarts.get(key) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart >= 60_000) {
      entry.count = 0;
      entry.windowStart = now;
    }
    this.#pageStarts.delete(key);
    this.#pageStarts.set(key, entry);
    this.#forgetOldest(this.#pageStarts, () => true);
    if (entry.count >= this.#maxPageStarts) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.windowStart + 60_000 - now) / 1000)) };
    }
    entry.count += 1;
    return { allowed: true };
  }

  #state(key: string, now: number): KeyState {
    const state = this.#keys.get(key) ?? {
      failures: 0,
      accounts: new Map<string, number>(),
      culprits: new Set<string>(),
      inflight: 0,
      windowStart: now,
      lockedUntil: 0,
      lockouts: 0,
      lastFailure: 0,
      lastSuccess: 0,
    };
    this.#keys.delete(key);
    this.#keys.set(key, state);
    this.#forgetOldest(this.#keys, entry => entry.inflight === 0);
    return state;
  }

  #accountName(state: KeyState, account: string): string {
    const name = account.trim().toLowerCase().slice(0, 200);
    return state.accounts.has(name) || state.accounts.size < this.#maxAccountsPerKey ? name : '\u0000other';
  }

  #forgetOldest<T>(map: Map<string, T>, removable: (value: T) => boolean): void {
    if (map.size <= this.#maxKeys) {
      return;
    }
    for (const [key, value] of map) {
      if (removable(value)) {
        map.delete(key);
        return;
      }
    }
  }

  #expireWindows(state: KeyState, now: number): void {
    if (now - state.windowStart > this.#windowMs) {
      state.failures = 0;
      state.accounts.clear();
      state.windowStart = now;
    }
    // A day without a failure forgets the lockout history, so one slip long ago does not lengthen a later lockout.
    if (state.lastFailure > 0 && now - state.lastFailure > DAY_MS) {
      state.lockouts = 0;
      state.culprits.clear();
    }
    if (now - this.#globalWindowStart > this.#windowMs) {
      this.#globalWindowStart = now;
      this.#globalFailures = 0;
    }
  }

  #recordFailure(state: KeyState, account: string): void {
    const now = this.#now();
    this.#expireWindows(state, now);
    this.#globalFailures += 1;
    if (this.#globalFailures >= this.#maxGlobalFailures) {
      this.#globalLockedUntil = now + this.#baseLockoutMs;
      this.#globalFailures = 0;
    }
    state.lastFailure = now;
    state.failures += 1;
    state.accounts.set(account, (state.accounts.get(account) ?? 0) + 1);
    if (state.failures >= this.#maxFailuresPerKey) {
      state.lockouts += 1;
      state.lockedUntil = now + Math.min(this.#baseLockoutMs * 2 ** (state.lockouts - 1), this.#maxLockoutMs);
      for (const account of state.accounts.keys()) {
        state.culprits.add(account);
      }
      state.failures = 0;
      state.accounts.clear();
    }
  }
}
