import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, forUnattendedRun } from '../../../src/core/permissions/context';
import {
  createWebSearchTurnState,
  isSearchAskReason,
  markPrivateDataRead,
} from '../../../src/core/permissions/webSearch';

function makeCtx(unattended = false): ClassifyContext {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  return {
    services: unattended ? forUnattendedRun(services) : services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

const SEARCH: SentinelAction = {
  tool_name: 'web_search',
  canonical_params: { query: 'best tapas in Lisbon' },
  tool_type: 'mcp',
  mcp_server_name: 'search',
  mcp_search_provider: true,
  mcp_search_tool: true,
  mcp_hints: { read_only_hint: true, open_world_hint: true },
};

const MAIL_READ: SentinelAction = {
  tool_name: 'read_email',
  canonical_params: { message_id: 'm1' },
  tool_type: 'truefoundry-system',
  mcp_server_name: 'gmail',
  mcp_hints: { read_only_hint: true, open_world_hint: true },
};

const CALENDAR_READ: SentinelAction = {
  tool_name: 'list_events',
  canonical_params: { time_min: '2026-10-19', time_max: '2026-10-26' },
  tool_type: 'truefoundry-system',
  mcp_server_name: 'google_calendar',
  mcp_hints: { read_only_hint: true, open_world_hint: true },
};

/** A read that ran: the classifier admits it, then the tool set marks it as dispatched. */
async function dispatchRead(ctx: ClassifyContext, read: SentinelAction): Promise<void> {
  await classifyTier(read, ctx);
  markPrivateDataRead(ctx.web_search);
}

describe('web search after the turn read the calendar', () => {
  it('asks once the turn has read the calendar, saying why', async () => {
    const ctx = makeCtx();
    await dispatchRead(ctx, CALENDAR_READ);
    const decision = await classifyTier(SEARCH, ctx);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('mcp_search_after_private_read');
    expect(decision.card?.plain_what).toContain(
      'This chat has read your private data, so Aman is checking before searching.',
    );
    expect(decision.card?.why_asked_again).toBeNull();
  });

  it('is held for the owner in a scheduled run after a calendar read', async () => {
    const ctx = makeCtx(true);
    await dispatchRead(ctx, CALENDAR_READ);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });

  it('does not carry over to a turn that did not read the calendar', async () => {
    await dispatchRead(makeCtx(), CALENDAR_READ);
    expect((await classifyTier(SEARCH, makeCtx())).tier).toBe(1);
  });
});

describe('web search after the turn read mail', () => {
  it('searches silently when no mail was read', async () => {
    const decision = await classifyTier(SEARCH, makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'mcp_search_provider' });
  });

  it('asks once the turn has read mail, saying why', async () => {
    const ctx = makeCtx();
    await dispatchRead(ctx, MAIL_READ);
    const decision = await classifyTier(SEARCH, ctx);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('mcp_search_after_private_read');
    expect(isSearchAskReason(decision.reason)).toBe(true);
    expect(decision.card?.plain_what).toContain(
      'This chat has read your private data, so Aman is checking before searching.',
    );
    expect(decision.card?.why_asked_again).toBeNull();
  });

  it('does not carry over to a turn that did not read mail', async () => {
    await dispatchRead(makeCtx(), MAIL_READ);
    expect((await classifyTier(SEARCH, makeCtx())).tier).toBe(1);
  });

  it('is held for the owner in a scheduled run, where nobody could approve it on the spot', async () => {
    const ctx = makeCtx(true);
    await dispatchRead(ctx, MAIL_READ);
    const decision = await classifyTier(SEARCH, ctx);
    expect(decision.auto_deny).toBeNull();
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });
});
