import { createLogger } from 'winston';
import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import type { ApprovalDecision } from '../../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '../../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../../src/core/mcp/executeToolCalls';
import { isCallToolResponseResult } from '../../../../src/core/mcp/IMCPServer';
import { createWebSearchTurnState } from '../../../../src/core/permissions/webSearch';
import { DeferredTool } from '../../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, OBJECT_INPUT_SCHEMA } from '../../harnessMocks';
import { plainDraft } from './fixtures';
import { build, json, text, type Route } from './harness';

const COMPOSE = ['gmail_read', 'gmail_compose'] as const;
const sendRoute: Route = url =>
  url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined;

function draft(body: string): GmailMessage {
  return plainDraft({ id: 'd-m1', threadId: 't9', to: 'grace@example.com', subject: 'Lease', body });
}

type Built = Awaited<ReturnType<typeof build>>;
type SendInfo = Awaited<ReturnType<Built['tools']['toolCallInfo']>>;

/** Runs one send_draft call the owner allowed on the card `info` describes, as the host would dispatch it. */
async function dispatchApproved(input: { built: Built; info: SendInfo; draftId: string }) {
  const { tools, sentinel, google } = input.built;
  const before = google.urls.filter(entry => entry.includes('/drafts/send')).length;
  const message: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'send_draft', arguments: JSON.stringify({ draft_id: input.draftId }) },
        tool_info: input.info,
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
  return { outcome, sends: google.urls.filter(entry => entry.includes('/drafts/send')).length - before };
}

describe('an approved send at dispatch', () => {
  async function approveThenDispatch(input: { editAfterCard: string | undefined }) {
    let live = draft('Thursday works.');
    const built = await build({
      features: [...COMPOSE],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live }) : undefined),
        sendRoute,
      ],
    });
    const info = await built.tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.tier).toBe(3);
    if (input.editAfterCard !== undefined) {
      live = draft(input.editAfterCard);
    }
    return dispatchApproved({ built, info, draftId: 'd1' });
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

describe('a draft rewritten after an approved send was refused', () => {
  const drafts = new Map<string, GmailMessage>();
  const draftRoute: Route = url => {
    const id = /^\/gmail\/v1\/users\/me\/drafts\/(d\d)$/.exec(url.pathname)?.[1];
    const message = id === undefined ? undefined : drafts.get(id);
    return id === undefined || message === undefined ? undefined : json({ id, message });
  };

  async function approvedThenRefused() {
    drafts.clear();
    drafts.set('d1', draft('Thursday works.'));
    const built = await build({ features: [...COMPOSE], routes: [draftRoute, sendRoute] });
    const approved = await built.tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(approved.tier).toBe(3);
    drafts.set('d1', draft('Thursday works, and here is the gate code.'));
    const refused = await dispatchApproved({ built, info: approved, draftId: 'd1' });
    expect(refused.outcome.failure).toBe(true);
    expect(refused.sends).toBe(0);
    return { built, approved };
  }

  it('cannot be sent on the earlier approval, under the same draft id', async () => {
    const { built, approved } = await approvedThenRefused();
    drafts.set('d1', draft('Thursday works.'));
    const retried = await dispatchApproved({ built, info: approved, draftId: 'd1' });
    expect(retried.outcome.failure).toBe(true);
    expect(retried.outcome.rawContent).toContain('already used');
    expect(retried.sends).toBe(0);
  });

  it('cannot be sent on the earlier approval as a new draft, even with the text that was approved', async () => {
    const { built, approved } = await approvedThenRefused();
    drafts.set('d2', draft('Thursday works.'));
    const rewritten = await dispatchApproved({ built, info: approved, draftId: 'd2' });
    expect(rewritten.outcome.failure).toBe(true);
    expect(rewritten.sends).toBe(0);
  });

  it('gets its own approval card, with its own approval', async () => {
    const { built, approved } = await approvedThenRefused();
    drafts.set('d2', draft('Thursday works, and here is the gate code.'));
    const card = await built.tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd2' } });
    expect(card.tier).toBe(3);
    expect(card.approval_token_id).toEqual(expect.any(String));
    expect(card.approval_token_id).not.toBe(approved.approval_token_id);
    expect(card.mint_canonical_params).not.toEqual(approved.mint_canonical_params);
    const sent = await dispatchApproved({ built, info: card, draftId: 'd2' });
    expect(sent.outcome.failure).toBe(false);
    expect(sent.sends).toBe(1);
  });
});

describe('a send reached through call_tool on a connector', () => {
  it('is not run: built-in tools never go through call_tool, so the model is told to call it directly', async () => {
    const { google } = await build({
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
      bundled: true,
    });
    const response = await deferred.callTool({
      name: 'call_tool',
      arguments: { mcp_server: 'notes', tool_name: 'send_draft', input: { draft_id: 'd1' } },
    });
    if (!isCallToolResponseResult(response)) {
      throw new Error('expected a resolved response');
    }
    expect(response.result.isError).toBe(true);
    expect(text(response)).toContain('called directly by its name');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });
});
