import type { TwilioSettings } from '../../config';
import type { ReachAvailability } from '../../schemas/reach';
import { CALLS_NEED_VOICE, CALLS_NOT_SET_UP } from '../calls/phoneCalls';
import { TEXTS_NOT_SET_UP } from '../texts/textWords';

/**
 * Which of the person's phone channels can be used on this server. Each channel reports itself here when it is set
 * up, and nothing else about noticing changes. While calls are not set up, a call that survives the rules is
 * delivered as a nudge.
 */
export type ReachChannels = ReachAvailability;

export const NO_PHONE_CHANNELS: ReachChannels = {
  texts: { available: false, note: TEXTS_NOT_SET_UP },
  calls: { available: false, note: CALLS_NOT_SET_UP },
};

/** Shown beside Calls in Reach me settings, word for word. */
const CALLS_PRIVACY_NOTE =
  "Calls and texts travel through Twilio and the phone company. The assistant's voice and the transcript are made on your computer.";

/**
 * The channels this server offers: texts once Twilio is set up, and calls once the parts that listen and speak are
 * running too. Calls ring the number confirmed for texts.
 */
export function reachChannelsFor({
  twilio,
  voiceReady,
}: {
  twilio: Pick<TwilioSettings, 'accountSid'> | undefined;
  voiceReady: boolean;
}): ReachChannels {
  if (twilio === undefined) {
    return NO_PHONE_CHANNELS;
  }
  return {
    texts: { available: true, note: 'Texts travel through Twilio and the phone company.' },
    calls: voiceReady ? { available: true, note: CALLS_PRIVACY_NOTE } : { available: false, note: CALLS_NEED_VOICE },
  };
}
