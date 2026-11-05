import type { TwilioSettings } from '../../config';
import type { ReachAvailability } from '../../schemas/reach';

/**
 * Which of the person's phone channels can be used on this server. Each channel reports itself here when it is set
 * up, and nothing else about noticing changes. Until phone calls exist, a call that survives the rules is delivered
 * as a nudge.
 */
export type ReachChannels = ReachAvailability;

export const NO_PHONE_CHANNELS: ReachChannels = {
  texts: {
    available: false,
    note: 'Texts are not set up. To set them up, add your Twilio details to the settings file and restart Aman.',
  },
  calls: { available: false, note: 'Phone calls are not set up yet.' },
};

/** The channels this server offers: texts when Twilio is set up, and no calls until they exist. */
export function reachChannelsFor({
  twilio,
}: {
  twilio: Pick<TwilioSettings, 'accountSid'> | undefined;
}): ReachChannels {
  if (twilio === undefined) {
    return NO_PHONE_CHANNELS;
  }
  return {
    ...NO_PHONE_CHANNELS,
    texts: { available: true, note: 'Texts travel through Twilio and the phone company.' },
  };
}
