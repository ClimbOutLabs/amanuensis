import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { message, plainDraft } from './fixtures';
import { build, json, route, sentDraft, text, threadRoute, type Route } from './harness';

const COMPOSE = ['gmail_read', 'gmail_compose'] as const;
const header = (name: string, value: string) => ({ name, value });

/** The message being answered, already in the thread. */
const ORIGINAL = message({
  id: 'orig',
  threadId: 't9',
  from: 'Grace <grace@example.com>',
  subject: 'Invitation to the lease signing',
  extraHeaders: [header('Message-ID', '<orig@mail.example.com>'), header('References', '<first@mail.example.com>')],
});

/** A reply draft as Gmail stores it, with threading that can be changed per case. */
function replyDraft(input?: { threadId?: string; inReplyTo?: string; references?: string; to?: string }) {
  return plainDraft({
    id: 'd-m1',
    threadId: input?.threadId ?? 't9',
    to: input?.to ?? 'Grace <grace@example.com>',
    subject: 'Re: Invitation to the lease signing',
    body: 'I accept, thank you.',
    extraHeaders: [
      header('In-Reply-To', input?.inReplyTo ?? '<orig@mail.example.com>'),
      header('References', input?.references ?? '<first@mail.example.com> <orig@mail.example.com>'),
    ],
  });
}

const THREAD_ROUTE = threadRoute({ id: 't9', messages: [ORIGINAL, { ...replyDraft(), id: 'd-m1' }] });
const draftRoute =
  (live: () => GmailMessage): Route =>
  url =>
    url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live() }) : undefined;
const sendRoute: Route = url =>
  url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined;

const sendArgs = { draft_id: 'd1' };

describe('a reply with valid threading', () => {
  it('shows the thread line on the card and sends in the thread', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(() => replyDraft()), THREAD_ROUTE, sendRoute],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.pre_dispatch_failure).toBeUndefined();
    expect(info.tier3_card?.plain_what).toContain(
      'Reply in the thread: "Invitation to the lease signing", from Grace <grace@example.com>.',
    );
    expect(info.tier3_card?.email).toMatchObject({
      action: 'send',
      to: ['grace@example.com'],
      subject: 'Re: Invitation to the lease signing',
      body: 'I accept, thank you.',
      reply_in_thread: { subject: 'Invitation to the lease signing', from: 'Grace <grace@example.com>' },
    });
    expect(info.tier3_card?.plain_what).toContain('Sent as "Ada"');
    const sent = await tools.callTool({ name: 'send_draft', arguments: sendArgs });
    expect(JSON.parse(text(sent))).toMatchObject({ status: 'sent', thread_id: 't9' });
    expect(google.urls).toContain('POST /gmail/v1/users/me/drafts/send');
  });

  it('shows no thread line on a message that is not a reply', async () => {
    const plain = plainDraft({ id: 'd-m1', threadId: 't9', to: 'grace@example.com', body: 'Hello.' });
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(() => plain), sendRoute] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs });
    expect(info.tier3_card?.plain_what).not.toContain('Reply in the thread');
    expect(info.tier3_card?.email).toMatchObject({ reply_in_thread: null });
  });

  it('shows the thread line when the reply is saved as a draft, with the thread taken from the answered message', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        route('/messages/orig', ORIGINAL),
        url =>
          url.pathname === '/gmail/v1/users/me/drafts'
            ? json({ id: 'd8', message: { id: 'm8', threadId: 't9' } })
            : undefined,
      ],
    });
    const args = { to: ['grace@example.com'], subject: 'ignored', body: 'I accept.', in_reply_to: 'orig' };
    const info = await tools.toolCallInfo({ name: 'draft_email', arguments: args });
    expect(info.tier3_card?.email).toMatchObject({
      reply_in_thread: { subject: 'Invitation to the lease signing', from: 'Grace <grace@example.com>' },
    });
    await tools.callTool({ name: 'draft_email', arguments: args });
    const saved = sentDraft(google.bodies.at(-1));
    expect(saved.threadId).toBe('t9');
    expect(saved.mime).toContain('In-Reply-To: <orig@mail.example.com>');
    expect(saved.mime).toContain('References: <first@mail.example.com> <orig@mail.example.com>');
  });
});

describe('forged or malformed threading is refused', () => {
  const cases: { name: string; draft: GmailMessage }[] = [
    { name: 'an In-Reply-To that is not in the thread', draft: replyDraft({ inReplyTo: '<forged@evil.example>' }) },
    {
      name: 'a References id that is not from the thread',
      draft: replyDraft({ references: '<first@mail.example.com> <forged@evil.example> <orig@mail.example.com>' }),
    },
    {
      name: 'a References list that omits the message answered',
      draft: replyDraft({ references: '<first@mail.example.com>' }),
    },
    { name: 'an In-Reply-To that is not an id', draft: replyDraft({ inReplyTo: 'orig@mail.example.com' }) },
    { name: 'an In-Reply-To with a comment in it', draft: replyDraft({ inReplyTo: '<orig@mail.example.com> (hi)' }) },
    {
      name: 'an In-Reply-To with two ids',
      draft: replyDraft({ inReplyTo: '<first@mail.example.com> <orig@mail.example.com>' }),
    },
    { name: 'a References id with a space in it', draft: replyDraft({ references: '<orig @mail.example.com>' }) },
    { name: 'a thread other than the one the ids come from', draft: replyDraft({ threadId: 't77' }) },
  ];

  it.each(cases)('refuses $name, before a card and again at the send', async ({ draft }) => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(() => draft), THREAD_ROUTE, threadRoute({ id: 't77', messages: [] }), sendRoute],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs });
    expect(info.is_approval_required).not.toBe(true);
    expect(info.tier3_card).toBeFalsy();
    expect(info.pre_dispatch_failure?.message).toMatch(
      /not tied to a message in its own Gmail thread|header that Aman cannot/,
    );
    const sent = await tools.callTool({ name: 'send_draft', arguments: sendArgs });
    expect(text(sent)).toContain('Nothing was sent');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('does not let the draft itself vouch for its own ids', async () => {
    const selfVouching = {
      ...replyDraft({ inReplyTo: '<mine@mail.example.com>', references: '<mine@mail.example.com>' }),
    };
    const withOwnId = {
      ...selfVouching,
      payload: {
        ...selfVouching.payload,
        headers: [...(selfVouching.payload?.headers ?? []), header('Message-ID', '<mine@mail.example.com>')],
      },
    };
    const { tools } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(() => withOwnId), threadRoute({ id: 't9', messages: [ORIGINAL, withOwnId] }), sendRoute],
    });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs });
    expect(info.pre_dispatch_failure?.message).toContain('not tied to a message in its own Gmail thread');
  });

  it('refuses a reply to a thread Gmail cannot show', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(() => replyDraft()), sendRoute] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs });
    expect(info.is_approval_required).not.toBe(true);
    expect(info.pre_dispatch_failure).toBeDefined();
  });

  it('takes no threading text from the model: a thread_id of another thread is refused, and unknown fields do not parse', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [route('/messages/orig', ORIGINAL)],
    });
    const args = { to: ['grace@example.com'], subject: 's', body: 'b', in_reply_to: 'orig', thread_id: 't-other' };
    const info = await tools.toolCallInfo({ name: 'draft_email', arguments: args });
    expect(info.pre_dispatch_failure?.message).toContain('thread_id is not the thread of the message');
    expect(text(await tools.callTool({ name: 'draft_email', arguments: args }))).toContain(
      'thread_id is not the thread',
    );
    const forged = await tools.callTool({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], subject: 's', body: 'b', references: '<forged@evil.example>' },
    });
    expect(text(forged)).toContain('Validation failed');
    expect(google.urls.some(entry => entry.startsWith('POST /gmail'))).toBe(false);
  });

  it('will not turn a reply into an unthreaded draft when the answered message has no usable Message-ID', async () => {
    const noId = message({ id: 'orig', threadId: 't9', subject: 'Invitation' });
    const { tools, google } = await build({ features: [...COMPOSE], routes: [route('/messages/orig', noId)] });
    const response = await tools.callTool({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], subject: 's', body: 'b', in_reply_to: 'orig' },
    });
    expect(text(response)).toContain('no usable Message-ID');
    expect(google.urls.some(entry => entry.startsWith('POST /gmail'))).toBe(false);
  });

  it('checks the headers update_draft keeps, since the saved draft may have been edited in Gmail', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(() => replyDraft({ inReplyTo: '<forged@evil.example>' })), THREAD_ROUTE],
    });
    const args = { draft_id: 'd1', to: ['grace@example.com'], subject: 's', body: 'new text' };
    const response = await tools.callTool({ name: 'update_draft', arguments: args });
    expect(text(response)).toContain('not tied to a message in its own Gmail thread');
    expect(google.urls.some(entry => entry.startsWith('PUT'))).toBe(false);
  });
});

describe('threading changed after review', () => {
  const changes: { name: string; after: GmailMessage }[] = [
    {
      name: 'In-Reply-To moved to another message of the thread',
      after: replyDraft({ inReplyTo: '<first@mail.example.com>' }),
    },
    { name: 'References shortened', after: replyDraft({ references: '<orig@mail.example.com>' }) },
    { name: 'the thread', after: replyDraft({ threadId: 't9b' }) },
  ];

  it.each(changes)('refuses the send when $name', async ({ after }) => {
    let live = replyDraft();
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        draftRoute(() => live),
        threadRoute({ id: 't9', messages: [ORIGINAL, replyDraft()] }),
        threadRoute({ id: 't9b', messages: [{ ...ORIGINAL, threadId: 't9b' }] }),
        sendRoute,
      ],
    });
    expect((await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs })).is_approval_required).toBe(true);
    live = after;
    const response = await tools.callTool({ name: 'send_draft', arguments: sendArgs });
    expect(text(response)).toContain('changed after you reviewed it');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });
});

describe('after a refusal', () => {
  it('tells the model what was refused, that nothing went out, and that another draft needs a new approval', async () => {
    const { tools } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(() => replyDraft({ inReplyTo: '<forged@evil.example>' })), THREAD_ROUTE, sendRoute],
    });
    const response = text(await tools.callTool({ name: 'send_draft', arguments: sendArgs }));
    expect(response).toContain('Nothing was sent');
    expect(response).toContain('needs its own new approval');
    expect(response).toContain('must not tell the user a different draft is the message they approved');
  });

  it('gives a new draft a new approval, and the earlier review does not cover it', async () => {
    let live = replyDraft();
    const second = plainDraft({ id: 'd2-m', threadId: 't9', to: 'grace@example.com', body: 'A different text.' });
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(() => live), route('/drafts/d2', { id: 'd2', message: second }), THREAD_ROUTE, sendRoute],
    });
    await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs });
    live = replyDraft({ references: '<orig@mail.example.com>' });
    expect(text(await tools.callTool({ name: 'send_draft', arguments: sendArgs }))).toContain('changed after');

    const unreviewed = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd2' } });
    expect(text(unreviewed)).toContain('needs your OK again');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);

    const card = await tools.toolCallInfo({ name: 'send_draft', arguments: { draft_id: 'd2' } });
    expect(card).toMatchObject({ tier: 3, is_approval_required: true });
    expect(card.tier3_card?.email?.body).toBe('A different text.');
    const sent = await tools.callTool({ name: 'send_draft', arguments: { draft_id: 'd2' } });
    expect(JSON.parse(text(sent))).toMatchObject({ status: 'sent' });
  });

  it('leaves no lock behind: the same draft can be reviewed and sent again once it is fixed', async () => {
    let live = replyDraft({ inReplyTo: '<forged@evil.example>' });
    const { tools } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(() => live), THREAD_ROUTE, sendRoute],
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const info = await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs });
      // A content refusal is recoverable, never a permission wall that counts toward the turn's policy stop.
      expect(info.pre_dispatch_failure?.kind).toBe('pre_dispatch_failed');
      expect(text(await tools.callTool({ name: 'send_draft', arguments: sendArgs }))).toContain('Nothing was sent');
    }
    live = replyDraft();
    const card = await tools.toolCallInfo({ name: 'send_draft', arguments: sendArgs });
    expect(card).toMatchObject({ tier: 3, is_approval_required: true });
    expect(JSON.parse(text(await tools.callTool({ name: 'send_draft', arguments: sendArgs })))).toMatchObject({
      status: 'sent',
    });
  });
});
