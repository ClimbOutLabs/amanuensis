import { DraftReviewLedger } from '../../../../src/core/email/gmail/draftReview';
import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { allowsChatApproval, allowsToolGrant } from '../../../../src/core/mcp/approvalGrant';
import { verifyPreDispatch } from '../../../../src/core/permissions/dispatch';
import { classifyUnstampedToolCall } from '../../../../src/core/runtime/AgentThread';
import { message, plainDraft } from './fixtures';
import { build, json, route, sentDraft, text, type Route } from './harness';

const COMPOSE = ['gmail_read', 'gmail_compose'] as const;

/** Gmail's draft resource: the stored message under a draft id. */
function draftResource(id: string, mail: GmailMessage) {
  return { id, message: mail };
}

const ORIGINAL = plainDraft({
  id: 'd-m1',
  threadId: 't9',
  to: 'Grace <grace@example.com>, lin@example.com',
  subject: 'Lease',
  body: 'Thursday works.',
});

const draftRoute = (mail: GmailMessage = ORIGINAL): Route => route('/drafts/d1', draftResource('d1', mail));

const sendRoute: Route = url =>
  url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined;

describe('tools offered', () => {
  it('offers the write tools only with the compose grant', async () => {
    const readOnly = await build({ routes: [] });
    expect((await readOnly.tools.listTools()).result.tools.map(tool => tool.name)).not.toContain('send_draft');
    const compose = await build({ routes: [], features: [...COMPOSE] });
    expect((await compose.tools.listTools()).result.tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['draft_email', 'update_draft', 'send_draft']),
    );
  });

  it('never offers or runs a write in a scheduled run, even with the compose grant', async () => {
    const { tools } = await build({ routes: [], features: [...COMPOSE], unattended: true });
    const names = (await tools.listTools()).result.tools.map(tool => tool.name);
    expect(names).toContain('read_email');
    for (const write of ['draft_email', 'update_draft', 'send_draft']) {
      expect(names).not.toContain(write);
    }
    const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(text(response)).toContain('Unknown tool');
  });

  it('refuses a write call from a scheduled run at classification, with a card-free denial and no Gmail call', async () => {
    const { tools, google } = await build({ routes: [draftRoute()], features: [...COMPOSE], unattended: true });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.pre_dispatch_failure?.message).toContain('never draft or send');
    expect(info.tier3_card).toBeFalsy();
    expect(google.urls).toHaveLength(0);
  });
});

describe('draft_email', () => {
  it('saves a draft through Gmail and returns its ids', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url =>
          url.pathname === '/gmail/v1/users/me/drafts'
            ? json({ id: 'd7', message: { id: 'm7', threadId: 't7' } })
            : undefined,
      ],
    });
    const response = await tools.callTool({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], subject: 'Lease', body: 'Thursday works.' },
    });
    expect(JSON.parse(text(response))).toMatchObject({
      draft_id: 'd7',
      message_id: 'm7',
      action: 'drafted',
      thread_id: 't7',
    });
    expect(google.urls).toContain('POST /gmail/v1/users/me/drafts');
    expect(sentDraft(google.bodies[0]).mime).toContain('To: grace@example.com');
  });

  describe('replying', () => {
    const original = message({
      id: 'orig',
      threadId: 't5',
      subject: 'Lease renewal',
      extraHeaders: [
        { name: 'Message-ID', value: '<orig@mail.example.com>' },
        { name: 'References', value: '<first@mail.example.com>\r\n <second@mail.example.com>' },
      ],
    });
    const created: Route = url =>
      url.pathname === '/gmail/v1/users/me/drafts'
        ? json({ id: 'd8', message: { id: 'm8', threadId: 't5' } })
        : undefined;

    it('takes the thread, the subject "Re: <original>" and the reply headers from the message it answers', async () => {
      const { tools, google } = await build({
        features: [...COMPOSE],
        routes: [route('/messages/orig', original), created],
      });
      await tools.callTool({
        name: 'draft_email',
        arguments: { to: ['grace@example.com'], subject: 'anything the model chose', body: 'ok', in_reply_to: 'orig' },
      });
      const { mime, threadId } = sentDraft(google.bodies[0]);
      expect(threadId).toBe('t5');
      expect(mime).toContain('Subject: Re: Lease renewal');
      expect(mime).toContain('In-Reply-To: <orig@mail.example.com>');
      expect(mime).toContain('References: <first@mail.example.com> <second@mail.example.com> <orig@mail.example.com>');
    });

    it('does not stack "Re:" on a subject that already has it', async () => {
      const answering = message({ id: 'orig', threadId: 't5', subject: 'Re: Lease renewal' });
      const { tools, google } = await build({
        features: [...COMPOSE],
        routes: [route('/messages/orig', answering), created],
      });
      await tools.callTool({
        name: 'draft_email',
        arguments: { to: ['grace@example.com'], subject: 'x', body: 'ok', in_reply_to: 'orig' },
      });
      expect(sentDraft(google.bodies[0]).mime).toContain('Subject: Re: Lease renewal\r\n');
    });

    it('shows the derived subject on the card the user approves', async () => {
      const { tools } = await build({ features: [...COMPOSE], routes: [route('/messages/orig', original)] });
      const info = await tools.toolCallInfo({
        name: 'draft_email',
        arguments: { to: ['grace@example.com'], subject: 'x', body: 'ok', in_reply_to: 'orig' },
      });
      expect(info.tier3_card?.email?.subject).toBe('Re: Lease renewal');
    });
  });

  it('refuses a subject with a line break instead of sending a header the model smuggled in', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [] });
    const response = await tools.callTool({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], subject: 'Hi\r\nBcc: mallory@example.com', body: 'x' },
    });
    expect(text(response)).toContain('line breaks');
    expect(google.urls).toHaveLength(0);
  });

  it('asks with the recipients, subject and body taken from the call itself', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [] });
    const info = await tools.toolCallInfo({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], cc: ['lin@example.com'], subject: 'Lease', body: 'Thursday works.' },
    });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card).toMatchObject({
      plain_what: 'Save a draft "Lease" in your Gmail to grace@example.com. Copy: lin@example.com. It is not sent.',
      destination: null,
      recipient: null,
      email: {
        action: 'save',
        to: ['grace@example.com'],
        cc: ['lin@example.com'],
        bcc: [],
        subject: 'Lease',
        body: 'Thursday works.',
        replaces: null,
      },
    });
  });
});

describe('update_draft', () => {
  const threaded = plainDraft({
    id: 'd-m1',
    threadId: 't9',
    to: 'Grace <grace@example.com>',
    subject: 'Re: Lease renewal',
    body: 'Thursday works.',
    extraHeaders: [
      { name: 'In-Reply-To', value: '<orig@mail.example.com>' },
      { name: 'References', value: '<orig@mail.example.com>' },
    ],
  });

  it('shows what it replaces, so a change is never read as a new draft', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const info = await tools.toolCallInfo({
      name: 'update_draft',
      arguments: { draft_id: 'd1', to: ['mallory@example.com'], subject: 'Keys', body: 'Send them.' },
    });
    expect(info.tier3_card?.plain_what).toContain('It replaces "Lease" to grace@example.com and lin@example.com');
    expect(info.tier3_card?.email).toMatchObject({
      action: 'change',
      subject: 'Keys',
      replaces: { subject: 'Lease', to: ['grace@example.com', 'lin@example.com'] },
    });
  });

  it('keeps the thread and the reply headers the draft already had', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        draftRoute(threaded),
        url =>
          url.pathname === '/gmail/v1/users/me/drafts/d1' && url.search === ''
            ? json({ id: 'd1', message: { id: 'm', threadId: 't9' } })
            : undefined,
      ],
    });
    await tools.callTool({
      name: 'update_draft',
      arguments: { draft_id: 'd1', to: ['grace@example.com'], subject: 'Re: Lease renewal', body: 'Friday instead.' },
    });
    const put = sentDraft(google.bodies.at(-1));
    expect(put.threadId).toBe('t9');
    expect(put.mime).toContain('In-Reply-To: <orig@mail.example.com>');
  });

  it('refuses to change a draft that has an attachment or an HTML version rather than silently dropping them', async () => {
    const withFile = message({
      id: 'd-m1',
      labelIds: ['DRAFT'],
      body: 'see file',
      attachments: [{ id: 'a1', filename: 'x.pdf', mimeType: 'application/pdf', size: 3 }],
    });
    const html = message({ id: 'd-m1', labelIds: ['DRAFT'], body: 'hi', html: '<b>hi</b>' });
    for (const mail of [withFile, html]) {
      const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute(mail)] });
      const args = { draft_id: 'd1', to: ['grace@example.com'], subject: 'Lease', body: 'new' };
      const info = await tools.toolCallInfo({ name: 'update_draft', arguments: args });
      expect(info.pre_dispatch_failure?.message).toContain('cannot be changed here');
      const response = await tools.callTool({ name: 'update_draft', arguments: args });
      expect(text(response)).toContain('cannot be changed here');
      expect(google.urls.some(entry => entry.startsWith('PUT'))).toBe(false);
    }
  });
});

describe('send_draft', () => {
  it('shows the draft as Gmail holds it', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card?.plain_what).toBe(
      'Send "Lease" from your Gmail to grace@example.com and lin@example.com. Sent as "Ada".',
    );
    expect(info.tier3_card?.cannot_be_undone).toBe("Once this is sent, it can't be unsent.");
    expect(info.tier3_card?.email).toMatchObject({
      action: 'send',
      to: ['grace@example.com', 'lin@example.com'],
      subject: 'Lease',
      body: 'Thursday works.',
    });
  });

  it('takes no recipients, subject or body from the model: extra fields offer no approval and reach no card', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    const args = { draft_id: 'd1', to: ['mallory@example.com'], body: 'model prose', subject: 'model subject' };
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: args });
    expect(info.is_approval_required).not.toBe(true);
    expect(JSON.stringify(info.tier3_card ?? null)).not.toMatch(/mallory|model prose|model subject/);
    expect(text(await tools.callTool({ name: 'send_draft', arguments: args }))).toContain('Validation failed');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('puts every recipient, copy and hidden copy on the card', async () => {
    const mail = plainDraft({
      id: 'd-m1',
      to: 'a@example.com, b@example.com',
      cc: 'c@example.com',
      bcc: 'd@example.com',
      body: 'x',
    });
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(mail)] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.tier3_card?.plain_what).toBe(
      'Send "Lease" from your Gmail to a@example.com and b@example.com. Copy: c@example.com. Hidden copy (Bcc): d@example.com. Sent as "Ada".',
    );
  });

  it('sends the reviewed draft', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(JSON.parse(text(response))).toMatchObject({ draft_id: 'd1', message_id: 'sent-1', status: 'sent' });
    expect(google.urls).toContain('POST /gmail/v1/users/me/drafts/send');
    expect(google.bodies.at(-1)).toEqual({ id: 'd1' });
  });

  it('will not send a draft nobody reviewed', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(text(response)).toContain('not reviewed');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('will not send twice on one review', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    const second = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(text(second)).toContain('not reviewed');
    expect(google.urls.filter(entry => entry.includes('/drafts/send'))).toHaveLength(1);
  });

  describe('a draft edited after the user saw it', () => {
    const edits: { name: string; edit: Parameters<typeof plainDraft>[0] }[] = [
      { name: 'subject', edit: { id: 'd-m1', threadId: 't9', subject: 'Keys', body: 'Thursday works.' } },
      { name: 'body', edit: { id: 'd-m1', threadId: 't9', body: 'Send me the keys.' } },
      { name: 'to', edit: { id: 'd-m1', threadId: 't9', to: 'mallory@example.com', body: 'Thursday works.' } },
      {
        name: 'cc',
        edit: { id: 'd-m1', threadId: 't9', cc: 'mallory@example.com', body: 'Thursday works.' },
      },
      {
        name: 'bcc',
        edit: { id: 'd-m1', threadId: 't9', bcc: 'mallory@example.com', body: 'Thursday works.' },
      },
      { name: 'threadId', edit: { id: 'd-m1', threadId: 'other-thread', body: 'Thursday works.' } },
      {
        name: 'In-Reply-To',
        edit: {
          id: 'd-m1',
          threadId: 't9',
          body: 'Thursday works.',
          extraHeaders: [{ name: 'In-Reply-To', value: '<other@mail.example.com>' }],
        },
      },
    ];

    it.each(edits)('refuses when the $name changed, even if the card is rebuilt afterwards', async ({ edit }) => {
      const reviewed = plainDraft({
        id: 'd-m1',
        threadId: 't9',
        to: 'Grace <grace@example.com>, lin@example.com',
        subject: 'Lease',
        body: 'Thursday works.',
      });
      let live: GmailMessage = reviewed;
      const { tools, google } = await build({
        features: [...COMPOSE],
        routes: [
          url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json(draftResource('d1', live)) : undefined),
          sendRoute,
        ],
      });
      await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      live = plainDraft({
        to: 'Grace <grace@example.com>, lin@example.com',
        subject: 'Lease',
        ...edit,
      });
      // Rebuilding the card after the edit must not replace what the user approved.
      await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(text(response)).toContain('changed after you reviewed it');
      expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
    });

    it('refuses when an attachment was added after review', async () => {
      let live: GmailMessage = ORIGINAL;
      const { tools, google } = await build({
        features: [...COMPOSE],
        routes: [
          url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json(draftResource('d1', live)) : undefined),
          sendRoute,
        ],
      });
      await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      live = message({
        id: 'd-m1',
        threadId: 't9',
        labelIds: ['DRAFT'],
        from: 'Ada <ada@example.com>',
        to: 'Grace <grace@example.com>, lin@example.com',
        subject: 'Lease',
        body: 'Thursday works.',
        attachments: [{ id: 'a1', filename: 'x.pdf', mimeType: 'application/pdf', size: 3 }],
      });
      const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(text(response)).toContain('attachments');
      expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
    });

    it('refuses when an HTML version was added that the plain text does not show', async () => {
      let live: GmailMessage = ORIGINAL;
      const { tools, google } = await build({
        features: [...COMPOSE],
        routes: [
          url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json(draftResource('d1', live)) : undefined),
          sendRoute,
        ],
      });
      await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      live = message({
        id: 'd-m1',
        threadId: 't9',
        labelIds: ['DRAFT'],
        from: 'Ada <ada@example.com>',
        to: 'Grace <grace@example.com>, lin@example.com',
        subject: 'Lease',
        body: 'Thursday works.',
        html: '<p>Send me the keys.</p>',
      });
      const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(text(response)).toContain('cannot show you in full');
      expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
    });
  });

  it('fails closed after a restart, when the review is gone', async () => {
    const first = await build({ features: [...COMPOSE], routes: [draftRoute()], reviews: new DraftReviewLedger() });
    await first.tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    const restarted = await build({ features: [...COMPOSE], routes: [draftRoute()], reviews: new DraftReviewLedger() });
    const response = await restarted.tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(text(response)).toContain('not reviewed');
  });

  it('voids the review when the draft is changed through update_draft', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        draftRoute(),
        url =>
          url.pathname === '/gmail/v1/users/me/drafts/d1' && url.search === ''
            ? json({ id: 'd1', message: { id: 'm', threadId: 't9' } })
            : undefined,
      ],
    });
    await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    await tools.callTool({
      name: 'update_draft',
      arguments: { draft_id: 'd1', to: ['grace@example.com'], subject: 'Lease', body: 'New text.' },
    });
    const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(text(response)).toContain('not reviewed');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  describe('drafts that cannot be shown in full are refused before any card', () => {
    const refusals: { name: string; mail: GmailMessage; says: string }[] = [
      {
        name: 'an attachment',
        mail: message({
          id: 'd-m1',
          labelIds: ['DRAFT'],
          from: 'Ada <ada@example.com>',
          to: 'grace@example.com',
          body: 'see file',
          attachments: [{ id: 'a1', filename: 'x.pdf', mimeType: 'application/pdf', size: 3 }],
        }),
        says: 'attachments',
      },
      {
        name: 'an attachment with no file name',
        mail: message({
          id: 'd-m1',
          labelIds: ['DRAFT'],
          from: 'Ada <ada@example.com>',
          to: 'grace@example.com',
          body: 'see file',
          attachments: [{ id: 'a1', filename: '', mimeType: 'application/pdf', size: 3 }],
        }),
        says: 'attachments',
      },
      {
        name: 'an HTML version beside the plain text',
        mail: message({
          id: 'd-m1',
          labelIds: ['DRAFT'],
          from: 'Ada <ada@example.com>',
          to: 'grace@example.com',
          body: 'hi',
          html: '<p>different</p>',
        }),
        says: 'cannot show you in full',
      },
      {
        name: 'a Reply-To',
        mail: plainDraft({
          id: 'd-m1',
          to: 'grace@example.com',
          body: 'x',
          extraHeaders: [{ name: 'Reply-To', value: 'mallory@example.com' }],
        }),
        says: 'reply address or sender',
      },
      {
        name: 'a Sender',
        mail: plainDraft({
          id: 'd-m1',
          to: 'grace@example.com',
          body: 'x',
          extraHeaders: [{ name: 'Sender', value: 'mallory@example.com' }],
        }),
        says: 'reply address or sender',
      },
      {
        name: 'a different From',
        mail: plainDraft({ id: 'd-m1', from: 'Mallory <mallory@example.com>', to: 'grace@example.com', body: 'x' }),
        says: 'different address',
      },
      {
        name: 'no recipients',
        mail: plainDraft({ id: 'd-m1', to: '', body: 'x' }),
        says: 'no recipients',
      },
    ];

    it.each(refusals)('refuses $name', async ({ mail, says }) => {
      const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute(mail), sendRoute] });
      const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(info.pre_dispatch_failure?.message).toContain(says);
      expect(info.tier3_card).toBeFalsy();
      const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(text(response)).toContain('not reviewed');
      expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
    });
  });

  describe('the whole message is shown', () => {
    it('puts a 12,000 character body on the card without cutting it', async () => {
      const body = `${'Line of the lease. '.repeat(600)}END-MARKER`;
      const { tools } = await build({
        features: [...COMPOSE],
        routes: [draftRoute(plainDraft({ id: 'd-m1', to: 'grace@example.com', body }))],
      });
      const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(info.tier3_card?.email?.body).toBe(body);
      expect(info.tier3_card?.email?.body.endsWith('END-MARKER')).toBe(true);
    });

    it('cannot approve a message whose hidden part sits after a long benign start', async () => {
      const body =
        `${'Thanks for the update. '.repeat(90)}\n${'\n'.repeat(500)}${'Wire the deposit to account 000. '.repeat(550)}`.trimEnd();
      expect(body.length).toBeGreaterThan(20_000);
      const { tools, google } = await build({
        features: [...COMPOSE],
        routes: [draftRoute(plainDraft({ id: 'd-m1', to: 'grace@example.com', body })), sendRoute],
      });
      const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(info.tier3_card).toBeFalsy();
      expect(info.pre_dispatch_failure?.message).toContain('too long to show you in full');
      const response = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd1' } });
      expect(text(response)).toContain('not reviewed');
      expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
    });
  });

  it('is never offered a card when Gmail cannot be reached to load the draft', async () => {
    const { tools, sleeps } = await build({ features: [...COMPOSE], routes: [route('/drafts/d1', {}, 503)] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    expect(info.pre_dispatch_failure?.message).toContain('could not be shown to you');
    expect(info.tier3_card).toBeFalsy();
    expect(info.is_approval_required).not.toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('is not eligible for a standing "Always allow" or a chat-wide approval', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    for (const [name, args] of [
      ['send_draft', { draft_id: 'd1' }],
      ['update_draft', { draft_id: 'd1', to: ['grace@example.com'], subject: 'Lease', body: 'x' }],
      ['draft_email', { to: ['grace@example.com'], subject: 'Lease', body: 'x' }],
    ] as const) {
      const info = await tools.toolCallInfo({ name, arguments: args });
      expect(info.tier).toBe(3);
      expect(allowsToolGrant(info)).toBe(false);
      expect(allowsChatApproval(info)).toBe(false);
    }
  });
});

describe('the approval a send waits for', () => {
  it('is not re-classified by the turn, and its token is spent by exactly one dispatch', async () => {
    const { tools, sentinel } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const params = { draft_id: 'd1' };
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: params });
    expect(await classifyUnstampedToolCall({ sentinel, canonical_params: params, info })).toBe(info);

    const call = {
      tool_name: 'send_draft',
      tool_type: info.type,
      canonical_params: params,
      tier: 3 as const,
      approval_token_id: info.approval_token_id ?? null,
      approval_binding: null,
      shell_binding: null,
    };
    const ctx = { ...sentinel, repository_id: null, agent_intent: null, offline: false };
    expect(await verifyPreDispatch({ call, ctx })).toBeUndefined();
    expect(await verifyPreDispatch({ call, ctx })).toContain('already used');
  });

  it('is not valid for a different draft', async () => {
    const { tools, sentinel } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd1' } });
    const ctx = { ...sentinel, repository_id: null, agent_intent: null, offline: false };
    const result = await verifyPreDispatch({
      call: {
        tool_name: 'send_draft',
        tool_type: info.type,
        canonical_params: { draft_id: 'someone-elses' },
        tier: 3,
        approval_token_id: info.approval_token_id ?? null,
        approval_binding: null,
        shell_binding: null,
      },
      ctx,
    });
    expect(result).toContain('Approval invalid');
  });
});
