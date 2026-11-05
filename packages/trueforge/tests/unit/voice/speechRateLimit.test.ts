import { SpeechRateLimiter } from '../../../src/voice/speechRateLimit';

describe('SpeechRateLimiter', () => {
  it('allows a fixed number of requests per rolling minute', () => {
    let now = 0;
    const limiter = new SpeechRateLimiter({ maxPerWindow: 2, now: () => now });

    const first = limiter.acquire('alice');
    const second = limiter.acquire('alice');
    if (first.allowed) first.release();
    if (second.allowed) second.release();
    now = 10_000;
    const third = limiter.acquire('alice');

    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, false]);
    expect(third).toEqual({ allowed: false, retryAfterSeconds: 50 });
    now = 60_000;
    expect(limiter.acquire('alice').allowed).toBe(true);
  });

  it('caps requests in flight until they are released', () => {
    const limiter = new SpeechRateLimiter({ maxInFlight: 1 });

    const first = limiter.acquire('alice');
    expect(limiter.acquire('alice')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    if (first.allowed) {
      first.release();
      first.release();
    }
    expect(limiter.acquire('alice').allowed).toBe(true);
    expect(limiter.acquire('alice').allowed).toBe(false);
  });

  it('keeps each person separate', () => {
    const limiter = new SpeechRateLimiter({ maxPerWindow: 1 });

    expect(limiter.acquire('alice').allowed).toBe(true);
    expect(limiter.acquire('alice').allowed).toBe(false);
    expect(limiter.acquire('bob').allowed).toBe(true);
  });
});
