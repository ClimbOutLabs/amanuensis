import type { Logger } from 'winston';

import type { TwilioSettings } from '../config';
import { isOptOutWord, normalizePhoneNumber, type TextNumberService } from '../runtime/texts/textNumber';
import { EMPTY_TWIML, type TwilioWebhookRoute } from './listener';

export const INBOUND_SMS_PATH = '/twilio/sms';

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
  return {
    method: 'POST',
    path: INBOUND_SMS_PATH,
    async handle({ params }) {
      const account = params.get('AccountSid');
      if (account !== null && account !== settings.accountSid) {
        return { status: 403, body: EMPTY_TWIML };
      }
      const from = normalizePhoneNumber(params.get('From') ?? '');
      if (from !== undefined && isOptOutWord(params.get('Body') ?? '')) {
        const people = await textNumbers.stopNumber(from);
        // Only a count is logged: the number and the message are the person's.
        logger.info('A STOP turned texts off', { people });
      }
      return { status: 200, body: EMPTY_TWIML };
    },
  };
}
