import { isMailSendSuccessText } from '../../../../src/core/email/mailConnector/toolContract';

describe('isMailSendSuccessText', () => {
  it.each([
    'Email sent successfully to dana@example.com',
    'Email sent successfully to dana@example.com, sam@example.com with 2 attachment(s). Message-Id: <a@b>',
    'Email forwarded successfully to dana@example.com. Message-Id: <a@b>',
  ])('accepts the sidecar clean success sentence: %s', text => {
    expect(isMailSendSuccessText(text)).toBe(true);
  });

  it.each([
    'Email delivery [dana@example.com: failed (rejected); sent-copy: skipped]',
    'Email delivery [dana@example.com: unknown; sent-copy: unknown; warning: reconciliation needed]',
    'Email forward [dana@example.com: succeeded; sent-copy: failed; warning: reconciliation needed]',
    'Error: Recipient(s) not in allowlist',
    ' Email sent successfully to dana@example.com',
    '',
  ])('rejects any other result: %s', text => {
    expect(isMailSendSuccessText(text)).toBe(false);
  });
});
