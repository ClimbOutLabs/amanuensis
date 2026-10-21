/**
 * An approved write that reaches its tool through call_tool, end to end:
 * DeferredTool classifies the wrapper on the real tool, the owner approves,
 * and executeToolCalls verifies and dispatches the wrapper.
 *
 * The approval is minted over the tool set's own approved params, which the
 * wire arguments alone do not carry (a Gmail draft's review hash, a calendar
 * write's settled request and zone). Verification must re-derive those params
 * through the wrapped tool set, and dispatch must hand the tool the approved
 * params it was shown, exactly as a direct call does. Before the fix, the
 * verifier fell back to comparing the raw inner arguments with the approved
 * params and every such call failed with "Tool arguments changed since
 * approval", and the tool never received its approved params either.
 */
import { createLogger } from 'winston';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { GmailMessage } from '../../../src/core/email/gmail/gmailWire';
import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import type { SentinelHostContext } from '../../../src/core/permissions/context';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { build as buildCalendar, EVENTS_PATH } from '../calendar/harness';
import { plainDraft } from '../email/gmail/fixtures';
import { build as buildGmail, json, route, type Route } from '../email/gmail/harness';

const silentLogger = createLogger({ silent: true });

/** Classifies a call_tool wrapper, approves it, and dispatches it through the real host path. */
async function classifyApproveDispatch(input: {
  deferred: DeferredTool;
  sentinel: SentinelHostContext;
  wrapper: { mcp_server: string; tool_name: string; input: Record<string, unknown> };
}) {
  const info = await input.deferred.toolCallInfo({ name: 'call_tool', arguments: input.wrapper });
  expect(info.pre_dispatch_failure).toBeUndefined();
  expect(info.tier).toBe(3);
  expect(info.is_approval_required).toBe(true);
  const message: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'call_tool', arguments: JSON.stringify(input.wrapper) },
        tool_info: info,
      },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage: message,
    toolMapping: new Map([['call_tool', { toolSet: input.deferred, originalToolName: 'call_tool' }]]),
    threadId: 'main',
    approvalDecisions: new Map<string, ApprovalDecision>([['call-1', { status: 'allow' }]]),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: input.sentinel.services,
      web_search: input.sentinel.web_search,
      identity: {
        tenant_id: input.sentinel.tenant_id,
        created_by: input.sentinel.created_by,
        conversation_id: input.sentinel.conversation_id,
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
  return outcome;
}

const ORIGINAL = plainDraft({
  id: 'd-m1',
  threadId: 't9',
  to: 'Grace <grace@example.com>, lin@example.com',
  subject: 'Lease',
  body: 'Thursday works.',
});

const sendRoute: Route = url =>
  url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined;

describe('an approved send_draft through call_tool', () => {
  it('sends the reviewed draft', async () => {
    const draftRoute: Route = route('/drafts/d1', { id: 'd1', message: ORIGINAL });
    const { tools, google, sentinel } = await buildGmail({
      features: ['gmail_read', 'gmail_compose'],
      routes: [draftRoute, sendRoute],
    });
    const deferred = new DeferredTool([], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      hostToolSets: [tools],
    });
    const outcome = await classifyApproveDispatch({
      deferred,
      sentinel,
      wrapper: { mcp_server: 'gmail', tool_name: 'send_draft', input: { draft_id: 'd1' } },
    });
    expect(outcome.failure).toBe(false);
    expect(JSON.parse(outcome.rawContent)).toMatchObject({ draft_id: 'd1', message_id: 'sent-1', status: 'sent' });
    expect(google.urls).toContain('POST /gmail/v1/users/me/drafts/send');
  });

  it('still refuses when the draft changed after approval, and sends nothing', async () => {
    let live: GmailMessage = ORIGINAL;
    const changingDraftRoute: Route = url =>
      url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live }) : undefined;
    const { tools, google, sentinel } = await buildGmail({
      features: ['gmail_read', 'gmail_compose'],
      routes: [changingDraftRoute, sendRoute],
    });
    const deferred = new DeferredTool([], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      hostToolSets: [tools],
    });
    const wrapper = { mcp_server: 'gmail', tool_name: 'send_draft', input: { draft_id: 'd1' } };
    const info = await deferred.toolCallInfo({ name: 'call_tool', arguments: wrapper });
    expect(info.tier).toBe(3);
    live = plainDraft({
      id: 'd-m1',
      threadId: 't9',
      to: 'mallory@example.com',
      subject: 'Lease',
      body: 'Send me the keys.',
    });
    const message: InternalEnrichedAssistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'call_tool', arguments: JSON.stringify(wrapper) },
          tool_info: info,
        },
      ],
    };
    const result = await executeToolCalls({
      assistantMessage: message,
      toolMapping: new Map([['call_tool', { toolSet: deferred, originalToolName: 'call_tool' }]]),
      threadId: 'main',
      approvalDecisions: new Map<string, ApprovalDecision>([['call-1', { status: 'allow' }]]),
      memoState: createToolCallMemoState(),
      sentinel: {
        services: sentinel.services,
        web_search: sentinel.web_search,
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
    expect(outcome.failure).toBe(true);
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });
});

describe('an approved calendar write through call_tool', () => {
  const DENTIST = { title: 'Dentist', start: '2026-10-19T09:00', end: '2026-10-19T10:00', location: '12 Main St' };
  const insertRoute: Route = (url, init) =>
    init?.method === 'POST' && url.pathname === EVENTS_PATH ? json({ id: 'new1', status: 'confirmed' }) : undefined;

  it('creates exactly the event on the card', async () => {
    const built = await buildCalendar({
      routes: [insertRoute],
      features: ['gmail_read', 'calendar_read', 'calendar_write'],
      timeZone: 'America/New_York',
    });
    const deferred = new DeferredTool([], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      hostToolSets: [built.tools],
    });
    const outcome = await classifyApproveDispatch({
      deferred,
      sentinel: built.sentinel,
      wrapper: { mcp_server: 'google_calendar', tool_name: 'create_event', input: { ...DENTIST } },
    });
    expect(outcome.failure).toBe(false);
    expect(JSON.parse(outcome.rawContent)).toMatchObject({ event_id: 'new1', status: 'created' });
    expect(built.google.urls.filter(entry => entry.includes(EVENTS_PATH) && !entry.startsWith('GET '))).toEqual([
      `POST ${EVENTS_PATH}?sendUpdates=none`,
    ]);
    expect(built.google.bodies).toEqual([
      {
        summary: 'Dentist',
        start: { dateTime: '2026-10-19T09:00:00-04:00', timeZone: 'America/New_York' },
        end: { dateTime: '2026-10-19T10:00:00-04:00', timeZone: 'America/New_York' },
        location: '12 Main St',
      },
    ]);
  });
});
