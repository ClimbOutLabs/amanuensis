import { APPROVAL_EXPIRED_REASON_CODE, approvalExpiredReason } from '../../../src/core/permissions/approvalExpiry';
import { changeRequestReason } from '../../../src/core/permissions/changeRequest';
import { deniedToolCallRemediation, deniedToolCallText } from '../../../src/core/mcp/ToolSet';

describe('deniedToolCallText', () => {
  it('hands a change request to the model as exactly the request sentence', () => {
    expect(deniedToolCallText(changeRequestReason('make it shorter'))).toBe(
      'The person asked for changes before approving: make it shorter. Make the changes and propose it again.',
    );
  });

  it('tells the model firmly not to retry after a no, in the same error shape', () => {
    const text = deniedToolCallText(undefined);
    expect(JSON.parse(text)).toEqual({
      error:
        'The person said no to this. Do not try it again, with any wording, unless they ask for it. Answer with what you have, or ask them what they want.',
    });
    expect(JSON.parse(deniedToolCallText('not now'))).toEqual({
      error:
        'The person said no to this. Their reason: not now. Do not try it again, with any wording, unless they ask for it. Answer with what you have, or ask them what they want.',
    });
  });

  it('tells the model a card that expired unanswered was not turned down', () => {
    const text = deniedToolCallText(approvalExpiredReason());
    expect(text).toContain('They did not say no');
    expect(text).not.toContain('User denied');
  });

  it('marks only an expired card on the result, so the chat does not say the person said no', () => {
    expect(deniedToolCallRemediation(approvalExpiredReason())?.reason_code).toBe(APPROVAL_EXPIRED_REASON_CODE);
    expect(deniedToolCallRemediation('not now')).toBeUndefined();
    expect(deniedToolCallRemediation(undefined)).toBeUndefined();
  });
});
