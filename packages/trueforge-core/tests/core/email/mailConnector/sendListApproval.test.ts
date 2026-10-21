import {
  NEW_RECIPIENT_REFUSED,
  newRecipientsOfMailCall,
} from '../../../../src/core/email/mailConnector/sendListApproval';

const send = (args: Record<string, unknown>) => ({
  tool_name: 'send_email',
  mcp_server_name: 'Email',
  arguments: JSON.stringify(args),
});

describe('newRecipientsOfMailCall', () => {
  it('names each recipient the send would reach that is not on the list', () => {
    expect(
      newRecipientsOfMailCall(
        send({ recipients: ['Stranger@Example.net', 'dana@example.com'], cc: ['x@example.org'] }),
        ['dana@example.com'],
      ),
    ).toEqual(['stranger@example.net', 'x@example.org']);
  });

  it('is empty when every recipient is listed', () => {
    expect(newRecipientsOfMailCall(send({ recipients: ['dana@example.com'] }), ['dana@example.com'])).toEqual([]);
  });

  it('reads only the call arguments, so the list alone decides what is new', () => {
    expect(newRecipientsOfMailCall(send({ recipients: ['dana@example.com'] }), [])).toEqual(['dana@example.com']);
  });

  it('is empty for any tool that is not a mail send, and for a send on another connector', () => {
    expect(
      newRecipientsOfMailCall(
        { tool_name: 'save_draft', mcp_server_name: 'Email', arguments: '{"recipients":["a@b.co"]}' },
        [],
      ),
    ).toEqual([]);
    expect(
      newRecipientsOfMailCall(
        { tool_name: 'send_email', mcp_server_name: 'Other', arguments: '{"recipients":["a@b.co"]}' },
        [],
      ),
    ).toEqual([]);
  });

  it('treats arguments that are not an object as naming no recipient', () => {
    expect(
      newRecipientsOfMailCall({ tool_name: 'send_email', mcp_server_name: 'Email', arguments: '[1,2]' }, []),
    ).toEqual([]);
    expect(
      newRecipientsOfMailCall({ tool_name: 'send_email', mcp_server_name: 'Email', arguments: 'not json' }, []),
    ).toEqual([]);
  });

  it('says in plain words that nothing was sent and the draft is kept', () => {
    expect(NEW_RECIPIENT_REFUSED).toMatch(/nothing was sent/);
    expect(NEW_RECIPIENT_REFUSED).toMatch(/draft is still here/);
  });
});
