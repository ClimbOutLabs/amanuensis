import { callFailureWords, createTwilioCallProvider } from '../../../../src/runtime/calls/twilioCalls';
import { PublicFetchError } from '../../../../src/runtime/publicFetch';
import type { TwilioFetch } from '../../../../src/runtime/twilio/rest';

const settings = {
  accountSid: `AC${'a'.repeat(32)}`,
  authToken: 'token-for-tests',
  fromNumber: '+15550100',
  webhookPublicUrl: 'https://aman.example.invalid',
};
const CALL_SID = `CA${'b'.repeat(32)}`;

function replying(
  status: number,
  body: unknown,
): { fetchTwilio: TwilioFetch; sent: { url: string; headers: Record<string, string>; form: URLSearchParams }[] } {
  const sent: { url: string; headers: Record<string, string>; form: URLSearchParams }[] = [];
  return {
    sent,
    fetchTwilio: ({ url, headers, body: bytes }) => {
      sent.push({ url, headers, form: new URLSearchParams(new TextDecoder().decode(bytes)) });
      return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
    },
  };
}

describe('starting a call through Twilio', () => {
  it('asks Twilio to ring, detect a voicemail, call back about this call, and hang up after at most 11 minutes', async () => {
    const t = replying(201, { sid: CALL_SID });
    const result = await createTwilioCallProvider({ settings, fetchTwilio: t.fetchTwilio }).place({
      to: '+15550111',
      call_id: 'call-1',
    });
    expect(result).toEqual({ outcome: 'started', call_sid: CALL_SID });
    const [request] = t.sent;
    expect(request?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Calls.json`);
    expect(request?.headers['Authorization']).toBe(
      `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString('base64')}`,
    );
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      To: '+15550111',
      From: '+15550100',
      Url: 'https://aman.example.invalid/twilio/voice?call=call-1',
      Method: 'POST',
      StatusCallback: 'https://aman.example.invalid/twilio/call-status?call=call-1',
      StatusCallbackMethod: 'POST',
      Timeout: '25',
      TimeLimit: '660',
      MachineDetection: 'DetectMessageEnd',
      MachineDetectionTimeout: '30',
    });
  });

  it('takes only a well-formed call id from Twilio, and otherwise cannot tell whether a call started', async () => {
    for (const body of [{ sid: 'CA123' }, { sid: `SM${'b'.repeat(32)}` }, {}, 'not json']) {
      const t = replying(201, body);
      expect(
        await createTwilioCallProvider({ settings, fetchTwilio: t.fetchTwilio }).place({ to: '+1', call_id: 'c' }),
      ).toEqual({ outcome: 'unknown' });
    }
  });

  it.each([
    [401, {}, 'not_accepted'],
    [403, {}, 'not_accepted'],
    [400, { code: 21211 }, 'invalid_number'],
    [400, { code: 13224 }, 'invalid_number'],
    [400, { code: 99999 }, 'unreachable'],
  ] as const)('reads a %s refusal with %j as %s', async (status, body, failure) => {
    const t = replying(status, body);
    expect(
      await createTwilioCallProvider({ settings, fetchTwilio: t.fetchTwilio }).place({ to: '+1', call_id: 'c' }),
    ).toEqual({
      outcome: 'failed',
      failure,
    });
  });

  it.each([500, 502, 503])('cannot tell whether a call started when Twilio answers %s', async status => {
    const t = replying(status, {});
    expect(
      await createTwilioCallProvider({ settings, fetchTwilio: t.fetchTwilio }).place({ to: '+1', call_id: 'c' }),
    ).toEqual({ outcome: 'unknown' });
  });

  const failing = (error: unknown) => createTwilioCallProvider({ settings, fetchTwilio: () => Promise.reject(error) });
  const withCode = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

  it.each([
    'ENOTFOUND',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
  ])('knows no call started when the request never reached Twilio (%s)', async code => {
    expect(await failing(withCode(code)).place({ to: '+1', call_id: 'c' })).toEqual({
      outcome: 'failed',
      failure: 'unreachable',
    });
  });

  it('knows no call started when the address was refused before any request', async () => {
    const error = new PublicFetchError({
      problem: { kind: 'lookup_failed', hostname: 'api.twilio.com' },
      message: 'Twilio could not be reached.',
      cause: undefined,
    });
    expect(await failing(error).place({ to: '+1', call_id: 'c' })).toEqual({
      outcome: 'failed',
      failure: 'unreachable',
    });
  });

  it.each([
    ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ['a reset', withCode('ECONNRESET')],
    ['a closed socket', withCode('UND_ERR_SOCKET')],
  ])('cannot tell whether a call started after %s, since the request may have been sent', async (_what, error) => {
    expect(await failing(error).place({ to: '+1', call_id: 'c' })).toEqual({ outcome: 'unknown' });
  });

  it('never throws, and what it says carries no number or credential', async () => {
    const result = await createTwilioCallProvider({
      settings,
      fetchTwilio: () => Promise.reject(new Error(`boom ${settings.authToken} +15550111`)),
    }).place({ to: '+15550111', call_id: 'c' });
    // The request may have reached Twilio before it failed, so whether the phone rings is not known.
    expect(result).toEqual({ outcome: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('5550111');
  });

  it('says what to do next for every failure', () => {
    expect(callFailureWords({ failure: 'invalid_number', test: true })).toBe(
      'The phone company would not call this number. Check it in Settings, Reach me.',
    );
    expect(callFailureWords({ failure: 'not_accepted', test: false })).toContain('Check the account id and auth token');
    expect(callFailureWords({ failure: 'unreachable', test: true })).toBe(
      'The call could not be started. Try again in 2 minutes.',
    );
    expect(callFailureWords({ failure: 'unreachable', test: false })).toBe(
      'The call could not be started. It was sent as a text and a notice instead.',
    );
  });
});
