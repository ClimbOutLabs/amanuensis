import {
  NEW_RECIPIENT_ACCOUNT_SWITCHED,
  NEW_RECIPIENT_REFUSED,
  SEND_LIST_STILL_UPDATING,
} from '../../../../src/core/email/mailConnector/sendListApproval';

describe('send list messages', () => {
  it('say the draft is still here and what to do next', () => {
    expect(NEW_RECIPIENT_REFUSED).toMatch(/nothing was sent/);
    expect(NEW_RECIPIENT_REFUSED).toMatch(/draft is still here/);
    expect(SEND_LIST_STILL_UPDATING).toMatch(/Try sending again/);
  });

  it('the account switch message says nothing was sent and to ask again from that account', () => {
    expect(NEW_RECIPIENT_ACCOUNT_SWITCHED).toMatch(/did not send/);
    expect(NEW_RECIPIENT_ACCOUNT_SWITCHED).toMatch(/Ask Aman to send it from that account/);
    expect(NEW_RECIPIENT_ACCOUNT_SWITCHED).not.toContain(';');
  });
});
