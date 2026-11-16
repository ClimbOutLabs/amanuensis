import type { Logger } from 'winston';

import type { TwilioSettings } from '../config';
import { isOptOutWord, normalizePhoneNumber, type TextNumberService } from '../runtime/texts/textNumber';
import { EMPTY_TWIML, type TwilioWebhookRoute } from './listener';

export const INBOUND_SMS_PATH = '/twilio/sms';

/** How long a message id is remembered, and how many at most, so a request sent again is not acted on twice. */
const SEEN_FOR_MS = 24 * 60 * 60_000;
const SEEN_MAX = 10_000;

/**
 * Twilio posts every text sent to the number here. Replies are ignored except STOP and the other words Twilio
 * treats as STOP, which turn texts off for that number. The answer is always empty: Twilio sends its own
 * confirmation of a STOP, and Aman never writes back.
 */
export function inboundSmsRoute({
  settings,
  textNumbers,
  logger,
}: {
  settings: Pick<TwilioSettings, 'accountSid'>;
  textNumbers: Pick<TextNumberService, 'stopNumber'>;
  logger: Logger;
}): TwilioWebhookRoute {
  // In memory only: Twilio signs no time, so this stops a copied request from being replayed soon after, not forever.
  const seen = new Map<string, number>();
  const seenRecently = (messageSid: string): boolean => {
    const at = Date.now();
    for (const [sid, until] of seen) {
      if (until > at && seen.size < SEEN_MAX) {
        break;
      }
      seen.delete(sid);
    }
    return (seen.get(messageSid) ?? 0) > at;
  };
  return {
    method: 'POST',
    path: INBOUND_SMS_PATH,
    async handle({ params }) {
      const account = params.get('AccountSid');
      if (account !== null && account !== settings.accountSid) {
        return { status: 403, body: EMPTY_TWIML };
      }
      const messageSid = params.get('MessageSid');
      if (messageSid !== null && seenRecently(messageSid)) {
        return { status: 200, body: EMPTY_TWIML };
      }
      // Marked before the work starts, so a second copy arriving meanwhile is not acted on too. A request that fails is
      // forgotten again, so Twilio can still send it again.
      if (messageSid !== null) {
        seen.set(messageSid, Date.now() + SEEN_FOR_MS);
      }
      const from = normalizePhoneNumber(params.get('From') ?? '');
      if (from !== undefined && isOptOutWord(params.get('Body') ?? '')) {
        try {
          const people = await textNumbers.stopNumber(from);
          // Only a count is logged: the number and the message are the person's.
          logger.info('A STOP turned texts off', { people });
        } catch (error) {
          if (messageSid !== null) {
            seen.delete(messageSid);
          }
          throw error;
        }
      }
      return { status: 200, body: EMPTY_TWIML };
    },
  };
}
