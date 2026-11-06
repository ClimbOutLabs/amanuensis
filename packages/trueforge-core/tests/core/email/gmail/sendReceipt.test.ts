import { checkCodeOf, hashDraft, type ReviewableDraft } from '../../../../src/core/email/gmail/draftReview';
import type { GmailMessage } from '../../../../src/core/email/gmail/gmailWire';
import { SendReceiptEventSchema } from '../../../../src/core/email/gmail/receiptEvents';
import {
  isCallToolResponseResult,
  type CallToolResponse,
  type ToolInvocationContext,
} from '../../../../src/core/mcp/IMCPServer';
import { plainDraft } from './fixtures';
import { approvedContext, build, json, route, text, type Route } from './harness';

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
const sendFails =
  (status: number): Route =>
  url =>
    url.pathname === '/gmail/v1/users/me/drafts/send' ? json({ error: { message: 'no' } }, status) : undefined;

function receiptEvents(response: CallToolResponse) {
  expect(isCallToolResponseResult(response)).toBe(true);
  return isCallToolResponseResult(response) ? (response.events ?? []) : [];
}

/** The context the host hands an approved send, naming the tool call the receipt answers. */
function approvedSend(info: Parameters<typeof approvedContext>[0]): ToolInvocationContext {
  return { ...approvedContext(info), tool_call_id: 'call-1' };
}

async function notSentReason(response: CallToolResponse) {
  const [event, ...rest] = receiptEvents(response);
  expect(rest).toEqual([]);
  if (event?.type !== 'aman.email.send_receipt') {
    throw new Error('expected a send receipt event');
  }
  expect(event.result.outcome).toBe('not_sent');
  return event.result.outcome === 'not_sent' ? event.result.reason : undefined;
}

const BASE: ReviewableDraft = {
  to: [{ name: '', address: 'a@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Lease',
  body: 'Thursday works.',
  threadId: 't1',
  inReplyTo: '',
  references: '',
  fromName: 'Ada',
  nameLeftOff: false,
  replyTo: null,
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
    const other = [{ name: '', address: 'b@example.com' }];
    const edits: Partial<ReviewableDraft>[] = [
      { to: other },
      { cc: other },
      { bcc: other },
      { subject: 'Keys' },
      { body: 'Send the keys.' },
      { threadId: 't2' },
      { inReplyTo: '<x@y>' },
      { references: '<x@y>' },
      { fromName: 'Eve' },
      { replyTo: 'eve@example.com' },
    ];
    for (const edit of edits) {
      expect(checkCodeOf(hashDraft({ ...BASE, ...edit }))).not.toBe(code);
    }
  });
});

describe('the check code on the card', () => {
  it('is on a send card and is the code of the hash the approval binds', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute()] });
    const info = await tools.toolCallInfo(CALL);
    const bound = info.mint_canonical_params?.['review_hash'];
    expect(typeof bound).toBe('string');
    expect(info.tier3_card?.email?.check_code).toBe(checkCodeOf(String(bound)));
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
    const info = await tools.toolCallInfo(CALL);
    const card = info.tier3_card?.email;
    const before = Date.now();
    const response = await tools.callTool(CALL, undefined, approvedSend(info));
    const [event, ...rest] = receiptEvents(response);
    expect(rest).toEqual([]);
    expect(SendReceiptEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({ type: 'aman.email.send_receipt', tool_call_id: 'call-1' });
    if (event?.type !== 'aman.email.send_receipt' || event.result.outcome !== 'sent') {
      throw new Error('expected a sent receipt');
    }
    expect(event.result.sent_message_id).toBe('sent-1');
    expect(event.result.check_code).toBe(card?.check_code);
    expect(Date.parse(event.result.sent_at)).toBeGreaterThanOrEqual(before);
    expect(event.result.message).toEqual({
      to: card?.to,
      cc: card?.cc,
      bcc: card?.bcc,
      subject: card?.subject,
      body: card?.body,
      reply_to: card?.reply_to,
    });
  });

  it('shows what the gate verified, not what the model was told', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    const info = await tools.toolCallInfo(CALL);
    const response = await tools.callTool(CALL, undefined, approvedSend(info));
    expect(JSON.stringify(receiptEvents(response))).not.toContain(text(response));
    expect(JSON.stringify(receiptEvents(response))).toContain('See you then.');
  });

  it('is not recorded when the call has no id to answer', async () => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    const info = await tools.toolCallInfo(CALL);
    expect(receiptEvents(await tools.callTool(CALL, undefined, approvedContext(info)))).toEqual([]);
  });
});

describe('a send that did not go out', () => {
  it('says the draft changed, with no message id, no time and no content', async () => {
    let live: GmailMessage = DRAFT;
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live }) : undefined),
        sendRoute,
      ],
    });
    const info = await tools.toolCallInfo(CALL);
    live = plainDraft({ id: 'd-m1', threadId: 't9', subject: 'Lease', body: 'Send me the keys.' });
    const response = await tools.callTool(CALL, undefined, approvedSend(info));
    expect(await notSentReason(response)).toBe('draft_changed');
    expect(JSON.stringify(receiptEvents(response))).not.toMatch(/sent_message_id|sent_at|check_code|keys/);
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('says the draft changed when it can no longer be shown in full, not that it could not be read', async () => {
    let live: GmailMessage = DRAFT;
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [
        url => (url.pathname === '/gmail/v1/users/me/drafts/d1' ? json({ id: 'd1', message: live }) : undefined),
        sendRoute,
      ],
    });
    const info = await tools.toolCallInfo(CALL);
    live = plainDraft({
      id: 'd-m1',
      threadId: 't9',
      body: 'Thursday works.\nSee you then.',
      extraHeaders: [{ name: 'X-Foo', value: 'x' }],
    });
    expect(await notSentReason(await tools.callTool(CALL, undefined, approvedSend(info)))).toBe('draft_changed');
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
    const info = await tools.toolCallInfo(CALL);
    failing = true;
    expect(await notSentReason(await tools.callTool(CALL, undefined, approvedSend(info)))).toBe('cannot_send');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it.each([
    [400, 'gmail_refused'],
    [401, 'reconnect_google'],
    [403, 'reconnect_google'],
    [429, 'rate_limited'],
    [502, 'unconfirmed'],
  ] as const)('reads %s from Gmail on the send as %s', async (status, reason) => {
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendFails(status)] });
    const info = await tools.toolCallInfo(CALL);
    expect(await notSentReason(await tools.callTool(CALL, undefined, approvedSend(info)))).toBe(reason);
  });

  it('does not claim "not sent" when Gmail never answered', async () => {
    const dropped: Route = url => {
      if (url.pathname === '/gmail/v1/users/me/drafts/send') {
        throw new TypeError('fetch failed');
      }
      return undefined;
    };
    const { tools } = await build({ features: [...COMPOSE], routes: [draftRoute(), dropped] });
    const info = await tools.toolCallInfo(CALL);
    expect(await notSentReason(await tools.callTool(CALL, undefined, approvedSend(info)))).toBe('unconfirmed');
  });

  it('says it needs the OK again when the call carries no approval', async () => {
    const { tools, google } = await build({ features: [...COMPOSE], routes: [draftRoute(), sendRoute] });
    const response = await tools.callTool(CALL, undefined, {
      admission_provenance: { source: 'automatic' },
      tool_call_id: 'call-1',
    });
    expect(await notSentReason(response)).toBe('needs_ok_again');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
  });

  it('says a demo only sends to its own addresses', async () => {
    const { tools, google } = await build({
      features: [...COMPOSE],
      routes: [draftRoute(), sendRoute],
      demoSendAllowlist: ['demo@example.com'],
    });
    const info = await tools.toolCallInfo(CALL);
    const response = await tools.callTool(CALL, undefined, approvedSend(info));
    expect(await notSentReason(response)).toBe('demo_limited');
    expect(google.urls.some(entry => entry.includes('/drafts/send'))).toBe(false);
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
