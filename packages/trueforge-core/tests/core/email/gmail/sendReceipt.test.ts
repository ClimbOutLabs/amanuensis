import { checkCodeOf, hashDraft, type ReviewableDraft } from '../../../../src/core/email/gmail/draftReview';
import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { SendReceiptEventSchema } from '../../../../src/core/email/gmail/receiptEvents';
import { isCallToolResponseResult, type CallToolResponse } from '../../../../src/core/mcp/IMCPServer';
import { plainDraft } from './fixtures';
import { build, json, route, text, type Route } from './harness';

const COMPOSE = ['gmail_read', 'gmail_compose'] as const;
const CALL = { name: 'send_draft', arguments: { draft_id: 'd1' } };

const DRAFT = plainDraft({
  id: 'd-m1',
  threadId: 't9',
  to: 'Grace <grace@example.com>, lin@example.com',
  subject: 'Lease',
  body: 'Thursday works.\nSee you then.',
});

const draftRoute = (mail: GmailMessage = DRAFT): Route => route('/drafts/d1', { id: 'd1', message: mail });
const sendRoute: Route = url =>
  url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ id: 'sent-1', threadId: 't9' }) : undefined;

function receiptEvents(response: CallToolResponse) {
  expect(isCallToolResponseResult(response)).toBe(true);
  return isCallToolResponseResult(response) ? (response.events ?? []) : [];
}

function plainExpected(): ReviewableDraft {
  return {
    to: ['grace@example.com', 'lin@example.com'],
    cc: [],
    bcc: [],
    subject: 'Lease',
    body: 'Thursday works.\nSee you then.',
    threadId: 't9',
    inReplyTo: '',
    references: '',
    fromName: 'Ada',
  };
}

const BASE: ReviewableDraft = {
  to: ['a@example.com'],
  cc: [],
  bcc: [],
  subject: 'Lease',
  body: 'Thursday works.',
  threadId: 't1',
  inReplyTo: '',
  references: '',
  fromName: 'Ada',
};

describe('checkCodeOf', () => {
  it('is six upper-case characters taken from the hash the gate binds', () => {
    const code = checkCodeOf(hashDraft(BASE));
    expect(code).toMatch(/^[0-9A-F]{6}$/);
    expect(code).toBe(hashDraft(BASE).slice(0, 6).toUpperCase());
  });

  it('is the same for the same message and changes with any bound field', () => {
    const code = checkCodeOf(hashDraft(BASE));
    expect(checkCodeOf(hashDraft({ ...BASE }))).toBe(code);
    const edits: Partial<ReviewableDraft>[] = [
      { to: ['b@example.com'] },
      { cc: ['b@example.com'] },
      { bcc: ['b@example.com'] },
      { subject: 'Keys' },
      { body: 'Send the keys.' },
      { threadId: 't2' },
      { inReplyTo: '<x@y>' },
      { references: '<x@y>' },
      { fromName: 'Eve' },
    ];
    for (const edit of edits) {
      expect(checkCodeOf(hashDraft({ ...BASE, ...edit }))).not.toBe(code);
    }
  });
});

describe('the check code on the card', () => {
  it('is on a send card and is the code of the hash the gate binds', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const info = await tools.toolCallInfo(CALL);
    expect(info.tier3_card?.email?.check_code).toMatch(/^[0-9A-F]{6}$/);
  });

  it('is the code of the hash of exactly the message the gate verifies, thread and sender name included', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const info = await tools.toolCallInfo(CALL);
    const expected: ReviewableDraft = {
      to: ['grace@example.com', 'lin@example.com'],
      cc: [],
      bcc: [],
      subject: 'Lease',
      body: 'Thursday works.\nSee you then.',
      threadId: 't9',
      inReplyTo: '',
      references: '',
      fromName: 'Ada',
    };
    expect(info.tier3_card?.email?.check_code).toBe(checkCodeOf(hashDraft(expected)));
    expect(info.tier3_card?.email?.check_code).not.toBe(checkCodeOf(hashDraft({ ...expected, threadId: '' })));
    expect(info.tier3_card?.email?.check_code).not.toBe(
      checkCodeOf(hashDraft({ ...expected, body: `${expected.body} ` })),
    );
  });

  it('is not on a draft card, which sends nothing', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [] });
    const info = await tools.toolCallInfo({
      name: 'draft_email',
      arguments: { to: ['grace@example.com'], subject: 'Lease', body: 'Thursday works.' },
    });
    expect(info.tier3_card?.email?.check_code).toBeNull();
  });
});

describe('the receipt of an approved send', () => {
  it('repeats the card, the message id and the check code, and carries the time Gmail accepted it', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    const card = (await tools.toolCallInfo(CALL)).tier3_card?.email;
    const before = Date.now();
    const response = await tools.callTool(CALL, undefined, {
      admission_provenance: { source: 'automatic' },
      tool_call_id: 'call-1',
    });
    const [event, ...rest] = receiptEvents(response);
    expect(rest).toEqual([]);
    expect(SendReceiptEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({ type: 'aman.email.send_receipt', tool_call_id: 'call-1' });
    if (event?.type !== 'aman.email.send_receipt' || event.result.outcome !== 'sent') {
      throw new Error('expected a sent receipt');
    }
    expect(event.result.sent_message_id).toBe('sent-1');
    expect(event.result.check_code).toBe(card?.check_code);
    expect(event.result.check_code).toBe(checkCodeOf(hashDraft(plainExpected())));
    expect(Date.parse(event.result.sent_at)).toBeGreaterThanOrEqual(before);
    expect(event.result.message).toEqual({
      to: card?.to,
      cc: card?.cc,
      bcc: card?.bcc,
      subject: card?.subject,
      body: card?.body,
    });
  });

  it('shows what the gate verified, not what the model answered', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    await tools.toolCallInfo(CALL);
    const response = await tools.callTool(CALL, undefined, {
      admission_provenance: { source: 'automatic' },
      tool_call_id: 'call-1',
    });
    expect(JSON.stringify(receiptEvents(response))).not.toContain(text(response));
    expect(JSON.stringify(receiptEvents(response))).toContain('See you then.');
  });

  it('is not recorded when the call has no id to answer', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    await tools.toolCallInfo(CALL);
    expect(receiptEvents(await tools.callTool(CALL))).toEqual([]);
  });
});

describe('a send that did not go out', () => {
  const context = { admission_provenance: { source: 'automatic' }, tool_call_id: 'call-1' } as const;

  async function notSentReason(response: CallToolResponse) {
    const [event] = receiptEvents(response);
    if (event?.type !== 'aman.email.send_receipt') {
      throw new Error('expected a send receipt event');
    }
    expect(event.result.outcome).toBe('not_sent');
    return event.result.outcome === 'not_sent' ? event.result.reason : undefined;
  }

  it('says the draft changed, with no message id, no time and no content', async () => {
    let live: GmailMessage = DRAFT;
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live }) : undefined),
        sendRoute,
      ],
    });
    await tools.toolCallInfo(CALL);
    live = plainDraft({ id: 'd-m1', threadId: 't9', subject: 'Lease', body: 'Send me the keys.' });
    const response = await tools.callTool(CALL, undefined, context);
    expect(await notSentReason(response)).toBe('draft_changed');
    expect(JSON.stringify(receiptEvents(response))).not.toMatch(/sent_message_id|sent_at|check_code|keys/);
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('says the draft changed when an attachment was added after the card, not that it could not be checked', async () => {
    let live: GmailMessage = DRAFT;
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live }) : undefined),
        sendRoute,
      ],
    });
    await tools.toolCallInfo(CALL);
    live = {
      ...DRAFT,
      payload: {
        ...DRAFT.payload,
        parts: [
          ...(DRAFT.payload?.parts ?? []),
          { filename: 'lease.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 10 } },
        ],
      },
    };
    expect(await notSentReason(await tools.callTool(CALL, undefined, context))).toBe('draft_changed');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('says it could not read the draft when Gmail fails on the re-read, and sends nothing', async () => {
    let failing = false;
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url =>
          url.pathname === '/gmail/v1/users/me/drafts/d1'
            ? failing
              ? json({ error: { message: 'gone' } }, 404)
              : json({ id: 'd1', message: DRAFT })
            : undefined,
        sendRoute,
      ],
    });
    await tools.toolCallInfo(CALL);
    failing = true;
    expect(await notSentReason(await tools.callTool(CALL, undefined, context))).toBe('cannot_send');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it.each([
    [401, 'reconnect_google'],
    [403, 'reconnect_google'],
    [429, 'rate_limited'],
  ] as const)('says %s from Gmail on the send as %s', async (status, reason) => {
    const refused: Route = url =>
      url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ error: { message: 'no' } }, status) : undefined;
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), refused] });
    await tools.toolCallInfo(CALL);
    expect(await notSentReason(await tools.callTool(CALL, undefined, context))).toBe(reason);
  });

  it('says a Gmail server error on the send may have gone through', async () => {
    const failed: Route = url =>
      url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ error: { message: 'boom' } }, 502) : undefined;
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), failed] });
    await tools.toolCallInfo(CALL);
    expect(await notSentReason(await tools.callTool(CALL, undefined, context))).toBe('unconfirmed');
  });

  it('says it needs the OK again when no review stands', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    expect(await notSentReason(await tools.callTool(CALL, undefined, context))).toBe('needs_ok_again');
  });

  it('never turns a second send on one review into a receipt', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    await tools.toolCallInfo(CALL);
    await tools.callTool(CALL, undefined, context);
    expect(await notSentReason(await tools.callTool(CALL, undefined, context))).toBe('needs_ok_again');
  });

  it('says Gmail refused when Gmail turns the send down', async () => {
    const refused: Route = url =>
      url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ error: { message: 'no' } }, 400) : undefined;
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), refused] });
    await tools.toolCallInfo(CALL);
    expect(await notSentReason(await tools.callTool(CALL, undefined, context))).toBe('gmail_refused');
  });

  it('does not claim "not sent" when Gmail never answered', async () => {
    const dropped: Route = url => {
      if (url.pathname === '/gmail/v1/users/me/drafts/send') {
        throw new TypeError('fetch failed');
      }
      return undefined;
    };
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), dropped] });
    await tools.toolCallInfo(CALL);
    expect(await notSentReason(await tools.callTool(CALL, undefined, context))).toBe('unconfirmed');
  });
});

describe('a scheduled run', () => {
  it('is not offered the send and so can never produce a receipt', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(), sendRoute],
      unattended: true,
    });
    const response = await tools.callTool(CALL, undefined, {
      admission_provenance: { source: 'automatic' },
      tool_call_id: 'call-1',
    });
    expect(receiptEvents(response)).toEqual([]);
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });
});
