import {
  approvalCardForGatedCall,
  classifyTier,
  type ClassifyContext,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const MAIL_CONNECTOR = 'Email';
const CLOSED_WORLD_READ = { read_only_hint: true, open_world_hint: false };
const LOCAL_WRITE = { read_only_hint: false, open_world_hint: false };
const OUTBOUND_WRITE = { read_only_hint: false, open_world_hint: true };

import { inMemoryApprovedMailDrafts, mailDraftKey } from '../../../src/core/email/mailConnector/approvedDrafts';
import { everyMailDraftApproved } from '../fixtures/approvedMailDrafts';
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

/** A call on the Email connector with the hints it publishes, on the host's own sidecar. */
function hostMailCall(
  tool_name: string,
  canonical_params: Record<string, unknown>,
  mcp_hints: SentinelAction['mcp_hints'],
): SentinelAction {
  return { ...mailCall(tool_name, canonical_params, mcp_hints), mcp_first_party: true };
}

function makeCtx(): ClassifyContext {
  return {
    // Most tests here are about one card, so the draft step counts as done; the draft-first tests use a real record.
    services: {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      mail_approved_drafts: everyMailDraftApproved,
    },
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

  describe('mark as read', () => {
    // The hints the mail server really publishes for get_emails_content: a write only because of its mark-as-read switch.
    const CONTENT_HINTS = { read_only_hint: false, open_world_hint: true };

    it.each([
      ['left out', undefined],
      ['off', false],
      ['on', true],
      ['spelled as text', 'true'],
      ['a number', 1],
      ['the word yes', 'yes'],
    ])(
      'reading message bodies with the mark-as-read switch %s is a silent read, never a card the person did not ask for',
      async (_label, value) => {
        const params = value === undefined ? { email_ids: ['e1'] } : { email_ids: ['e1'], mark_as_read: value };
        const decision = await classifyTier(hostMailCall('get_emails_content', params, CONTENT_HINTS), makeCtx());
        expect(decision).toMatchObject({ tier: 1, reason: 'mail_read', auto_deny: null, sensitive_read: true });
        expect(decision.card).toBeNull();
      },
    );

    it('marking emails as read is its own change and asks on a card', async () => {
      const decision = await classifyTier(
        mailCall('mark_emails_as_read', { email_ids: ['e1', 'e2'] }, LOCAL_WRITE),
        makeCtx(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.reason).not.toBe('external_service');
      expect(decision.card?.plain_what).toContain('Mark emails as read');
      expect(decision.approval_token_id).not.toBeNull();
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

  describe('a send shows the message as a draft', () => {
    const LISTED = 'dana@example.com';
    const BODY = 'Hi Dana,\n\nThe terms look fine to me.\n\nNora';

    function ctxWithList(listed: readonly string[]): ClassifyContext {
      const ctx = makeCtx();
      return {
        ...ctx,
        services: {
          ...ctx.services,
          mail_listed_addresses: () => Promise.resolve(listed),
          mail_accounts: () =>
            Promise.resolve({ accounts: ['nora@mail.example'], default_account: 'nora@mail.example' }),
        },
      };
    }

    it('lays out who it goes to, the subject and the whole text, and names the account it goes from', async () => {
      const decision = await classifyTier(
        hostMailCall(
          'send_email',
          { recipients: [LISTED], cc: [{ name: 'Pippa', email: 'pippa@example.com' }], subject: SUBJECT, body: BODY },
          OUTBOUND_WRITE,
        ),
        ctxWithList([LISTED, 'pippa@example.com']),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.card?.email).toEqual({
        action: 'send',
        to: [{ name: '', address: LISTED }],
        cc: [{ name: 'Pippa', address: 'pippa@example.com' }],
        bcc: [],
        subject: SUBJECT,
        body: BODY,
        check_code: null,
        replaces: null,
        reply_in_thread: null,
        reply_to: null,
        from_name: null,
        name_left_off: false,
        forwards: null,
      });
      expect(decision.card?.mail_from).toBe('nora@mail.example');
      // The draft is the whole request here, so nothing is listed a second time beside it.
      expect(decision.card?.outbound_text).toBeNull();
    });

    it('a send to a new address shows the same draft with the new-recipient notice', async () => {
      const decision = await classifyTier(
        hostMailCall(
          'send_email',
          { recipients: ['stranger@example.com'], subject: SUBJECT, body: BODY },
          OUTBOUND_WRITE,
        ),
        ctxWithList([LISTED]),
      );
      expect(decision.reason).toBe('mail_new_recipient');
      expect(decision.card?.email).toMatchObject({
        action: 'send',
        to: [{ name: '', address: 'stranger@example.com' }],
        subject: SUBJECT,
        body: BODY,
      });
    });

    it('a draft to a new address shows the draft as something saved, not sent', async () => {
      const decision = await classifyTier(
        hostMailCall('save_draft', { recipients: ['stranger@example.com'], subject: SUBJECT, body: BODY }, LOCAL_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision.card?.mail_draft).toBe(true);
      expect(decision.card?.email).toMatchObject({ action: 'save', subject: SUBJECT, body: BODY });
    });

    it('lists every other argument beside the draft, so nothing that is sent is left off the card', async () => {
      const decision = await classifyTier(
        hostMailCall(
          'send_email',
          { recipients: [LISTED], subject: SUBJECT, body: BODY, attachments: ['/files/lease.pdf'], html: true },
          OUTBOUND_WRITE,
        ),
        ctxWithList([LISTED]),
      );
      expect(decision.card?.email?.body).toBe(BODY);
      expect(decision.card?.outbound_text).toContain('/files/lease.pdf');
      expect(decision.card?.outbound_text).toContain('html');
      expect(decision.card?.outbound_text).not.toContain(SUBJECT);
    });

    it('keeps the plain listing of the whole request when a part of the message cannot be shown as written', async () => {
      const decision = await classifyTier(
        hostMailCall('send_email', { recipients: [LISTED], subject: SUBJECT, body: { text: BODY } }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.card?.email ?? null).toBeNull();
      expect(decision.card?.outbound_text).toContain(SUBJECT);
    });

    const FORWARDED = {
      from: 'Pippa Reed <pippa@example.com>',
      subject: 'Roof repair quote',
      body: 'The quote is 1,200 for the whole roof.',
      truncated: false,
      attachments: ['quote.pdf'],
    };

    it('a forward shows the note, the message it sends on and the files that go with it', async () => {
      const decision = await classifyTier(
        {
          ...hostMailCall(
            'forward_email',
            { email_id: 'e1', recipients: [LISTED], body: 'Can you look at this?' },
            OUTBOUND_WRITE,
          ),
          mail_forward: FORWARDED,
        },
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_send' });
      expect(decision.card?.email).toMatchObject({
        action: 'send',
        to: [{ name: '', address: LISTED }],
        subject: 'Fwd: Roof repair quote',
        body: 'Can you look at this?',
        forwards: FORWARDED,
      });
      expect(decision.card?.outbound_text).toBeNull();
    });

    it('a forward with no note still shows the message it sends on, and marks the subject once', async () => {
      const decision = await classifyTier(
        {
          ...hostMailCall('forward_email', { email_id: 'e1', recipients: [LISTED] }, OUTBOUND_WRITE),
          mail_forward: { ...FORWARDED, subject: 'Fwd: Roof repair quote' },
        },
        ctxWithList([LISTED]),
      );
      expect(decision.card?.email).toMatchObject({ subject: 'Fwd: Roof repair quote', body: '' });
    });

    it('a forward that leaves the files behind lists none', async () => {
      const decision = await classifyTier(
        {
          ...hostMailCall(
            'forward_email',
            { email_id: 'e1', recipients: [LISTED], include_attachments: false },
            OUTBOUND_WRITE,
          ),
          mail_forward: FORWARDED,
        },
        ctxWithList([LISTED]),
      );
      expect(decision.card?.email?.forwards?.attachments).toEqual([]);
    });

    it('a forward offers no other account, because one account holds the message', async () => {
      const decision = await classifyTier(
        {
          ...hostMailCall('forward_email', { email_id: 'e1', recipients: [LISTED] }, OUTBOUND_WRITE),
          mail_forward: FORWARDED,
        },
        ctxWithList([LISTED]),
      );
      expect(decision.card?.mail_from).toBe('nora@mail.example');
      expect(decision.card?.mail_from_choices).toEqual([]);
    });

    it('a forward to a new address shows the same draft with the new-recipient notice', async () => {
      const decision = await classifyTier(
        {
          ...hostMailCall('forward_email', { email_id: 'e1', recipients: ['stranger@example.com'] }, OUTBOUND_WRITE),
          mail_forward: FORWARDED,
        },
        ctxWithList([LISTED]),
      );
      expect(decision.reason).toBe('mail_new_recipient');
      expect(decision.card?.email?.forwards).toEqual(FORWARDED);
    });

    it('a forward whose message could not be read keeps the plain listing of the whole request', async () => {
      const decision = await classifyTier(
        {
          ...hostMailCall('forward_email', { email_id: 'e1', recipients: [LISTED] }, OUTBOUND_WRITE),
          mail_forward: null,
        },
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.card?.email ?? null).toBeNull();
      expect(decision.card?.outbound_text).toContain('e1');
    });
  });

  describe('a message is a draft the person approved before it can be sent', () => {
    const LISTED = 'dana@example.com';
    const BODY = 'Hi Dana,\n\nThe terms look fine to me.\n\nNora';
    const MESSAGE = { recipients: [LISTED], subject: SUBJECT, body: BODY };
    const OWNER = { tenant_id: 't1', created_by: 'u1' };

    function ctxWithDrafts(): ClassifyContext {
      const ctx = makeCtx();
      return {
        ...ctx,
        services: {
          ...ctx.services,
          mail_approved_drafts: inMemoryApprovedMailDrafts(),
          mail_listed_addresses: () => Promise.resolve([LISTED]),
          mail_accounts: () =>
            Promise.resolve({ accounts: ['nora@mail.example'], default_account: 'nora@mail.example' }),
        },
      };
    }

    async function approveDraft(ctx: ClassifyContext, tool_name: string, params: Record<string, unknown>) {
      await ctx.services.mail_approved_drafts.add({ ...OWNER, key: mailDraftKey({ tool_name, params }) });
    }

    it('refuses a send with no approved draft, shows no card, and says to save a draft first', async () => {
      const decision = await classifyTier(hostMailCall('send_email', MESSAGE, OUTBOUND_WRITE), ctxWithDrafts());
      expect(decision).toMatchObject({ tier: 3, auto_deny: 'draft_first', card: null });
      expect(decision.reason_detail).toContain('save_draft');
    });

    it('refuses a send to a new address with no approved draft, before any new-recipient card', async () => {
      const decision = await classifyTier(
        hostMailCall('send_email', { ...MESSAGE, recipients: ['stranger@example.com'] }, OUTBOUND_WRITE),
        ctxWithDrafts(),
      );
      expect(decision).toMatchObject({ auto_deny: 'draft_first', card: null });
    });

    it('asks to save a draft with the whole message on the card, and no answer covers the next draft', async () => {
      const decision = await classifyTier(hostMailCall('save_draft', MESSAGE, LOCAL_WRITE), ctxWithDrafts());
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_draft', standing_grant_barred: true });
      expect(decision.card?.copy?.headline).toBe('Save this draft?');
      expect(decision.card?.email).toMatchObject({ action: 'save', subject: SUBJECT, body: BODY });
      expect(decision.card?.mail_from).toBe('nora@mail.example');
      expect(decision.mail_send ?? false).toBe(false);
    });

    it('asks to send once the same message was approved as a draft', async () => {
      const ctx = ctxWithDrafts();
      await approveDraft(ctx, 'save_draft', MESSAGE);
      const decision = await classifyTier(hostMailCall('send_email', MESSAGE, OUTBOUND_WRITE), ctx);
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_send', mail_send: true });
      expect(decision.card?.email).toMatchObject({ action: 'send', subject: SUBJECT, body: BODY });
    });

    it('treats the same message written with other line endings and address case as the same draft', async () => {
      const ctx = ctxWithDrafts();
      await approveDraft(ctx, 'save_draft', { ...MESSAGE, body: 'Line one\r\nLine two  ' });
      const decision = await classifyTier(
        hostMailCall(
          'send_email',
          { recipients: ['Dana@Example.com'], subject: SUBJECT, body: 'Line one\nLine two', cc: [] },
          OUTBOUND_WRITE,
        ),
        ctx,
      );
      expect(decision).toMatchObject({ auto_deny: null, reason: 'mail_send' });
    });

    it.each([
      ['a changed text', { ...MESSAGE, body: `${BODY} One more thing.` }],
      ['a changed subject', { ...MESSAGE, subject: 'Another subject' }],
      ['another recipient', { ...MESSAGE, recipients: ['pippa@example.com'] }],
      ['an added copy', { ...MESSAGE, cc: ['pippa@example.com'] }],
      ['an added hidden copy', { ...MESSAGE, bcc: ['pippa@example.com'] }],
      ['an added file', { ...MESSAGE, attachments: ['/files/lease.pdf'] }],
    ])('refuses a send with %s, because that is not the draft the person approved', async (_what, changed) => {
      const ctx = ctxWithDrafts();
      await approveDraft(ctx, 'save_draft', MESSAGE);
      const decision = await classifyTier(hostMailCall('send_email', changed, OUTBOUND_WRITE), ctx);
      expect(decision).toMatchObject({ auto_deny: 'draft_first', card: null });
    });

    it('does not let an approved draft of a new message stand in for a forward', async () => {
      const ctx = ctxWithDrafts();
      await approveDraft(ctx, 'save_draft', { recipients: [LISTED], body: 'See below.' });
      const decision = await classifyTier(
        {
          ...hostMailCall(
            'forward_email',
            { email_id: 'e1', recipients: [LISTED], body: 'See below.' },
            OUTBOUND_WRITE,
          ),
          mail_forward: {
            from: 'Pippa <pippa@example.com>',
            subject: 'Quote',
            body: 'Hi',
            truncated: false,
            attachments: [],
          },
        },
        ctx,
      );
      expect(decision).toMatchObject({ auto_deny: null, reason: 'mail_draft' });
    });

    it('asks to keep a forward as a draft first, then asks to send the same forward', async () => {
      const ctx = ctxWithDrafts();
      const params = { email_id: 'e1', recipients: [LISTED], body: 'Can you look at this?' };
      const forward = {
        ...hostMailCall('forward_email', params, OUTBOUND_WRITE),
        mail_forward: {
          from: 'Pippa <pippa@example.com>',
          subject: 'Quote',
          body: 'Hi',
          truncated: false,
          attachments: [],
        },
      };
      const first = await classifyTier(forward, ctx);
      expect(first).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_draft', standing_grant_barred: true });
      expect(first.mail_send ?? false).toBe(false);
      expect(first.card?.copy?.headline).toBe('Save this draft?');
      expect(first.card?.email).toMatchObject({ action: 'save', forwards: { subject: 'Quote' } });

      await approveDraft(ctx, 'forward_email', params);
      const second = await classifyTier(forward, ctx);
      expect(second).toMatchObject({ auto_deny: null, reason: 'mail_send', mail_send: true });
      expect(second.card?.email).toMatchObject({ action: 'send', forwards: { subject: 'Quote' } });
    });

    it('keeps a forward to a new address as a draft first, and adds the address with it', async () => {
      const decision = await classifyTier(
        hostMailCall('forward_email', { email_id: 'e1', recipients: ['stranger@example.com'] }, OUTBOUND_WRITE),
        ctxWithDrafts(),
      );
      expect(decision).toMatchObject({ auto_deny: null, reason: 'mail_new_recipient' });
      expect(decision.card?.mail_draft).toBe(true);
      expect(decision.mail_send ?? false).toBe(false);
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
        hostMailCall('send_email', { recipients: [LISTED], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.reason).not.toBe('mail_new_recipient');
      expect(decision.card?.plain_what).not.toContain('New recipient');
    });

    it('a send to an address not on the list asks with the new-recipient card', async () => {
      const decision = await classifyTier(
        hostMailCall('send_email', { recipients: [STRANGER], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_new_recipient' });
      expect(decision.card?.plain_what).toContain(NEW_RECIPIENT_LINE);
      expect(decision.card?.plain_what).toContain('Approving adds them to your send list and sends.');
      expect(decision.card?.mail_new_recipients).toEqual([STRANGER]);
      expect(decision.card?.mail_draft ?? null).toBeNull();
      expect(decision.card?.cannot_be_undone).toBe("Once this is sent, it can't be unsent.");
      expect(decision.card?.destination_host).toBeNull();
      expect(decision.card?.email?.subject).toBe(SUBJECT);
      expect(decision.approval_token_id).not.toBeNull();
    });

    it('puts the new-recipient line in the copy the card renders, not only in its older sentence', async () => {
      const decision = await classifyTier(
        hostMailCall('send_email', { recipients: [STRANGER], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_new_recipient' });
      // The permission card renders its copy and never shows plain_what, so the line a person
      // needs (this address is new, and approving adds it) has to lead the copy's consequence.
      expect(decision.card?.copy?.consequence).toBe(
        `${NEW_RECIPIENT_LINE} Approving adds them to your send list and sends. Once this is sent, it can't be unsent.`,
      );
    });

    it('one unlisted address among listed ones is still a new recipient', async () => {
      const decision = await classifyTier(
        hostMailCall(
          'send_email',
          { recipients: [LISTED], cc: [STRANGER], subject: SUBJECT, body: 'Hi' },
          OUTBOUND_WRITE,
        ),
        ctxWithList([LISTED]),
      );
      expect(decision.reason).toBe('mail_new_recipient');
      expect(decision.card?.plain_what).toContain(NEW_RECIPIENT_LINE);
    });

    it('matches the list ignoring case and edge space', async () => {
      const decision = await classifyTier(
        hostMailCall(
          'send_email',
          { recipients: [' DANA@Example.com '], subject: SUBJECT, body: 'Hi' },
          OUTBOUND_WRITE,
        ),
        ctxWithList([LISTED]),
      );
      expect(decision.reason).not.toBe('mail_new_recipient');
    });

    it('with no list at all, every recipient is new', async () => {
      const decision = await classifyTier(
        hostMailCall('send_email', { recipients: [LISTED], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([]),
      );
      expect(decision.reason).toBe('mail_new_recipient');
    });

    it('forward_email to an address not on the list asks with the new-recipient card', async () => {
      const decision = await classifyTier(
        hostMailCall('forward_email', { email_id: 'e1', recipients: [STRANGER], subject: SUBJECT }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, reason: 'mail_new_recipient' });
      expect(decision.card?.plain_what).toContain(NEW_RECIPIENT_LINE);
    });

    it('a draft to an address not on the list asks with the new-recipient card, in draft words', async () => {
      const decision = await classifyTier(
        hostMailCall('save_draft', { recipients: [STRANGER], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_new_recipient' });
      expect(decision.card?.plain_what).toContain(NEW_RECIPIENT_LINE);
      expect(decision.card?.plain_what).toContain('Approving adds them to your send list and saves this draft.');
      expect(decision.card?.plain_what).toContain('Save a message draft');
      expect(decision.card?.plain_what).not.toContain('and sends.');
      expect(decision.card?.mail_new_recipients).toEqual([STRANGER]);
      expect(decision.card?.mail_draft).toBe(true);
      // A draft sends nothing, so it carries no send warning, and its destination is the recipient, not the endpoint.
      expect(decision.card?.cannot_be_undone).toBeNull();
      expect(decision.card?.destination_host).toBeNull();
      expect(decision.card?.recipient).toContain(STRANGER);
      expect(decision.mail_send).toBe(false);
      expect(decision.approval_token_id).not.toBeNull();
    });

    it('a draft to a listed address keeps the ordinary draft card and adds nobody', async () => {
      const decision = await classifyTier(
        hostMailCall('save_draft', { recipients: [LISTED], subject: SUBJECT, body: 'Hi' }, LOCAL_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision.reason).toBe('mail_draft');
      expect(decision.card?.plain_what).not.toContain('New recipient');
      expect(decision.card?.mail_new_recipients ?? null).toBeNull();
    });

    it('a draft to a listed address on the host sidecar shows no send warning and no endpoint as its destination', async () => {
      const decision = await classifyTier(
        hostMailCall('save_draft', { recipients: [LISTED], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_draft' });
      expect(decision.card?.plain_what).toBe('Save this draft?');
      expect(decision.card?.cannot_be_undone).toBeNull();
      expect(decision.card?.destination_host).toBeNull();
      expect(decision.card?.recipient).toContain(LISTED);
    });

    it('a draft with no recipient is refused before any card', async () => {
      const decision = await classifyTier(
        hostMailCall('save_draft', { subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision.card).toBeNull();
      expect(decision.auto_deny).toBe('incomplete_send_card');
      expect(decision.reason_detail).toContain('a draft must say who it is for');
      expect(decision.owner_message).toContain('Nothing was saved');
    });

    it('a draft with no recipient on a connector that only shares the name is not refused for that', async () => {
      const decision = await classifyTier(
        mailCall('save_draft', { subject: SUBJECT, body: 'Hi' }, LOCAL_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision.auto_deny).toBeNull();
      expect(decision.card).not.toBeNull();
    });

    it("a send through the host's own sidecar to a listed address asks under its own reason, and no answer covers it", async () => {
      const decision = await classifyTier(
        hostMailCall('send_email', { recipients: [LISTED], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_send' });
      expect(decision.card?.destination_host).toBeNull();
      expect(decision.approval_token_id).not.toBeNull();
    });

    it('a connector that only shares the name never gets the new-recipient card or the send-list reason', async () => {
      const decision = await classifyTier(
        mailCall('send_email', { recipients: [STRANGER], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithList([LISTED]),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null });
      expect(decision.reason).not.toBe('mail_new_recipient');
      expect(decision.reason).not.toBe('mail_send');
      expect(decision.card?.mail_new_recipients ?? null).toBeNull();
      // Only the host's own sidecar drops the endpoint: a connector that shares the name still shows its host.
      expect(decision.card?.destination_host).toBe('mail-email');
    });
  });

  describe('accounts', () => {
    const WORK = 'work@example.com';
    const HOME = 'home@example.com';
    const DANA = 'dana@example.com';

    /** Two accounts; Dana is listed for Home only. Work is the default. */
    function ctxWithAccounts(): ClassifyContext {
      const ctx = makeCtx();
      return {
        ...ctx,
        services: {
          ...ctx.services,
          mail_accounts: () => Promise.resolve({ accounts: [WORK, HOME], default_account: WORK }),
          mail_listed_addresses: ({ account }: { account: string | null }) =>
            Promise.resolve(account === HOME ? [DANA] : []),
        },
      };
    }

    it('a send from the account that lists the recipient keeps the plain send card and names its account', async () => {
      const decision = await classifyTier(
        hostMailCall(
          'send_email',
          { account_name: HOME, recipients: [DANA], subject: SUBJECT, body: 'Hi' },
          OUTBOUND_WRITE,
        ),
        ctxWithAccounts(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_send' });
      expect(decision.card?.mail_from).toBe(HOME);
      expect(decision.card?.mail_from_choices).toEqual([WORK, HOME]);
    });

    it('a send from the other account to the same recipient asks with the new-recipient card', async () => {
      const decision = await classifyTier(
        hostMailCall(
          'send_email',
          { account_name: WORK, recipients: [DANA], subject: SUBJECT, body: 'Hi' },
          OUTBOUND_WRITE,
        ),
        ctxWithAccounts(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_new_recipient' });
      expect(decision.card?.mail_new_recipients).toEqual([DANA]);
      expect(decision.card?.mail_from).toBe(WORK);
    });

    it('a send naming no account is checked against the default account list', async () => {
      const decision = await classifyTier(
        hostMailCall('send_email', { recipients: [DANA], subject: SUBJECT, body: 'Hi' }, OUTBOUND_WRITE),
        ctxWithAccounts(),
      );
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'mail_new_recipient' });
      expect(decision.card?.mail_from).toBe(WORK);
    });
  });

  describe('unknown tools', () => {
    it('a tool the Email connector does not offer with a mail word in its name is never silent', async () => {
      const decision = await classifyTier(hostMailCall('purge_emails', { mailbox: 'INBOX' }, {}), makeCtx());
      expect(decision.tier).not.toBe(1);
      // It asks with the unknown-tool card, like empty_trash below: naming a mailbox reaches only
      // the connector's own store, so the unverifiable-destination rule no longer refuses it for
      // the mail word in its name. That refusal came from the deleted name-fragment registry.
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'unrecognized_tool' });
      expect(decision.card).not.toBeNull();
    });

    it('a tool with no recognized name asks with a card and is never silent', async () => {
      const decision = await classifyTier(hostMailCall('empty_trash', { mailbox: 'Trash' }, {}), makeCtx());
      expect(decision).toMatchObject({ tier: 3, auto_deny: null, reason: 'unrecognized_tool' });
      expect(decision.card).not.toBeNull();
    });

    it('the card for an unknown Email tool keeps a plain warning and shows its argument labels', async () => {
      const decision = await classifyTier(hostMailCall('empty_trash', { mailbox: 'Trash', ids: ['1'] }, {}), makeCtx());
      expect(decision.card?.cannot_be_undone).toBe('It is not clear whether this can be undone.');
      expect(decision.card?.plain_what).toBe('Allow this new tool from Email?');
      expect(decision.card?.outbound_text).toContain('ids (array): ["1"]');
    });
  });

  describe('the card for a call that asks without a rule', () => {
    it.each(['list_emails_metadata', 'get_emails_content', 'get_attachment_content', 'list_mailboxes'])(
      'a gated %s read on the first-party Email sidecar is not called new and carries no warning',
      tool => {
        const card = approvalCardForGatedCall({
          action: firstPartyMailCall(tool, { mailbox: 'INBOX' }),
          agent_intent: null,
        });
        expect(card.plain_what).toBe('Allow reading your email?');
        expect(card.cannot_be_undone).toBeNull();
      },
    );

    it('a gated Email write keeps the warning, even on the first-party sidecar', () => {
      const card = approvalCardForGatedCall({
        action: firstPartyMailCall('archive_emails', { ids: ['1'] }),
        agent_intent: null,
      });
      expect(card.cannot_be_undone).not.toBeNull();
    });

    it('a mail-read call on a connector named Email that is not first-party asks like any other connector', () => {
      const card = approvalCardForGatedCall({
        action: mailCall('list_emails_metadata', {}, CLOSED_WORLD_READ),
        agent_intent: null,
      });
      expect(card.plain_what).toBe('Allow this new tool from Email?');
      expect(card.cannot_be_undone).toBe('It is not clear whether this can be undone.');
    });

    it('a connector that only declares itself read-only still gets the warning', async () => {
      const decision = await classifyTier(
        mailCall('peek_trash', { mailbox: 'Trash' }, { read_only_hint: true, open_world_hint: true }),
        makeCtx(),
      );
      expect(decision.card?.cannot_be_undone).toBe('It is not clear whether this can be undone.');
    });

    it('a mail-read name on another connector is still an unknown tool with the warning', () => {
      const card = approvalCardForGatedCall({
        action: { ...firstPartyMailCall('list_emails_metadata', {}), mcp_server_name: 'Mail Mirror' },
        agent_intent: null,
      });
      expect(card.plain_what).toBe('Allow this new tool from Mail Mirror?');
      expect(card.cannot_be_undone).toBe('It is not clear whether this can be undone.');
    });
  });
});
