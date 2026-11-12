import {
  RecoveryAttemptLimiter,
  RecoveryKeyFormatError,
  generateRecoveryKey,
  normalizeRecoveryKey,
} from '../../../src/secrets/recoveryKey';

describe('recovery key', () => {
  it('is 8 groups of 6 digits and differs each time', () => {
    const first = generateRecoveryKey();
    expect(first).toMatch(/^\d{6}(-\d{6}){7}$/);
    expect(generateRecoveryKey()).not.toBe(first);
  });

  it('accepts the key typed with spaces or no separators', () => {
    const key = generateRecoveryKey();
    expect(normalizeRecoveryKey(key.replace(/-/g, ' '))).toBe(key);
    expect(normalizeRecoveryKey(key.replace(/-/g, ''))).toBe(key);
  });

  it.each(['123', `${'1'.repeat(47)}a`, '1'.repeat(49)])('rejects a mistyped key: %s', input => {
    expect(() => normalizeRecoveryKey(input)).toThrow(RecoveryKeyFormatError);
  });

  it('allows 5 failed attempts per 15 minutes', () => {
    let now = 0;
    const limiter = new RecoveryAttemptLimiter({ now: () => now });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.waitMs()).toBe(0);
      limiter.recordFailure();
    }
    expect(limiter.waitMs()).toBe(15 * 60_000);
    now = 15 * 60_000;
    expect(limiter.waitMs()).toBe(0);
  });
});
