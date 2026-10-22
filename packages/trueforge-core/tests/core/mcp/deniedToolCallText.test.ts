import { deniedToolCallText } from '../../../src/core/mcp/ToolSet';
import { changeRequestReason } from '../../../src/core/permissions/changeRequest';

describe('deniedToolCallText', () => {
  it('hands a change request to the model as exactly the request sentence', () => {
    expect(deniedToolCallText(changeRequestReason('make it shorter'))).toBe(
      'The person asked for changes before approving: make it shorter. Make the changes and propose it again.',
    );
  });

  it('keeps the error wording for an ordinary denial', () => {
    expect(deniedToolCallText('not allowed')).toBe(JSON.stringify({ error: 'User denied tool call: not allowed' }));
    expect(deniedToolCallText(undefined)).toBe(JSON.stringify({ error: 'User denied tool call: no reason provided' }));
  });
});
