import { CALLS_NEED_VOICE, CALLS_VOICE_OUT_OF_DATE } from '../../../../src/runtime/calls/callVoiceReady';
import { CALLS_NOT_SET_UP } from '../../../../src/runtime/calls/phoneCalls';
import { NO_PHONE_CHANNELS, reachChannelsFor } from '../../../../src/runtime/noticing/reachChannels';
import type { PointNumberFailure } from '../../../../src/runtime/texts/smsProvider';

const twilio = { accountSid: `AC${'a'.repeat(32)}` };

describe('the phone channels this server offers', () => {
  it('offers neither without Twilio, and says how to set them up', () => {
    const channels = reachChannelsFor({
      twilio: undefined,
      voice: 'ready',
      numberProblem: undefined,
      viewer: 'person',
    });
    expect(channels.texts.available).toBe(false);
    expect(channels.calls).toEqual({ available: false, note: CALLS_NOT_SET_UP, problem: null });
  });

  it('offers texts but not calls while the voice parts are not running, and says what to start', () => {
    const channels = reachChannelsFor({ twilio, voice: 'not_running', numberProblem: undefined, viewer: 'person' });
    expect(channels.texts.available).toBe(true);
    expect(channels.calls).toEqual({ available: false, note: CALLS_NEED_VOICE, problem: null });
  });

  it('says the voice service is out of date when it is too old to check', () => {
    const channels = reachChannelsFor({ twilio, voice: 'out_of_date', numberProblem: undefined, viewer: 'person' });
    expect(channels.calls).toEqual({ available: false, note: CALLS_VOICE_OUT_OF_DATE, problem: null });
  });

  it('offers both once Twilio is set up and the voice parts are running', () => {
    const channels = reachChannelsFor({ twilio, voice: 'ready', numberProblem: undefined, viewer: 'person' });
    expect(channels.texts.available).toBe(true);
    expect(channels.calls.available).toBe(true);
    expect(channels.calls.note).toContain('Twilio');
  });

  it('offers no texts without Twilio, and says how to set them up', () => {
    expect(reachChannelsFor({ twilio: undefined, voice: 'ready', numberProblem: undefined, viewer: 'person' })).toEqual(
      NO_PHONE_CHANNELS,
    );
    expect(NO_PHONE_CHANNELS.texts.problem).toBeNull();
  });

  it('offers texts once Twilio is set up, with no problem', () => {
    expect(
      reachChannelsFor({ twilio: { accountSid: 'AC' }, voice: 'ready', numberProblem: undefined, viewer: 'owner' })
        .texts,
    ).toEqual({ available: true, note: 'Texts travel through Twilio and the phone company.', problem: null });
  });

  it('says STOP replies do not reach Aman when the number could not be pointed here, in words for each viewer', () => {
    const problems: PointNumberFailure[] = ['number_not_found', 'not_accepted', 'unreachable'];
    for (const problem of problems) {
      const person = reachChannelsFor({
        twilio: { accountSid: 'AC' },
        voice: 'ready',
        numberProblem: problem,
        viewer: 'person',
      });
      expect(person.texts).toEqual({
        available: true,
        note: 'Texts travel through Twilio and the phone company.',
        problem: 'STOP replies do not reach Aman yet. Ask the person who runs Aman to check the Twilio settings.',
      });
      const owner = reachChannelsFor({
        twilio: { accountSid: 'AC' },
        voice: 'ready',
        numberProblem: problem,
        viewer: 'owner',
      });
      expect(owner.texts.problem).toMatch(/^STOP replies do not reach Aman yet\. /);
      expect(owner.texts.problem).not.toMatch(/TWILIO_/);
    }
    expect(
      reachChannelsFor({
        twilio: { accountSid: 'AC' },
        voice: 'ready',
        numberProblem: 'not_accepted',
        viewer: 'owner',
      }).texts.problem,
    ).toBe(
      'STOP replies do not reach Aman yet. Twilio did not accept the sign-in details. Copy the account id and auth token from the Twilio console into the settings file again, then start Aman again.',
    );
  });
});
