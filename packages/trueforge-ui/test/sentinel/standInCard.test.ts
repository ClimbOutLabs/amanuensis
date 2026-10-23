import { describe, expect, it } from 'vitest';

import { standInApprovalCard } from '@/sentinel/standInCard.js';

describe('standInApprovalCard', () => {
  it('lists who a call goes to and where it goes before its other arguments', () => {
    const card = standInApprovalCard({
      toolName: 'send_message',
      argsText: JSON.stringify({
        body: 'Bring the blue blanket.',
        subject: 'Picnic plans',
        webhook_url: 'https://hooks.example.test/picnic',
        to: 'robin@example.test',
      }),
      hostTarget: undefined,
    });
    expect(card.outbound_text).toBe(
      [
        'to: robin@example.test',
        'webhook_url: https://hooks.example.test/picnic',
        'body: Bring the blue blanket.',
        'subject: Picnic plans',
      ].join('\n'),
    );
  });

  it('reads a connector call through its wrapper', () => {
    const card = standInApprovalCard({
      toolName: 'call_tool',
      argsText: JSON.stringify({
        mcp_server: 'email-mcp',
        tool_name: 'draft_email',
        input: { subject: 'Picnic plans', cc: 'sam@example.test' },
      }),
      hostTarget: undefined,
    });
    expect(card.plain_what).toBe('Allow "draft email" on email-mcp?');
    expect(card.outbound_text).toBe('cc: sam@example.test\nsubject: Picnic plans');
  });

  it('ignores a connector name that is not text', () => {
    const card = standInApprovalCard({
      toolName: 'call_tool',
      argsText: JSON.stringify({ mcp_server: 7, tool_name: ['draft'], input: {} }),
      hostTarget: undefined,
    });
    expect(card.plain_what).toBe('Allow the assistant to use "call tool"?');
    expect(card.outbound_text).toBeNull();
  });
});
