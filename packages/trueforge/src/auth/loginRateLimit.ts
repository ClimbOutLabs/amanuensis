export interface LoginAttemptLimiterOptions {
  /** Failed attempts one address may make inside the window before it is locked out. */
  maxFailuresPerKey?: number;
  /** Failed attempts from all addresses together inside the window before everyone waits. */
  maxGlobalFailures?: number;
  windowMs?: number;
  baseLockoutMs?: number;
  maxLockoutMs?: number;
  /** Most addresses remembered at once; the oldest are forgotten first. */
  maxKeys?: number;
  now?: () => number;
}

interface KeyState {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  lockouts: number;
}

export type LoginAttemptCheck = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Slows password guessing against the sign-in form: one address that keeps failing is locked out for longer each time,
 * and a flood from many addresses makes everyone wait briefly. State is in memory and lost on restart.
 */
export class LoginAttemptLimiter {
  readonly #maxFailuresPerKey: number;
  readonly #maxGlobalFailures: number;
  readonly #windowMs: number;
  readonly #baseLockoutMs: number;
  readonly #maxLockoutMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #keys = new Map<string, KeyState>();
  #globalFailures = 0;
  #globalWindowStart = 0;
  #globalLockedUntil = 0;

  constructor(options: LoginAttemptLimiterOptions = {}) {
    this.#maxFailuresPerKey = options.maxFailuresPerKey ?? 5;
    this.#maxGlobalFailures = options.maxGlobalFailures ?? 30;
    this.#windowMs = options.windowMs ?? 5 * 60_000;
    this.#baseLockoutMs = options.baseLockoutMs ?? 30_000;
    this.#maxLockoutMs = options.maxLockoutMs ?? 10 * 60_000;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  check(key: string): LoginAttemptCheck {
    const now = this.#now();
    const until = Math.max(this.#globalLockedUntil, this.#keys.get(key)?.lockedUntil ?? 0);
    if (until > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
    return { allowed: true };
  }

  recordFailure(key: string): void {
    const now = this.#now();
    if (now - this.#globalWindowStart > this.#windowMs) {
      this.#globalWindowStart = now;
      this.#globalFailures = 0;
    }
    this.#globalFailures += 1;
    if (this.#globalFailures >= this.#maxGlobalFailures) {
      this.#globalLockedUntil = now + this.#baseLockoutMs;
      this.#globalFailures = 0;
    }
    const state = this.#keys.get(key) ?? { failures: 0, windowStart: now, lockedUntil: 0, lockouts: 0 };
    if (now - state.windowStart > this.#windowMs) {
      state.failures = 0;
      state.windowStart = now;
    }
    state.failures += 1;
    if (state.failures >= this.#maxFailuresPerKey) {
      state.lockouts += 1;
      state.lockedUntil = now + Math.min(this.#baseLockoutMs * 2 ** (state.lockouts - 1), this.#maxLockoutMs);
      state.failures = 0;
    }
    this.#keys.delete(key);
    this.#keys.set(key, state);
    if (this.#keys.size > this.#maxKeys) {
      const oldest = this.#keys.keys().next();
      if (!oldest.done) {
        this.#keys.delete(oldest.value);
      }
    }
  }

  /** A successful sign-in clears that address's failures but keeps its lockout history. */
  recordSuccess(key: string): void {
    const state = this.#keys.get(key);
    if (state !== undefined) {
      state.failures = 0;
    }
  }
}
