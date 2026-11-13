import { NO_PHONE_CHANNELS, reachChannelsFor } from '../../../../src/runtime/noticing/reachChannels';
import type { PointNumberFailure } from '../../../../src/runtime/texts/smsProvider';

describe('the phone channels this server offers', () => {
  it('offers no texts without Twilio, and says how to set them up', () => {
    expect(reachChannelsFor({ twilio: undefined, numberProblem: undefined, viewer: 'person' })).toEqual(
      NO_PHONE_CHANNELS,
    );
    expect(NO_PHONE_CHANNELS.texts.problem).toBeNull();
  });

  it('offers texts once Twilio is set up, with no problem', () => {
    expect(reachChannelsFor({ twilio: { accountSid: 'AC' }, numberProblem: undefined, viewer: 'owner' }).texts).toEqual(
      { available: true, note: 'Texts travel through Twilio and the phone company.', problem: null },
    );
  });

  it('says STOP replies do not reach Aman when the number could not be pointed here, in words for each viewer', () => {
    const problems: PointNumberFailure[] = ['number_not_found', 'not_accepted', 'unreachable'];
    for (const problem of problems) {
      const person = reachChannelsFor({ twilio: { accountSid: 'AC' }, numberProblem: problem, viewer: 'person' });
      expect(person.texts).toEqual({
        available: true,
        note: 'Texts travel through Twilio and the phone company.',
        problem: 'STOP replies do not reach Aman yet. Ask the person who runs Aman to check the Twilio settings.',
      });
      const owner = reachChannelsFor({ twilio: { accountSid: 'AC' }, numberProblem: problem, viewer: 'owner' });
      expect(owner.texts.problem).toMatch(/^STOP replies do not reach Aman yet\. /);
      expect(owner.texts.problem).not.toMatch(/TWILIO_/);
    }
    expect(
      reachChannelsFor({ twilio: { accountSid: 'AC' }, numberProblem: 'not_accepted', viewer: 'owner' }).texts.problem,
    ).toBe(
      'STOP replies do not reach Aman yet. Twilio did not accept the sign-in details. Copy the account id and auth token from the Twilio console into the settings file again, then start Aman again.',
    );
  });
});
