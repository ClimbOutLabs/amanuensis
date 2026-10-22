import { isMailSend, NEW_RECIPIENT_REFUSED } from '../../../../src/core/email/mailConnector/sendListApproval';

describe('isMailSend', () => {
  it('is true for a send through the Email connector under its real name', () => {
    expect(isMailSend({ mcp_server_name: 'Email', tool_name: 'send_email' })).toBe(true);
    expect(isMailSend({ mcp_server_name: 'Email', tool_name: 'forward_email' })).toBe(true);
  });

  it('is false for a read, for another server, and for a missing name', () => {
    expect(isMailSend({ mcp_server_name: 'Email', tool_name: 'list_emails_metadata' })).toBe(false);
    expect(isMailSend({ mcp_server_name: 'mail', tool_name: 'send_email' })).toBe(false);
    expect(isMailSend({ mcp_server_name: undefined, tool_name: 'send_email' })).toBe(false);
    expect(isMailSend({ mcp_server_name: 'Email', tool_name: undefined })).toBe(false);
  });

  it('is false for a model-facing clash name, which is never the real tool name', () => {
    expect(isMailSend({ mcp_server_name: 'Email', tool_name: 'send_email1' })).toBe(false);
  });
});

describe('send list messages', () => {
  it('say the draft is still there and what to do next', () => {
    expect(NEW_RECIPIENT_REFUSED).toMatch(/nothing was sent/);
    expect(NEW_RECIPIENT_REFUSED).toMatch(/draft is still here/);
  });
});
