import type { TwilioFetch } from '../../src/runtime/twilio/rest';

export const FAKE_ACCOUNT_SID = `AC${'f'.repeat(32)}`;
export const FAKE_AUTH_TOKEN = 'fake-twilio-token-for-tests';
export const FAKE_CALL_SID = `CA${'e'.repeat(32)}`;
export const FAKE_NUMBER_SID = `PN${'d'.repeat(32)}`;

/** One request our code made to Twilio, with the form read back into fields. */
export interface TwilioRequest {
  method: 'GET' | 'POST';
  /** The address without the account's own path, such as `Messages.json`. */
  resource: string;
  query: Record<string, string>;
  form: Record<string, string>;
  /** Whether the request signed in with the fake account's own details. */
  signedIn: boolean;
}

/**
 * A pretend Twilio REST API that answers like the real one and records every request, so a test sees exactly what
 * would have gone out. Number lookups list one number that points at `smsUrl` and takes updates.
 */
export function fakeTwilio({ numbers = [] }: { numbers?: { phone_number: string; sms_url: string | null }[] } = {}): {
  fetchTwilio: TwilioFetch;
  requests: TwilioRequest[];
} {
  const requests: TwilioRequest[] = [];
  const reply = (status: number, body: unknown) =>
    Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
  const fetchTwilio: TwilioFetch = ({ method, url, headers, body }) => {
    const parsed = new URL(url);
    const prefix = `/2010-04-01/Accounts/${FAKE_ACCOUNT_SID}/`;
    const resource = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : parsed.pathname;
    requests.push({
      method,
      resource,
      query: Object.fromEntries(parsed.searchParams),
      form: Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body ?? new Uint8Array()))),
      signedIn:
        parsed.host === 'api.twilio.com' &&
        headers['Authorization'] ===
          `Basic ${Buffer.from(`${FAKE_ACCOUNT_SID}:${FAKE_AUTH_TOKEN}`).toString('base64')}`,
    });
    if (resource === 'Messages.json') {
      return reply(201, { sid: `SM${'1'.repeat(32)}`, status: 'queued' });
    }
    if (resource === 'Calls.json') {
      return reply(201, { sid: FAKE_CALL_SID, status: 'queued' });
    }
    if (resource === 'IncomingPhoneNumbers.json') {
      return reply(200, {
        incoming_phone_numbers: numbers.map(number => ({ sid: FAKE_NUMBER_SID, sms_method: 'POST', ...number })),
      });
    }
    if (resource === `IncomingPhoneNumbers/${FAKE_NUMBER_SID}.json`) {
      return reply(200, { sid: FAKE_NUMBER_SID });
    }
    return reply(404, { code: 20404 });
  };
  return { fetchTwilio, requests };
}
