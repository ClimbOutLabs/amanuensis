import { mailSendOutcome } from '../../../../src/core/email/mailConnector/toolContract';

describe('mailSendOutcome', () => {
  it.each([
    'Email sent successfully to dana@example.com',
    'Email sent successfully to dana@example.com, sam@example.com with 2 attachment(s). Message-Id: <a@b>',
    'Email forwarded successfully to dana@example.com. Message-Id: <a@b>',
    'Email delivery [succeeded: dana@example.com; message-id: <a@b>; sent-copy: failed (Sent); warning: reconciliation needed]',
    'Email delivery [succeeded: dana@example.com, sam@example.com; message-id: <a@b>; sent-copy: unknown (Sent); warning: reconciliation needed]',
    'Email forward [succeeded: dana@example.com; message-id: <a@b>; sent-copy: failed; warning: reconciliation needed]',
  ])('says sent for %s', text => {
    expect(mailSendOutcome(text)).toBe('sent');
  });

  it.each([
    'Email delivery [failed: dana@example.com (rejected); sent-copy: skipped]',
    'Email delivery [unknown: dana@example.com; sent-copy: unknown; warning: reconciliation needed]',
    'Email delivery [succeeded: a@example.com; failed: b@example.com (rejected); sent-copy: succeeded]',
    'Email forward [succeeded: a@example.com; unknown: b@example.com; sent-copy: succeeded; warning: reconciliation needed]',
    'Email delivery [sent-copy: failed]',
    'Email delivery []',
    'Error: Recipient(s) not in allowlist',
    ' Email sent successfully to dana@example.com',
    '',
  ])('says not sent for %s', text => {
    expect(mailSendOutcome(text)).toBe('not_sent');
  });
});
