import { createLogger } from 'winston';
import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import type { ApprovalDecision } from '../../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '../../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../../src/core/mcp/executeToolCalls';
import { isCallToolResponseResult } from '../../../../src/core/mcp/IMCPServer';
import { createWebSearchTurnState } from '../../../../src/core/permissions/webSearch';
import { DeferredTool } from '../../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { builtInToolIndex } from '../../fixtures/toolIndex';
import { makeMockIMCPServer, OBJECT_INPUT_SCHEMA } from '../../harnessMocks';
import { plainDraft } from './fixtures';
import { build, json, text, type Route } from './harness';

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

describe('a send reached through call_tool on a connector', () => {
  it("becomes a direct send_draft call, so it gets the Gmail card instead of the connector's generic one", async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [] });
    const connector = makeMockIMCPServer({
      name: 'notes',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const deferred = new DeferredTool([connector], {
      tracing: NOOP_AGENT_TRACING,
      logger: createLogger({ silent: true }),
      index: (await builtInToolIndex([tools])).index,
    });
    const wrapper = { mcp_server: 'notes', tool_name: 'send_draft', input: { draft_id: 'd1' } };
    const { message } = await deferred.toDirectCalls({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'call_tool', arguments: JSON.stringify(wrapper) } }],
    });
    expect(message.tool_calls?.[0]?.function).toEqual({ name: 'send_draft', arguments: '{"draft_id":"d1"}' });
  });

  it('is not run by call_tool itself: the model is told to call send_draft directly', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url =>
          url.pathname === '/gmail/v1/users/me/drafts/d1'
            ? json({ id: 'd1', message: draft('Thursday works.') })
            : undefined,
        sendRoute,
      ],
    });
    const connector = makeMockIMCPServer({
      name: 'notes',
      preload: false,
      tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
    });
    const deferred = new DeferredTool([connector], {
      tracing: NOOP_AGENT_TRACING,
      logger: createLogger({ silent: true }),
      index: (await builtInToolIndex([tools])).index,
    });
    const response = await deferred.callTool({
      name: 'call_tool',
      arguments: { mcp_server: 'notes', tool_name: 'send_draft', input: { draft_id: 'd1' } },
    });
    if (!isCallToolResponseResult(response)) {
      throw new Error('expected a resolved response');
    }
    expect(response.result.isError).toBe(true);
    expect(text(response)).toContain('Call send_draft directly');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });
});
