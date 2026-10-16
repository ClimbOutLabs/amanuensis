import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(services?: SentinelServices): ClassifyContext {
  return {
    services: services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: 'reply to Grace about the lease',
    web_search: createWebSearchTurnState(),
  };
}

function gmail(
  tool_name: string,
  canonical_params: Record<string, unknown>,
  extra: Partial<SentinelAction> = {},
): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'truefoundry-system',
    mcp_server_name: 'gmail',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: true },
    ...extra,
  };
}

const DRAFT_PARAMS = { to: ['grace@example.com'], cc: ['lin@example.com'], subject: 'Lease', body: 'Thursday works.' };
const REVIEWED = {
  to: ['grace@example.com'],
  cc: [],
  bcc: ['audit@example.com'],
  subject: 'Lease "final"',
  body: 'Thursday works.\nBest, Ada',
  threadId: 't9',
};

describe('Gmail write classification', () => {
  it.each(['draft_email', 'update_draft'])('asks before %s, with a card built from the params', async name => {
    const decision = await classifyTier(gmail(name, { draftId: 'd1', ...DRAFT_PARAMS }), makeCtx());
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.card).toMatchObject({
      destination: 'Gmail',
      recipient: 'grace@example.com, lin@example.com',
      cannot_be_undone: null,
    });
    expect(decision.card?.outbound_text).toContain('subject: Lease');
    expect(decision.card?.outbound_text).toContain('body: Thursday works.');
    expect(decision.card?.plain_what).toContain('It is not sent.');
  });

  it('asks before send_draft with the reviewed draft in the card, bcc included', async () => {
    const decision = await classifyTier(gmail('send_draft', { draftId: 'd1' }, { mail_draft: REVIEWED }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toBe(
      'Send "Lease \\"final\\"" to grace@example.com, audit@example.com from your Gmail.',
    );
    expect(decision.card?.recipient).toBe('grace@example.com, audit@example.com');
    expect(decision.card?.outbound_text).toContain('bcc (array): ["audit@example.com"]');
    expect(decision.card?.outbound_text).toContain('Best, Ada');
    expect(decision.card?.cannot_be_undone).toContain("can't be unsent");
  });

  it('never offers a send it has no draft for', async () => {
    const decision = await classifyTier(gmail('send_draft', { draftId: 'd1' }), makeCtx());
    expect(decision.auto_deny).toBe('destination_unverifiable');
    expect(decision.card).toBeNull();
  });

  it('shows bidi overrides in a recipient or subject as visible escapes, not as reordered text', async () => {
    const decision = await classifyTier(
      gmail('send_draft', { draftId: 'd1' }, { mail_draft: { ...REVIEWED, subject: 'invoice‮txt.exe', bcc: [] } }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('\\u{202E}');
    expect(decision.card?.plain_what).not.toContain('‮');
  });

  it('keeps Arabic and Hebrew subjects readable on the card', async () => {
    const decision = await classifyTier(
      gmail('send_draft', { draftId: 'd1' }, { mail_draft: { ...REVIEWED, subject: 'שלום עולם مرحبا', bcc: [] } }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('שלום עולם مرحبا');
  });

  it('cannot be lowered by the tool declaring itself read-only', async () => {
    const decision = await classifyTier(
      gmail(
        'send_draft',
        { draftId: 'd1' },
        { mail_draft: REVIEWED, mcp_hints: { read_only_hint: true, open_world_hint: false } },
      ),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
  });

  it('is denied without a card in a scheduled run', async () => {
    const services = forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }));
    for (const name of ['draft_email', 'update_draft', 'send_draft']) {
      const decision = await classifyTier(gmail(name, DRAFT_PARAMS, { mail_draft: REVIEWED }), makeCtx(services));
      expect(decision).toMatchObject({ auto_deny: 'unattended_run', card: null });
    }
  });

  it('still lets a scheduled run read mail', async () => {
    const services = forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }));
    const decision = await classifyTier(gmail('read_email', { messageId: 'm1' }), makeCtx(services));
    expect(decision.tier).toBe(1);
  });

  it('is denied while offline', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    const decision = await classifyTier(
      gmail('send_draft', { draftId: 'd1' }, { mail_draft: REVIEWED }),
      makeCtx(services),
    );
    expect(decision.auto_deny).toBe('offline_mode');
  });

  it('binds the approval to the exact call: a different draft id fails dispatch', async () => {
    const ctx = makeCtx();
    const decision = await classifyTier(gmail('send_draft', { draftId: 'd1' }, { mail_draft: REVIEWED }), ctx);
    const base = {
      tool_name: 'send_draft',
      tool_type: 'truefoundry-system' as const,
      tier: decision.tier,
      approval_token_id: decision.approval_token_id,
      approval_binding: null,
      shell_binding: null,
    };
    const dispatchCtx = {
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      repository_id: null,
      workspace_cwd: null,
      agent_intent: null,
      services: ctx.services,
      offline: false,
    };
    const other = await verifyPreDispatch({
      call: { ...base, canonical_params: { draftId: 'other' } },
      ctx: dispatchCtx,
    });
    expect(other).toContain('Approval invalid');
    const decision2 = await classifyTier(gmail('send_draft', { draftId: 'd1' }, { mail_draft: REVIEWED }), ctx);
    const same = await verifyPreDispatch({
      call: { ...base, approval_token_id: decision2.approval_token_id, canonical_params: { draftId: 'd1' } },
      ctx: dispatchCtx,
    });
    expect(same).toBeUndefined();
  });
});
