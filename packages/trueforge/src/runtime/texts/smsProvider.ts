import type { TwilioSettings } from '../../config';
import { fetchPublicUrl, type ResolveAddresses } from '../publicFetch';

/** Why a text was not sent. The words for the person are written by whoever shows it. */
export type SmsFailure = 'opted_out' | 'invalid_number' | 'not_accepted' | 'unreachable';

export type SmsSendResult = { outcome: 'sent' } | { outcome: 'failed'; failure: SmsFailure };

/**
 * One way to send a text. A provider never throws: a failure comes back as a result, and what it says never carries
 * the number, the text or any credential.
 */
export interface SmsProvider {
  send(input: { to: string; body: string }): Promise<SmsSendResult>;
}

const SEND_TIMEOUT_MS = 15_000;

/** What Twilio answers with when it will not send; only the error code is read, never its message, which can hold the number. */
const OPTED_OUT_CODES = new Set([21610]);
const INVALID_NUMBER_CODES = new Set([21211, 21214, 21217, 21408, 21614, 21612]);

export interface TwilioReply {
  status: number;
  text: () => Promise<string>;
}
/** Twilio's REST API, reached like any outside address. Phone calls use the same one. */
export type TwilioFetch = (input: {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}) => Promise<TwilioReply>;

export function publicTwilioFetch(resolveAddresses: ResolveAddresses | undefined): TwilioFetch {
  return async ({ url, headers, body }) => {
    const result = await fetchPublicUrl(url, {
      fetchImpl: undefined,
      resolveAddresses,
      timeoutMs: SEND_TIMEOUT_MS,
      maxRedirects: 0,
      method: 'POST',
      headers,
      body,
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

/** The header every REST request to Twilio signs in with. */
export function twilioAuthorization(settings: Pick<TwilioSettings, 'accountSid' | 'authToken'>): string {
  return `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString('base64')}`;
}

/** Sends through Twilio's REST API. The address is checked like any outside address, and nothing here is logged. */
export function createTwilioSmsProvider({
  settings,
  resolveAddresses,
  fetchTwilio = publicTwilioFetch(resolveAddresses),
}: {
  settings: Pick<TwilioSettings, 'accountSid' | 'authToken' | 'fromNumber'>;
  /** DNS seam for tests. */
  resolveAddresses?: ResolveAddresses;
  fetchTwilio?: TwilioFetch;
}): SmsProvider {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(settings.accountSid)}/Messages.json`;
  const authorization = twilioAuthorization(settings);
  return {
    async send({ to, body }) {
      const form = new URLSearchParams({ To: to, From: settings.fromNumber, Body: body });
      try {
        const reply = await fetchTwilio({
          url,
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new TextEncoder().encode(form.toString()),
        });
        if (reply.status >= 200 && reply.status < 300) {
          return { outcome: 'sent' };
        }
        const code = twilioErrorCode(await reply.text());
        if (code !== undefined && OPTED_OUT_CODES.has(code)) {
          return { outcome: 'failed', failure: 'opted_out' };
        }
        if (code !== undefined && INVALID_NUMBER_CODES.has(code)) {
          return { outcome: 'failed', failure: 'invalid_number' };
        }
        return {
          outcome: 'failed',
          failure: reply.status === 401 || reply.status === 403 ? 'not_accepted' : 'unreachable',
        };
      } catch {
        return { outcome: 'failed', failure: 'unreachable' };
      }
    },
  };
}

/** The line shown to the person for a failure, ending with the one thing to do. */
export function smsFailureWords(failure: SmsFailure): string {
  switch (failure) {
    case 'opted_out':
      return 'This number replied STOP to the phone company. Reply START from that phone, then confirm the number again in Settings.';
    case 'invalid_number':
      return 'The phone company would not take this number. Check it in Settings, Reach me.';
    case 'not_accepted':
      return 'Twilio did not accept the sign-in details. Check the account id and auth token in the settings file.';
    case 'unreachable':
      return 'Twilio could not be reached, so no text was sent. Open the app to see the item.';
  }
}
