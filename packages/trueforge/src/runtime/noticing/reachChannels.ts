import type { TwilioSettings } from '../../config';
import type { ReachAvailability } from '../../schemas/reach';
import type { PointNumberFailure } from '../texts/smsProvider';
import { TEXTS_NOT_SET_UP } from '../texts/textWords';

/** Who reads the words about a number that could not be pointed here: whoever runs Aman, or anyone else. */
export type ChannelViewer = 'owner' | 'person';

/**
 * What Reach me says when the number could not be pointed here. Whoever runs Aman gets the one thing to do, in words
 * the settings page can show; everyone else is told whom to ask. The setting names stay in the log.
 */
function numberProblemWords({ failure, viewer }: { failure: PointNumberFailure; viewer: ChannelViewer }): string {
  const lead = 'STOP replies do not reach Aman yet.';
  if (viewer === 'person') {
    return `${lead} Ask the person who runs Aman to check the Twilio settings.`;
  }
  switch (failure) {
    case 'number_not_found':
      return `${lead} Aman could not find its number in your Twilio account. Put one of your Twilio numbers in the settings file, then start Aman again.`;
    case 'not_accepted':
      return `${lead} Twilio did not accept the sign-in details. Copy the account id and auth token from the Twilio console into the settings file again, then start Aman again.`;
    case 'unreachable':
      return `${lead} Twilio could not be reached. Aman keeps trying by itself, so check again in a few minutes.`;
  }
}

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
