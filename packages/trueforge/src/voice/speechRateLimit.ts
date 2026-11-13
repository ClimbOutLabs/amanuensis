/**
 * Per-person limits on the voice service. One sidecar serves every person on the instance and
 * synthesizes one reply at a time, so each person gets a bounded share: a number of requests per
 * rolling minute and a cap on requests in flight. The read-aloud route and voice conversations share
 * the in-flight cap. Connecting a conversation uses a limiter of its own with a per-minute count only.
 * State is in memory and lost on restart.
 */
const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 30;
const DEFAULT_MAX_IN_FLIGHT = 2;
/** Most people remembered at once; the oldest are forgotten first. */
const MAX_KEYS = 1_000;

interface KeyState {
  starts: number[];
  inFlight: number;
  /** Callers waiting for a place. A place that comes back goes straight to the first, never to a new request. */
  waiters: ((release: () => void) => void)[];
}

/** The key a person's place at the voice service is kept under, the same wherever they speak from. */
export function speechPersonKey({ tenantId, personId }: { tenantId: string; personId: string }): string {
  return `${tenantId}:${personId}`;
}

export type SpeechPermit = { allowed: true; release: () => void } | { allowed: false; retryAfterSeconds: number };

export class SpeechRateLimiter {
  readonly #maxPerWindow: number;
  readonly #maxInFlight: number;
  readonly #now: () => number;
  readonly #keys = new Map<string, KeyState>();

  constructor(options: { maxPerWindow?: number; maxInFlight?: number; now?: () => number } = {}) {
    this.#maxPerWindow = options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
    this.#maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.#now = options.now ?? Date.now;
  }

  acquire(key: string): SpeechPermit {
    return this.#take({ key, countsTowardMinute: true });
  }

  /** Waits for a free in-flight place, up to `timeoutMs` or until `signal` aborts; rejects otherwise. */
  async acquireInFlightWaiting({
    key,
    signal,
    timeoutMs,
  }: {
    key: string;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<() => void> {
    const stop = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    stop.throwIfAborted();
    const permit = this.#take({ key, countsTowardMinute: false });
    if (permit.allowed) {
      return permit.release;
    }
    const state = this.#keys.get(key);
    return await new Promise<() => void>((resolve, reject) => {
      const handOver = (release: () => void): void => {
        stop.removeEventListener('abort', giveUp);
        resolve(release);
      };
      const giveUp = (): void => {
        state?.waiters.splice(state.waiters.indexOf(handOver), 1);
        reject(stop.reason instanceof Error ? stop.reason : new Error('stopped waiting for a free place'));
      };
      state?.waiters.push(handOver);
      stop.addEventListener('abort', giveUp, { once: true });
    });
  }

  #take({ key, countsTowardMinute }: { key: string; countsTowardMinute: boolean }): SpeechPermit {
    const now = this.#now();
    const state = this.#keys.get(key) ?? { starts: [], inFlight: 0, waiters: [] };
    state.starts = state.starts.filter(start => now - start < WINDOW_MS);
    // Re-inserting keeps the map in least-recently-used order for eviction.
    this.#keys.delete(key);
    this.#keys.set(key, state);
    this.#evict();
    const oldest = state.starts[0];
    if (countsTowardMinute && state.starts.length >= this.#maxPerWindow && oldest !== undefined) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) };
    }
    if (state.inFlight >= this.#maxInFlight) {
      return { allowed: false, retryAfterSeconds: 1 };
    }
    if (countsTowardMinute) {
      state.starts.push(now);
    }
    state.inFlight += 1;
    return { allowed: true, release: this.#releaseFor(state) };
  }

  /** Frees a place once; when someone waits, the place stays counted and goes to them. */
  #releaseFor(state: KeyState): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = state.waiters.shift();
      if (next === undefined) {
        state.inFlight -= 1;
      } else {
        next(this.#releaseFor(state));
      }
    };
  }

  #evict(): void {
    while (this.#keys.size > MAX_KEYS) {
      const oldest = this.#keys.keys().next();
      if (oldest.done) {
        return;
      }
      this.#keys.delete(oldest.value);
    }
  }
}

/** The one limiter this process shares between read-aloud requests and voice conversations. */
export const speechLimiter = new SpeechRateLimiter();
