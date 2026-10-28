import type { ReviewableDraft } from '../../../src/core/email/gmail/draftReview';
import { SEND_DRAFT_TOOL_NAME } from '../../../src/core/email/gmail/toolContract';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import {
  DEMO_CONNECTOR_REFUSAL,
  DEMO_SEND_REFUSAL,
  recipientsAllowed,
} from '../../../src/core/permissions/sendAllowlist';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function ctx(demoSendAllowlist: readonly string[] | null): ClassifyContext {
  return {
    services: { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), demoSendAllowlist },
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: 'send a note',
    web_search: createWebSearchTurnState(),
  };
}

function connectorCall(input: {
  tool_name: string;
  params: Record<string, unknown>;
  read_only_hint?: boolean;
}): SentinelAction {
  return {
    tool_name: input.tool_name,
    canonical_params: input.params,
    tool_type: 'mcp',
    mcp_server_name: 'mail',
    mcp_hints: { read_only_hint: input.read_only_hint ?? false, destructive_hint: false, open_world_hint: true },
  };
}

function hostGmailSend(draft: ReviewableDraft | undefined): SentinelAction {
  return {
    tool_name: SEND_DRAFT_TOOL_NAME,
    canonical_params: { draft_id: 'd1' },
    tool_type: 'truefoundry-system',
    mcp_server_name: 'gmail',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: true },
    mail_draft: draft,
  };
}

/** A recipient with no display name: the bare address. */
const bare = (address: string) => ({ name: '', address });

const DRAFT: ReviewableDraft = {
  to: [bare('a@demo.example')],
  cc: [],
  bcc: [],
  subject: 'Hi',
  body: 'Hi',
  threadId: 't1',
  inReplyTo: '',
  references: '',
  fromName: '',
  nameLeftOff: false,
  replyTo: null,
};

describe('recipientsAllowed', () => {
  it('allows anyone when there is no list', () => {
    expect(recipientsAllowed({ allowlist: null, recipients: ['anyone@example.com'] })).toBe(true);
  });

  it('refuses a message with no recipients, since nothing was checked', () => {
    expect(recipientsAllowed({ allowlist: ['a@demo.example'], recipients: [] })).toBe(false);
  });

  it('allows no one when the list is empty', () => {
    expect(recipientsAllowed({ allowlist: [], recipients: ['maya@demo.example'] })).toBe(false);
  });

  it('ignores case and edge space on both sides', () => {
    expect(recipientsAllowed({ allowlist: [' Maya@Demo.Example'], recipients: ['MAYA@demo.example  '] })).toBe(true);
  });

  it('needs every recipient on the list', () => {
    expect(recipientsAllowed({ allowlist: ['a@demo.example'], recipients: ['a@demo.example', 'b@demo.example'] })).toBe(
      false,
    );
  });

  it('does not take a lookalike for a listed address', () => {
    expect(recipientsAllowed({ allowlist: ['a@demo.example'], recipients: ['a@demo.example.evil.test'] })).toBe(false);
  });
});

describe('demo instance and connector calls', () => {
  it.each([
    ['send_draft with only a draft id', 'send_draft', { draft_id: 'd1' }],
    ['forward to an outside address', 'forward', { message_id: 'm1', to: 'x@outside.example' }],
    ['reply to all', 'reply', { message_id: 'm1', reply_all: true }],
    ['send_email to a stray address', 'send_email', { to: ['x@outside.example'], body: 'Hi' }],
    ['send_email to a listed address', 'send_email', { to: 'a@demo.example', body: 'Hi' }],
  ])('refuses %s with no card, however the list reads', async (_name, tool_name, params) => {
    for (const allowlist of [['a@demo.example'], []]) {
      const decision = await classifyTier(connectorCall({ tool_name, params }), ctx(allowlist));
      expect(decision).toMatchObject({
        auto_deny: 'outbound_guard',
        card: null,
        reason_detail: DEMO_CONNECTOR_REFUSAL,
      });
    }
  });

  it('still lets a connector call declared read-only through', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'search_threads', params: { query: 'lease' }, read_only_hint: true }),
      ctx(['a@demo.example']),
    );
    expect(decision.auto_deny).toBeNull();
  });

  it('is unchanged outside demo mode', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'send_email', params: { to: 'x@outside.example', body: 'Hi' } }),
      ctx(null),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
  });
});

describe("demo instance and Aman's own Gmail send", () => {
  it('asks as usual when every recipient is listed, however it is written', async () => {
    const decision = await classifyTier(
      hostGmailSend({ ...DRAFT, to: [bare(' A@Demo.example ')], cc: [bare('a@demo.example')] }),
      ctx(['a@demo.example']),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
  });

  it.each([
    ['a stray To', { to: [bare('x@outside.example')] }],
    ['a stray Cc', { cc: [bare('x@outside.example')] }],
    ['a stray Bcc', { bcc: [bare('x@outside.example')] }],
    ['no recipients at all', { to: [] }],
  ])('refuses %s with no card', async (_name, change) => {
    const decision = await classifyTier(hostGmailSend({ ...DRAFT, ...change }), ctx(['a@demo.example']));
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard', card: null, reason_detail: DEMO_SEND_REFUSAL });
  });

  it('refuses when the draft could not be loaded to check', async () => {
    const decision = await classifyTier(hostGmailSend(undefined), ctx(['a@demo.example']));
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard', card: null });
  });

  it('refuses everything when the list is empty', async () => {
    const decision = await classifyTier(hostGmailSend(DRAFT), ctx([]));
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard' });
  });

  it("still saves one of Aman's own Gmail drafts to anyone, since a draft never leaves the account", async () => {
    const decision = await classifyTier({ ...hostGmailSend(DRAFT), tool_name: 'draft_email' }, ctx(['a@demo.example']));
    expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'gmail_draft' });
  });
});

describe("demo instance and the host Email connector's drafts", () => {
  const LISTED = 'dana@example.com';
  const STRANGER = 'stranger@example.com';

  /** A demo context whose Email list (the addresses the owner has mailed) holds only the listed address. */
  function demoCtx(): ClassifyContext {
    const base = ctx(['a@demo.example']);
    return {
      ...base,
      services: { ...base.services, mail_listed_addresses: () => Promise.resolve([LISTED]) },
    };
  }

  /** A call on the host's own Email sidecar, carrying the first-party mark only the host's connector gets. */
  function hostMailCall(tool_name: string, params: Record<string, unknown>): SentinelAction {
    return {
      tool_name,
      canonical_params: params,
      tool_type: 'mcp',
      mcp_server_name: 'Email',
      mcp_server_host: 'mail-email',
      mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: true },
      mcp_first_party: true,
    };
  }

  it('lets a draft to a listed address through to its ordinary card, with no demo refusal', async () => {
    const decision = await classifyTier(
      hostMailCall('save_draft', { recipients: [LISTED], subject: 'Lease', body: 'Hi' }),
      demoCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'connector_send' });
    expect(decision.card?.plain_what).toContain('Save a message draft');
  });

  it('raises the new-recipient card for a draft to a new address instead of the demo refusal', async () => {
    const decision = await classifyTier(
      hostMailCall('save_draft', { recipients: [STRANGER], subject: 'Lease', body: 'Hi' }),
      demoCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_new_recipient' });
    expect(decision.card?.mail_new_recipients).toEqual([STRANGER]);
    expect(decision.card?.mail_draft).toBe(true);
    expect(decision.mail_send).toBe(false);
  });

  it('refuses a draft naming no one with the plain draft wording, not the demo refusal', async () => {
    const decision = await classifyTier(hostMailCall('save_draft', { subject: 'Lease', body: 'Hi' }), demoCtx());
    expect(decision.card).toBeNull();
    expect(decision.auto_deny).toBe('incomplete_send_card');
    expect(decision.reason_detail).toContain('a draft must say who it is for');
  });

  it.each(['send_email', 'forward_email'])('still refuses %s through the host connector', async tool_name => {
    const decision = await classifyTier(
      hostMailCall(tool_name, { recipients: [LISTED], subject: 'Lease', body: 'Hi' }),
      demoCtx(),
    );
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard', card: null, reason_detail: DEMO_CONNECTOR_REFUSAL });
  });

  it("still refuses a send named like Gmail's draft send on the host connector", async () => {
    const decision = await classifyTier(
      hostMailCall('send_draft', { recipients: [LISTED], subject: 'Lease', body: 'Hi' }),
      demoCtx(),
    );
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard', card: null, reason_detail: DEMO_CONNECTOR_REFUSAL });
  });

  it('still refuses a draft save from a connector that only shares the Email name', async () => {
    const lookalike: SentinelAction = {
      ...hostMailCall('save_draft', { recipients: [LISTED], subject: 'Lease', body: 'Hi' }),
      mcp_first_party: false,
    };
    const decision = await classifyTier(lookalike, demoCtx());
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard', card: null, reason_detail: DEMO_CONNECTOR_REFUSAL });
  });

  it('is unchanged outside demo mode', async () => {
    const base = demoCtx();
    const outsideDemo: ClassifyContext = {
      ...base,
      services: { ...base.services, demoSendAllowlist: null },
    };
    const decision = await classifyTier(
      hostMailCall('save_draft', { recipients: [LISTED], subject: 'Lease', body: 'Hi' }),
      outsideDemo,
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'connector_send' });
  });
});
