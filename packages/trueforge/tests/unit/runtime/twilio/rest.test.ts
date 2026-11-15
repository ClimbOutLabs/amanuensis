import {
  postTwilioForm,
  twilioAccount,
  twilioErrorCode,
  twilioRefusal,
  type TwilioFetch,
} from '../../../../src/runtime/twilio/rest';

const SETTINGS = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'synthetic-token' };

describe("Twilio's REST API", () => {
  it("reads only Twilio's error code from a refusal", () => {
    expect(twilioErrorCode(JSON.stringify({ code: 21211, message: 'The number +15550100 is not valid' }))).toBe(21211);
    expect(twilioErrorCode(JSON.stringify({ code: '21211' }))).toBeUndefined();
    expect(twilioErrorCode(JSON.stringify({ message: 'no code' }))).toBeUndefined();
    expect(twilioErrorCode('<html>Bad gateway</html>')).toBeUndefined();
  });

  it('tells a refused sign-in apart from anything else', () => {
    expect(twilioRefusal(401)).toBe('not_accepted');
    expect(twilioRefusal(403)).toBe('not_accepted');
    expect(twilioRefusal(400)).toBe('unreachable');
    expect(twilioRefusal(500)).toBe('unreachable');
  });

  it("signs in with the account's own details at the account's own address", () => {
    const account = twilioAccount(SETTINGS);
    expect(account.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SETTINGS.accountSid}`);
    expect(account.headers['Authorization']).toBe(
      `Basic ${Buffer.from(`${SETTINGS.accountSid}:synthetic-token`).toString('base64')}`,
    );
    expect(account.headers['Accept']).toBe('application/json');
    expect(twilioAccount({ ...SETTINGS, accountSid: 'AC/../x' }).url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC%2F..%2Fx',
    );
  });

  it('posts a form to a resource under the account', async () => {
    const sent: Parameters<TwilioFetch>[0][] = [];
    const fetchTwilio: TwilioFetch = input => {
      sent.push(input);
      return Promise.resolve({ status: 201, text: () => Promise.resolve('{}') });
    };
    const reply = await postTwilioForm({
      fetchTwilio,
      settings: SETTINGS,
      resource: 'Messages.json',
      form: new URLSearchParams({ To: '+15550100', Body: 'Hi & bye' }),
    });
    expect(reply.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SETTINGS.accountSid}/Messages.json`);
    expect(sent[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(sent[0]?.headers['Authorization']).toMatch(/^Basic /);
    expect(new TextDecoder().decode(sent[0]?.body)).toBe('To=%2B15550100&Body=Hi+%26+bye');
  });
});
