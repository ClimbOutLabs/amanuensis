import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { OUTBOUND_VALUE_MAX_CHARS, SEND_VALUE_MAX_CHARS } from '../../../src/core/permissions/extractorRegistry';
import { GRANT_BARRED_TIER_REASONS, type TierDecision } from '../../../src/core/permissions/tier';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const readOnlyClosedWorld = { read_only_hint: true, open_world_hint: false, destructive_hint: false };

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function mailCall(tool_name: string, params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params: params,
    tool_type: 'mcp',
    mcp_server_name: 'mail',
    mcp_server_host: 'mail.example.com',
    mcp_hints: { destructive_hint: false },
  };
}

function classify(action: SentinelAction): Promise<TierDecision> {
  return classifyTier(action, makeCtx());
}

function expectRefused(decision: TierDecision): void {
  expect(decision.tier).toBe(3);
  expect(decision.auto_deny).toBe('incomplete_send_card');
  expect(decision.approval_token_id).toBeNull();
}

describe('connector send cards', () => {
  test('refuses reply_all, whose recipients are filled in after approval', async () => {
    expectRefused(await classify(mailCall('reply_all', { messageId: 'm1', body: 'Thanks all' })));
  });

  test('refuses send_draft, whose content the card cannot show, even when a recipient is passed', async () => {
    expectRefused(await classify(mailCall('send_draft', { draftId: 'd1' })));
    expectRefused(await classify(mailCall('send_draft', { draftId: 'd1', to: 'friend@example.com' })));
  });

  test('refuses a reply that names no recipient', async () => {
    expectRefused(await classify(mailCall('reply_to_thread', { threadId: 't1', body: 'ok' })));
  });

  test('cards a filter that forwards, naming the forwarding address', async () => {
    const decision = await classify(
      mailCall('create_filter', {
        criteria: { from: 'billing@example.com' },
        action: { addLabelIds: ['L1'], forward: 'archive@example.com' },
      }),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.recipient).toBe('archive@example.com');
    expect(decision.card?.plain_what).toContain('Forward every matching message to archive@example.com');
  });

  test('send_email shows the whole body and recipients, and binds them into the token', async () => {
    const body = `${'a'.repeat(OUTBOUND_VALUE_MAX_CHARS)}END-OF-MESSAGE`;
    const decision = await classify(
      mailCall('send_email', { to: ['friend@example.com'], cc: ['boss@example.com'], subject: 'Hi', body }),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.outbound_truncated).toBe(false);
    expect(decision.card?.outbound_text).toContain('END-OF-MESSAGE');
    expect(decision.card?.recipient).toBe('friend@example.com, boss@example.com');
  });

  test('refuses a send_email whose body is too long to show, instead of cutting it', async () => {
    const body = `${'a'.repeat(SEND_VALUE_MAX_CHARS)}HIDDEN-TAIL`;
    expectRefused(await classify(mailCall('send_email', { to: ['friend@example.com'], subject: 'Hi', body })));
  });

  test('still cuts a long value on a call that sends nothing', async () => {
    const decision = await classify(mailCall('lookup_note', { text: 'a'.repeat(OUTBOUND_VALUE_MAX_CHARS + 5) }));
    expect(decision.auto_deny).toBeNull();
    expect(decision.card?.outbound_truncated).toBe(true);
  });
});

describe('reasons that bar a durable grant', () => {
  test.each([
    ['external_service', mailCall('share_note', { to: 'friend@example.com', body: 'hi' })],
    ['destructive_action', mailCall('delete_note', { id: 'n1' })],
    ['install_action', mailCall('install_pack', { name: 'left-pad' })],
    ['mcp_destructive_hint', { ...mailCall('tidy_notes', {}), mcp_hints: { destructive_hint: true } }],
    ['mcp_open_world_hint', { ...mailCall('tidy_notes', {}), mcp_hints: { open_world_hint: true } }],
    ['connector_send', mailCall('push_files', { owner: 'o', repo: 'r', files: [] })],
    ['connector_send', mailCall('reply_to_thread', { threadId: 't1', to: 'friend@example.com', body: 'ok' })],
  ])('%s is the code the classifier gives and the grant gate bars', async (reason, action) => {
    const decision = await classify(action);
    expect(decision.reason).toBe(reason);
    expect(GRANT_BARRED_TIER_REASONS.has(decision.reason)).toBe(true);
  });
});

describe('sends are never trusted by a hint or a standing grant', () => {
  const sendTools = [
    ['reply', { messageId: 'm1', to: 'friend@example.com', body: 'ok' }],
    ['forward', { messageId: 'm1', to: 'friend@example.com' }],
    ['push_files', { owner: 'o', repo: 'r', files: [] }],
    ['create_filter', { criteria: { from: 'a@example.com' }, action: { forward: 'archive@example.com' } }],
  ] as const;

  test.each(sendTools)('a read-only closed-world %s on a first-party connector still asks', async (name, params) => {
    const decision = await classify({
      ...mailCall(name, params),
      mcp_first_party: true,
      mcp_hints: readOnlyClosedWorld,
    });
    expect(decision.tier).toBe(3);
    expect(decision.approval_token_id).not.toBeNull();
  });

  test.each(sendTools)('a standing Always allow for %s does not skip the card', async (name, params) => {
    const ctx = makeCtx();
    await ctx.services.tool_grants.recordToolGrant({
      tenant_id: 't1',
      created_by: 'u1',
      mcp_server_name: 'mail',
      tool_name: name,
    });
    const decision = await classifyTier({ ...mailCall(name, params), mcp_hints: readOnlyClosedWorld }, ctx);
    expect(decision.tier).toBe(3);
    expect(GRANT_BARRED_TIER_REASONS.has(decision.reason)).toBe(true);
  });

  test.each(['invite_user', 'create_event', 'add_issue_comment'])(
    '%s with attendees is barred from durable scope and shows its whole body',
    async name => {
      const body = 'b'.repeat(OUTBOUND_VALUE_MAX_CHARS + 50);
      const decision = await classify({
        ...mailCall(name, { attendees: ['guest@example.com'], body }),
        mcp_hints: readOnlyClosedWorld,
      });
      expect(decision.tier).toBe(3);
      expect(decision.card?.recipient).toBe('guest@example.com');
      expect(GRANT_BARRED_TIER_REASONS.has(decision.reason)).toBe(true);
      expect(decision.card?.outbound_truncated).toBe(false);
    },
  );

  test('a read-only closed-world search keeps its durable scope', async () => {
    const decision = await classify({ ...mailCall('search_notes', { query: 'tax' }), mcp_hints: readOnlyClosedWorld });
    expect(decision.tier).toBe(3);
    expect(GRANT_BARRED_TIER_REASONS.has(decision.reason)).toBe(false);
  });
});

describe('attachments and refusal wording', () => {
  test('a large attachment is shown by name and size and does not make the send too long', async () => {
    const decision = await classify(
      mailCall('send_email', {
        to: ['friend@example.com'],
        subject: 'Report',
        body: 'See attached',
        attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', content: 'A'.repeat(500_000) }],
      }),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.card?.outbound_truncated).toBe(false);
    expect(decision.card?.outbound_text).toContain('report.pdf');
    expect(decision.card?.outbound_text).toContain('500000 characters, not shown');
  });

  test.each([
    [mailCall('reply_all', { messageId: 'm1' }), 'names every recipient'],
    [mailCall('reply_to_thread', { threadId: 't1', body: 'ok' }), 'Name each recipient'],
    [
      mailCall('send_email', { to: 'friend@example.com', body: 'a'.repeat(SEND_VALUE_MAX_CHARS + 1) }),
      'Shorten it or split it',
    ],
  ])('each refusal tells the model its one next step', async (action, step) => {
    const decision = await classify(action);
    expect(decision.reason_detail).toContain(step);
  });
});

describe('hidden sends passed as arguments', () => {
  test.each([
    ['send_message', { draftId: 'd1', to: ['shown@example.com'] }],
    ['send_message', { draft_id: 'd1', to: ['shown@example.com'], body: 'hi' }],
    ['reply', { messageId: 'm1', replyAll: true, to: ['a@example.com'], body: 'ok' }],
    ['reply', { messageId: 'm1', reply_all: true, to: ['a@example.com'], body: 'ok' }],
    ['reply', { messageId: 'm1', replyAll: 'true', to: ['a@example.com'], body: 'ok' }],
    ['reply', { messageId: 'm1', reply_all: 'True', to: ['a@example.com'], body: 'ok' }],
    ['reply', { messageId: 'm1', options: { replyAll: '1' }, to: ['a@example.com'] }],
  ])('%s is refused for %j', async (name, params) => {
    expectRefused(await classify(mailCall(name, params)));
  });

  test('a plain reply with replyAll switched off is still carded', async () => {
    const decision = await classify(
      mailCall('reply', { messageId: 'm1', replyAll: false, to: ['a@example.com'], body: 'ok' }),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
  });

  test('a send_message with only a draft id stays refused', async () => {
    const decision = await classify(mailCall('send_message', { draftId: 'd1' }));
    expect(decision.tier).toBe(3);
    expect(decision.auto_deny).toBe('destination_unverifiable');
  });
});
