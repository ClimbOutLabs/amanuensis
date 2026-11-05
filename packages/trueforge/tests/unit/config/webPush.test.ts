import { randomBytes } from 'node:crypto';

import { DEFAULT_WEB_PUSH_SUBJECT, parseWebPushSettings } from '../../../src/config';

const publicKey = randomBytes(65).toString('base64url');
const privateKey = randomBytes(32).toString('base64url');
const subject = 'mailto:owner@example.invalid';

describe('parseWebPushSettings', () => {
  it('leaves push off when nothing is set', () => {
    expect(parseWebPushSettings({ publicKey: undefined, privateKey: '', subject: ' ' })).toBeUndefined();
    expect(parseWebPushSettings({ publicKey: undefined, privateKey: undefined, subject })).toBeUndefined();
  });

  it('accepts a full, well-formed set', () => {
    expect(parseWebPushSettings({ publicKey, privateKey, subject })).toEqual({ publicKey, privateKey, subject });
  });

  it('names the project page, not the person, when no contact is set', () => {
    expect(parseWebPushSettings({ publicKey, privateKey, subject: undefined })).toEqual({
      publicKey,
      privateKey,
      subject: DEFAULT_WEB_PUSH_SUBJECT,
    });
    expect(DEFAULT_WEB_PUSH_SUBJECT).toMatch(/^https:\/\//);
  });

  it('refuses one key without the other and says what to do', () => {
    expect(() => parseWebPushSettings({ publicKey, privateKey: undefined, subject })).toThrow(/both be set/);
  });

  it('refuses keys of the wrong size and a bad contact', () => {
    expect(() => parseWebPushSettings({ publicKey: 'abc', privateKey, subject })).toThrow(/WEB_PUSH_PUBLIC_KEY/);
    expect(() => parseWebPushSettings({ publicKey, privateKey: 'abc', subject })).toThrow(/WEB_PUSH_PRIVATE_KEY/);
    expect(() => parseWebPushSettings({ publicKey, privateKey, subject: 'owner' })).toThrow(/WEB_PUSH_SUBJECT/);
  });
});
