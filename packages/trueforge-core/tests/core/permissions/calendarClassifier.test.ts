import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { createWebSearchTurnState, hasReadPrivateData } from '../../../src/core/permissions/webSearch';

function makeCtx(
  services: SentinelServices = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function calendarAction(tool_name: string, server = 'google_calendar'): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_server_name: server,
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  };
}

describe('Calendar read classification', () => {
  it.each(['list_events', 'get_event'])('runs %s silently and flags it as a sensitive read', async name => {
    const ctx = makeCtx();
    const decision = await classifyTier(calendarAction(name), ctx);
    expect(decision).toMatchObject({
      tier: 1,
      reason: 'calendar_read',
      reason_detail: 'Read your calendar.',
      sensitive_read: true,
      card: null,
      auto_deny: null,
    });
    expect(hasReadPrivateData(ctx.web_search)).toBe(true);
  });

  it('reads in a scheduled run too', async () => {
    const decision = await classifyTier(
      calendarAction('list_events'),
      makeCtx(forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }))),
    );
    expect(decision).toMatchObject({ tier: 1, sensitive_read: true, auto_deny: null });
  });

  it.each(['create_event', 'update_event', 'delete_event', 'quick_add', 'wipe_everything'])(
    'refuses %s: nothing here writes, and an unknown name fails closed without repeating it',
    async name => {
      const ctx = makeCtx();
      const decision = await classifyTier(calendarAction(name), ctx);
      expect(decision.reason_detail).toBe('Unknown calendar tool.');
      expect(decision.tier).not.toBe(1);
      expect(hasReadPrivateData(ctx.web_search)).toBe(false);
    },
  );

  it('does not give a connector tool of the same name the host path', async () => {
    const ctx = makeCtx();
    const decision = await classifyTier({ ...calendarAction('list_events', 'some_connector'), tool_type: 'mcp' }, ctx);
    expect(decision.reason).not.toBe('calendar_read');
    expect(hasReadPrivateData(ctx.web_search)).toBe(false);
  });

  it('is refused while offline', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    const decision = await classifyTier(calendarAction('list_events'), makeCtx(services));
    expect(decision.auto_deny).not.toBeNull();
  });
});
