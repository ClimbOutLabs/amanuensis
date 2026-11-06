import { CALLS_NEED_VOICE, CALLS_NOT_SET_UP } from '../../../../src/runtime/calls/phoneCalls';
import { reachChannelsFor } from '../../../../src/runtime/noticing/reachChannels';

const twilio = { accountSid: `AC${'a'.repeat(32)}` };

describe('the phone channels this server offers', () => {
  it('offers neither without Twilio, and says how to set them up', () => {
    const channels = reachChannelsFor({ twilio: undefined, voiceReady: true });
    expect(channels.texts.available).toBe(false);
    expect(channels.calls).toEqual({ available: false, note: CALLS_NOT_SET_UP });
  });

  it('offers texts but not calls while the voice parts are not running, and says what to start', () => {
    const channels = reachChannelsFor({ twilio, voiceReady: false });
    expect(channels.texts.available).toBe(true);
    expect(channels.calls).toEqual({ available: false, note: CALLS_NEED_VOICE });
  });

  it('offers both once Twilio is set up and the voice parts are running', () => {
    const channels = reachChannelsFor({ twilio, voiceReady: true });
    expect(channels.texts.available).toBe(true);
    expect(channels.calls.available).toBe(true);
    expect(channels.calls.note).toContain('Twilio');
  });
});
