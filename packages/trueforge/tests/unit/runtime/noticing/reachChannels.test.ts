import { NO_PHONE_CHANNELS, reachChannelsFor } from '../../../../src/runtime/noticing/reachChannels';
import { pointNumberWords, type PointNumberFailure } from '../../../../src/runtime/texts/smsProvider';

describe('the phone channels this server offers', () => {
  it('offers no texts without Twilio, and says how to set them up', () => {
    expect(reachChannelsFor({ twilio: undefined, numberProblem: undefined })).toEqual(NO_PHONE_CHANNELS);
  });

  it('offers texts once Twilio is set up', () => {
    expect(reachChannelsFor({ twilio: { accountSid: 'AC' }, numberProblem: undefined }).texts).toEqual({
      available: true,
      note: 'Texts travel through Twilio and the phone company.',
    });
  });

  it('says so in Settings when the number could not be pointed at this server, with the one thing to do', () => {
    const problems: PointNumberFailure[] = ['number_not_found', 'not_accepted', 'unreachable'];
    for (const problem of problems) {
      expect(reachChannelsFor({ twilio: { accountSid: 'AC' }, numberProblem: problem }).texts).toEqual({
        available: true,
        note: `Texts travel through Twilio and the phone company. ${pointNumberWords(problem)}`,
      });
    }
  });
});
