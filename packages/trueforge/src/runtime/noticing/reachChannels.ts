import type { ReachAvailability } from '../../schemas/reach';

/**
 * Which of the person's phone channels can be used on this server, until texts and calls are set up: each later part
 * passes its own status in their place, and nothing else about noticing changes. A call that survives the rules is
 * delivered as a nudge meanwhile.
 */
export const NO_PHONE_CHANNELS: ReachAvailability = {
  texts: { available: false, note: 'Texts are not set up yet.' },
  calls: { available: false, note: 'Phone calls are not set up yet.' },
};
