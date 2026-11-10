import { SpeechRateLimiter, speechPersonKey } from '../../../src/voice/speechRateLimit';

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

  it('hands a freed place straight to the caller that waited longest, so a quick new request cannot take it', async () => {
    const limiter = new SpeechRateLimiter({ maxPerWindow: 50, maxInFlight: 1 });
    const first = limiter.acquire('alice');
    const waiting = limiter.acquireInFlightWaiting({
      key: 'alice',
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    if (first.allowed) first.release();
    // Before the woken caller has run, the place is already its own.
    expect(limiter.acquire('alice').allowed).toBe(false);
    const release = await waiting;
    release();
    expect(limiter.acquire('alice').allowed).toBe(true);
  });

  it('lets a voice conversation wait for the in-flight cap it shares, without spending the minute budget', async () => {
    const limiter = new SpeechRateLimiter({ maxPerWindow: 5, maxInFlight: 1 });
    const readAloud = limiter.acquire('alice');
    const waiting = limiter.acquireInFlightWaiting({
      key: 'alice',
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    if (readAloud.allowed) readAloud.release();
    const release = await waiting;
    // The conversation holds the one place; the minute budget was spent only by the read-aloud request.
    expect(limiter.acquire('alice')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    release();
    release();
    expect(
      (await limiter.acquireInFlightWaiting({ key: 'alice', signal: new AbortController().signal, timeoutMs: 50 }))
        .name,
    ).toBeDefined();
  });

  it('gives up waiting after the time allowed, or when the caller stops', async () => {
    const limiter = new SpeechRateLimiter({ maxInFlight: 1 });
    limiter.acquire('alice');
    await expect(
      limiter.acquireInFlightWaiting({ key: 'alice', signal: new AbortController().signal, timeoutMs: 30 }),
    ).rejects.toThrow();
    const stop = new AbortController();
    const waiting = limiter.acquireInFlightWaiting({ key: 'alice', signal: stop.signal, timeoutMs: 5_000 });
    stop.abort();
    await expect(waiting).rejects.toThrow();
  });

  it('serves waiting callers in the order they came', async () => {
    const limiter = new SpeechRateLimiter({ maxInFlight: 1 });
    const first = limiter.acquire('alice');
    const order: number[] = [];
    const never = new AbortController().signal;
    const second = limiter.acquireInFlightWaiting({ key: 'alice', signal: never, timeoutMs: 5_000 }).then(release => {
      order.push(2);
      release();
    });
    const third = limiter.acquireInFlightWaiting({ key: 'alice', signal: never, timeoutMs: 5_000 }).then(release => {
      order.push(3);
      release();
    });
    if (first.allowed) first.release();
    await Promise.all([second, third]);
    expect(order).toEqual([2, 3]);
  });

  it('keeps each person separate', () => {
    const limiter = new SpeechRateLimiter({ maxPerWindow: 1 });

    expect(limiter.acquire('alice').allowed).toBe(true);
    expect(limiter.acquire('alice').allowed).toBe(false);
    expect(limiter.acquire('bob').allowed).toBe(true);
  });
});

describe('the key of a person at the voice service', () => {
  it('is the same for the same person and differs between people and instances', () => {
    expect(speechPersonKey({ tenantId: 't', personId: 'p' })).toBe(speechPersonKey({ tenantId: 't', personId: 'p' }));
    expect(speechPersonKey({ tenantId: 't', personId: 'p' })).not.toBe(
      speechPersonKey({ tenantId: 't', personId: 'q' }),
    );
    expect(speechPersonKey({ tenantId: 't', personId: 'p' })).not.toBe(
      speechPersonKey({ tenantId: 'u', personId: 'p' }),
    );
  });
});
