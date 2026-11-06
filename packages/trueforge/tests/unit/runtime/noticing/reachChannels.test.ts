import { CALLS_NEED_VOICE, CALLS_NOT_SET_UP } from '../../../../src/runtime/calls/phoneCalls';
import { NO_PHONE_CHANNELS, reachChannelsFor } from '../../../../src/runtime/noticing/reachChannels';
import { pointNumberWords, type PointNumberFailure } from '../../../../src/runtime/texts/smsProvider';

const twilio = { accountSid: `AC${'a'.repeat(32)}` };

describe('the phone channels this server offers', () => {
  it('offers neither without Twilio, and says how to set them up', () => {
    const channels = reachChannelsFor({ twilio: undefined, voiceReady: true, numberProblem: undefined });
    expect(channels.texts.available).toBe(false);
    expect(channels.calls).toEqual({ available: false, note: CALLS_NOT_SET_UP });
  });

  it('offers texts but not calls while the voice parts are not running, and says what to start', () => {
    const channels = reachChannelsFor({ twilio, voiceReady: false, numberProblem: undefined });
    expect(channels.texts.available).toBe(true);
    expect(channels.calls).toEqual({ available: false, note: CALLS_NEED_VOICE });
  });

  it('offers both once Twilio is set up and the voice parts are running', () => {
    const channels = reachChannelsFor({ twilio, voiceReady: true, numberProblem: undefined });
    expect(channels.texts.available).toBe(true);
    expect(channels.calls.available).toBe(true);
    expect(channels.calls.note).toContain('Twilio');
  });

  it('offers no texts without Twilio, and says how to set them up', () => {
    expect(reachChannelsFor({ twilio: undefined, voiceReady: true, numberProblem: undefined })).toEqual(
      NO_PHONE_CHANNELS,
    );
  });

  it('offers texts once Twilio is set up', () => {
    expect(
      reachChannelsFor({ twilio: { accountSid: 'AC' }, voiceReady: true, numberProblem: undefined }).texts,
    ).toEqual({
      available: true,
      note: 'Texts travel through Twilio and the phone company.',
    });
  });

  it('says so in Settings when the number could not be pointed at this server, with the one thing to do', () => {
    const problems: PointNumberFailure[] = ['number_not_found', 'not_accepted', 'unreachable'];
    for (const problem of problems) {
      expect(
        reachChannelsFor({ twilio: { accountSid: 'AC' }, voiceReady: true, numberProblem: problem }).texts,
      ).toEqual({
        available: true,
        note: `Texts travel through Twilio and the phone company. ${pointNumberWords(problem)}`,
      });
    }
  });
});
