import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import type { ApprovalDecision } from '../../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '../../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../../src/core/mcp/executeToolCalls';
import { createWebSearchTurnState } from '../../../../src/core/permissions/webSearch';
import { plainDraft } from './fixtures';
import { build, json } from './harness';

function draft(id: string): GmailMessage {
  return plainDraft({ id, threadId: 't9', to: 'grace@example.com', subject: 'Lease', body: 'Thursday works.' });
}

describe('an approved send whose wire arguments changed after the card', () => {
  async function dispatch(input: { wireArguments: Record<string, unknown> }) {
    const { tools, sentinel, google } = await build({
      features: ['gmail_read', 'gmail_compose'],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: draft('m1') }) : undefined),
        url => (url.pathname === '/gmail/v1/users/me/drafts/d2' ? json({ id: 'd2', message: draft('m2') }) : undefined),
        url => (url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined),
      ],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.tier).toBe(3);
    const message: InternalEnrichedAssistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'send_draft', arguments: JSON.stringify(input.wireArguments) },
          tool_info: info,
        },
      ],
    };
    const result = await executeToolCalls({
      assistantMessage: message,
      toolMapping: new Map([['send_draft', { toolSet: tools, originalToolName: 'send_draft' }]]),
      threadId: 'main',
      approvalDecisions: new Map<string, ApprovalDecision>([['call-1', { status: 'allow' }]]),
      memoState: createToolCallMemoState(),
      sentinel: {
        services: sentinel.services,
        web_search: createWebSearchTurnState(),
        identity: {
          tenant_id: sentinel.tenant_id,
          created_by: sentinel.created_by,
          conversation_id: sentinel.conversation_id,
          repository_id: null,
          workspace_cwd: null,
          agent_intent: null,
        },
      },
    });
    const outcome = result.toolCallResults[0];
    if (outcome === undefined) {
      throw new Error('expected one tool call result');
    }
    return { outcome, sends: google.urls.filter(entry => entry.includes('/drafts/send')).length };
  }

  it('refuses a different draft id, even one whose content matches the card, and sends nothing', async () => {
    const { outcome, sends } = await dispatch({ wireArguments: { draft_id: 'd2' } });
    expect(outcome.failure).toBe(true);
    expect(outcome.rawContent).toContain('Approval invalid');
    expect(sends).toBe(0);
  });

  it('refuses arguments the card did not cover, and sends nothing', async () => {
    const { outcome, sends } = await dispatch({ wireArguments: { draft_id: 'd1', review_hash: 'forged' } });
    expect(outcome.failure).toBe(true);
    expect(sends).toBe(0);
  });
});
