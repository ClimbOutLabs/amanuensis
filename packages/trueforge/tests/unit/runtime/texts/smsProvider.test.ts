import { createTwilioSmsProvider, smsFailureWords } from '../../../../src/runtime/texts/smsProvider';

const settings = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'secret-token-for-tests', fromNumber: '+15550100' };

function reply(status: number, json: unknown) {
  return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(json)) });
}

describe('Twilio text provider', () => {
  it('posts the form to the account’s Messages address with basic auth', async () => {
    const fetchTwilio = jest.fn().mockImplementation(() => reply(201, { sid: 'SM1' }));
    const provider = createTwilioSmsProvider({ settings, fetchTwilio });
    await expect(provider.send({ to: '+15550111', body: 'Hello there' })).resolves.toEqual({ outcome: 'sent' });
    const [call] = fetchTwilio.mock.calls as [[{ url: string; headers: Record<string, string>; body: Uint8Array }]];
    const input = call[0];
    expect(input.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`);
    expect(input.headers['Authorization']).toBe(
      `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString('base64')}`,
    );
    const form = new URLSearchParams(new TextDecoder().decode(input.body));
    expect(Object.fromEntries(form)).toEqual({ To: '+15550111', From: '+15550100', Body: 'Hello there' });
  });

  it('reads only the error code, so a refusal is told apart without echoing Twilio’s words', async () => {
    const send = async (status: number, body: unknown) =>
      createTwilioSmsProvider({ settings, fetchTwilio: () => reply(status, body) }).send({
        to: '+15550111',
        body: 'x',
      });
    await expect(send(400, { code: 21610, message: 'The number +15550111 is unsubscribed' })).resolves.toEqual({
      outcome: 'failed',
      failure: 'opted_out',
    });
    await expect(send(400, { code: 21211 })).resolves.toEqual({ outcome: 'failed', failure: 'invalid_number' });
    await expect(send(401, { code: 20003 })).resolves.toEqual({ outcome: 'failed', failure: 'not_accepted' });
    await expect(send(500, 'not json')).resolves.toEqual({ outcome: 'failed', failure: 'unreachable' });
  });

  it('never throws, and nothing it returns carries the token, the number or the text', async () => {
    const provider = createTwilioSmsProvider({
      settings,
      fetchTwilio: () => Promise.reject(new Error(`boom ${settings.authToken} +15550111 secret words`)),
    });
    const result = await provider.send({ to: '+15550111', body: 'secret words' });
    expect(result).toEqual({ outcome: 'failed', failure: 'unreachable' });
    expect(JSON.stringify(result)).not.toMatch(/secret|5550111/);
  });

  it('words every failure with one next step and no credential', () => {
    for (const failure of ['opted_out', 'invalid_number', 'not_accepted', 'unreachable'] as const) {
      const words = smsFailureWords(failure);
      expect(words).not.toContain(settings.authToken);
      expect(words).not.toContain('—');
      expect(words.length).toBeGreaterThan(20);
    }
  });
});
