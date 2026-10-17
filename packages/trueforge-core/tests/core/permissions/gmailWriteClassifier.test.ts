import type { ReviewableDraft } from '../../../src/core/email/gmail/draftReview';
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
const CONTENT: ReviewableDraft = {
  to: ['grace@example.com'],
  cc: [],
  bcc: ['audit@example.com'],
  subject: 'Lease "final"',
  body: 'Thursday works.\nBest, Ada',
  threadId: 't9',
  inReplyTo: '',
  references: '',
  fromName: '',
};

describe('Gmail write classification', () => {
  it.each(['draft_email', 'update_draft'])(
    'asks before %s, with a card built from the content it will write',
    async name => {
      const decision = await classifyTier(
        gmail(
          name,
          { draft_id: 'd1', ...DRAFT_PARAMS },
          {
            mail_draft: { ...CONTENT, to: ['grace@example.com'], cc: ['lin@example.com'], bcc: [], subject: 'Lease' },
            ...(name === 'update_draft'
              ? { mail_replaces: { ...CONTENT, subject: 'Old lease', to: ['sam@example.com'], bcc: [] } }
              : {}),
          },
        ),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.card).toMatchObject({
        destination: null,
        recipient: null,
        cannot_be_undone: null,
        outbound_text: null,
      });
      expect(decision.card?.plain_what).toContain('It is not sent.');
      expect(decision.card?.email).toMatchObject({
        action: name === 'draft_email' ? 'save' : 'change',
        to: ['grace@example.com'],
        cc: ['lin@example.com'],
        subject: 'Lease',
        body: 'Thursday works.\nBest, Ada',
        replaces: name === 'draft_email' ? null : { subject: 'Old lease', to: ['sam@example.com'] },
      });
    },
  );

  it('names the saved draft an update replaces, in the sentence the user reads', async () => {
    const decision = await classifyTier(
      gmail(
        'update_draft',
        { draft_id: 'd1' },
        { mail_draft: CONTENT, mail_replaces: { ...CONTENT, subject: 'Old lease', to: ['sam@example.com'] } },
      ),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('It replaces "Old lease" to sam@example.com');
  });

  it('never offers a draft write that has no content to show', async () => {
    for (const name of ['draft_email', 'update_draft']) {
      const decision = await classifyTier(gmail(name, DRAFT_PARAMS), makeCtx());
      expect(decision.auto_deny).toBe('destination_unverifiable');
      expect(decision.card).toBeNull();
    }
  });

  it('asks before send_draft with the whole message in the card, hidden copy included', async () => {
    const decision = await classifyTier(gmail('send_draft', { draft_id: 'd1' }, { mail_draft: CONTENT }), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toBe(
      'Send "Lease \\"final\\"" from your Gmail to grace@example.com. Hidden copy: audit@example.com.',
    );
    expect(decision.card?.email).toMatchObject({
      action: 'send',
      to: ['grace@example.com'],
      cc: [],
      bcc: ['audit@example.com'],
      body: 'Thursday works.\nBest, Ada',
    });
    expect(decision.card?.cannot_be_undone).toBe("Once this is sent, it can't be unsent.");
    expect(decision.card?.destination).toBeNull();
    expect(decision.card?.outbound_text).toBeNull();
  });

  it('puts the whole body on the card, however long', async () => {
    const body = `${'a'.repeat(19_000)}\nEND`;
    const decision = await classifyTier(
      gmail('send_draft', { draft_id: 'd1' }, { mail_draft: { ...CONTENT, body } }),
      makeCtx(),
    );
    expect(decision.card?.email?.body).toBe(body);
  });

  it('never offers a send it has no draft for', async () => {
    const decision = await classifyTier(gmail('send_draft', { draft_id: 'd1' }), makeCtx());
    expect(decision.auto_deny).toBe('destination_unverifiable');
    expect(decision.card).toBeNull();
  });

  it('shows bidi overrides in a recipient or subject as visible escapes, not as reordered text', async () => {
    const decision = await classifyTier(
      gmail('send_draft', { draft_id: 'd1' }, { mail_draft: { ...CONTENT, subject: 'invoice\u202Etxt.exe', bcc: [] } }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('\\u{202E}');
    expect(decision.card?.plain_what).not.toContain('\u202E');
    expect(decision.card?.email?.subject).not.toContain('\u202E');
  });

  it('keeps Arabic and Hebrew subjects readable on the card', async () => {
    const decision = await classifyTier(
      gmail('send_draft', { draft_id: 'd1' }, { mail_draft: { ...CONTENT, subject: 'שלום עולם مرحبا', bcc: [] } }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toContain('שלום עולם مرحبا');
  });

  it('does not take the Gmail path for a connector that is merely named gmail', async () => {
    const decision = await classifyTier(
      gmail(
        'send_draft',
        { draft_id: 'd1' },
        { tool_type: 'mcp', mcp_server_host: 'mcp.example.com', mail_draft: CONTENT },
      ),
      makeCtx(),
    );
    expect(decision.reason).not.toMatch(/^gmail_/);
    expect(decision.card?.email ?? null).toBeNull();
  });

  it('cannot be lowered by the tool declaring itself read-only', async () => {
    const decision = await classifyTier(
      gmail(
        'send_draft',
        { draft_id: 'd1' },
        { mail_draft: CONTENT, mcp_hints: { read_only_hint: true, open_world_hint: false } },
      ),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
  });

  it('is denied without a card in a scheduled run', async () => {
    const services = forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }));
    for (const name of ['draft_email', 'update_draft', 'send_draft']) {
      const decision = await classifyTier(gmail(name, DRAFT_PARAMS, { mail_draft: CONTENT }), makeCtx(services));
      expect(decision).toMatchObject({ auto_deny: 'unattended_run', card: null });
    }
  });

  it('still lets a scheduled run read mail', async () => {
    const services = forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }));
    const decision = await classifyTier(gmail('read_email', { message_id: 'm1' }), makeCtx(services));
    expect(decision.tier).toBe(1);
  });

  it('is denied while offline', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    const decision = await classifyTier(
      gmail('send_draft', { draft_id: 'd1' }, { mail_draft: CONTENT }),
      makeCtx(services),
    );
    expect(decision.auto_deny).toBe('offline_mode');
  });

  it('binds the approval to the exact call: a different draft id fails dispatch', async () => {
    const ctx = makeCtx();
    const decision = await classifyTier(gmail('send_draft', { draft_id: 'd1' }, { mail_draft: CONTENT }), ctx);
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
      call: { ...base, canonical_params: { draft_id: 'other' } },
      ctx: dispatchCtx,
    });
    expect(other).toContain('Approval invalid');
    const decision2 = await classifyTier(gmail('send_draft', { draft_id: 'd1' }, { mail_draft: CONTENT }), ctx);
    const same = await verifyPreDispatch({
      call: { ...base, approval_token_id: decision2.approval_token_id, canonical_params: { draft_id: 'd1' } },
      ctx: dispatchCtx,
    });
    expect(same).toBeUndefined();
  });
});
