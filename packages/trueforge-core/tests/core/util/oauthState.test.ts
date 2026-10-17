import { generateOAuthState } from '../../../src/core/util/oauthState';

describe('generateOAuthState', () => {
  it('is 256 bits of base64url with no padding', () => {
    const state = generateOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(state, 'base64url')).toHaveLength(32);
  });

  it('is different every time', () => {
    const states = new Set(Array.from({ length: 200 }, () => generateOAuthState()));
    expect(states.size).toBe(200);
  });
});
