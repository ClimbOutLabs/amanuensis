import {
  classifyHostToolCall,
  classifyTier,
  type ClassifyContext,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { DEMO_CONNECTOR_REFUSAL } from '../../../src/core/permissions/sendAllowlist';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const MAIL_READS: Array<[string, Record<string, unknown>]> = [
  ['list-messages', { mailbox: 'INBOX', limit: 20 }],
  ['search-messages', { query: 'lease' }],
  ['get-message', { message_id: 'm1' }],
  ['get-thread', { thread_id: 't1' }],
  ['get-unread-count', { mailbox: 'INBOX' }],
  ['list-attachments', { message_id: 'm1' }],
  ['fetch-attachment', { attachment_id: 'a1' }],
];

const SEARCH: SentinelAction = {
  tool_name: 'web_search',
  canonical_params: { query: 'best tapas in Lisbon' },
  tool_type: 'mcp',
  mcp_server_name: 'search',
  mcp_search_provider: true,
  mcp_search_tool: true,
  mcp_hints: { read_only_hint: true, open_world_hint: true },
};

/** An unannotated connector tool on a local mail bridge, as most mail connectors are. */
function mailCall(tool_name: string, params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params: params,
    tool_type: 'mcp',
    mcp_server_name: 'apple-mail',
    mcp_server_host: 'mail.bridge.example',
    mcp_hints: {},
  };
}

function servicesFor({ demo }: { demo: boolean }): SentinelServices {
  return {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    demoSendAllowlist: demo ? ['a@demo.example'] : null,
  };
}

function makeCtx(services: SentinelServices = servicesFor({ demo: false })): ClassifyContext {
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

describe('connector mail reads', () => {
  it.each(MAIL_READS)('%s on an unannotated connector asks with a card, not an auto-deny', async (name, params) => {
    const decision = await classifyTier(mailCall(name, params), makeCtx());
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.destination_host).toBe('mail.bridge.example');
    for (const value of Object.values(params)) {
      expect(decision.card?.outbound_text).toContain(String(value));
    }
  });

  it.each(MAIL_READS)('%s asks with the usual card in a demo instance', async (name, params) => {
    const decision = await classifyTier(mailCall(name, params), makeCtx(servicesFor({ demo: true })));
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.card?.destination_host).toBe('mail.bridge.example');
  });

  it('a read marks the chat as having read private data, so a later search asks', async () => {
    const services = servicesFor({ demo: false });
    const sentinel = createSentinelHostContext({ tenant_id: 't1', created_by: 'u1', conversation_id: 'c1', services });
    expect(await classifyTier(SEARCH, makeCtx(services))).toMatchObject({ tier: 1 });

    await classifyHostToolCall({
      sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: mailCall('list-messages', { mailbox: 'INBOX' }),
    });

    expect(await classifyTier(SEARCH, makeCtx(services))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('a read is not a send, so it is not refused or carded as one', async () => {
    const decision = await classifyTier(mailCall('list-messages', { mailbox: 'INBOX' }), makeCtx());
    expect(decision.auto_deny).toBeNull();
    expect(decision.reason).not.toBe('external_service');
    expect(decision.reason).not.toBe('connector_send');
  });
});

describe('connector mail sends keep their decisions', () => {
  it('send-email, reply-to-message and create-draft are unchanged without a recipient', async () => {
    expect(await classifyTier(mailCall('send-email', { subject: 'Hi', body: 'Hello' }), makeCtx())).toMatchObject({
      tier: 3,
      auto_deny: 'destination_unverifiable',
    });
    expect(
      await classifyTier(mailCall('reply-to-message', { message_id: 'm1', body: 'Thanks' }), makeCtx()),
    ).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable' });
    expect(await classifyTier(mailCall('create-draft', { subject: 'Hi', body: 'Hello' }), makeCtx())).toMatchObject({
      tier: 3,
      auto_deny: null,
      reason: 'connector_send',
    });
  });

  it('send-email, reply-to-message and create-draft are unchanged with a recipient', async () => {
    const to = { to: 'x@outside.example', subject: 'Hi', body: 'Hello' };
    expect(await classifyTier(mailCall('send-email', to), makeCtx())).toMatchObject({
      tier: 3,
      auto_deny: null,
      reason: 'external_service',
    });
    expect(
      await classifyTier(
        mailCall('reply-to-message', { message_id: 'm1', to: 'x@outside.example', body: 'Thanks' }),
        makeCtx(),
      ),
    ).toMatchObject({ tier: 3, auto_deny: null, reason: 'external_service' });
    expect(await classifyTier(mailCall('create-draft', to), makeCtx())).toMatchObject({
      tier: 3,
      auto_deny: null,
      reason: 'connector_send',
    });
  });

  it('a name with a send word stays a send even when it starts like a read', async () => {
    expect(await classifyTier(mailCall('get-and-send-message', { message_id: 'm1' }), makeCtx())).toMatchObject({
      auto_deny: 'destination_unverifiable',
    });
  });

  it('a read-named call with a recipient is still a send', async () => {
    const decision = await classifyTier(mailCall('list-messages', { to: 'x@outside.example' }), makeCtx());
    expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'external_service' });
    expect(decision.card?.recipient).toBe('x@outside.example');
  });

  it('a read-named call with a recipient nested in its arguments is still a send', async () => {
    expect(
      await classifyTier(mailCall('list-messages', { filter: { cc: 'x@outside.example' } }), makeCtx()),
    ).toMatchObject({ auto_deny: 'destination_unverifiable' });
  });

  it('a read-named call with a reply-to-everyone flag is still refused', async () => {
    expect(await classifyTier(mailCall('search-messages', { query: 'x', reply_all: true }), makeCtx())).toMatchObject({
      auto_deny: 'destination_unverifiable',
    });
  });

  it('a delete or a mark is unchanged', async () => {
    expect(await classifyTier(mailCall('delete-message', { message_id: 'm1' }), makeCtx())).toMatchObject({
      auto_deny: 'destination_unverifiable',
    });
    expect(await classifyTier(mailCall('mark-message', { message_id: 'm1', read: true }), makeCtx())).toMatchObject({
      auto_deny: 'destination_unverifiable',
    });
  });
});

describe('demo instance and connector mail', () => {
  const demo = servicesFor({ demo: true });

  it.each([
    ['send-email with a recipient', 'send-email', { to: 'x@outside.example', subject: 'Hi', body: 'Hello' }],
    [
      'reply-to-message with a recipient',
      'reply-to-message',
      { message_id: 'm1', to: 'x@outside.example', body: 'Hi' },
    ],
    ['create-draft', 'create-draft', { subject: 'Hi', body: 'Hello' }],
    ['a read-named call with a recipient', 'list-messages', { to: 'x@outside.example' }],
  ])('refuses %s with the demo message and no card', async (_label, tool_name, params) => {
    expect(await classifyTier(mailCall(tool_name, params), makeCtx(demo))).toMatchObject({
      tier: 3,
      auto_deny: 'outbound_guard',
      card: null,
      reason_detail: DEMO_CONNECTOR_REFUSAL,
    });
  });

  it('keeps the demo refusal for an unannotated connector call that is neither a read nor declared read-only', async () => {
    expect(await classifyTier(mailCall('update-thread', { thread_id: 't1', flag: 'x' }), makeCtx(demo))).toMatchObject({
      auto_deny: 'outbound_guard',
      reason_detail: DEMO_CONNECTOR_REFUSAL,
    });
  });
});

/**
 * Connector names that start like a read but also name another service or a write. Each one keeps the
 * decision it had on main, in live and demo instances alike.
 */
const READS_NAMING_OTHER_ACTIONS = [
  'list_messages_and_archive',
  'list_and_pay_invoice',
  'get_and_transfer_funds',
  'getMessagesAndArchive',
  'search-and-share-message',
  'fetch-and-notify',
  'get_mail_and_wire',
  'list_messages_and_deliver',
  'get_message_and_text',
  'get_messages_and_buy',
];

/** Main's decision for each name above, checked by running origin/main's classifier on each name before this change. */
const MAIN_OTHER_ACTION_DECISION = {
  tier: 3,
  auto_deny: 'destination_unverifiable',
  reason: 'auto_denied',
  reason_detail: 'External-service action with no verifiable destination; never carded.',
  card: null,
};

describe('connector reads that name another action keep main decision', () => {
  it.each(READS_NAMING_OTHER_ACTIONS)('%s is auto-denied as on main', async name => {
    expect(await classifyTier(mailCall(name, { message_id: 'm1' }), makeCtx())).toMatchObject(
      MAIN_OTHER_ACTION_DECISION,
    );
  });

  it.each(READS_NAMING_OTHER_ACTIONS)('%s is auto-denied as on main in a demo instance', async name => {
    expect(
      await classifyTier(mailCall(name, { message_id: 'm1' }), makeCtx(servicesFor({ demo: true }))),
    ).toMatchObject(MAIN_OTHER_ACTION_DECISION);
  });
});
