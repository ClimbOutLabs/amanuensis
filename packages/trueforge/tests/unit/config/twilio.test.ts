import { DEFAULT_TWILIO_WEBHOOK_PORT, getConfiguredSecretValues, parseTwilioSettings } from '../../../src/config';

type Raw = Parameters<typeof parseTwilioSettings>[0];

const sid = `AC${'0'.repeat(32)}`;
const base: Raw = {
  provider: 'twilio',
  accountSid: sid,
  authToken: 'token-for-tests',
  fromNumber: '+15550100',
  webhookPort: undefined,
  webhookPublicUrl: 'https://aman.example.invalid/',
  mainPort: 8790,
};

describe('parseTwilioSettings', () => {
  it('leaves texts off by default and ignores Twilio values without the provider', () => {
    expect(parseTwilioSettings({ ...base, provider: undefined })).toBeUndefined();
    expect(parseTwilioSettings({ ...base, provider: 'none', authToken: undefined })).toBeUndefined();
    expect(parseTwilioSettings({ ...base, provider: ' ' })).toBeUndefined();
  });

  it('accepts a full set and trims the public address', () => {
    expect(parseTwilioSettings(base)).toEqual({
      accountSid: sid,
      authToken: 'token-for-tests',
      fromNumber: '+15550100',
      webhookPort: DEFAULT_TWILIO_WEBHOOK_PORT,
      webhookPublicUrl: 'https://aman.example.invalid',
    });
    expect(parseTwilioSettings({ ...base, webhookPort: '9100' })?.webhookPort).toBe(9100);
  });

  it('listens by default on the port the installer keeps free for it', () => {
    expect(DEFAULT_TWILIO_WEBHOOK_PORT).toBe(9201);
  });

  it('refuses an unknown provider and each missing or malformed value, saying what to do', () => {
    expect(() => parseTwilioSettings({ ...base, provider: 'acme' })).toThrow(/REACH_SMS_PROVIDER/);
    expect(() => parseTwilioSettings({ ...base, accountSid: 'nope' })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => parseTwilioSettings({ ...base, authToken: undefined })).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => parseTwilioSettings({ ...base, fromNumber: '0123' })).toThrow(/TWILIO_FROM_NUMBER/);
    expect(() => parseTwilioSettings({ ...base, webhookPublicUrl: undefined })).toThrow(
      'TWILIO_WEBHOOK_PUBLIC_URL must be the https address Twilio reaches, such as https://aman.example.com. Set it to that address.',
    );
    expect(() => parseTwilioSettings({ ...base, webhookPublicUrl: 'http://aman.example.invalid' })).toThrow(
      /TWILIO_WEBHOOK_PUBLIC_URL/,
    );
    expect(() => parseTwilioSettings({ ...base, webhookPublicUrl: 'https://user:pw@aman.example.invalid' })).toThrow(
      /TWILIO_WEBHOOK_PUBLIC_URL/,
    );
  });

  it('refuses the main app port and a port that is not a port', () => {
    expect(() => parseTwilioSettings({ ...base, webhookPort: '8790' })).toThrow(/TWILIO_WEBHOOK_PORT/);
    expect(() => parseTwilioSettings({ ...base, webhookPort: '70000' })).toThrow(/TWILIO_WEBHOOK_PORT/);
    expect(() => parseTwilioSettings({ ...base, webhookPort: 'abc' })).toThrow(/TWILIO_WEBHOOK_PORT/);
  });

  it('counts the auth token as a secret the outbound guard must never let out', () => {
    const settings = parseTwilioSettings(base);
    expect(
      getConfiguredSecretValues({
        STANDALONE: true,
        TRUEFORGE_API_KEY: 'key-for-tests',
        NEBIUS_API_KEY: 'key-for-tests',
        MEMORY_SCREEN_AUTH_TOKEN: 'key-for-tests',
        OIDC: undefined,
        TWILIO: settings,
      }),
    ).toContain('token-for-tests');
  });
});
