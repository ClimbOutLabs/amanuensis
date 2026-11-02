/**
 * Per-person limit on `POST /api/v1/voice/speak`. One sidecar serves every person on the
 * instance and synthesizes one reply at a time, so each person gets a bounded share:
 * a fixed number of requests per rolling minute and a cap on requests in flight.
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
    const now = this.#now();
    const state = this.#keys.get(key) ?? { starts: [], inFlight: 0 };
    state.starts = state.starts.filter(start => now - start < WINDOW_MS);
    // Re-inserting keeps the map in least-recently-used order for eviction.
    this.#keys.delete(key);
    this.#keys.set(key, state);
    this.#evict();
    const oldest = state.starts[0];
    if (state.starts.length >= this.#maxPerWindow && oldest !== undefined) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) };
    }
    if (state.inFlight >= this.#maxInFlight) {
      return { allowed: false, retryAfterSeconds: 1 };
    }
    state.starts.push(now);
    state.inFlight += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (!released) {
          released = true;
          state.inFlight -= 1;
        }
      },
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
