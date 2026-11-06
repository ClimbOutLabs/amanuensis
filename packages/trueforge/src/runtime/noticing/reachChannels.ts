import type { TwilioSettings } from '../../config';
import type { ReachAvailability } from '../../schemas/reach';
import { TEXTS_NOT_SET_UP } from '../texts/textWords';

/**
 * Which of the person's phone channels can be used on this server. Each channel reports itself here when it is set
 * up, and nothing else about noticing changes. Until phone calls exist, a call that survives the rules is delivered
 * as a nudge.
 */
export const NO_PHONE_CHANNELS: ReachAvailability = {
  texts: { available: false, note: TEXTS_NOT_SET_UP },
  calls: { available: false, note: 'Phone calls are not set up yet.' },
};

/** The channels this server offers: texts when Twilio is set up, and no calls until they exist. */
export function reachChannelsFor({
  twilio,
}: {
  twilio: Pick<TwilioSettings, 'accountSid'> | undefined;
}): ReachAvailability {
  if (twilio === undefined) {
    return NO_PHONE_CHANNELS;
  }
  return {
    ...NO_PHONE_CHANNELS,
    texts: { available: true, note: 'Texts travel through Twilio and the phone company.' },
  };
}
