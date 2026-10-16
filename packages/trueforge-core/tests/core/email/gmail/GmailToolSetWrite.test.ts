import { DraftReviewLedger } from '../../../../src/core/email/gmail/draftReview';
import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { verifyPreDispatch } from '../../../../src/core/permissions/dispatch';
import { classifyUnstampedToolCall } from '../../../../src/core/runtime/AgentThread';
import { message } from './fixtures';
import { build, json, route, text, type Route } from './harness';

const COMPOSE = ['gmail_read', 'gmail_compose'] as const;

function draftMessage(overrides: Parameters<typeof message>[0]): GmailMessage {
  return message({ labelIds: ['DRAFT'], ...overrides });
}

/** Gmail's draft resource: the stored message under a draft id. */
function draftResource(id: string, mail: GmailMessage) {
  return { id, message: mail };
}

const ORIGINAL = draftMessage({
  id: 'd-m1',
  threadId: 't9',
  from: 'Ada <ada@example.com>',
  to: 'Grace <grace@example.com>, lin@example.com',
  subject: 'Lease',
  body: 'Thursday works.',
});

const draftRoute = (mail: GmailMessage = ORIGINAL): Route => route('/drafts/d1', draftResource('d1', mail));

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
    const response = await tools.callTool({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(text(response)).toContain('Unknown tool');
  });

  it('refuses a write call from a scheduled run at classification, with a card-free denial', async () => {
    const { tools } = await build({ routes: [draftRoute()], features: [...COMPOSE], unattended: true });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(info.pre_dispatch_failure?.message).toContain('never draft or send');
    expect(info.tier3_card).toBeNull();
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
      draftId: 'd7',
      messageId: 'm7',
      action: 'drafted',
      threadId: 't7',
    });
    expect(google.urls).toContain('POST /gmail/v1/users/me/drafts');
    const raw = (google.bodies[0] as { message: { raw: string } }).message.raw;
    expect(Buffer.from(raw, 'base64url').toString()).toContain('To: grace@example.com');
  });

  it('replies inside the thread of the message it answers', async () => {
    const original = message({
      id: 'orig',
      threadId: 't5',
      extraHeaders: [{ name: 'Message-ID', value: '<orig@mail.example.com>' }],
    });
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        route('/messages/orig', original),
        url =>
          url.pathname === '/gmail/v1/users/me/drafts'
            ? json({ id: 'd8', message: { id: 'm8', threadId: 't5' } })
            : undefined,
      ],
    });
    await tools.callTool({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], subject: 'Re: Lease', body: 'ok', inReplyTo: 'orig' },
    });
    const sent = google.bodies[0] as { message: { raw: string; threadId: string } };
    expect(sent.message.threadId).toBe('t5');
    expect(Buffer.from(sent.message.raw, 'base64url').toString()).toContain('In-Reply-To: <orig@mail.example.com>');
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

  it('is asked about with the recipients, subject and body taken from the call itself', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [] });
    const info = await tools.toolCallInfo({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], cc: ['lin@example.com'], subject: 'Lease', body: 'Thursday works.' },
    });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card).toMatchObject({
      recipient: 'grace@example.com, lin@example.com',
      destination: 'Gmail',
    });
    expect(info.tier3_card?.outbound_text).toContain('Thursday works.');
    expect(info.tier3_card?.outbound_text).toContain('subject: Lease');
  });
});

describe('send_draft', () => {
  it('shows the draft as Gmail holds it, not as the model describes it', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(info).toMatchObject({ tier: 3, is_approval_required: true });
    expect(info.tier3_card?.plain_what).toBe('Send "Lease" to grace@example.com, lin@example.com from your Gmail.');
    expect(info.tier3_card?.cannot_be_undone).toContain("can't be unsent");
    expect(info.tier3_card?.outbound_text).toContain('Thursday works.');
    expect(info.tier3_card?.recipient).toBe('grace@example.com, lin@example.com');
  });

  it('sends the reviewed draft', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        draftRoute(),
        url => (url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined),
      ],
    });
    await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    const response = await tools.callTool({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(JSON.parse(text(response))).toMatchObject({ draftId: 'd1', messageId: 'sent-1', status: 'sent' });
    expect(google.urls).toContain('POST /gmail/v1/users/me/drafts/send');
    expect(google.bodies.at(-1)).toEqual({ id: 'd1' });
  });

  it('will not send a draft nobody reviewed', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const response = await tools.callTool({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(text(response)).toContain('not reviewed');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('will not send twice on one review', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        draftRoute(),
        url => (url.pathname.endsWith('/drafts/send') ? json({ id: 's', threadId: 't9' }) : undefined),
      ],
    });
    await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    await tools.callTool({ name: 'send_draft', arguments: { draftId: 'd1' } });
    const second = await tools.callTool({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(text(second)).toContain('not reviewed');
    expect(google.urls.filter(entry => entry.includes('/drafts/send'))).toHaveLength(1);
  });

  it('refuses when the draft was edited after the user saw it, even if the card is rebuilt later', async () => {
    let live = ORIGINAL;
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json(draftResource('d1', live)) : undefined),
        url => (url.pathname.endsWith('/drafts/send') ? json({ id: 's', threadId: 't9' }) : undefined),
      ],
    });
    await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    live = draftMessage({
      id: 'd-m1',
      threadId: 't9',
      to: 'mallory@example.com',
      subject: 'Lease',
      body: 'Send me the keys.',
    });
    // Rebuilding the card after the edit must not replace what the user approved.
    await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    const response = await tools.callTool({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(text(response)).toContain('changed after you reviewed it');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('fails closed after a restart, when the review is gone', async () => {
    const first = await build({ features: [...COMPOSE], routes: [draftRoute()], reviews: new DraftReviewLedger() });
    await first.tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    const restarted = await build({ features: [...COMPOSE], routes: [draftRoute()], reviews: new DraftReviewLedger() });
    const response = await restarted.tools.callTool({ name: 'send_draft', arguments: { draftId: 'd1' } });
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
    await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    await tools.callTool({
      name: 'update_draft',
      arguments: { draftId: 'd1', to: ['grace@example.com'], subject: 'Lease', body: 'New text.' },
    });
    const response = await tools.callTool({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(text(response)).toContain('not reviewed');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('refuses a draft with an attachment before asking, and a draft with no recipient', async () => {
    const withFile = draftMessage({
      id: 'd-m1',
      to: 'grace@example.com',
      body: 'see file',
      attachments: [{ id: 'a1', filename: 'x.pdf', mimeType: 'application/pdf', size: 3 }],
    });
    const a = await build({ features: [...COMPOSE], routes: [draftRoute(withFile)] });
    const attachInfo = await a.tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(attachInfo.pre_dispatch_failure?.message).toContain('attachments');

    const empty = draftMessage({ id: 'd-m1', to: '', body: 'x' });
    const b = await build({ features: [...COMPOSE], routes: [draftRoute(empty)] });
    const noRecipient = await b.tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(noRecipient.pre_dispatch_failure?.message).toContain('no recipients');
  });

  it('does not offer a send it could not show, when Gmail cannot be reached', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [route('/drafts/d1', {}, 503)] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(info.pre_dispatch_failure?.message).toContain('could not be loaded to show you');
    expect(info.is_approval_required).not.toBe(true);
  });
});

describe('the approval a send waits for', () => {
  it('is not re-classified by the turn, and its token is spent by exactly one dispatch', async () => {
    const { tools, sentinel } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    expect(await classifyUnstampedToolCall({ sentinel, canonical_params: { draftId: 'd1' }, info })).toBe(info);

    const call = {
      tool_name: 'send_draft',
      tool_type: info.type,
      canonical_params: { draftId: 'd1' },
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
    const info = await tools.toolCallInfo({ name: 'send_draft', arguments: { draftId: 'd1' } });
    const ctx = { ...sentinel, repository_id: null, agent_intent: null, offline: false };
    const result = await verifyPreDispatch({
      call: {
        tool_name: 'send_draft',
        tool_type: info.type,
        canonical_params: { draftId: 'someone-elses' },
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
