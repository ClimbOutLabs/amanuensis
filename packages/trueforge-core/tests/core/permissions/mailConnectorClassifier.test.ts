import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const MAIL_CONNECTOR = 'Email';
const CLOSED_WORLD_READ = { read_only_hint: true, open_world_hint: false };
const LOCAL_WRITE = { read_only_hint: false, open_world_hint: false };
const OUTBOUND_WRITE = { read_only_hint: false, open_world_hint: true };

function mailCall(
  tool_name: string,
  canonical_params: Record<string, unknown>,
  mcp_hints: SentinelAction['mcp_hints'],
): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'mcp',
    mcp_server_name: MAIL_CONNECTOR,
    mcp_server_host: 'mail-email',
    mcp_hints,
  };
}

/** A call on the Email connector that the host vouches for: the operator's own sidecar. */
function firstPartyMailCall(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return { ...mailCall(tool_name, canonical_params, CLOSED_WORLD_READ), mcp_first_party: true };
}

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

const RECIPIENT = { name: 'Dana Lee', email: 'dana@example.com' };
const SUBJECT = 'Lease renewal terms';

describe('Email connector classifier', () => {
  describe('reads', () => {
    const READS: Array<[string, Record<string, unknown>]> = [
      ['list_emails_metadata', { mailbox: 'INBOX', limit: 20 }],
      ['get_emails_content', { email_ids: ['e1'] }],
      ['get_attachment_content', { email_id: 'e1', attachment_id: 'a1' }],
      ['list_mailboxes', { account: 'owner' }],
    ];

    it.each(READS)(
      '%s from a connector the user added, not first-party, still shows its card',
      async (name, params) => {
        const decision = await classifyTier(mailCall(name, params, CLOSED_WORLD_READ), makeCtx());
        expect(decision).toMatchObject({ tier: 3, auto_deny: null, sensitive_read: true });
        expect(decision.approval_token_id).not.toBeNull();
        expect(decision.card?.destination_host).toBe('mail-email');
        for (const value of Object.values(params)) {
          expect(decision.card?.outbound_text).toContain(String(value));
        }
      },
    );

    it.each(READS)(
      '%s from the first-party Email sidecar runs without a card and is a read of private data',
      async (name, params) => {
        const ctx = makeCtx();
        const decision = await classifyTier(firstPartyMailCall(name, params), ctx);
        expect(decision).toMatchObject({ tier: 1, reason: 'mail_read', auto_deny: null, sensitive_read: true });
        expect(decision.card).toBeNull();
      },
    );

    it('a read is never silent when the sidecar is offline', async () => {
      const ctx = makeCtx();
      ctx.services.isOffline = () => Promise.resolve(true);
      const decision = await classifyTier(firstPartyMailCall('list_emails_metadata', { mailbox: 'INBOX' }), ctx);
      expect(decision).toMatchObject({ tier: 3, reason: 'auto_denied', auto_deny: 'offline_mode' });
    });
  });

  describe('sends', () => {
    it('a send from the first-party Email sidecar still asks, even when the server declares it read-only', async () => {
      const decision = await classifyTier(
        firstPartyMailCall('send_email', { recipients: [RECIPIENT], subject: SUBJECT, body: 'Hello' }),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.card).not.toBeNull();
    });

    it('a new-recipient card names the addresses it would add, and a plain send card names none', async () => {
      const stranger = await classifyTier(
        firstPartyMailCall('send_email', { recipients: ['Stranger@Example.net'], subject: SUBJECT, body: 'Hello' }),
        makeCtx(),
      );
      expect(stranger.card?.mail_new_recipients).toEqual(['stranger@example.net']);
      const listedCtx = makeCtx();
      listedCtx.services.mail_listed_addresses = () => Promise.resolve(['dana@example.com']);
      const listed = await classifyTier(
        mailCall('send_email', { recipients: ['dana@example.com'], subject: SUBJECT, body: 'Hi' }, CLOSED_WORLD_READ),
        listedCtx,
      );
      expect(listed.card?.mail_new_recipients ?? null).toBeNull();
    });

    it('a request that reaches a stranger asks with the new-recipient card, even from the first-party sidecar', async () => {
      const decision = await classifyTier(
        firstPartyMailCall('send_email', { recipients: ['stranger@example.net'], subject: SUBJECT, body: 'Hello' }),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, reason: 'mail_new_recipient', auto_deny: null });
    });

    it('send_email always shows a card naming the recipient and the subject', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { recipients: [RECIPIENT], subject: SUBJECT, body: 'See attached.' }, OUTBOUND_WRITE),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.card?.recipient).toContain('dana@example.com');
      expect(decision.card?.outbound_text).toContain('Dana Lee');
      expect(decision.card?.outbound_text).toContain(SUBJECT);
    });

    it('send_email still shows its card when the server declares it read-only', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { recipients: ['dana@example.com'], subject: SUBJECT, body: 'Hi' }, CLOSED_WORLD_READ),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.card?.recipient).toContain('dana@example.com');
    });

    it('send_email with no recipient is refused rather than sent without a card', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        makeCtx(),
      );
      expect(decision.auto_deny).not.toBeNull();
    });

    it('forward_email shows a card naming the recipient and the subject', async () => {
      const decision = await classifyTier(
        mailCall('forward_email', { email_id: 'e1', recipients: [RECIPIENT], subject: SUBJECT }, OUTBOUND_WRITE),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.card?.recipient).toContain('dana@example.com');
      expect(decision.card?.outbound_text).toContain(SUBJECT);
    });

    it('save_draft is carded like the other draft saves, as a message send', async () => {
      const decision = await classifyTier(
        mailCall('save_draft', { recipients: [RECIPIENT], subject: SUBJECT, body: 'See the lease.' }, LOCAL_WRITE),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'connector_send' });
      expect(decision.card?.plain_what).toContain('Save a message draft');
      expect(decision.card?.recipient).toContain('dana@example.com');
    });

    it('archive_emails shows a card and is not treated as an external send', async () => {
      const decision = await classifyTier(
        mailCall('archive_emails', { email_ids: ['e1', 'e2'] }, LOCAL_WRITE),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.reason).not.toBe('external_service');
      expect(decision.card?.plain_what).toContain('Archive emails');
      expect(decision.card?.outbound_text).toContain('e2');
    });
  });

  describe('new recipients', () => {
    const LISTED = 'dana@example.com';
    const STRANGER = 'stranger@example.com';
    const NEW_RECIPIENT_LINE = `New recipient. You have never emailed ${STRANGER}.`;

    function ctxWithList(listed: readonly string[]): ClassifyContext {
      const ctx = makeCtx();
      return { ...ctx, services: { ...ctx.services, mail_listed_addresses: () => Promise.resolve(listed) } };
    }

    it('a send to a listed address keeps the plain send card', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { recipients: [LISTED], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.reason).not.toBe('mail_new_recipient');
      expect(decision.card?.plain_what).not.toContain('New recipient');
    });

    it('a send to an address not on the list asks with the new-recipient card', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { recipients: [STRANGER], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_new_recipient' });
      expect(decision.card?.plain_what).toContain(NEW_RECIPIENT_LINE);
      expect(decision.card?.plain_what).toContain('Approving adds them to your send list and sends.');
      expect(decision.card?.mail_new_recipients).toEqual([STRANGER]);
      expect(decision.card?.outbound_text).toContain(SUBJECT);
      expect(decision.approval_token_id).not.toBeNull();
    });

    it('one unlisted address among listed ones is still a new recipient', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { recipients: [LISTED], cc: [STRANGER], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision.reason).toBe('mail_new_recipient');
      expect(decision.card?.plain_what).toContain(NEW_RECIPIENT_LINE);
    });

    it('matches the list ignoring case and edge space', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { recipients: [' DANA@Example.com '], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision.reason).not.toBe('mail_new_recipient');
    });

    it('with no list at all, every recipient is new', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { recipients: [LISTED], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([]),
      );
      expect(decision.reason).toBe('mail_new_recipient');
    });

    it('forward_email to an address not on the list asks with the new-recipient card', async () => {
      const decision = await classifyTier(
        mailCall('forward_email', { email_id: 'e1', recipients: [STRANGER], subject: SUBJECT }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, reason: 'mail_new_recipient' });
      expect(decision.card?.plain_what).toContain(NEW_RECIPIENT_LINE);
    });

    it('save_draft is not a send, so it never asks about new recipients', async () => {
      const decision = await classifyTier(
        mailCall('save_draft', { recipients: [STRANGER], subject: SUBJECT, body: 'Hi' }, LOCAL_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision.reason).toBe('connector_send');
      expect(decision.card?.plain_what).not.toContain('New recipient');
    });
  });

  describe('unknown tools', () => {
    it('a tool the Email connector does not offer with a mail word in its name is never silent', async () => {
      const decision = await classifyTier(mailCall('purge_emails', { mailbox: 'INBOX' }, {}), makeCtx());
      expect(decision.tier).not.toBe(1);
      expect(decision.auto_deny).not.toBeNull();
    });

    it('a tool with no recognized name asks with a card and is never silent', async () => {
      const decision = await classifyTier(mailCall('empty_trash', { mailbox: 'Trash' }, {}), makeCtx());
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'unrecognized_tool' });
      expect(decision.card).not.toBeNull();
    });
  });
});
