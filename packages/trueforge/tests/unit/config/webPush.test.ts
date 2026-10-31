import { randomBytes } from 'node:crypto';

import { parseWebPushSettings } from '../../../src/config';

const publicKey = randomBytes(65).toString('base64url');
const privateKey = randomBytes(32).toString('base64url');
const subject = 'mailto:owner@example.invalid';

describe('parseWebPushSettings', () => {
  it('leaves push off when nothing is set', () => {
    expect(parseWebPushSettings({ publicKey: undefined, privateKey: '', subject: ' ' })).toBeUndefined();
  });

  it('accepts a full, well-formed set', () => {
    expect(parseWebPushSettings({ publicKey, privateKey, subject })).toEqual({ publicKey, privateKey, subject });
  });

  it('refuses a partial set and says what to do', () => {
    expect(() => parseWebPushSettings({ publicKey, privateKey: undefined, subject })).toThrow(/all be set/);
  });

  it('refuses keys of the wrong size and a bad contact', () => {
    expect(() => parseWebPushSettings({ publicKey: 'abc', privateKey, subject })).toThrow(/WEB_PUSH_PUBLIC_KEY/);
    expect(() => parseWebPushSettings({ publicKey, privateKey: 'abc', subject })).toThrow(/WEB_PUSH_PRIVATE_KEY/);
    expect(() => parseWebPushSettings({ publicKey, privateKey, subject: 'owner' })).toThrow(/WEB_PUSH_SUBJECT/);
  });
});
