import { approvalExpiredReason } from '../../../src/core/permissions/approvalExpiry';
import { changeRequestReason } from '../../../src/core/permissions/changeRequest';
import { deniedToolCallText } from '../../../src/core/mcp/ToolSet';

describe('deniedToolCallText', () => {
  it('hands a change request to the model as exactly the request sentence', () => {
    expect(deniedToolCallText(changeRequestReason('make it shorter'))).toBe(
      'The person asked for changes before approving: make it shorter. Make the changes and propose it again.',
    );
  });

  it('keeps the error wording for an ordinary denial', () => {
    expect(deniedToolCallText('not allowed')).toBe(JSON.stringify({ error: 'User denied tool call: not allowed' }));
    expect(deniedToolCallText(undefined)).toBe(
      JSON.stringify({ error: 'User denied tool call: no reason provided' }),
    );
  });

  it('tells the model a card that expired unanswered was not turned down', () => {
    const text = deniedToolCallText(approvalExpiredReason());
    expect(text).toContain('They did not say no');
    expect(text).not.toContain('User denied');
  });
});
