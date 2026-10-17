import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, forUnattendedRun } from '../../../src/core/permissions/context';
import { createWebSearchTurnState, isSearchAskReason } from '../../../src/core/permissions/webSearch';

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

describe('web search after the turn read the calendar', () => {
  it('asks once the turn has read the calendar, saying why', async () => {
    const ctx = makeCtx();
    await classifyTier(CALENDAR_READ, ctx);
    const decision = await classifyTier(SEARCH, ctx);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('mcp_search_after_private_read');
    expect(decision.card?.why_asked_again).toContain('calendar');
  });

  it('is held for the owner in a scheduled run after a calendar read', async () => {
    const ctx = makeCtx(true);
    await classifyTier(CALENDAR_READ, ctx);
    expect(await classifyTier(SEARCH, ctx)).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });

  it('does not carry over to a turn that did not read the calendar', async () => {
    await classifyTier(CALENDAR_READ, makeCtx());
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
    await classifyTier(MAIL_READ, ctx);
    const decision = await classifyTier(SEARCH, ctx);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('mcp_search_after_private_read');
    expect(isSearchAskReason(decision.reason)).toBe(true);
    expect(decision.card?.why_asked_again).toContain('read your email');
  });

  it('does not carry over to a turn that did not read mail', async () => {
    await classifyTier(MAIL_READ, makeCtx());
    expect((await classifyTier(SEARCH, makeCtx())).tier).toBe(1);
  });

  it('is held for the owner in a scheduled run, where nobody could approve it on the spot', async () => {
    const ctx = makeCtx(true);
    await classifyTier(MAIL_READ, ctx);
    const decision = await classifyTier(SEARCH, ctx);
    expect(decision.auto_deny).toBeNull();
    expect(decision).toMatchObject({ tier: 3, reason: 'mcp_search_after_private_read' });
  });
});
