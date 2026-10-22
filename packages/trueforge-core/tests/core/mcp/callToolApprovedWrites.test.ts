/**
 * An approved write that reaches its tool through call_tool, end to end: the
 * wrapper becomes a direct call of the indexed tool, the tool set classifies it,
 * the owner approves, and executeToolCalls verifies and dispatches it.
 *
 * The approval is minted over the tool set's own approved params, which the
 * wire arguments alone do not carry (a Gmail draft's review hash, a calendar
 * write's settled request and zone). Verification must re-derive those params,
 * and dispatch must hand the tool the approved params it was shown, exactly as
 * a direct call does, because after the rewrite it is a direct call.
 */
import { createLogger } from 'winston';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { GmailMessage } from '../../../src/core/email/gmail/gmailWire';
import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import type { SentinelHostContext } from '../../../src/core/permissions/context';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { build as buildCalendar, EVENTS_PATH } from '../calendar/harness';
import { builtInToolIndex } from '../fixtures/toolIndex';
import { plainDraft } from '../email/gmail/fixtures';
import { build as buildGmail, json, route, type Route } from '../email/gmail/harness';

const silentLogger = createLogger({ silent: true });

/** Turns a call_tool wrapper into its direct call, classifies it, approves it, and dispatches it through the real host path. */
async function directCallOf(input: {
  toolSet: IToolSet;
  wrapper: { mcp_server: string; tool_name: string; input: Record<string, unknown> };
}) {
  const { index, converted } = await builtInToolIndex([input.toolSet]);
  const deferred = new DeferredTool([], { tracing: NOOP_AGENT_TRACING, logger: silentLogger, index });
  const { message } = await deferred.toDirectCalls({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'call_tool', arguments: JSON.stringify(input.wrapper) } },
    ],
  });
  const call = message.tool_calls?.[0];
  const mapped = call === undefined ? undefined : converted.toolMapping.get(call.function.name);
  if (call === undefined || mapped === undefined) {
    throw new Error('expected the wrapper to become a direct call of an indexed tool');
  }
  const info = await mapped.toolSet.toolCallInfo({ name: mapped.originalToolName, arguments: input.wrapper.input });
  return { call, info, toolMapping: converted.toolMapping };
}

async function dispatchApproved(input: {
  direct: Awaited<ReturnType<typeof directCallOf>>;
  sentinel: SentinelHostContext;
}) {
  const { call, info, toolMapping } = input.direct;
  const message: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [{ ...call, tool_info: info }],
  };
  const result = await executeToolCalls({
    assistantMessage: message,
    toolMapping,
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

async function classifyApproveDispatch(input: {
  toolSet: IToolSet;
  sentinel: SentinelHostContext;
  wrapper: { mcp_server: string; tool_name: string; input: Record<string, unknown> };
}) {
  const direct = await directCallOf({ toolSet: input.toolSet, wrapper: input.wrapper });
  expect(direct.call.function.name).toBe(input.wrapper.tool_name);
  expect(direct.info.pre_dispatch_failure).toBeUndefined();
  expect(direct.info.tier).toBe(3);
  expect(direct.info.is_approval_required).toBe(true);
  return dispatchApproved({ direct, sentinel: input.sentinel });
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
    const outcome = await classifyApproveDispatch({
      toolSet: tools,
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
    const wrapper = { mcp_server: 'gmail', tool_name: 'send_draft', input: { draft_id: 'd1' } };
    const direct = await directCallOf({ toolSet: tools, wrapper });
    expect(direct.info.tier).toBe(3);
    live = plainDraft({
      id: 'd-m1',
      threadId: 't9',
      to: 'mallory@example.com',
      subject: 'Lease',
      body: 'Send me the keys.',
    });
    const outcome = await dispatchApproved({ direct, sentinel });
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
    const outcome = await classifyApproveDispatch({
      toolSet: built.tools,
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
