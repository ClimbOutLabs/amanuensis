import type { TwilioSettings } from '../../config';
import type { ReachAvailability } from '../../schemas/reach';
import { numberProblemWords, type ChannelViewer, type PointNumberFailure } from '../texts/smsProvider';
import { TEXTS_NOT_SET_UP } from '../texts/textWords';

/**
 * Which of the person's phone channels can be used on this server. Each channel reports itself here when it is set
 * up, and nothing else about noticing changes. Until phone calls exist, a call that survives the rules is delivered
 * as a nudge.
 */
export const NO_PHONE_CHANNELS: ReachAvailability = {
  texts: { available: false, note: TEXTS_NOT_SET_UP, problem: null },
  calls: { available: false, note: 'Phone calls are not set up yet.', problem: null },
};

/**
 * The channels this server offers: texts when Twilio is set up, and no calls until they exist. When the Twilio number
 * could not be pointed at this server, texts still go out, and the problem says, in words for the viewer, that STOP
 * replies do not reach Aman yet.
 */
export function reachChannelsFor({
  twilio,
  numberProblem,
  viewer,
}: {
  twilio: Pick<TwilioSettings, 'accountSid'> | undefined;
  numberProblem: PointNumberFailure | undefined;
  viewer: ChannelViewer;
}): ReachAvailability {
  if (twilio === undefined) {
    return NO_PHONE_CHANNELS;
  }
  return {
    ...NO_PHONE_CHANNELS,
    texts: {
      available: true,
      note: 'Texts travel through Twilio and the phone company.',
      problem: numberProblem === undefined ? null : numberProblemWords({ failure: numberProblem, viewer }),
    },
  };
}
