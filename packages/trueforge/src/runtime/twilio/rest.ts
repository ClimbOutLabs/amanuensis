import type { TwilioSettings } from '../../config';
import { fetchPublicUrl, type ResolveAddresses } from '../publicFetch';

const REQUEST_TIMEOUT_MS = 15_000;

interface TwilioReply {
  status: number;
  text: () => Promise<string>;
}

/** Twilio's REST API, reached like any outside address. Texts and calls use the same one. */
export type TwilioFetch = (input: {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array<ArrayBuffer>;
}) => Promise<TwilioReply>;

export function publicTwilioFetch(resolveAddresses: ResolveAddresses | undefined): TwilioFetch {
  return async ({ method, url, headers, body }) => {
    const result = await fetchPublicUrl(url, {
      fetchImpl: undefined,
      resolveAddresses,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      allowHop: undefined,
      describe: () => 'Twilio could not be reached.',
    });
    const text = await result.response.text().catch(() => '');
    await result.release();
    return { status: result.response.status, text: () => Promise.resolve(text) };
  };
}

/** Twilio's error code in a refusal, never its message, which can hold the number. */
export function twilioErrorCode(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'code' in parsed && typeof parsed.code === 'number') {
      return parsed.code;
    }
  } catch {
    // An answer that is not JSON has no code to read.
  }
  return undefined;
}

/** Why Twilio refused a request: its sign-in details, or anything else. */
export function twilioRefusal(status: number): 'not_accepted' | 'unreachable' {
  return status === 401 || status === 403 ? 'not_accepted' : 'unreachable';
}

/** The account's REST address and the headers that sign in with the account's own details. */
export function twilioAccount(settings: Pick<TwilioSettings, 'accountSid' | 'authToken'>): {
  url: string;
  headers: Record<string, string>;
} {
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(settings.accountSid)}`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString('base64')}`,
      Accept: 'application/json',
    },
  };
}

/** Posts a form to one of the account's REST resources. */
export function postTwilioForm({
  fetchTwilio,
  settings,
  resource,
  form,
}: {
  fetchTwilio: TwilioFetch;
  settings: Pick<TwilioSettings, 'accountSid' | 'authToken'>;
  /** The resource under the account, such as `Messages.json`. */
  resource: string;
  form: URLSearchParams;
}): Promise<TwilioReply> {
  const account = twilioAccount(settings);
  return fetchTwilio({
    method: 'POST',
    url: `${account.url}/${resource}`,
    headers: { ...account.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new TextEncoder().encode(form.toString()),
  });
}
