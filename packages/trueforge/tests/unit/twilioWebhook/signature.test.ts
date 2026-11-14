import { twilioSignature, verifyTwilioSignature } from '../../../src/twilioWebhook/signature';

// The worked example in Twilio's own documentation for request validation.
const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const authToken = '12345';
const params = new URLSearchParams({
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675310',
  Digits: '1234',
  From: '+14158675310',
  To: '+18005551212',
});
const documented = 'GvWf1cFY/Q7PnoempGyD5oXAezc=';

describe('Twilio request signature', () => {
  it('matches the signature Twilio documents for its worked example', () => {
    expect(twilioSignature({ authToken, url, params })).toBe(documented);
    expect(verifyTwilioSignature({ authToken, url, params, signature: documented })).toBe(true);
  });

  it('does not depend on the order the fields arrive in', () => {
    const shuffled = new URLSearchParams([...params.entries()].reverse());
    expect(verifyTwilioSignature({ authToken, url, params: shuffled, signature: documented })).toBe(true);
  });

  it('refuses a missing, empty, wrong or different-length signature', () => {
    for (const signature of [undefined, null, '', 'nope', `${documented}A`, documented.slice(1)]) {
      expect(verifyTwilioSignature({ authToken, url, params, signature })).toBe(false);
    }
  });

  it('refuses a changed field, a changed address, a changed query and another token', () => {
    const changed = new URLSearchParams(params);
    changed.set('Digits', '9999');
    expect(verifyTwilioSignature({ authToken, url, params: changed, signature: documented })).toBe(false);
    expect(
      verifyTwilioSignature({
        authToken,
        url: 'https://evil.example/myapp.php?foo=1&bar=2',
        params,
        signature: documented,
      }),
    ).toBe(false);
    expect(
      verifyTwilioSignature({ authToken, url: 'https://mycompany.com/myapp.php?foo=1', params, signature: documented }),
    ).toBe(false);
    expect(verifyTwilioSignature({ authToken: '54321', url, params, signature: documented })).toBe(false);
  });
});
