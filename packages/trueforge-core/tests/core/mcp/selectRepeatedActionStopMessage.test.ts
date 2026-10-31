import { selectRepeatedActionStopMessage } from '../../../src/core/mcp/executeToolCalls';

const NONE = {
  repeatedDeniedApproval: false,
  repeatedSideEffects: false,
  blockedFallback: false,
  repeatedVerification: false,
  repeatedGithubFileRead: false,
};

describe('selectRepeatedActionStopMessage', () => {
  it('names GitHub only when the replayed read was actually a GitHub file read', () => {
    const message = selectRepeatedActionStopMessage({ ...NONE, repeatedGithubFileRead: true });
    expect(message).toContain('GitHub file read');
  });

  it('uses a generic read message for a repeated non-GitHub read, such as a host tool like list_spaces', () => {
    const message = selectRepeatedActionStopMessage({ ...NONE, repeatedGithubFileRead: false });
    expect(message).not.toContain('GitHub');
    expect(message).toContain('identical read-only call');
  });

  it('prioritizes the denied-approval message over every other cause', () => {
    const message = selectRepeatedActionStopMessage({
      repeatedDeniedApproval: true,
      repeatedSideEffects: true,
      blockedFallback: true,
      repeatedVerification: true,
      repeatedGithubFileRead: true,
    });
    expect(message).toContain('something you said no to');
  });

  it('prioritizes repeated side effects over a repeated read', () => {
    const message = selectRepeatedActionStopMessage({
      ...NONE,
      repeatedSideEffects: true,
      repeatedGithubFileRead: true,
    });
    expect(message).toContain('side-effecting action');
  });

  it('prioritizes a blocked private fallback over a repeated read', () => {
    const message = selectRepeatedActionStopMessage({ ...NONE, blockedFallback: true, repeatedGithubFileRead: true });
    expect(message).toContain('private repository content through a web tool');
  });

  it('prioritizes repeated verification over a repeated GitHub read', () => {
    const message = selectRepeatedActionStopMessage({
      ...NONE,
      repeatedVerification: true,
      repeatedGithubFileRead: true,
    });
    expect(message).toContain('completed verification');
  });
});
