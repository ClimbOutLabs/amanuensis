import { z } from 'zod';

import type { TwilioSettings } from '../../config';
import type { ResolveAddresses } from '../publicFetch';
import {
  postTwilioForm,
  publicTwilioFetch,
  twilioAccount,
  twilioErrorCode,
  twilioRefusal,
  type TwilioFetch,
} from '../twilio/rest';

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

/** Why the server could not point its Twilio number's incoming texts at itself. */
export type PointNumberFailure = 'number_not_found' | 'not_accepted' | 'unreachable';

/** What happened when the server pointed its Twilio number's incoming texts at itself, and whose address it replaced. */
export type PointNumberResult =
  { result: 'updated'; replaced_host: string | null } | { result: 'already_set' } | { result: PointNumberFailure };

/** What a failure to point the number means, ending with the one thing for whoever runs Aman to do. */
export function pointNumberWords(failure: PointNumberFailure): string {
  switch (failure) {
    case 'number_not_found':
      return 'Aman could not find its number in the Twilio account, so STOP replies do not reach it. Set TWILIO_FROM_NUMBER to one of your Twilio numbers.';
    case 'not_accepted':
      return 'Twilio did not accept the sign-in details, so STOP replies do not reach Aman. Copy TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN again.';
    case 'unreachable':
      return 'Twilio could not be reached, so STOP replies may not reach Aman. Start Aman again later.';
  }
}

/**
 * What to do with each try at pointing the number: keep the problem Reach me shows, set while it failed and cleared
 * once a try works, and log what happened. A replaced address is logged by its host only.
 */
export function reportPointing({
  logger,
  setProblem,
}: {
  logger: { info: (message: string, meta: object) => unknown; warn: (message: string, meta: object) => unknown };
  setProblem: (problem: PointNumberFailure | undefined) => void;
}): (pointed: PointNumberResult) => void {
  return pointed => {
    if (pointed.result === 'updated') {
      setProblem(undefined);
      // Another app or Aman that used this number stops getting its incoming texts; the host says which one.
      logger.info('The Twilio number now sends its incoming texts to this server', {
        result: pointed.result,
        replaced_host: pointed.replaced_host,
      });
    } else if (pointed.result === 'already_set') {
      setProblem(undefined);
      logger.info('The Twilio number sends its incoming texts to this server', { result: pointed.result });
    } else {
      setProblem(pointed.result);
      logger.warn(`The Twilio number could not be pointed at this server. ${pointNumberWords(pointed.result)}`, {
        result: pointed.result,
      });
    }
  };
}

/** Points the Twilio number at this server, and only it, at `smsUrl` for incoming texts. */
export interface NumberPointer {
  pointNumberAt(input: { smsUrl: string }): Promise<PointNumberResult>;
}

const FIRST_RETRY_MS = 30_000;
const LONGEST_RETRY_MS = 60 * 60_000;

/**
 * Points the number, and while Twilio cannot be reached tries again with waits that double up to an hour, so a short
 * outage at start does not leave STOP replies unheard until the next restart. A failure only the person who runs Aman
 * can fix is not tried again. Each try is reported, so the problem shown in Reach me clears once one works.
 */
export async function pointNumberWithRetry({
  provider,
  smsUrl,
  onResult,
  wait,
}: {
  provider: NumberPointer;
  smsUrl: string;
  onResult: (pointed: PointNumberResult) => void;
  wait: (ms: number) => Promise<void>;
}): Promise<void> {
  let delay = FIRST_RETRY_MS;
  for (;;) {
    const pointed = await provider.pointNumberAt({ smsUrl });
    onResult(pointed);
    if (pointed.result !== 'unreachable') {
      return;
    }
    await wait(delay);
    delay = Math.min(delay * 2, LONGEST_RETRY_MS);
  }
}

/** The host of the address a number used before, for the log; never the whole address, which can hold a token. */
function hostOf(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** What Twilio answers with when it will not send; only the error code is read, never its message, which can hold the number. */
const OPTED_OUT_CODES = new Set([21610]);
const INVALID_NUMBER_CODES = new Set([21211, 21214, 21217, 21408, 21614, 21612]);

/** One of the account's numbers as Twilio lists it. Only these fields are read, and the id must look like one. */
const TwilioNumberSchema = z.object({
  sid: z.string().regex(/^PN[0-9a-fA-F]{32}$/),
  phone_number: z.string(),
  sms_url: z.string().nullish(),
  sms_method: z.string().nullish(),
});

const TwilioNumberListSchema = z.object({ incoming_phone_numbers: z.array(z.unknown()) });

type TwilioNumber = z.infer<typeof TwilioNumberSchema>;

/** The one entry for this number in Twilio's list of the account's numbers. */
function numberEntry({ text, fromNumber }: { text: string; fromNumber: string }): TwilioNumber | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = TwilioNumberListSchema.safeParse(parsed);
  if (!list.success) {
    return undefined;
  }
  for (const entry of list.data.incoming_phone_numbers) {
    const number = TwilioNumberSchema.safeParse(entry);
    if (number.success && number.data.phone_number === fromNumber) {
      return number.data;
    }
  }
  return undefined;
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
}): SmsProvider & NumberPointer {
  const { url: account, headers } = twilioAccount(settings);
  return {
    // So nobody has to set it by hand in the Twilio console. A number already pointed there, or not in the account,
    // is left alone.
    async pointNumberAt({ smsUrl }) {
      try {
        const lookup = await fetchTwilio({
          method: 'GET',
          url: `${account}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: settings.fromNumber }).toString()}`,
          headers,
        });
        if (lookup.status !== 200) {
          return { result: twilioRefusal(lookup.status) };
        }
        const entry = numberEntry({ text: await lookup.text(), fromNumber: settings.fromNumber });
        if (entry === undefined) {
          return { result: 'number_not_found' };
        }
        if (entry.sms_url === smsUrl && entry.sms_method === 'POST') {
          return { result: 'already_set' };
        }
        const update = await postTwilioForm({
          fetchTwilio,
          settings,
          resource: `IncomingPhoneNumbers/${entry.sid}.json`,
          form: new URLSearchParams({ SmsUrl: smsUrl, SmsMethod: 'POST' }),
        });
        return update.status >= 200 && update.status < 300
          ? { result: 'updated', replaced_host: entry.sms_url === smsUrl ? null : hostOf(entry.sms_url) }
          : { result: twilioRefusal(update.status) };
      } catch {
        return { result: 'unreachable' };
      }
    },

    async send({ to, body }) {
      const form = new URLSearchParams({ To: to, From: settings.fromNumber, Body: body });
      try {
        const reply = await postTwilioForm({ fetchTwilio, settings, resource: 'Messages.json', form });
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
          failure: twilioRefusal(reply.status),
        };
      } catch {
        return { outcome: 'failed', failure: 'unreachable' };
      }
    },
  };
}

/**
 * The line shown to the person for a failure, ending with the one thing to do. While asking for a code, a number
 * that replied STOP reads the same as one that cannot take texts, so the page never tells whether a number opted out.
 */
export function smsFailureWords({ failure, during }: { failure: SmsFailure; during: 'code' | 'delivery' }): string {
  switch (failure) {
    case 'opted_out':
    case 'invalid_number':
      if (during === 'code') {
        return 'That number cannot get texts from this server. Check the number, then try again.';
      }
      return failure === 'opted_out'
        ? 'This number replied STOP to the phone company. Reply START from that phone, then confirm the number again in Settings.'
        : 'The phone company would not take this number. Check it in Settings, Reach me.';
    case 'not_accepted':
      return during === 'code'
        ? 'Twilio did not accept this server’s sign-in details. Ask whoever runs Aman to check them.'
        : 'Twilio did not accept the sign-in details. Check the account id and auth token in the settings file.';
    case 'unreachable':
      return during === 'code'
        ? 'Twilio could not be reached. Try again in a few minutes.'
        : 'Twilio could not be reached, so no text was sent. Open the app to see the item.';
  }
}
