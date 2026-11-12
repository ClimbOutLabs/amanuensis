import {
  NEW_RECIPIENT_REFUSED,
  SEND_LIST_STILL_UPDATING,
} from '../../../../src/core/email/mailConnector/sendListApproval';

describe('send list messages', () => {
  it('say the draft is still here and what to do next', () => {
    expect(NEW_RECIPIENT_REFUSED).toMatch(/nothing was sent/);
    expect(NEW_RECIPIENT_REFUSED).toMatch(/draft is still here/);
    expect(SEND_LIST_STILL_UPDATING).toMatch(/Try sending again/);
  });
});
