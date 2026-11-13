import {
  createTwilioSmsProvider,
  pointNumberWithRetry,
  pointNumberWords,
  reportPointing,
  smsFailureWords,
  type PointNumberResult,
  type TwilioFetch,
} from '../../../../src/runtime/texts/smsProvider';

const settings = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'secret-token-for-tests', fromNumber: '+15550100' };

function reply(status: number, json: unknown) {
  return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(json)) });
}

describe('Twilio text provider', () => {
  it('posts the form to the account’s Messages address with basic auth', async () => {
    const fetchTwilio = jest.fn<ReturnType<TwilioFetch>, Parameters<TwilioFetch>>(() => reply(201, { sid: 'SM1' }));
    const provider = createTwilioSmsProvider({ settings, fetchTwilio });
    await expect(provider.send({ to: '+15550111', body: 'Hello there' })).resolves.toEqual({ outcome: 'sent' });
    const input = fetchTwilio.mock.calls[0]?.[0];
    if (input === undefined) {
      throw new Error('Twilio was not called.');
    }
    expect(input.method).toBe('POST');
    expect(input.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`);
    expect(input.headers['Authorization']).toBe(
      `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString('base64')}`,
    );
    const form = new URLSearchParams(new TextDecoder().decode(input.body ?? new Uint8Array()));
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
      const words = smsFailureWords({ failure, during: 'delivery' });
      expect(words).not.toContain(settings.authToken);
      expect(words).not.toContain('—');
      expect(words.length).toBeGreaterThan(20);
    }
    expect(smsFailureWords({ failure: 'unreachable', during: 'delivery' })).toBe(
      'Twilio could not be reached, so no text was sent. Open the app to see the item.',
    );
  });

  it('words a code that could not be sent the same for a number that replied STOP and one that does not exist', () => {
    const general = 'That number cannot get texts from this server. Check the number, then try again.';
    expect(smsFailureWords({ failure: 'opted_out', during: 'code' })).toBe(general);
    expect(smsFailureWords({ failure: 'invalid_number', during: 'code' })).toBe(general);
    expect(smsFailureWords({ failure: 'not_accepted', during: 'code' })).toBe(
      'Twilio did not accept this server’s sign-in details. Ask whoever runs Aman to check them.',
    );
    expect(smsFailureWords({ failure: 'unreachable', during: 'code' })).toBe(
      'Twilio could not be reached. Try again in a few minutes.',
    );
  });
});

describe('pointing the Twilio number at this server', () => {
  const PN = `PN${'a'.repeat(32)}`;
  const webhookUrl = 'https://aman.example.invalid/twilio/sms';

  function twilio(numbers: unknown[]) {
    return jest.fn<ReturnType<TwilioFetch>, Parameters<TwilioFetch>>(input =>
      input.method === 'GET' ? reply(200, { incoming_phone_numbers: numbers }) : reply(200, { sid: PN }),
    );
  }

  it('sets only that number’s incoming-message address, to the configured one', async () => {
    const fetchTwilio = twilio([{ sid: PN, phone_number: '+15550100', sms_url: 'https://old.example/x' }]);
    const provider = createTwilioSmsProvider({ settings, fetchTwilio });
    await expect(provider.pointNumberAt({ smsUrl: webhookUrl })).resolves.toEqual({
      result: 'updated',
      replaced_host: 'old.example',
    });
    const [lookup, update] = fetchTwilio.mock.calls.map(call => call[0]);
    expect(lookup?.method).toBe('GET');
    expect(lookup?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=%2B15550100`,
    );
    expect(update?.method).toBe('POST');
    expect(update?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/IncomingPhoneNumbers/${PN}.json`,
    );
    expect(Object.fromEntries(new URLSearchParams(new TextDecoder().decode(update?.body ?? new Uint8Array())))).toEqual(
      { SmsUrl: webhookUrl, SmsMethod: 'POST' },
    );
  });

  it('updates only the entry for exactly this number, when Twilio lists others first', async () => {
    const other = `PN${'b'.repeat(32)}`;
    const fetchTwilio = twilio([
      { sid: other, phone_number: '+155501000', sms_url: 'https://someone-else.example/sms' },
      { sid: PN, phone_number: '+15550100', sms_url: null },
    ]);
    await expect(
      createTwilioSmsProvider({ settings, fetchTwilio }).pointNumberAt({ smsUrl: webhookUrl }),
    ).resolves.toEqual({ result: 'updated', replaced_host: null });
    const posts = fetchTwilio.mock.calls.map(call => call[0]).filter(input => input.method === 'POST');
    expect(posts.map(input => input.url)).toEqual([
      `https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/IncomingPhoneNumbers/${PN}.json`,
    ]);
  });

  it('gives one thing to do for each way pointing the number can fail', () => {
    expect(pointNumberWords('number_not_found')).toBe(
      'Aman could not find its number in the Twilio account, so STOP replies do not reach it. Set TWILIO_FROM_NUMBER to one of your Twilio numbers.',
    );
    expect(pointNumberWords('not_accepted')).toBe(
      'Twilio did not accept the sign-in details, so STOP replies do not reach Aman. Copy TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN again.',
    );
    expect(pointNumberWords('unreachable')).toBe(
      'Twilio could not be reached, so STOP replies may not reach Aman. Start Aman again later.',
    );
  });

  it('changes nothing when the number already points here', async () => {
    const fetchTwilio = twilio([{ sid: PN, phone_number: '+15550100', sms_url: webhookUrl, sms_method: 'POST' }]);
    await expect(
      createTwilioSmsProvider({ settings, fetchTwilio }).pointNumberAt({ smsUrl: webhookUrl }),
    ).resolves.toEqual({ result: 'already_set' });
    expect(fetchTwilio).toHaveBeenCalledTimes(1);
  });

  it('touches nothing when the number is not in the account, or Twilio answers with something unexpected', async () => {
    const missing = twilio([]);
    await expect(
      createTwilioSmsProvider({ settings, fetchTwilio: missing }).pointNumberAt({ smsUrl: webhookUrl }),
    ).resolves.toEqual({ result: 'number_not_found' });
    const odd = twilio([{ sid: '../../Messages', phone_number: '+15550100', sms_url: '' }]);
    await expect(
      createTwilioSmsProvider({ settings, fetchTwilio: odd }).pointNumberAt({ smsUrl: webhookUrl }),
    ).resolves.toEqual({ result: 'number_not_found' });
    const refused = jest.fn<ReturnType<TwilioFetch>, Parameters<TwilioFetch>>(() => reply(401, { code: 20003 }));
    await expect(
      createTwilioSmsProvider({ settings, fetchTwilio: refused }).pointNumberAt({ smsUrl: webhookUrl }),
    ).resolves.toEqual({ result: 'not_accepted' });
    for (const fetchTwilio of [missing, odd, refused]) {
      expect(fetchTwilio.mock.calls.every(call => call[0].method === 'GET')).toBe(true);
    }
  });
});

describe('pointing the number again after Twilio could not be reached', () => {
  it('tries again with growing waits until Twilio answers, and reports each try', async () => {
    const answers: PointNumberResult[] = [{ result: 'unreachable' }, { result: 'unreachable' }];
    let call = 0;
    const waits: number[] = [];
    const results: string[] = [];
    await pointNumberWithRetry({
      provider: { pointNumberAt: () => Promise.resolve(answers[call++] ?? { result: 'already_set' }) },
      smsUrl: 'https://aman.example.invalid/twilio/sms',
      onResult: pointed => results.push(pointed.result),
      wait: ms => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(results).toEqual(['unreachable', 'unreachable', 'already_set']);
    expect(waits).toEqual([30_000, 60_000]);
  });

  it('does not try again when only the person who runs Aman can fix it', async () => {
    const waits: number[] = [];
    await pointNumberWithRetry({
      provider: { pointNumberAt: () => Promise.resolve({ result: 'not_accepted' }) },
      smsUrl: 'https://aman.example.invalid/twilio/sms',
      onResult: () => undefined,
      wait: ms => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([]);
  });
});

describe('reporting each try at pointing the number', () => {
  function reporter() {
    const problems: (string | undefined)[] = [];
    const logged: { level: string; message: string; meta: unknown }[] = [];
    const onResult = reportPointing({
      logger: {
        info: (message, meta) => logged.push({ level: 'info', message, meta }),
        warn: (message, meta) => logged.push({ level: 'warn', message, meta }),
      },
      setProblem: problem => problems.push(problem),
    });
    return { problems, logged, onResult };
  }

  it('keeps the problem while a try fails, and clears it once one works', () => {
    const { problems, logged, onResult } = reporter();
    onResult({ result: 'unreachable' });
    onResult({ result: 'not_accepted' });
    onResult({ result: 'updated', replaced_host: 'old.example.invalid' });
    onResult({ result: 'already_set' });
    expect(problems).toStrictEqual(['unreachable', 'not_accepted', undefined, undefined]);
    expect(logged.map(line => line.level)).toEqual(['warn', 'warn', 'info', 'info']);
    expect(logged[1]?.message).toBe(
      `The Twilio number could not be pointed at this server. ${pointNumberWords('not_accepted')}`,
    );
    expect(logged[2]?.meta).toEqual({ result: 'updated', replaced_host: 'old.example.invalid' });
  });
});
