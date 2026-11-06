import type { TwilioSettings } from '../../config';
import type { ReachAvailability } from '../../schemas/reach';
import { CALLS_NEED_VOICE, CALLS_NOT_SET_UP } from '../calls/phoneCalls';
import { pointNumberWords, type PointNumberFailure } from '../texts/smsProvider';
import { TEXTS_NOT_SET_UP } from '../texts/textWords';

/**
 * Which of the person's phone channels can be used on this server. Each channel reports itself here when it is set
 * up, and nothing else about noticing changes. While calls are not set up, a call that survives the rules is
 * delivered as a nudge.
 */
export const NO_PHONE_CHANNELS: ReachAvailability = {
  texts: { available: false, note: TEXTS_NOT_SET_UP },
  calls: { available: false, note: CALLS_NOT_SET_UP },
};

/** Shown beside Calls in Reach me settings, word for word. */
const CALLS_PRIVACY_NOTE =
  "Calls and texts travel through Twilio and the phone company. The assistant's voice and the transcript are made on your computer.";

/**
 * The channels this server offers: texts once Twilio is set up, and calls once the parts that listen and speak are
 * running too. Calls ring the number confirmed for texts. When the Twilio number could not be pointed at this server,
 * texts still go out, and the note says what to do so STOP replies reach it.
 */
export function reachChannelsFor({
  twilio,
  voiceReady,
  numberProblem,
}: {
  twilio: Pick<TwilioSettings, 'accountSid'> | undefined;
  voiceReady: boolean;
  numberProblem: PointNumberFailure | undefined;
}): ReachAvailability {
  if (twilio === undefined) {
    return NO_PHONE_CHANNELS;
  }
  const note = 'Texts travel through Twilio and the phone company.';
  return {
    texts: { available: true, note: numberProblem === undefined ? note : `${note} ${pointNumberWords(numberProblem)}` },
    calls: voiceReady ? { available: true, note: CALLS_PRIVACY_NOTE } : { available: false, note: CALLS_NEED_VOICE },
  };
}
