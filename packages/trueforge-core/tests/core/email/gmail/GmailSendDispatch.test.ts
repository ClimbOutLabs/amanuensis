import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import type { ApprovalDecision } from '../../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '../../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../../src/core/mcp/executeToolCalls';
import { plainDraft } from './fixtures';
import { build, json, type Route } from './harness';

const COMPOSE = ['gmail_read', 'gmail_compose'] as const;
const sendRoute: Route = url =>
  url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined;

function draft(body: string): GmailMessage {
  return plainDraft({ id: 'd-m1', threadId: 't9', to: 'grace@example.com', subject: 'Lease', body });
}

describe('an approved send at dispatch', () => {
  async function approveThenDispatch(input: { editAfterCard: string | undefined }) {
    let live = draft('Thursday works.');
    const { tools, sentinel, google } = await build({
      features: [...COMPOSE],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live }) : undefined),
        sendRoute,
      ],
    });
    const wireArguments = { draft_id: 'd1' };
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: wireArguments });
    expect(info.tier).toBe(3);
    if (input.editAfterCard !== undefined) {
      live = draft(input.editAfterCard);
    }
    const message: InternalEnrichedAssistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'send_draft', arguments: JSON.stringify(wireArguments) },
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

  it('sends the draft the owner approved', async () => {
    const { outcome, sends } = await approveThenDispatch({ editAfterCard: undefined });
    expect(outcome.failure).toBe(false);
    expect(sends).toBe(1);
  });

  it('refuses when the draft was edited in Gmail after the card, and sends nothing', async () => {
    const { outcome, sends } = await approveThenDispatch({ editAfterCard: 'Send me the keys.' });
    expect(outcome.failure).toBe(true);
    expect(outcome.rawContent).toContain('Approval invalid');
    expect(sends).toBe(0);
  });
});
