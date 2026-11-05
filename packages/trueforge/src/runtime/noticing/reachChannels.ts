import type { ReachAvailability } from '../../schemas/reach';

/**
 * Which of the person's phone channels can be used on this server. Texts and calls are set up by later parts; each
 * passes its own status here when it exists, and nothing else about noticing changes. Until then both read as not
 * set up, and a call that survives the rules is delivered as a nudge.
 */
export type ReachChannels = ReachAvailability;

export const NO_PHONE_CHANNELS: ReachChannels = {
  texts: { available: false, note: 'Texts are not set up yet.' },
  calls: { available: false, note: 'Phone calls are not set up yet.' },
};
